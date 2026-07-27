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
import { tokenMatches } from "../auth.js";
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
			// ADR-0009: forward the optional ship-to. The domain validates + trims
			// (bounded lengths) and snapshots it immutably onto the order; a logged-in
			// checkout may have prefilled it from the profile book, but the order copies
			// the SUBMITTED value, never a live pointer to the profile row.
			...(parsed.data.shippingAddress !== undefined
				? { shippingAddress: parsed.data.shippingAddress }
				: {}),
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

	// Unauthenticated, capability-URL-only read (ADR-0010 §2 / PR D — guest
	// "track my order" polling drives checkout; the order id alone is the only
	// credential). A VALID `X-Internal-Token` unlocks the full admin-equivalent
	// view (`serializeOrder`); anything else — absent, empty, or wrong —
	// DEGRADES to the redacted `serializePublicOrder` view, never a 401/503:
	// this route must keep working for a guest whether or not the internal
	// token is even configured. That is why this checks `deps.internalToken`
	// directly instead of calling `requireInternalToken` (which fails closed)
	// and why the token is checked for presence before `tokenMatches` —
	// `tokenMatches` takes a REQUIRED `expected: string`, so calling it with an
	// unset/empty token would hash the empty string and (worse) invite a caller
	// to "authenticate" with an empty `X-Internal-Token` against an unconfigured
	// server. Mirrors the "empty token ⇒ treated as unset" rule at
	// `auth.ts:52`. NOTE: `entitlements.ts`'s `/grant` also calls the full
	// `serializeOrder` — that route sits behind `requireInternalToken` (a
	// server-to-server POST), so it is unaffected by and intentionally
	// untouched by this change.
	app.get("/orders/:orderId", async (c) => {
		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const order = await deps.orderStore.getById(toOrderId(params.data.orderId));
		if (order === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		const authorized =
			deps.internalToken !== undefined &&
			deps.internalToken.length > 0 &&
			tokenMatches(c.req.header("X-Internal-Token"), deps.internalToken);
		return c.json(
			{ ok: true, order: authorized ? serializeOrder(order) : serializePublicOrder(order) },
			200,
		);
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
		// The admin disposition once the flag was resolved (admin-UX Increment 1);
		// null while unflagged/unresolved. Additive — existing consumers ignore it.
		reconciliationResolution: order.reconciliationResolution,
		// The shipping fulfillment once recorded (admin-UX Increment 1); null until
		// the order ships with tracking. Additive — existing consumers ignore it.
		fulfillment: order.fulfillment,
		// The structured cancellation once recorded via cancelOrder (admin-UX
		// Increment 1, "cancel with reason"); null while never cancelled OR
		// cancelled via the bare transition (no reason on file). Additive —
		// existing consumers ignore it.
		cancellation: order.cancellation,
		// The immutable ship-to snapshot captured at checkout (ADR-0009); null for a
		// historical order (predates capture) or a digital-only order. Additive —
		// existing consumers ignore it.
		shippingAddress: order.shippingAddress,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
			appliedCouponCode: order.totals.appliedCouponCode,
			// ADR-0009 (admin display-only juxtaposition): the chosen shipping zone,
			// read off the totals' method snapshot, so the admin can render the
			// captured ship-to country NEXT TO the priced zone and spot a "domestic
			// zone / foreign country" mismatch. No matching/validation — two facts,
			// side by side. Null when no zone was selected.
			shippingZoneId: shippingZoneIdOf(order.totals.shippingMethodSnapshot),
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

/**
 * Public (unauthenticated, capability-URL) projection of an order — ADR-0010
 * §2 / PR D. A **WHITELIST**, not a delete-list: every key is added here
 * explicitly, so a future additive `Order` field is PRIVATE by default — the
 * inverse of `serializeOrder`'s "additive — existing consumers ignore it"
 * habit, which is exactly how `shippingAddress` became silently public under
 * ADR-0009. If this is ever "simplified" into `{ ...serializeOrder(order),
 * delete x }`, the next field added to `serializeOrder` leaks by default —
 * don't.
 *
 * Omits `buyerRef`, `customerId`, `shippingAddress`, `reconciliationFlag`,
 * `reconciliationResolution` ENTIRELY (never `null`): a client must not be
 * able to distinguish "redacted" from "absent" and probe for the real shape.
 * `fulfillment`/`cancellation` stay present but TRIMMED — the carrier/tracking
 * info and the cancellation reason are a legitimate guest read, but
 * `recordedBy`/`cancelledBy` (staff identity) and `recordedAt`/`detail` (an
 * audit witness / free text) are not.
 *
 * A GUEST has no session, so `GET /me/orders/:orderId` is not a fallback for
 * this read — until a dedicated order-confirmation page exists, an
 * unauthenticated caller cannot see their own ship-to via this route. The
 * full view remains behind a session (`GET /me/orders/:orderId`) or a valid
 * `X-Internal-Token` (this same route, see below). The widening path, if the
 * confirmation UX ever needs a shipping hint, is a DERIVED
 * `shippingAddressSummary` (city + country + a masked postal code) —
 * never reopen the raw `shippingAddress` snapshot on this route.
 */
export function serializePublicOrder(order: Order): Record<string, unknown> {
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		holdExpiresAt: order.holdExpiresAt,
		createdAt: order.createdAt,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
			appliedCouponCode: order.totals.appliedCouponCode,
			shippingZoneId: shippingZoneIdOf(order.totals.shippingMethodSnapshot),
		},
		lines: order.lines.map((l) => ({
			sku: l.sku,
			title: l.title,
			unitPriceCents: l.unitPrice,
			currency: l.currency,
			quantity: l.quantity,
			fulfillmentKind: l.fulfillmentKind,
		})),
		fulfillment:
			order.fulfillment === null
				? null
				: {
						carrier: order.fulfillment.carrier,
						trackingNumber: order.fulfillment.trackingNumber,
						trackingUrl: order.fulfillment.trackingUrl,
						shippedAt: order.fulfillment.shippedAt,
					},
		cancellation:
			order.cancellation === null
				? null
				: { reason: order.cancellation.reason, cancelledAt: order.cancellation.cancelledAt },
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

/** Read the chosen shipping zone id off `order_totals.shippingMethodSnapshot`
 *  (shape `{ zoneId, methodId }` — an opaque `unknown` on the model). Returns null
 *  when absent/malformed. Display-only (ADR-0009): never used for matching. */
function shippingZoneIdOf(snapshot: unknown | null): string | null {
	if (snapshot === null || typeof snapshot !== "object") return null;
	const zoneId = (snapshot as { zoneId?: unknown }).zoneId;
	return typeof zoneId === "string" ? zoneId : null;
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
		case "INVALID_SHIPPING_ADDRESS":
			// Malformed input (a required ship-to field empty / over-length) — a 400,
			// like the top-level zod parse failure, not a 409 conflict (ADR-0009).
			return c.json(body, 400);
		case "PAYMENT_INTENT_FAILED":
			// The UPSTREAM gateway failed (down / rejecting), not the request — a 502,
			// never a 409. The `pending` order row is intentionally kept: a same-key
			// retry re-issues the SAME intent, and expireOrders sweeps it at TTL.
			return c.json(body, 502);
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
