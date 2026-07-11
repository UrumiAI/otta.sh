import type { Currency } from "../money/cents.js";
import type { CustomerId, IdempotencyKey, OrderId } from "../money/ids.js";
import type { CouponRecord } from "../ports/coupon-store.js";
import type { TotalsBreakdown } from "../pricing/types.js";
import {
	orderId as brandOrderId,
	productId as brandProductId,
	reservationId as brandReservationId,
	sku as brandSku,
} from "../money/ids.js";
import type { CartStore } from "../ports/cart-store.js";
import type { Clock } from "../ports/clock.js";
import type { CouponStore } from "../ports/coupon-store.js";
import type { IdGen } from "../ports/id-gen.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type { CreateOrderLineInput, OrderStore } from "../ports/order-store.js";
import type {
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
} from "../ports/payment-gateway.js";
import type { ProductCommerceStore } from "../ports/product-commerce-store.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";
import { computeQuote } from "../pricing/quote.js";
import type { TotalsLineInput } from "../pricing/types.js";
import type { CreateOrderFailure } from "./errors.js";
import type { Order, PaymentMethod } from "./model.js";

/** 15 minutes — the checkout hold TTL (§9 decision 5), configurable. */
export const DEFAULT_CHECKOUT_TTL_MS = 15 * 60 * 1000;

export interface CreateOrderDeps {
	orderStore: OrderStore;
	cartStore: CartStore;
	inventoryStore: InventoryStore;
	productCommerce: ProductCommerceStore;
	/** Phase 6: the totals-pipeline rules stores (shipping / tax / coupons). */
	shippingRules: ShippingRulesStore;
	taxRules: TaxRulesStore;
	couponStore: CouponStore;
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
	// -- Phase 6 checkout inputs (all optional; absent ⇒ zero shipping/tax) ----
	/** The buyer's tax zone. */
	shippingZoneId?: string;
	/** The selected shipping method. */
	shippingMethodId?: string;
	/** An optional coupon code, redeemed atomically alongside order creation. */
	couponCode?: string;
	/** Logged-in customer (Phase 5) — drives `maxUsesPerCustomer` when present. */
	customerId?: CustomerId;
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

	// I1 — top-level idempotency short-circuit (CLAUDE.md idempotency, plan §1
	// case 6). A replay of the same key must return the ORIGINAL order WITHOUT
	// re-running the pipeline: computeQuote→validateCoupon does a SOFT
	// usesCount>=maxUses / expiresAt check that would wrongly reject a replay of a
	// checkout that consumed the coupon's last use (or whose coupon has since
	// expired). Re-issuing the payment intent is idempotent under the same key.
	const already = await deps.orderStore.getByIdempotencyKey(command.idempotencyKey);
	if (already !== null) {
		const intent = await gateway.createIntent({
			orderId: already.id,
			amount: already.totals.total,
			currency: already.totals.currency,
			idempotencyKey: command.idempotencyKey,
		});
		return { ok: true, order: already, intent };
	}

	const cart = await deps.cartStore.get(command.cartId);
	if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
	if (cart.lines.length === 0) return { ok: false, reason: "CART_EMPTY" };
	if (cart.state !== "active") {
		// Cart-state fence at the checkout entrance (§5, review G2): a checked-out
		// cart never mints a SECOND order (two tabs with per-click keys would
		// otherwise snapshot reservations the first order already adopted). A
		// same-key REPLAY was already returned above by the idempotency
		// short-circuit, so reaching here with a NON-active cart is always a
		// distinct-key second checkout ⇒ reject.
		return { ok: false, reason: "CART_CHECKED_OUT" };
	}

	// Snapshot price + title + fulfillment_kind from product_commerce (§4). This
	// read is the ONLY code path from the product projection to an order line; the
	// snapshot lives on `order_items` thereafter, so later product edits never
	// rewrite it (immutability is structural).
	const currency = cart.currency;
	const lines: CreateOrderLineInput[] = [];
	const totalsLines: TotalsLineInput[] = [];
	for (const line of cart.lines) {
		if (line.productId === null) return { ok: false, reason: "PRODUCT_NOT_PRICED" };
		const pc = await deps.productCommerce.getByProductId(brandProductId(line.productId));
		if (pc === null || pc.price === null || pc.title === null) {
			return { ok: false, reason: "PRODUCT_NOT_PRICED" };
		}
		if (pc.price.currency !== currency) {
			// Review G5: order.currency (and the order_totals row) is stamped from
			// the cart; a line priced in another currency must never be summed into
			// that total — reject, never mix monies.
			return { ok: false, reason: "CURRENCY_MISMATCH" };
		}
		const physical = pc.productKind === "physical";
		if (physical && line.reservationId === null) {
			// Review G3: the product flipped digital → physical between add-to-cart
			// and checkout, so this line holds NO reservation. Writing it as
			// physical+NULL would make adoption AND settle's commit branch silently
			// skip it — a paid order with zero inventory committed. Fail loudly
			// before minting anything; the buyer re-adds (same recovery as a swept
			// hold).
			return { ok: false, reason: "RESERVATION_LOST" };
		}
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
		// Tax base for the pipeline: the line's snapshot price × qty at its tax class.
		totalsLines.push({
			unitPriceCents: pc.price.amount,
			qty: line.qty,
			taxClassId: pc.taxClass ?? "standard",
		});
	}

