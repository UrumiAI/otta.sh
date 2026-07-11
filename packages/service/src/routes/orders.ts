import {
	type CartStore,
	type Clock,
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
	type PaymentGateway,
	type PaymentIntentHandle,
	type PaymentMethod,
	type PaymentEventStore,
	type ProductCommerceStore,
} from "@urumi/domain";
import { type Context, Hono } from "hono";
import { checkoutBody, orderPathParams } from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";

/** Shared deps for every Phase-4 order/payment/entitlement route (§7). */
export interface OrderServiceDeps {
	store: InventoryStore;
	cartStore: CartStore;
	productCommerce: ProductCommerceStore;
	orderStore: OrderStore;
	entitlementStore: EntitlementStore;
	paymentEventStore: PaymentEventStore;
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
		clock: deps.clock,
		idGen: deps.idGen,
		gateways: deps.gateways,
		ttlMs: deps.checkoutTtlMs,
	};
	const expireDeps: ExpireOrdersDeps = {
		orderStore: deps.orderStore,
		inventoryStore: deps.store,
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
		});
		if (res.ok) {
			return c.json(
				{ ok: true, order: serializeOrder(res.order), intent: serializeIntent(res.intent) },
				201,
			);
		}
		return checkoutFailure(c, res.reason);
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

/** Wire shape of an order (§7) — totals from `order_totals`, snapshots from lines. */
export function serializeOrder(order: Order): Record<string, unknown> {
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		buyerRef: order.buyerRef,
		holdExpiresAt: order.holdExpiresAt,
		reconciliationFlag: order.reconciliationFlag,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
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

function serializeIntent(intent: PaymentIntentHandle): Record<string, unknown> {
	return { gateway: intent.gateway, intentId: intent.intentId, clientAction: intent.clientAction };
}

function checkoutFailure(c: Context, reason: CreateOrderFailure): Response {
	const body = { ok: false as const, reason };
	switch (reason) {
		case "CART_NOT_FOUND":
			return c.json(body, 404);
		case "CART_EMPTY":
		case "CART_CHECKED_OUT":
		case "RESERVATION_LOST":
		case "PRODUCT_NOT_PRICED":
		case "CURRENCY_MISMATCH":
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
