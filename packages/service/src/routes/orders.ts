import {
	type CartStore,
	type Clock,
	computeQuote,
	type CouponStore,
	type CreateOrderDeps,
	type CreateOrderFailure,
	createOrderFromCart,
	type EntitlementStore,
	type ExpireOrdersDeps,
	expireOrders,
	type IdGen,
	idempotencyKey,
	type InventoryStore,
	type Order,
	orderId as toOrderId,
	type OrderStore,
	type OrderSummary,
	type PaymentGateway,
	type PaymentIntentHandle,
	type PaymentMethod,
	type PaymentEventStore,
	productId as toProductId,
	type QuoteFailure,
	type ShippingRulesStore,
	type TaxRulesStore,
	type TotalsLineInput,
	type ProductCommerceStore,
} from "@urumi/domain";
import { type Context, Hono } from "hono";
import { checkoutBody, orderPathParams, quoteBody } from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";

/** Shared deps for every Phase-4 order/payment/entitlement route (§7). */
export interface OrderServiceDeps {
	store: InventoryStore;
	cartStore: CartStore;
	productCommerce: ProductCommerceStore;
	orderStore: OrderStore;
	entitlementStore: EntitlementStore;
	paymentEventStore: PaymentEventStore;
	// Phase 6: the totals-pipeline rules stores.
	shippingRules: ShippingRulesStore;
	taxRules: TaxRulesStore;
	couponStore: CouponStore;
	clock: Clock;
	idGen: IdGen;
	gateways: Partial<Record<PaymentMethod, PaymentGateway>>;
	/** Checkout hold TTL in ms; defaults to the domain's DEFAULT_CHECKOUT_TTL_MS. */
	checkoutTtlMs?: number;
	/** Shared secret for /internal/* + service-authenticated /entitlements/grant. */
	internalToken?: string;
}

/**
 * Order routes (§7): create-from-cart, order read (drives the redirect poll), and
 * the internal order-expiry trigger. Each a straight serialization of a use-case.
 * The canonical create endpoint is `POST /checkout/orders` — Phase 6 extends this
 * exact route (never renamed `/checkout/complete`).
 */
export function orderRoutes(deps: OrderServiceDeps): Hono {
	const app = new Hono();
	const createDeps: CreateOrderDeps = {
		orderStore: deps.orderStore,
		cartStore: deps.cartStore,
		inventoryStore: deps.store,
		productCommerce: deps.productCommerce,
		shippingRules: deps.shippingRules,
		taxRules: deps.taxRules,
		couponStore: deps.couponStore,
		clock: deps.clock,
		idGen: deps.idGen,
		gateways: deps.gateways,
		ttlMs: deps.checkoutTtlMs,
	};
	const expireDeps: ExpireOrdersDeps = {
		orderStore: deps.orderStore,
		inventoryStore: deps.store,
		couponStore: deps.couponStore,
		clock: deps.clock,
	};

	app.post("/checkout/orders", async (c) => {
		const parsed = checkoutBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		// Idempotency key (§9 decision 8): the client `Idempotency-Key` header, or a
		// fallback derived from the cart id (the cart is single-use → checked_out).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0 ? header : `checkout:${parsed.data.cartId}`;
		const res = await createOrderFromCart(createDeps, {
			cartId: parsed.data.cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: parsed.data.buyerRef,
			paymentMethod: parsed.data.paymentMethod,
			...(parsed.data.shippingZoneId !== undefined
				? { shippingZoneId: parsed.data.shippingZoneId }
				: {}),
			...(parsed.data.shippingMethodId !== undefined
				? { shippingMethodId: parsed.data.shippingMethodId }
				: {}),
			...(parsed.data.couponCode !== undefined ? { couponCode: parsed.data.couponCode } : {}),
		});
		if (res.ok) {
			return c.json(
				{ ok: true, order: serializeOrder(res.order), intent: serializeIntent(res.intent) },
				201,
			);
		}
		return checkoutFailure(c, res.reason);
	});

	// Read-only totals preview (§6): cart + zone/method + coupon → breakdown. Does
	// NOT redeem the coupon — safe to call repeatedly as the buyer edits selection.
	app.post("/checkout/quote", async (c) => {
		const parsed = quoteBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const cart = await deps.cartStore.get(parsed.data.cartId);
		if (cart === null) return c.json({ ok: false, reason: "CART_NOT_FOUND" }, 404);
		if (cart.lines.length === 0) return c.json({ ok: false, reason: "CART_EMPTY" }, 409);

		// Resolve each line's snapshot price + tax class (mirrors createOrderFromCart).
		// Bulk-fetch every line's projection in ONE store round trip (kills the
		// per-cart-line N+1); brand lazily per line below so a null line's
		// PRODUCT_NOT_PRICED precedence is unchanged.
		const pcById = await deps.productCommerce.getManyByProductId(
			cart.lines
				.map((line) => line.productId)
				.filter((id): id is string => id !== null)
				.map((id) => toProductId(id)),
		);
		const lines: TotalsLineInput[] = [];
		for (const line of cart.lines) {
			if (line.productId === null) return c.json({ ok: false, reason: "PRODUCT_NOT_PRICED" }, 409);
			const pc = pcById.get(toProductId(line.productId)) ?? null;
			if (pc === null || pc.price === null) {
				return c.json({ ok: false, reason: "PRODUCT_NOT_PRICED" }, 409);
			}
			if (pc.price.currency !== cart.currency) {
				return c.json({ ok: false, reason: "CURRENCY_MISMATCH" }, 409);
			}
			lines.push({
				unitPriceCents: pc.price.amount,
				qty: line.qty,
				taxClassId: pc.taxClass ?? "standard",
			});
		}

		const quote = await computeQuote(
			{
				shippingRules: deps.shippingRules,
				taxRules: deps.taxRules,
				couponStore: deps.couponStore,
				clock: deps.clock,
			},
			{
				currency: cart.currency,
				lines,
				...(parsed.data.shippingZoneId !== undefined ? { zoneId: parsed.data.shippingZoneId } : {}),
				...(parsed.data.shippingMethodId !== undefined
					? { methodId: parsed.data.shippingMethodId }
					: {}),
				...(parsed.data.couponCode !== undefined ? { couponCode: parsed.data.couponCode } : {}),
			},
		);
		if (!quote.ok) return quoteFailure(c, quote.reason);
		const b = quote.breakdown;
		return c.json(
			{
				ok: true,
				breakdown: {
					currency: b.currency,
					subtotalCents: b.subtotalCents,
					discountCents: b.discountCents,
					shippingCents: b.shippingCents,
					taxCents: b.taxCents,
					totalCents: b.totalCents,
					appliedCouponCode: b.appliedCouponCode ?? null,
				},
			},
			200,
		);
	});

	app.get("/orders/:orderId", async (c) => {
		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const order = await deps.orderStore.getById(toOrderId(params.data.orderId));
		if (order === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		return c.json({ ok: true, order: serializeOrder(order) }, 200);
	});

	app.post("/internal/expire-orders", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const expired = await expireOrders(expireDeps);
		return c.json({ ok: true, expired }, 200);
	});

	return app;
}