	// Phase 6: compute the full totals breakdown (subtotal → discount → shipping
	// → tax) via the pipeline — this REPLACES the Phase-4 naive Σ(line) stub. Pure
	// engine after the store reads; read-only (no redemption here).
	const quote = await computeQuote(
		{
			shippingRules: deps.shippingRules,
			taxRules: deps.taxRules,
			couponStore: deps.couponStore,
			clock: deps.clock,
		},
		{
			currency,
			lines: totalsLines,
			...(command.shippingZoneId !== undefined ? { zoneId: command.shippingZoneId } : {}),
			...(command.shippingMethodId !== undefined ? { methodId: command.shippingMethodId } : {}),
			...(command.couponCode !== undefined ? { couponCode: command.couponCode } : {}),
		},
	);
	if (!quote.ok) return { ok: false, reason: quote.reason };
	const breakdown = quote.breakdown;

	const freshOrderId = brandOrderId(deps.idGen.newId());
	const holdExpiresAt = new Date(deps.clock.now().getTime() + ttl(deps)).toISOString();

	// Coupon redemption is the GATE, before order creation (§5): redeem atomically
	// under the SAME idempotency key so a replay never double-redeems. If order
	// creation/adoption then fails, we synchronously release (catch-and-release).
	//
	// I4 — a valid coupon that computes to ZERO discount is NOT redeemed: burning a
	// max_uses slot for zero benefit would also leave a redemption with no audit
	// link (order_totals.applied_coupon_code stays null when discount is 0). Only a
	// discount-bearing coupon is redeemed and stamped.
	let redemptionId: string | null = null;
	if (quote.couponRecord !== null && breakdown.discountCents > 0) {
		const redeemed = await deps.couponStore.redeem({
			couponId: quote.couponRecord.id,
			orderId: freshOrderId,
			idempotencyKey: command.idempotencyKey,
			...(command.customerId !== undefined ? { customerId: command.customerId } : {}),
			createdAt: deps.clock.now().toISOString(),
		});
		if (!redeemed.ok) return { ok: false, reason: redeemed.reason };
		redemptionId = redeemed.redemptionId;
	}

	// From here on, any failure after a fresh redemption must release the coupon
	// (synchronous path, §5). A replay (redeemed.replayed) is harmless to release
	// only if we actually fail — on the happy replay path nothing fails.
	try {
		return await finalizeOrder(deps, command, {
			freshOrderId,
			currency,
			holdExpiresAt,
			lines,
			breakdown,
			couponRecord: quote.couponRecord,
			shippingZoneId: command.shippingZoneId,
			shippingMethodId: command.shippingMethodId,
			gateway,
			onFailure: async () => {
				if (redemptionId !== null) await deps.couponStore.release(redemptionId);
			},
		});
	} catch (err) {
		if (redemptionId !== null) await deps.couponStore.release(redemptionId);
		throw err;
	}
}

interface FinalizeContext {
	freshOrderId: OrderId;
	currency: Currency;
	holdExpiresAt: string;
	lines: CreateOrderLineInput[];
	breakdown: TotalsBreakdown;
	couponRecord: CouponRecord | null;
	shippingZoneId?: string;
	shippingMethodId?: string;
	gateway: PaymentGateway;
	onFailure: () => Promise<void>;
}

async function finalizeOrder(
	deps: CreateOrderDeps,
	command: CreateOrderCommand,
	ctx: FinalizeContext,
): Promise<CreateOrderFromCartResult> {
	const { breakdown } = ctx;
	// 1. Insert the pending order FIRST (guarded by idempotency_key UNIQUE),
	//    before adopting any reservation (§5 ordering / self-healing). Writes the
	//    FULL breakdown into order_totals (§6), once, never rewritten.
	const { order } = await deps.orderStore.createFromCart({
		orderId: ctx.freshOrderId,
		cartId: command.cartId,
		currency: ctx.currency,
		idempotencyKey: command.idempotencyKey,
		holdExpiresAt: ctx.holdExpiresAt,
		buyerRef: command.buyerRef,
		paymentMethod: command.paymentMethod,
		lines: ctx.lines,
		totals: {
			subtotal: breakdown.subtotalCents,
			total: breakdown.totalCents,
			currency: ctx.currency,
			discount: breakdown.discountCents,
			shipping: breakdown.shippingCents,
			tax: breakdown.taxCents,
			appliedCouponCode: breakdown.appliedCouponCode ?? null,
			shippingMethodSnapshot:
				ctx.shippingMethodId !== undefined
					? { zoneId: ctx.shippingZoneId ?? null, methodId: ctx.shippingMethodId }
					: null,
			taxBreakdown: {
				lines: breakdown.lineBreakdown,
				shippingTaxCents: breakdown.shippingTaxCents,
			},
		},
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
		if (!adopted.ok) {
			// A lost hold after redemption: synchronously release the coupon (§5)
			// before surfacing the failure. The pending order row stays and is
			// healed by expireOrders; the coupon use is freed here.
			await ctx.onFailure();
			return { ok: false, reason: "RESERVATION_LOST" };
		}
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
	const intent = await ctx.gateway.createIntent(intentInput);
	return { ok: true, order, intent };
}

// Branding at the use-case boundary (like inventory §0.2c): the cart line carries
// a plain `string | null` reservation id.
function asReservationId(value: string | null) {
	return value === null ? null : brandReservationId(value);
}
