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
import { isProductLive } from "../product-commerce/sellable.js";
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
	// -- Phase 6 checkout inputs -------------------------------------------
	// There is deliberately NO zone: the shipping/tax zone is derived from
	// `shippingAddress` (ADR-0021 Decision 1). Nobody can supply one.
	/** The selected shipping method. Required for a physical cart once the
	 *  address matched a zone; refused for a digital-only cart. */
	shippingMethodId?: string;
	/** An optional coupon code, redeemed atomically alongside order creation. */
	couponCode?: string;
	/**
	 * The signed-in customer who OWNS the order (Phase 5) — drives
	 * `maxUsesPerCustomer` when present, and is written onto the order so it is in
	 * their list from birth. Pass it only when the buyer reference is that
	 * customer's own email (`checkoutOwner`); for anyone else the order is a guest
	 * order, claimed by whoever later proves that inbox.
	 */
	customerId?: CustomerId;
	/**
	 * The shipping address the checkout submitted (ADR-0009). Validated (shape,
	 * bounds, ISO codes — ADR-0021) and snapshotted IMMUTABLY onto the order — a
	 * frozen copy of whatever checkout submitted (the Shopify model), never a
	 * live pointer to the profile address book. It is the ONLY input to the
	 * shipping/tax zone. Required for a cart with a physical line when zones
	 * are configured (`MISSING_SHIPPING_ADDRESS`), or for ANY cart when
	 * {@link addressRequired} says so; optional otherwise.
	 */
	shippingAddress?: OrderAddressInput;
	/**
	 * The buyer's name and address are required for THIS checkout whatever the
	 * cart holds (issue #382): a payment account under India's export rules
	 * refuses a payment without them, digital and no-zone carts included. The
	 * CALLER decides — whether the account needs it is a fact about the payment
	 * provider, which the domain does not read — and the domain enforces it with
	 * the same `MISSING_SHIPPING_ADDRESS` refusal, at the same point, as a
	 * physical cart in a zoned store: before any redemption or mint. A same-key
	 * replay short-circuits before the check, so the locked review's retry
	 * (which sends no address) still replays. Absent or `false` ⇒ ADR-0021's
	 * rules alone.
	 */
	addressRequired?: boolean;
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
 * (§5 ordering), so a partial-adoption abort is never a stranded hold: the abort
 * expires the order at once and releases what it adopted (and a crash before that
 * leaves it to `expireOrders`). Physical lines adopt their cart reservation via the guarded
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
 * `idempotencyKey`: a replay returns the same order and re-snapshots nothing. A
 * replay of a still-`pending` order re-runs the adoption and the cart flip —
 * idempotent for this order (the guarded flips see the reservations already
 * `adopted` for it, and the cart already terminal) — so a call that threw
 * between the durable insert and either step is FINISHED by its retry, never
 * handed a payment intent over holds still on the cart's deadline. A replay is
 * the same key for the SAME cart: the key reused for a different cart is refused
 * `IDEMPOTENCY_KEY_REUSED` (issue #133), both at the short-circuit and — for a
 * call that raced past it — after the deduped insert, before anything is adopted
 * or stamped.
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
		// Issue #133: a key is a replay only of the request it first carried. The
		// same key aimed at ANOTHER cart (a stale/second tab whose form still holds
		// the old cart's key) is not a replay — returning `already` would report
		// success for an order this cart has nothing to do with. Checked before the
		// state branch: a paid order is no more this cart's than a pending one.
		if (already.cartId !== command.cartId) return { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" };
		if (already.state !== "pending") {
			// Already left the checkout window: nothing to pay for (see the helper).
			// A dead order's coupon use is re-freed here too — the self-heal for a
			// call that died between its expiry flip and its coupon release.
			await healCouponOf(deps, already);
			return leftCheckoutWindow(already, gateway);
		}
		// A `pending` order does NOT prove the checkout finished — finish it first
		// (see `finishCheckout`). The cart flipped is the one the ORDER was made
		// from, never the command's.
		// KNOWN FOLLOW-UP (pre-existing): a cart line edited between the failed call
		// and this replay (qty adjusted on the same hold) is adopted as edited for an
		// order that snapshotted the old lines.
		const finished = await finishCheckout(deps, already, already.cartId, async () => {
			await deps.couponStore.releaseByOrder(already.id);
		});
		if (finished.outcome === "left") return leftCheckoutWindow(finished.order, gateway);
		if (finished.outcome === "lost") return { ok: false, reason: "RESERVATION_LOST" };
		let intent: PaymentIntentHandle;
		try {
			// Same builder as the fresh path below — the replay must describe the SAME
			// goods, byte-for-byte, or the provider's same-key retry is rejected.
			intent = await gateway.createIntent(
				intentInputFor(already, command.idempotencyKey, await recordedCustomer(deps, already)),
			);
		} catch (err) {
			// ONLY a typed intent failure is a clean checkout failure; every other
			// throw is a bug and must keep propagating. The replayed order is
			// untouched — nothing to release, nothing to roll back.
			if (!(err instanceof PaymentIntentError)) throw err;
			logIntentFailure(err, already.id);
			return { ok: false, reason: intentFailureReason(err) };
		}
		await rememberIntent(deps, already, intent);
		return { ok: true, order: already, intent };
	}

	// Validate + normalize the ship-to snapshot (ADR-0009, ADR-0021) BEFORE
	// minting anything: a malformed address must reject the checkout cleanly,
	// never a half-written order. A replay short-circuited above, so this never
	// re-runs for an order that already captured its address — the locked
	// review's retry sends none. The code rules hold for EVERY order, digital
	// ones included; whether an address is REQUIRED is decided below.
	let shippingAddress: OrderAddress | null = null;
	if (command.shippingAddress !== undefined) {
		const normalized = normalizeOrderAddress(command.shippingAddress);
		if (!normalized.ok) {
			return {
				ok: false,
				reason:
					normalized.reason === "REGION_NOT_A_CODE"
						? "SHIPPING_REGION_CODE_REQUIRED"
						: "INVALID_SHIPPING_ADDRESS",
			};
		}
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
		// An unpublished or deleted product is not for sale, even from a cart that
		// held it before the lifecycle event landed. Refused before anything is
		// minted, so the line's hold stays `held` for a remove or the TTL sweep.
		if (pc === null || !isProductLive(pc) || pc.price === null || pc.title === null) {
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
	// engine after the store reads; read-only (no redemption here). The zone is
	// derived from the address inside the quote (ADR-0021), so the review and
	// the order resolve it identically.
	const requiresShipping = lines.some((line) => line.fulfillmentKind === "physical");
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
			requiresShipping,
			...(shippingAddress !== null
				? { destination: { country: shippingAddress.country, region: shippingAddress.region } }
				: {}),
			...(command.shippingMethodId !== undefined ? { methodId: command.shippingMethodId } : {}),
			...(command.couponCode !== undefined ? { couponCode: command.couponCode } : {}),
		},
	);
	if (!quote.ok) return { ok: false, reason: quote.reason };
	const breakdown = quote.breakdown;
	// Completeness is enforced HERE only, never by the read-only quote (a review
	// may be priced before the buyer has chosen) — and before any redemption or
	// mint.
	const zone = quote.destination;
	if (zone.status === "address_needed") return { ok: false, reason: "MISSING_SHIPPING_ADDRESS" };
	// Issue #382: the payment account needs an address on every payment. The
	// address, when given, was already validated whole above (name, line1, city,
	// postal code, ISO country; region by ADR-0021's rules).
	if (command.addressRequired === true && shippingAddress === null) {
		return { ok: false, reason: "MISSING_SHIPPING_ADDRESS" };
	}
	const methodId = command.shippingMethodId ?? "";
	if (zone.status === "matched" && methodId === "") {
		return { ok: false, reason: "SHIPPING_METHOD_REQUIRED" };
	}
	// ADR-0021 Decision 7: what priced the shipping and the tax.
	const shippingMethodSnapshot =
		zone.status === "matched"
			? { zoneId: zone.zoneId, methodId, matchedRegion: zone.matchedRegion }
			: null;

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
	// Whether THIS call's redeem wrote the redemption (vs. replaying an existing
	// same-key one, which belongs to whichever call wrote it first).
	let redemptionFresh = false;
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
		redemptionFresh = !redeemed.replayed;
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
			shippingMethodSnapshot,
			shippingAddress,
			gateway,
			onFailure: async () => {
				if (redemptionId !== null) await deps.couponStore.release(redemptionId);
			},
			onOrderMinted: () => {
				orderMinted = true;
			},
			onForeignOrder: async () => {
				// Only a redemption THIS call wrote is orphaned (it names
				// `freshOrderId`, which was never inserted). A replayed same-key
				// redemption is the winning call's, and its order owns it.
				if (redemptionId !== null && redemptionFresh) {
					await deps.couponStore.release(redemptionId);
				}
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

/** A same-key request still in flight is not a failure (see the reason's doc). */
function intentFailureReason(
	err: PaymentIntentError,
): "PAYMENT_INTENT_FAILED" | "PAYMENT_INTENT_IN_FLIGHT" {
	return err.inFlight ? "PAYMENT_INTENT_IN_FLIGHT" : "PAYMENT_INTENT_FAILED";
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
	console.error(`[domain] createIntent failed → ${intentFailureReason(err)}`, {
		orderId: forOrder,
		gateway: err.gateway,
		retryable: err.retryable,
		providerStatus: err.providerStatus,
		providerCode: err.providerCode,
		inFlight: err.inFlight,
	});
}

interface FinalizeContext {
	freshOrderId: OrderId;
	currency: Currency;
	holdExpiresAt: string;
	lines: CreateOrderLineInput[];
	breakdown: TotalsBreakdown;
	couponRecord: CouponRecord | null;
	/** What priced the shipping and tax (ADR-0021 Decision 7); null when no zone
	 *  matched (no zones configured, or nothing ships). */
	shippingMethodSnapshot: { zoneId: string; methodId: string; matchedRegion: string } | null;
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
	/**
	 * The guarded insert deduped onto an order minted from ANOTHER cart under the
	 * same key (the race twin of the I1 cart check, issue #133). Nothing of this
	 * call's was persisted, so it releases only what this call itself wrote.
	 */
	onForeignOrder: () => Promise<void>;
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
		// The signed-in owner, when the caller resolved one (`checkoutOwner`): the
		// order is in their list from birth rather than after their next sign-in.
		...(command.customerId !== undefined ? { customerId: command.customerId } : {}),
		paymentMethod: command.paymentMethod,
		lines: ctx.lines,
		// ADR-0009: freeze the ship-to snapshot alongside the order, in the same
		// guarded insert. A replay re-inserts nothing (idempotency-key conflict).
		shippingAddress: ctx.shippingAddress,
		// Issue #382: the requirement this checkout was placed under, frozen in the
		// same insert — it also decides the payment's customer for every intent.
		buyerAddressRequired: command.addressRequired === true,
		totals: {
			subtotal: breakdown.subtotalCents,
			total: breakdown.totalCents,
			currency: ctx.currency,
			discount: breakdown.discountCents,
			shipping: breakdown.shippingCents,
			tax: breakdown.taxCents,
			appliedCouponCode: breakdown.appliedCouponCode ?? null,
			shippingMethodSnapshot: ctx.shippingMethodSnapshot,
			taxBreakdown: {
				lines: breakdown.lineBreakdown,
				shippingTaxCents: breakdown.shippingTaxCents,
			},
		},
	});
	// Issue #133, race twin of the I1 cart check: a same-key call for ANOTHER cart
	// that read I1 before the winner's insert landed is deduped HERE onto the
	// winner's order. That order is not this cart's — adopting its holds is
	// harmless but stamping it on THIS cart (step 3) would check out a cart that
	// was never ordered. Refuse before anything moves; the winner owns its order.
	if (order.cartId !== command.cartId) {
		await ctx.onForeignOrder();
		return { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" };
	}
	// The order row is now durable and carries the discounted total: it, not this
	// call frame, owns the coupon redemption from here on.
	ctx.onOrderMinted();

	// 2 + 3. Adopt the holds, then flip the cart — the steps a same-key replay
	//    re-runs when a call threw between them (see `finishCheckout`).
	const finished = await finishCheckout(deps, order, command.cartId, ctx.onFailure);
	if (finished.outcome === "left") return leftCheckoutWindow(finished.order, ctx.gateway);
	if (finished.outcome === "lost") return { ok: false, reason: "RESERVATION_LOST" };

	// 4. Begin payment; hand the buyer-facing next-action back to the caller.
	const intentInput = intentInputFor(order, command.idempotencyKey);
	//    A live gateway can FAIL here (Stripe down / rejecting). Catch ONLY the
	//    typed PaymentIntentError — any other throw is a bug and propagates. The
	//    inserted `pending` order, its adopted reservations and its coupon
	//    redemption all STAY: `expireOrders` sweeps them at TTL, and a same-key
	//    retry returns this order and re-issues the intent (the provider's native
	//    idempotency key makes that the SAME intent, never a duplicate charge).
	//    `onFailure` is deliberately NOT called (see the DELIBERATE ASYMMETRY note
	//    in `finishCheckout`'s lost-hold branch).
	try {
		const intent = await ctx.gateway.createIntent(intentInput);
		await rememberIntent(deps, order, intent);
		return { ok: true, order, intent };
	} catch (err) {
		if (!(err instanceof PaymentIntentError)) throw err;
		logIntentFailure(err, order.id);
		return { ok: false, reason: intentFailureReason(err) };
	}
}

/**
 * The post-insert steps of a checkout — adopt every physical hold, then flip the
 * cart — shared VERBATIM by the fresh path and the I1 replay of a `pending`
 * order, because a call can throw between the durable insert and either step and
 * the client's same-key retry must finish what it never reached. Both steps are
 * idempotent for the same order, so re-running them after a completed checkout
 * is a no-op.
 *
 * Three outcomes:
 *  - `finished` — every hold adopted for a still-`pending` order, cart flipped.
 *  - `left` — the order left `pending` underneath this call (a settle, the
 *    expiry sweep, a cancel, a concurrent same-key call's lost-hold flip).
 *    Whatever this call adopted for an order that no longer claims its holds is
 *    released again, an `expired` / `failed` order's coupon use is re-freed
 *    (idempotent; never for `cancelled` or `paid`), and no intent is minted. The
 *    cart is not stamped — unless the flip landed after the stamp, which the
 *    final re-check before returning `finished` catches.
 *  - `lost` — a hold is gone, so the order can never be paid. It is abandoned AT
 *    ONCE, exactly as the expiry sweep would abandon it (`pending → expired`,
 *    coupon use freed, then adopted holds released): the storefront's checkout
 *    key is fixed per cart, so an order left `pending` here would answer every
 *    later place from that cart RESERVATION_LOST until the sweep ran. Expired,
 *    the replay answers it as an order that has left the checkout window.
 *
 * Two concurrent same-key calls that both see the lost hold get different
 * answers — the flip winner RESERVATION_LOST, the loser `ok` with the expired
 * order and an empty, no-intent handle — and both are safe: neither can pay.
 *
 * `cartId` is the cart the order was made from (`null` only for an order with no
 * cart, which has nothing to fence). `releaseCoupon` is the caller's eager coupon
 * release on RESERVATION_LOST (the fresh path knows its redemption id; the replay
 * releases order-scoped).
 */
async function finishCheckout(
	deps: CreateOrderDeps,
	order: Order,
	cartId: string | null,
	releaseCoupon: () => Promise<void>,
): Promise<FinishOutcome> {
	// 2. Adopt every physical line's reservation in ONE batched held → adopted flip
	//    (PR B — checkout-write batching), collected from the persisted order lines
	//    so a replay re-issues idempotently. Digital lines carry no reservation.
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

	// Re-read the order AFTER the adoption. The order may have left `pending`
	// between the caller's read and `adoptMany`: a settle (which flips `→ paid`
	// before it commits, so a hold it spent reads `lost` here), or an expiry /
	// cancel whose own `releaseAdopted` ran while the holds were still cart-`held`
	// — a no-op — so this call's adoption just claimed them for a dead order.
	// Only this call can undo that. Reading after the adopt is what closes the
	// window: any flip that preceded the adopt is visible here, and any flip after
	// it releases the (by then adopted) holds itself.
	const current = await deps.orderStore.getById(order.id);
	if (current !== null && current.state !== "pending") return leftPending(deps, current);

	if (result.lost.length > 0) {
		// Abandon the order now — the expiry sweep's own guarded flip, early, and
		// without its email (the buyer is being told synchronously). Losing it means
		// the order left `pending` after the read above: answered the same way.
		const flip = await deps.orderStore.transition({
			orderId: order.id,
			fromState: "pending",
			toState: "expired",
			idempotencyKey: order.idempotencyKey,
			enqueueEmail: false,
		});
		if (!flip.transitioned) {
			const moved = flip.order ?? (await deps.orderStore.getById(order.id));
			if (moved !== null && moved.state !== "pending") return leftPending(deps, moved);
		}
		// DELIBERATE ASYMMETRY with PAYMENT_INTENT_FAILED (the callers): recovery from a
		// lost hold is a NEW cart with a NEW key (this order can never be paid), so
		// the use must be freed immediately; an intent failure recovers by REPLAYING
		// the same key against this very order, which must keep its discount.
		// The coupon goes FIRST, before the holds: nothing else will ever free it
		// once the order is `expired` (`expireOrders` lists only `pending` orders),
		// so a throw in the hold release (a contended hot SKU) must not strand it.
		// A crash between the flip and this line is healed by the next same-key call
		// (`healCouponOf`).
		await releaseCoupon();
		await releaseAdoptedHolds(deps, order);
		return { outcome: "lost" };
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
	//    flip). Note the stamp lands here, BEFORE `gateway.createIntent()`, so a
	//    stamped cart proves only "this cart became that order", never that the
	//    order was paid. And because a call can die between the order insert and
	//    this line (healed only when the same key is replayed), a NULL `orderId`
	//    does NOT prove no order exists — see the port's JSDoc; `orders.cart_id`
	//    is the complete answer.
	if (cartId !== null) await deps.cartStore.checkout(cartId, order.id);

	// 4. Re-check, immediately before the caller mints the intent. A concurrent
	//    same-key call whose (later) `now` classed a hold lost can win the
	//    pending → expired flip AFTER the re-read above — this call adopted with an
	//    older `now`. Its own release covers the holds; what this call must not do
	//    is hand the buyer a payable intent for the order it just expired. (The
	//    cart stamp above stays: it records only "this cart became that order".)
	const beforeIntent = await deps.orderStore.getById(order.id);
	if (beforeIntent !== null && beforeIntent.state !== "pending") {
		return leftPending(deps, beforeIntent);
	}

	return { outcome: "finished" };
}

/**
 * The states in which an order no longer claims its holds — the ones whose own
 * transition released (or never adopted) them. `paid` and its successors are
 * absent on purpose: a paid order's adopted holds are about to be COMMITTED by
 * the settle that flipped it, and releasing them would put spent units back on
 * sale.
 */
const RELEASES_HOLDS: ReadonlySet<Order["state"]> = new Set(["expired", "cancelled", "failed"]);

/** The `left` outcome, undoing whatever this call adopted for a dead order. */
async function leftPending(deps: CreateOrderDeps, current: Order): Promise<FinishOutcome> {
	await healCouponOf(deps, current);
	if (RELEASES_HOLDS.has(current.state)) await releaseAdoptedHolds(deps, current);
	return { outcome: "left", order: current };
}

/**
 * The states whose own transition frees the coupon use (`expireOrders`, a failed
 * settle, a lost-hold abandonment). `cancelled` is absent on purpose —
 * `cancelOrder` deliberately keeps the use — and so is `paid`, which consumed it.
 */
const RELEASES_COUPON: ReadonlySet<Order["state"]> = new Set(["expired", "failed"]);

/**
 * Re-free the coupon use of an order observed `expired` / `failed`. Order-scoped
 * and idempotent (a no-op once released), so every call that sees such an order
 * runs it: it is what heals a call that died between its `pending → expired`
 * flip and its coupon release — nothing else ever looks at that order again.
 */
async function healCouponOf(deps: CreateOrderDeps, order: Order): Promise<void> {
	if (RELEASES_COUPON.has(order.state)) await deps.couponStore.releaseByOrder(order.id);
}

/** `expireOrders`' release, verbatim: order-scoped, a no-op for any hold this
 *  order does not hold `adopted`, so it is safe to run twice. */
async function releaseAdoptedHolds(deps: CreateOrderDeps, order: Order): Promise<void> {
	for (const line of order.lines) {
		if (line.reservationId !== null) {
			await deps.inventoryStore.releaseAdopted(line.reservationId, order.id);
		}
	}
}

/**
 * What {@link finishCheckout} decided: every step done; a hold lost (order
 * expired, holds and coupon already released); or the order LEFT `pending`
 * underneath it (paid / expired / cancelled concurrently), carried as re-read.
 */
type FinishOutcome =
	| { outcome: "finished" }
	| { outcome: "lost" }
	| { outcome: "left"; order: Order };

/**
 * The answer for an order that has already left the checkout window — paid,
 * failed, expired or cancelled. There is nothing left to begin paying for, so
 * re-issuing an intent would be a pointless LIVE provider call whose outage could
 * turn a replay of a PAID order into a 502. The order comes back with an
 * explicitly EMPTY handle: `clientAction: "none"` (no buyer-facing next action)
 * and an empty `intentId` — this call minted no intent, and the original intent
 * id is not on the order (it lives on `payments.provider_ref`; a caller that
 * needs it reads the order's payments, never this field). The wire shape is
 * unchanged (`serializeIntent` still emits gateway/intentId/clientAction).
 */
function leftCheckoutWindow(order: Order, gateway: PaymentGateway): CreateOrderFromCartResult {
	return {
		ok: true,
		order,
		intent: { gateway: gateway.id, intentId: "", clientAction: { kind: "none" } },
	};
}

/**
 * Record the intent the gateway just minted against its order, so the expiry
 * sweep (and an unpaid cancel) can withdraw it later — the checkout reply and the
 * buyer's pay-page cookie are otherwise the only places its id ever lives.
 *
 * Runs on the fresh path AND the replay, because a call can die between the
 * gateway answering and this write; the store dedupes on `(orderId, intentId)`,
 * so the replay that re-issues the SAME intent records nothing new.
 *
 * BEST-EFFORT: a failed write is logged and the checkout still succeeds. The
 * buyer already holds a payable intent at this point — failing the checkout over
 * bookkeeping would not un-mint it, it would only send them to retry the same
 * key. An intent this misses is not cancelled at expiry, and a payment on it
 * takes `settleOrder`'s late-payment refund path: prevention narrows, the refund
 * guarantees. An empty id (no intent was minted) is skipped.
 */
async function rememberIntent(
	deps: CreateOrderDeps,
	order: Order,
	intent: PaymentIntentHandle,
): Promise<void> {
	if (intent.intentId.length === 0) return;
	try {
		await deps.orderStore.recordPaymentIntent({
			orderId: order.id,
			gateway: intent.gateway,
			intentId: intent.intentId,
			...(intent.customerRef !== undefined ? { customerRef: intent.customerRef } : {}),
		});
	} catch (err) {
		console.error(
			`[domain] could not record payment intent ${intent.intentId} for order ${order.id}; it will not be cancelled if the order expires`,
			{ error: err instanceof Error ? err.message : String(err) },
		);
	}
}

/**
 * The provider-side customer decision this order's earliest recorded intent
 * kept (issue #382), for a REPLAY to hand back to the gateway — so the gateway
 * decides it once per order and every same-key request it makes afterwards is
 * byte-identical. `undefined` when no recorded intent carries one (none yet, an
 * order from before decisions were recorded, another gateway): the gateway then
 * behaves exactly as it always did. A failed read THROWS — the checkout fails
 * with that error, and the buyer's same-key retry asks again — rather than
 * reading as "none": guessing could change the request Stripe already holds
 * under this key, which it refuses for good.
 */
async function recordedCustomer(
	deps: CreateOrderDeps,
	order: Order,
): Promise<string | null | undefined> {
	const intents = await deps.orderStore.listPaymentIntents(order.id);
	return intents.find((intent) => intent.customerRef !== undefined)?.customerRef;
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
function intentInputFor(
	order: Order,
	key: IdempotencyKey,
	customerRef?: string | null,
): CreateIntentInput {
	const address = order.shippingAddress;
	return {
		...(customerRef !== undefined ? { customerRef } : {}),
		// Issue #382: the order decides whether its payment carries a customer —
		// the same answer for every intent of it. Absent on older orders.
		...(order.buyerAddressRequired !== undefined
			? { customerRequired: order.buyerAddressRequired && address !== null }
			: {}),
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