/** Wire shape of an order (§7) — totals from `order_totals`, snapshots from lines.
 *  Extended ADDITIVELY for the admin Orders console with `createdAt` +
 *  `customerId` (existing consumers ignore unknown fields). */
export function serializeOrder(order: Order): Record<string, unknown> {
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		buyerRef: order.buyerRef,
		customerId: order.customerId,
		holdExpiresAt: order.holdExpiresAt,
		createdAt: order.createdAt,
		reconciliationFlag: order.reconciliationFlag,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
			appliedCouponCode: order.totals.appliedCouponCode,
		},
		lines: order.lines.map((l) => ({
			sku: l.sku,
			title: l.title,
			unitPriceCents: l.unitPrice,
			currency: l.currency,
			quantity: l.quantity,
			fulfillmentKind: l.fulfillmentKind,
		})),
	};
}

/** Wire shape of an admin Orders-list row (view-only projection). Money stays an
 *  integer minor unit + an ISO-4217 currency string; `reconciliationFlag` is the
 *  boolean list badge (the free-text detail lives only on the full order). */
export function serializeOrderSummary(summary: OrderSummary): Record<string, unknown> {
	return {
		id: summary.id,
		state: summary.state,
		currency: summary.currency,
		buyerRef: summary.buyerRef,
		customerId: summary.customerId,
		paymentMethod: summary.paymentMethod,
		createdAt: summary.createdAt,
		totalCents: summary.total,
		reconciliationFlag: summary.reconciliationFlag,
	};
}

function serializeIntent(intent: PaymentIntentHandle): Record<string, unknown> {
	return { gateway: intent.gateway, intentId: intent.intentId, clientAction: intent.clientAction };
}

function checkoutFailure(c: Context, reason: CreateOrderFailure): Response {
	const body = { ok: false as const, reason };
	switch (reason) {
		case "CART_NOT_FOUND":
		case "COUPON_NOT_FOUND":
			return c.json(body, 404);
		case "CART_EMPTY":
		case "CART_CHECKED_OUT":
		case "RESERVATION_LOST":
		case "PRODUCT_NOT_PRICED":
		case "CURRENCY_MISMATCH":
		case "SHIPPING_METHOD_NOT_FOUND":
		case "SHIPPING_RATE_NOT_FOUND":
		case "COUPON_NOT_ACTIVE":
		case "COUPON_MIN_SUBTOTAL":
		case "COUPON_EXHAUSTED":
		case "COUPON_MAX_PER_CUSTOMER":
		case "COUPON_CURRENCY_MISMATCH":
			return c.json(body, 409);
	}
}

function quoteFailure(c: Context, reason: QuoteFailure): Response {
	const body = { ok: false as const, reason };
	switch (reason) {
		case "COUPON_NOT_FOUND":
			return c.json(body, 404);
		case "SHIPPING_METHOD_NOT_FOUND":
		case "SHIPPING_RATE_NOT_FOUND":
		case "COUPON_NOT_ACTIVE":
		case "COUPON_MIN_SUBTOTAL":
		case "COUPON_EXHAUSTED":
		case "COUPON_CURRENCY_MISMATCH":
			return c.json(body, 409);
	}
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
