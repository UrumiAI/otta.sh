import { idempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { ConfirmationResult } from "../ports/payment-gateway.js";
import type { EntitlementStore } from "../ports/entitlement-store.js";
import type { InventoryStore } from "../ports/inventory-store.js";
import type { OrderStore } from "../ports/order-store.js";
import type { PaymentEventStore } from "../ports/payment-event-store.js";
import type { PaymentGateway, RawConfirmation } from "../ports/payment-gateway.js";
import type { SettleFailure } from "./errors.js";
import { isUnpaidTerminalState, refundLatePayment } from "./late-payment.js";
import type { Order } from "./model.js";

export interface SettleDeps {
	orderStore: OrderStore;
	entitlementStore: EntitlementStore;
	paymentEventStore: PaymentEventStore;
	inventoryStore: InventoryStore;
	clock: Clock;
}

export type SettleResult =
	| { ok: true; order: Order | null; noop: boolean }
	| { ok: false; reason: SettleFailure };

/** The success-side of a verified confirmation, after narrowing. */
type VerifiedSuccess = Extract<ConfirmationResult, { ok: true }>;

/**
 * The gateway-agnostic settlement use-case (§5): **verify → dedupe → transition →
 * commit-or-grant**. Every gateway's verified confirmation
 * converges here.
 *
 * 1. `gateway.verifyConfirmation(raw)` — a reject (bad signature / unknown /
 *    malformed) is a typed failure (HTTP 400). All crypto is adapter-side.
 * 2. Record the delivery in `payment_events` (UNIQUE `dedupeKey` — the audit
 *    trail). **A duplicate OF THE SAME ORDER does NOT short-circuit**: every
 *    delivery re-DRIVES the
 *    idempotent, state-guarded steps below, so a crash between any two of them
 *    (dedupe→flip, flip→commit/grant) is healed by the next gateway retry — the
 *    Phase-3 claim/resume idiom. "Settles once" is enforced by the guarded
 *    `pending → paid` flip, the `provider_ref`-keyed payment record, the
 *    state-guarded `commit`, and the grant-once entitlement key — never by
 *    blind-trusting the dedupe row.
 * 2b. A duplicate whose recorded row names a **different** order is the opposite
 *    case and is TERMINAL (`RECEIPT_REBOUND` + anomaly, nothing moved): one
 *    settlement consumes one payment. This is the receipt binding:
 *    a confirmation's order id is the caller's claim, so the amount equality in
 *    step 3 is not on its own enough to stop one receipt from settling a
 *    second, same-priced order. A duplicate whose bound order cannot be read
 *    back is refused the same way (fail closed, #448): only a PROVEN same-order
 *    binding re-drives.
 * 3. Amount + currency MUST equal `order_totals.total` — mismatch ⇒ reject +
 *    record anomaly (§9 Risk 3); no auto-refund. Checked only while the order
 *    can still settle: a terminal order short-circuits FIRST (review G6), so a
 *    stray mismatched duplicate on an already-paid order is never a false
 *    `AMOUNT_MISMATCH`. It moves nothing, but stays in the forensic trail as the
 *    low-severity `PAID_AMOUNT_MISMATCH` anomaly, once per gateway event (#35);
 *    when it names a payment the order never captured (a double charge) the
 *    order is also flagged for manual reconciliation — and so is a stray at the
 *    RIGHT amount under a payment the order never captured (#540).
 * 4. Guarded `pending → paid`; record the `payments` row; per line: physical ⇒
 *    `commit(reservationId)` (a lost adopted hold is the loud 0-row anomaly, §5);
 *    digital ⇒ grant entitlement (grant-once). An already-`paid` order re-drives
 *    the side-effects idempotently and no-ops.
 * 5. **Losing the `pending → paid` flip mid-flight** (an expiry/cancellation raced the
 *    settle between load and flip) is exactly as LOUD as finding the order
 *    already terminal: `PAID_FLIP_LOST` anomaly + manual-reconciliation flag —
 *    money was captured while stock was released; never a silent no-op.
 * 6. **A late payment is refunded automatically** (`refundLatePayment`). On a
 *    dead order (`expired`/`cancelled`/`failed`) the capture is ALWAYS recorded on
 *    the payments ledger, so nothing downstream can claim "nothing was charged".
 *    When the order provably left `pending` unpaid (for `cancelled`, its audit
 *    holds the `pending → cancelled` flip) and the gateway can refund, the payment
 *    is refunded once under a key derived from it, the flag resolved and the buyer
 *    notified — instead of sitting in the reconciliation queue while the buyer is
 *    out of pocket. A gateway that cannot refund (Stripe with no secret key),
 *    or an order with no such evidence, keeps the manual flag above. A TRANSIENT
 *    refund failure answers `LATE_PAYMENT_REFUND_RETRYABLE` so the provider
 *    redelivers, and schedules a sweep retry (`retryLatePaymentRefunds`) for when
 *    it stops. *
 * A verified `failed` event (`payment_intent.payment_failed`) is INFORMATIONAL
 * (ADR-0022): it is recorded by step 2 — deduped, bound to its order, auditable —
 * and changes nothing else. The order stays `pending` with its stock held and its
 * coupon consumed, because the PaymentIntent is still payable after a decline and
 * the pay page retries on it; failing the order here is what turned a decline
 * followed by a successful retry into `PAID_FLIP_LOST`. If the buyer pays, the
 * `succeeded` event settles it normally; if nobody does, the order-expiry sweep
 * (`expireOrders`) releases the stock and the coupon when the hold lapses.
 */
export async function settleOrder(
	deps: SettleDeps,
	gateway: PaymentGateway,
	raw: RawConfirmation,
): Promise<SettleResult> {
	const conf = await gateway.verifyConfirmation(raw);
	if (!conf.ok) return { ok: false, reason: conf.reason };

	const now = deps.clock.now().toISOString();

	// 2. Record the delivery (UNIQUE dedupe_key = the audit row). A duplicate of
	// THIS order is deliberately NOT a short-circuit — see the function doc:
	// replays re-drive by state. A duplicate naming a DIFFERENT order is not a
	// replay at all, and is terminally refused here (step 2b).
	const claimed = await deps.paymentEventStore.dedupe(
		conf.dedupeKey,
		conf.orderId,
		conf.gateway,
		now,
	);

	// 2b. THE RECEIPT BINDING, enforced rather than assumed. The dedupe key names
	// one payment, and the order id a confirmation carries is only the caller's
	// claim — so without this, a receipt already bound to order A,
	// resubmitted naming a same-priced order B, would sail past the amount check
	// and settle B off one payment. (`recordPayment`'s globally-unique
	// `provider_ref` then silently swallows the second ledger row, so the second
	// settle would not even be visible in the ledger.) The lookup runs ONLY on the
	// duplicate arm: a first delivery costs exactly what it always did.
	//
	// FAIL CLOSED (#448): a duplicate whose bound order cannot be read back has an
	// UNPROVEN binding, and only a proven same-order binding may re-drive. So a
	// missing read-back is refused exactly like a rebind — never waved through as
	// "probably the same order". No adapter deletes a dedupe row, so this arm is a
	// store inconsistency, and it is recorded as loudly as one. If a retention
	// purge of payment events is ever added, this arm becomes reachable: switch
	// then to `dedupe` returning the bound order atomically (or answer a
	// retryable 503) rather than refusing a legitimate redelivery here.
	if (!claimed) {
		const boundTo = await deps.paymentEventStore.orderForDedupeKey(conf.dedupeKey);
		if (boundTo !== conf.orderId) {
			// The attempt is the alert-worthy fact, so it is recorded against the
			// order it was AIMED at. The detail names the order that legitimately owns
			// the receipt; neither is a credential.
			await deps.paymentEventStore.recordAnomaly({
				orderId: conf.orderId,
				gateway: conf.gateway,
				kind: "RECEIPT_REBOUND",
				detail:
					boundTo === null
						? "confirmation dedupe key is already recorded, but its bound order could not be read back"
						: `confirmation dedupe key is already recorded against order ${boundTo}`,
				now,
			});
			return { ok: false, reason: "RECEIPT_REBOUND" };
		}
	}

	const order = await deps.orderStore.getById(conf.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	// A verified FAILURE event (a declined attempt) is recorded above and moves
	// nothing: no state flip, no stock or coupon release, whatever state the order
	// is in (ADR-0022). A pending order stays payable on the same PaymentIntent; a
	// late decline on a paid or expired order is equally inert. Checked BEFORE the
	// terminal short-circuits below, so a decline can never raise an anomaly.
	if (conf.outcome === "failed") {
		return { ok: true, order, noop: true };
	}

	// Already paid (webhook-before-redirect, duplicate delivery, or a retry after
	// a crash between the flip and its side-effects) — the terminal-state
	// short-circuit runs BEFORE the amount check (review G6): a stray verified
	// duplicate with a mismatched amount on a correctly-settled order must not
	// record a false AMOUNT_MISMATCH anomaly. RE-DRIVE the side-effects — each is
	// idempotent (provider_ref-keyed payment record, state-guarded commit,
	// grant-once entitlement) — only when the amounts MATCH and the event names
	// the payment this order captured, or the order has captured none yet (the
	// crash-window heal is always a redelivery of the original, matching event; a
	// wrong-amount stray re-drives nothing) — then no-op.
	//
	// A wrong-amount stray is still a fact worth keeping (#35): it is recorded as
	// the LOW-SEVERITY `PAID_AMOUNT_MISMATCH`, with no state move. The row is
	// gated on `claimed`, the event's own once-only: a redelivery of the same
	// event arrives at a later instant, so the anomaly store's field-digest
	// idempotency would not collapse it, but the dedupe claim does. The cost: ANY
	// failure between the claim and this write — a crash, or `recordAnomaly`
	// itself throwing, answering 5xx so the gateway redelivers with
	// `claimed === false` — loses that one informational row. Nothing about the
	// order or the money depends on it.
	//
	// It stays informational ONLY while the stray names the payment this order
	// already captured. A `providerRef` the ledger does not hold means a SECOND
	// payment really succeeded against a paid order — a double charge, possible
	// once the gateway's idempotency window on the intent has lapsed — so the
	// order is also flagged for manual reconciliation, the operator alert. That
	// flag is gated on the order being unflagged, not on `claimed`, so a failure
	// before it is healed by the redelivery; the compare-and-set never overwrites
	// a flag written since `order` was read (#364).
	//
	// A MATCHING amount under a payment the order never captured is the same
	// double charge (#540) — the usual shape, since a retried checkout mints its
	// second intent at the order's own price. It gets the same anomaly (once per
	// event) and flag, and does not re-drive the side-effects. Unlike the
	// wrong-amount stray, it IS recorded on the payments ledger: it is real money
	// held against this order at its own price, and a refund can only target a
	// payment the ledger holds (`refundOrder`'s `providerRef`). The ceiling stays
	// `min(Σ captured, total)`, so the row adds no refund capacity. The row is
	// written after the flag, because a redelivery treats a recorded ref as known.
	if (order.state === "paid") {
		const amountMatches =
			conf.amount === order.totals.total && conf.currency === order.totals.currency;
		const captured = await deps.orderStore.getCapturedPayments(order.id);
		const knownPayment = captured.some((p) => p.providerRef === conf.providerRef);
		if (amountMatches && (knownPayment || captured.length === 0)) {
			// The order's own payment (or, with nothing captured yet, the crash
			// between the flip and its payment row): the idempotent re-drive.
			await applyPaidSideEffects(deps, conf, order, now);
		} else if (amountMatches) {
			// The order's price, under a payment it never captured: a second
			// PaymentIntent succeeded — a double charge (#540). Same alert as the
			// wrong-amount one below; the paid side-effects are NOT re-run for it.
			if (claimed) {
				await deps.paymentEventStore.recordAnomaly({
					orderId: order.id,
					gateway: conf.gateway,
					kind: "PAID_AMOUNT_MISMATCH",
					detail: `verified success for the order total (${String(conf.amount)} ${conf.currency}) on already-paid order under payment ${conf.providerRef}, which is not this order's captured payment — possible double charge (event ${conf.dedupeKey})`,
					now,
				});
			}
			if (order.reconciliationFlag === null) {
				await deps.orderStore.flagReconciliation(
					order.id,
					`possible double charge: second payment ${conf.providerRef} captured on paid order`,
					{ expectedFlag: null },
				);
			}
			// Recorded LAST: a recorded ref reads as known on a redelivery, so a crash
			// before the flag would otherwise leave the double charge unflagged.
			await deps.orderStore.recordPayment({
				orderId: order.id,
				gateway: conf.gateway,
				providerRef: conf.providerRef,
				amount: conf.amount,
				currency: conf.currency,
				status: "succeeded",
			});
		} else {
			if (claimed) {
				await deps.paymentEventStore.recordAnomaly({
					orderId: order.id,
					gateway: conf.gateway,
					kind: "PAID_AMOUNT_MISMATCH",
					detail:
						`verified success on already-paid order: got ${String(conf.amount)} ${conf.currency}, expected ${String(order.totals.total)} ${order.totals.currency} (event ${conf.dedupeKey})` +
						(knownPayment
							? ""
							: `; payment ${conf.providerRef} is not this order's captured payment — possible double charge`),
					now,
				});
			}
			if (!knownPayment && order.reconciliationFlag === null) {
				await deps.orderStore.flagReconciliation(
					order.id,
					`possible double charge: unrecorded payment ${conf.providerRef} on paid order`,
					{ expectedFlag: null },
				);
			}
		}
		const fresh = await deps.orderStore.getById(order.id);
		return { ok: true, order: fresh, noop: true };
	}

	// Terminal non-paid + a verified success: money moved but cannot settle.
	// Also ahead of the amount check (G6): SETTLE_ON_NON_PENDING is the right
	// signal for a terminal order, whatever amount the stray event carries.
	if (order.state !== "pending") {
		// 6. A LATE payment on a never-paid dead order is refunded automatically
		// (see the function doc). Everything else it declines keeps the manual path.
		const late = await refundLatePayment(
			deps,
			gateway,
			conf,
			order,
			{
				kind: "SETTLE_ON_NON_PENDING",
				detail: `verified success on order in state=${order.state}`,
			},
			now,
		);
		if (late === "retryable") return { ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" };
		// Anomaly + manual reconciliation. Gated on the flag so a gateway's retry
		// storm records the incident once, not once per delivery.
		if (late === "ineligible" && order.reconciliationFlag === null) {
			await deps.paymentEventStore.recordAnomaly({
				orderId: order.id,
				gateway: conf.gateway,
				kind: "SETTLE_ON_NON_PENDING",
				detail: `verified success on order in state=${order.state}`,
				now,
			});
			// `order` was read at the start: never over a flag written since (#364).
			await deps.orderStore.flagReconciliation(order.id, `settle on ${order.state}`, {
				expectedFlag: null,
			});
		}
		const fresh = await deps.orderStore.getById(order.id);
		return { ok: true, order: fresh, noop: true };
	}

	// 3. Amount + currency must equal the order-total snapshot — checked on every
	// drive that can still settle (the order is pending here; a crash-window
	// resume of a paid order is re-driven above, gated on the same equality).
	if (conf.amount !== order.totals.total || conf.currency !== order.totals.currency) {
		await deps.paymentEventStore.recordAnomaly({
			orderId: order.id,
			gateway: conf.gateway,
			kind: "AMOUNT_MISMATCH",
			detail: `got ${String(conf.amount)} ${conf.currency}, expected ${String(order.totals.total)} ${order.totals.currency}`,
			now,
		});
		return { ok: false, reason: "AMOUNT_MISMATCH" };
	}

	// 4. Guarded pending → paid.
	const won = await deps.orderStore.markPaid(order.id);
	if (!won) {
		const fresh = await deps.orderStore.getById(order.id);
		if (fresh !== null && fresh.state === "paid") {
			// A concurrent settle won the flip: re-drive the side-effects
			// idempotently (heals its crash windows too), then no-op.
			await applyPaidSideEffects(deps, conf, fresh, now);
			return { ok: true, order: await deps.orderStore.getById(order.id), noop: true };
		}
		// F1: a verified, amount-checked success LOST the flip to a mid-flight
		// expiry/cancellation — the customer was charged while the stock was released.
		// Exactly as loud as the already-terminal-at-load case above.
		const lostTo = fresh?.state ?? "missing";
		const detail = `verified success lost the pending→paid flip; order is now state=${lostTo}`;
		// 6. The order the flip was lost to is, almost always, an expiry — a late
		// payment by any other name. Refund it the same way, under the loud
		// PAID_FLIP_LOST anomaly rather than a quieter one.
		if (fresh !== null && isUnpaidTerminalState(fresh.state)) {
			const late = await refundLatePayment(
				deps,
				gateway,
				conf,
				fresh,
				{ kind: "PAID_FLIP_LOST", detail },
				now,
			);
			if (late === "retryable") return { ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" };
			if (late !== "ineligible") {
				return { ok: true, order: await deps.orderStore.getById(order.id), noop: true };
			}
		}
		if (fresh === null || fresh.reconciliationFlag === null) {
			await deps.paymentEventStore.recordAnomaly({
				orderId: order.id,
				gateway: conf.gateway,
				kind: "PAID_FLIP_LOST",
				detail,
				now,
			});
			await deps.orderStore.flagReconciliation(
				order.id,
				`lost pending→paid flip to state=${lostTo}`,
				{ expectedFlag: null },
			);
		}
		return { ok: true, order: await deps.orderStore.getById(order.id), noop: true };
	}

	await applyPaidSideEffects(deps, conf, order, now);
	const finalOrder = await deps.orderStore.getById(order.id);
	return { ok: true, order: finalOrder, noop: false };
}

/**
 * The paid-order side-effects, each individually idempotent so the whole block
 * can be re-driven by any retry (crash-window healing):
 *  - `payments` record — keyed on `provider_ref` (INSERT … ON CONFLICT DO NOTHING);
 *  - physical lines — state-guarded `commit` (already-`committed` is a benign
 *    no-op; a LOST hold throws → loud `COMMIT_LOST` anomaly + reconciliation
 *    flag, gated on the flag so a retry storm records the incident once);
 *  - digital lines — grant-once entitlement (`ent:{order}:{sku}` UNIQUE key).
 */
async function applyPaidSideEffects(
	deps: SettleDeps,
	conf: VerifiedSuccess,
	order: Order,
	now: string,
): Promise<void> {
	await deps.orderStore.recordPayment({
		orderId: order.id,
		gateway: conf.gateway,
		providerRef: conf.providerRef,
		amount: conf.amount,
		currency: conf.currency,
		status: "succeeded",
	});

	// Physical lines: ONE batched held|adopted → committed flip (PR B). Each LOST
	// hold in the result is a resold-under-a-paid-order invariant violation — the
	// loud COMMIT_LOST anomaly + manual-reconciliation flag, NEVER a silent no-op.
	// Recorded once PER lost line, each gated on the SAME stale reconciliationFlag
	// read off the `order` loaded once (never re-read in the loop): N lost lines ⇒
	// N anomalies. The flag write is a compare-and-set on "still unflagged" (issue
	// #364), so the FIRST lost reservation's flag lands and the later ones' are
	// refused — every lost line is still in the anomalies.
	const physicalReservationIds = order.lines
		.filter((line) => line.fulfillmentKind === "physical" && line.reservationId !== null)
		.map((line) => line.reservationId)
		.filter((id): id is NonNullable<typeof id> => id !== null);
	const { lost } = await deps.inventoryStore.commitMany(physicalReservationIds);
	for (const reservationId of lost) {
		if (order.reconciliationFlag === null) {
			await deps.paymentEventStore.recordAnomaly({
				orderId: order.id,
				gateway: conf.gateway,
				kind: "COMMIT_LOST",
				detail: `commit matched 0 rows for reservation ${reservationId}`,
				now,
			});
			// Compare-and-set on "still unflagged": `order` was read before the
			// commit, and a flag written since is never overwritten (issue #364).
			await deps.orderStore.flagReconciliation(
				order.id,
				`commit lost for reservation ${reservationId}`,
				{ expectedFlag: null },
			);
		}
	}

	// Digital lines: grant-once entitlement, per-line and UNCHANGED (disjoint
	// state, idempotent under the deterministic (order, sku) grant key).
	for (const line of order.lines) {
		if (line.fulfillmentKind === "digital") {
			await deps.entitlementStore.grant({
				orderId: order.id,
				productId: line.productId,
				sku: line.sku,
				buyerRef: order.buyerRef,
				source: "order_paid",
				// Deterministic grant-once key per (order, sku): replay grants nothing.
				grantIdempotencyKey: idempotencyKey(`ent:${order.id}:${line.sku}`),
			});
		}
	}
}
