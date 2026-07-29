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
import {
	PaymentIntentError,
	type CreateIntentInput,
	type PaymentGateway,
	type PaymentIntentHandle,
} from "../ports/payment-gateway.js";
import type { ProductCommerceStore } from "../ports/product-commerce-store.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";
import { computeQuote } from "../pricing/quote.js";
import type { TotalsLineInput } from "../pricing/types.js";
import type { CreateOrderFailure } from "./errors.js";
import type { Order, OrderAddress, PaymentMethod } from "./model.js";
import { normalizeOrderAddress, type OrderAddressInput } from "./order-address.js";

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
	/**
	 * The optional shipping address the checkout submitted (ADR-0009). Validated
	 * (shape + bounds) and snapshotted IMMUTABLY onto the order — a frozen copy of
	 * whatever checkout submitted (the Shopify model), never a live pointer to the
	 * profile address book. Absent ⇒ no ship-to captured (allowed this slice:
	 * required-for-physical enforcement is deferred until the storefront UI
	 * collects it, per ADR-0009 sequencing).
	 */
	shippingAddress?: OrderAddressInput;
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
 * checked_out` **and records the order's id** (secondary fence + issue #132) —
 * one statement, two columns, so a cart written THROUGH `checkout` (the
 * column's single writer) is `active` iff it carries no order id. That is a
 * writer-enforced invariant, not a structural one: no CHECK constraint backs
 * it, and a raw partial UPDATE can still produce a `checked_out` cart with a
 * NULL order id.
 * That stamp lands BEFORE the payment intent, so it says "this cart became that
 * order", never "that order was paid"; and because the idempotency
 * short-circuit returns earlier, a NULL cart `orderId` never proves the absence
 * of an order (`orders.cart_id` is the complete answer). Idempotent under
 * `idempotencyKey`: a replay returns the same order, re-snapshots nothing,
 * re-adopts nothing (the guarded flips see the reservations already `adopted`
 * for this order).
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
		if (already.state !== "pending") {
			// The order has already left the checkout window — paid, failed, expired or
			// cancelled. There is nothing left to begin paying for, so re-issuing an
			// intent would be a pointless LIVE provider call whose outage could turn a
			// replay of a PAID order into a 502. Return the order with an explicitly
			// EMPTY handle: `clientAction: "none"` (no buyer-facing next action) and an
			// empty `intentId` — this call minted no intent, and the original intent id
			// is not on the order (it lives on `payments.provider_ref`; a caller that
			// needs it reads the order's payments, never this field). The wire shape is
			// unchanged (`serializeIntent` still emits gateway/intentId/clientAction).
			return {
				ok: true,
				order: already,
				intent: { gateway: gateway.id, intentId: "", clientAction: { kind: "none" } },
			};
		}
		let intent: PaymentIntentHandle;
		try {
			// Same builder as the fresh path below — the replay must describe the SAME
			// goods, byte-for-byte, or the provider's same-key retry is rejected.
			intent = await gateway.createIntent(intentInputFor(already, command.idempotencyKey));
		} catch (err) {
			// ONLY a typed intent failure is a clean checkout failure; every other
			// throw is a bug and must keep propagating. The replayed order is
			// untouched — nothing to release, nothing to roll back.
			if (!(err instanceof PaymentIntentError)) throw err;
			logIntentFailure(err, already.id);
			return { ok: false, reason: "PAYMENT_INTENT_FAILED" };
		}
		return { ok: true, order: already, intent };
	}

	// Validate + normalize the optional ship-to snapshot (ADR-0009) BEFORE minting
	// anything: a malformed address must reject the checkout cleanly, never a
	// half-written order. A replay short-circuited above, so this never re-runs for
	// an order that already captured its address. Absent ⇒ null (capture-optional
	// this slice — required-for-physical is a later flip).
	let shippingAddress: OrderAddress | null = null;
	if (command.shippingAddress !== undefined) {
		const normalized = normalizeOrderAddress(command.shippingAddress);
		if (!normalized.ok) return { ok: false, reason: "INVALID_SHIPPING_ADDRESS" };
		shippingAddress = normalized.value;
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
	// Bulk-fetch every priced line's product projection in ONE store round trip
	// (kills the per-cart-line N+1). Branding only the non-null ids keeps a null
	// line's PRODUCT_NOT_PRICED precedence identical to the per-line read: a null
	// line is never branded here, and each surviving line is re-branded lazily at
	// its own map lookup below, AFTER its own null guard.
	const pcById = await deps.productCommerce.getManyByProductId(
		cart.lines
			.map((line) => line.productId)
			.filter((id): id is string => id !== null)
			.map((id) => brandProductId(id)),
	);
	for (const line of cart.lines) {
		if (line.productId === null) return { ok: false, reason: "PRODUCT_NOT_PRICED" };
		const pc = pcById.get(brandProductId(line.productId)) ?? null;
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

	// From here on, a failure after a fresh redemption releases the coupon — but
	// ONLY while no order row owns it yet. `orderMinted` is that ownership
	// handoff, flipped by `finalizeOrder` the instant `orderStore.createFromCart`
	// returns (symmetric with the `onFailure` callback below): once the order row
	// exists it carries the DISCOUNTED total, so releasing the redemption would
	// grant the discount without consuming a use. From that point the coupon is
	// freed by exactly one of `expireOrders` (TTL sweep, via `releaseByOrder`) or
	// an explicit eager release the use-case decides on (RESERVATION_LOST).
	let orderMinted = false;
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
			shippingAddress,
			gateway,
			onFailure: async () => {
				if (redemptionId !== null) await deps.couponStore.release(redemptionId);
			},
			onOrderMinted: () => {
				orderMinted = true;
			},
		});
	} catch (err) {
		// Release ONLY when no order row was ever inserted (see `orderMinted`): a
		// throw AFTER the insert leaves the redemption with the order that carries
		// the discounted total, healed by the TTL sweep.
		if (redemptionId !== null && !orderMinted) await deps.couponStore.release(redemptionId);
		throw err;
	}
}

/**
 * Surface a mapped intent failure with its DIAGNOSTIC provider fields (status /
 * code), so `PaymentIntentError.providerStatus` / `providerCode` are read, not
 * write-only: `PAYMENT_INTENT_FAILED` alone cannot tell an operator whether
 * Stripe was down (503) or the request was rejected (402 `card_declined`).
 * `console` is an ambient global, not an IO import — domain purity (no
 * pg/ctx/fetch) holds. DEFERRED (separate from the durable-anomaly deferral
 * below): the intended replacement is an INJECTED `Logger` port on
 * `CreateOrderDeps`, mirroring how `Clock` displaces ambient `Date.now()`, so
 * the domain states the diagnostic and the caller owns the sink. A DURABLE
 * anomaly (the `settle-order` COMMIT_LOST
 * treatment) would need a `paymentEventStore` in `CreateOrderDeps`, which
 * checkout does not have today; adding one is a deliberate follow-up, not a
 * drive-by widening of this use-case's dependency surface.
 */
function logIntentFailure(err: PaymentIntentError, forOrder: OrderId): void {
	console.error("[domain] createIntent failed → PAYMENT_INTENT_FAILED", {
		orderId: forOrder,
		gateway: err.gateway,
		retryable: err.retryable,
		providerStatus: err.providerStatus,
		providerCode: err.providerCode,
	});
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
	/** The validated ship-to snapshot (ADR-0009), or null when none was captured. */
	shippingAddress: OrderAddress | null;
	gateway: PaymentGateway;
	/** Release the coupon redemption NOW — the eager, use-case-decided release
	 *  (RESERVATION_LOST, whose recovery is a new cart + a new key). */
	onFailure: () => Promise<void>;
	/**
	 * Ownership handoff, symmetric with {@link FinalizeContext.onFailure}: called
	 * exactly once, the instant the `pending` order row is durably inserted. From
	 * that moment the ORDER owns the coupon redemption, so the caller's outer
	 * catch must stop releasing it.
	 */
	onOrderMinted: () => void;
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
		// ADR-0009: freeze the ship-to snapshot alongside the order, in the same
		// guarded insert. A replay re-inserts nothing (idempotency-key conflict).
		shippingAddress: ctx.shippingAddress,
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
	// The order row is now durable and carries the discounted total: it, not this
	// call frame, owns the coupon redemption from here on.
	ctx.onOrderMinted();

	// 2. Adopt every physical line's reservation in ONE batched held → adopted flip
	//    (PR B — checkout-write batching), collected from the persisted order lines
	//    so a replay re-issues idempotently. Digital lines carry no reservation.
	//    ANY lost hold aborts the checkout: the already-adopted siblings are left in
	//    place (not stranded) and healed by expireOrders once the TTL passes.
	const now = deps.clock.now().toISOString();
	const physicalReservationIds = order.lines
		.map((line) => line.reservationId)
		.filter((id): id is NonNullable<typeof id> => id !== null);
	const result = await deps.inventoryStore.adoptMany({
		reservationIds: physicalReservationIds,
		orderId: order.id,
		holdExpiresAt: order.holdExpiresAt,
		now,
	});
	if (result.lost.length > 0) {
		// A lost hold after redemption: synchronously release the coupon (§5) before
		// surfacing the failure. The pending order row stays and is healed by
		// expireOrders; the coupon use is freed here.
		//
		// DELIBERATE ASYMMETRY with PAYMENT_INTENT_FAILED below: recovery from a
		// lost hold is a NEW cart with a NEW key (this order can never be paid), so
		// the use must be freed immediately; an intent failure recovers by REPLAYING
		// the same key against this very order, which must keep its discount.
		await ctx.onFailure();
		return { ok: false, reason: "RESERVATION_LOST" };
	}

	// 3. Secondary fence: flip the cart out of `active` (idempotent on replay),
	//    STAMPING the order it handed off to in the same statement (issue #132) —
	//    that is what lets `/cart` link a buyer to their purchase. `order.id` is
	//    already branded, and it is the PERSISTED order's id, not the locally
	//    minted `freshOrderId` candidate: when two same-key calls race past I1,
	//    the loser's insert is deduped by `orders.idempotency_key` and its
	//    `order.id` is the WINNER's — that is the id the cart must record.
	//
	//    A `false` return is deliberately silent (a replay legitimately loses the
	//    flip). Note the stamp lands here, BEFORE `gateway.createIntent()` below,
	//    so a stamped cart proves only "this cart became that order", never that
	//    the order was paid. And because the I1 short-circuit returns long before
	//    this line, a NULL `orderId` does NOT prove no order exists — see the
	//    port's JSDoc; `orders.cart_id` is the complete answer.
	await deps.cartStore.checkout(command.cartId, order.id);

	// 4. Begin payment; hand the buyer-facing next-action back to the caller.
	const intentInput = intentInputFor(order, command.idempotencyKey);
	//    A live gateway can FAIL here (Stripe down / rejecting). Catch ONLY the
	//    typed PaymentIntentError — any other throw is a bug and propagates. The
	//    inserted `pending` order, its adopted reservations and its coupon
	//    redemption all STAY: `expireOrders` sweeps them at TTL, and a same-key
	//    retry returns this order and re-issues the intent (the provider's native
	//    idempotency key makes that the SAME intent, never a duplicate charge).
	//    `onFailure` is deliberately NOT called (see the asymmetry note above).
	try {
		const intent = await ctx.gateway.createIntent(intentInput);
		return { ok: true, order, intent };
	} catch (err) {
		if (!(err instanceof PaymentIntentError)) throw err;
		logIntentFailure(err, order.id);
		return { ok: false, reason: "PAYMENT_INTENT_FAILED" };
	}
}

/**
 * Build the gateway's `createIntent` input from a persisted order — the SINGLE
 * source for **both** call sites (the fresh checkout and the I1 replay), so the
 * two can never drift into "one describes the goods, the other doesn't".
 *
 * The line data is read off the ORDER, i.e. off `order_items`, which snapshotted
 * `title` at purchase time (CLAUDE.md's snapshot invariant). Two consequences,
 * both load-bearing:
 *  - the payment says what the buyer actually bought, and a later product rename
 *    never rewrites it;
 *  - a same-key replay therefore produces the SAME structured data, which is what
 *    lets a provider's native idempotency (Stripe's `Idempotency-Key`) accept the
 *    replay instead of rejecting a drifted body.
 *
 * The domain hands over STRUCTURE only. Rendering it — joining, truncating,
 * naming the field `description` — is the adapter's job (ports-and-adapters: the
 * domain must not learn Stripe's string format).
 */
function intentInputFor(order: Order, key: IdempotencyKey): CreateIntentInput {
	const address = order.shippingAddress;
	return {
		orderId: order.id,
		amount: order.totals.total,
		currency: order.totals.currency,
		idempotencyKey: key,
		lines: order.lines.map((line) => ({ title: line.title, quantity: line.quantity })),
		// ADR-0009's frozen ship-to, narrowed to the postal fields: a provider's
		// export rules want a destination, never the buyer's contact channels.
		...(address === null
			? {}
			: {
					shipTo: {
						name: address.name,
						line1: address.line1,
						line2: address.line2,
						city: address.city,
						region: address.region,
						postalCode: address.postalCode,
						country: address.country,
					},
				}),
	};
}

// Branding at the use-case boundary (like inventory §0.2c): the cart line carries
// a plain `string | null` reservation id.
function asReservationId(value: string | null) {
	return value === null ? null : brandReservationId(value);
}
