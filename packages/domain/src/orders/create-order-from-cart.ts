import { cents } from "../money/cents.js";
import type { IdempotencyKey } from "../money/ids.js";
import {
	orderId as brandOrderId,
	productId as brandProductId,
	reservationId as brandReservationId,
	sku as brandSku,
} from "../money/ids.js";
import type { CartStore } from "../ports/cart-store.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type { CreateOrderLineInput, OrderStore } from "../ports/order-store.js";
import type {
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
} from "../ports/payment-gateway.js";
import type { ProductCommerceStore } from "../ports/product-commerce-store.js";
import type { CreateOrderFailure } from "./errors.js";
import type { Order, PaymentMethod } from "./model.js";

/** 15 minutes — the checkout hold TTL (§9 decision 5), configurable. */
export const DEFAULT_CHECKOUT_TTL_MS = 15 * 60 * 1000;

export interface CreateOrderDeps {
	orderStore: OrderStore;
	cartStore: CartStore;
	inventoryStore: InventoryStore;
	productCommerce: ProductCommerceStore;
	clock: Clock;
	idGen: IdGen;
	/** Payment adapters keyed by method — the buyer's chosen gateway is resolved here. */
	gateways: Partial<Record<PaymentMethod, PaymentGateway>>;
	/** Checkout hold TTL in ms; defaults to {@link DEFAULT_CHECKOUT_TTL_MS}. */
	ttlMs?: number;
}

export interface CreateOrderCommand {
	cartId: string;
	idempotencyKey: IdempotencyKey;
	/** Email/session claim token — the pre-Phase-5 entitlement key (§6). */
	buyerRef: string;
	paymentMethod: PaymentMethod;
}

export type CreateOrderFromCartResult =
	| { ok: true; order: Order; intent: PaymentIntentHandle }
	| { ok: false; reason: CreateOrderFailure };

function ttl(deps: CreateOrderDeps): number {
	return deps.ttlMs ?? DEFAULT_CHECKOUT_TTL_MS;
}

/**
 * Turn a Phase-3 cart into an immutable `pending` order (§4/§5). The order snapshots
 * each line's **price + title** from `product_commerce` and writes the
 * `order_totals` stub (`subtotal = total = Σ(unitPrice × quantity)`). The
 * **`pending` order row is durably inserted before any reservation is adopted**
 * (§5 ordering), so a partial-adoption abort is healed by `expireOrders` — never a
 * stranded hold. Physical lines adopt their cart reservation via the guarded
 * `held → adopted` flip (moving it out of the Phase-3 sweep's scope); **digital
 * lines reserve nothing** (§6). All lines adopted ⇒ the cart flips `active →
 * checked_out` (secondary fence). Idempotent under `idempotencyKey`: a replay
 * returns the same order, re-snapshots nothing, re-adopts nothing (the guarded
 * flips see the reservations already `adopted` for this order).
 */
export async function createOrderFromCart(
	deps: CreateOrderDeps,
	command: CreateOrderCommand,
): Promise<CreateOrderFromCartResult> {
	const gateway = deps.gateways[command.paymentMethod];
	if (gateway === undefined) {
		throw new Error(`no payment gateway configured for method "${command.paymentMethod}"`);
	}

	const cart = await deps.cartStore.get(command.cartId);
	if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (cart.lines.length === 0) return { ok: false, reason: "CART_EMPTY" };

	// Snapshot price + title + fulfillment_kind from product_commerce (§4). This
	// read is the ONLY code path from the product projection to an order line; the
	// snapshot lives on `order_items` thereafter, so later product edits never
	// rewrite it (immutability is structural).
	const currency = cart.currency;
	const lines: CreateOrderLineInput[] = [];
	let subtotalRaw = 0;
	for (const line of cart.lines) {
		if (line.productId === null) return { ok: false, reason: "PRODUCT_NOT_PRICED" };
		const pc = await deps.productCommerce.getByProductId(brandProductId(line.productId));
		if (pc === null || pc.price === null || pc.title === null) {
			return { ok: false, reason: "PRODUCT_NOT_PRICED" };
		}
		const physical = pc.productKind === "physical";
		lines.push({
			productId: pc.productId,
			sku: brandSku(line.sku),
			title: pc.title,
			unitPrice: pc.price.amount,
			currency: pc.price.currency,
			quantity: line.qty,
			fulfillmentKind: pc.productKind,
			// Physical lines adopt their cart reservation; digital carry none (§6).
			reservationId: physical ? asReservationId(line.reservationId) : null,
		});
		subtotalRaw += pc.price.amount * line.qty;
	}
	const subtotal = cents(subtotalRaw);

	// 1. Insert the pending order FIRST (guarded by idempotency_key UNIQUE),
	//    before adopting any reservation (§5 ordering / self-healing).
	const freshOrderId = brandOrderId(deps.idGen.newId());
	const holdExpiresAt = new Date(deps.clock.now().getTime() + ttl(deps)).toISOString();
	const { order } = await deps.orderStore.createFromCart({
		orderId: freshOrderId,
		cartId: command.cartId,
		currency,
		idempotencyKey: command.idempotencyKey,
		holdExpiresAt,
		buyerRef: command.buyerRef,
		paymentMethod: command.paymentMethod,
		lines,
		totals: { subtotal, total: subtotal, currency },
	});

	// 2. Adopt each physical line's reservation via the guarded held → adopted flip
	//    (from the persisted order lines, so a replay re-issues idempotently).
	const now = deps.clock.now().toISOString();
	for (const line of order.lines) {
		if (line.reservationId === null) continue; // digital: nothing to adopt
		const adopted = await deps.inventoryStore.adopt({
			reservationId: line.reservationId,
			orderId: order.id,
			holdExpiresAt: order.holdExpiresAt,
			now,
		});
		if (!adopted.ok) return { ok: false, reason: "RESERVATION_LOST" };
	}

	// 3. Secondary fence: flip the cart out of `active` (idempotent on replay).
	await deps.cartStore.checkout(command.cartId);

	// 4. Begin payment; hand the buyer-facing next-action back to the caller.
	const intentInput: CreateIntentInput = {
		orderId: order.id,
		amount: order.totals.total,
		currency: order.totals.currency,
		idempotencyKey: command.idempotencyKey,
	};
	const intent = await gateway.createIntent(intentInput);
	return { ok: true, order, intent };
}

// Branding at the use-case boundary (like inventory §0.2c): the cart line carries
// a plain `string | null` reservation id.
function asReservationId(value: string | null) {
	return value === null ? null : brandReservationId(value);
}
