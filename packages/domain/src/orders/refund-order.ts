import type { Cents, Currency } from "../money/cents.js";
import { cents } from "../money/cents.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { CapturedPayment, OrderStore, RefundRecord } from "../ports/order-store.js";
import type { PaymentEventStore } from "../ports/payment-event-store.js";
import type { PaymentGateway } from "../ports/payment-gateway.js";
import type { Order } from "./model.js";

export interface RefundOrderDeps {
	orderStore: OrderStore;
	/** The loud-anomaly seam (PAID_FLIP_LOST precedent) for the
	 *  impossible-by-construction "issued but unrecorded" residual — when present,
	 *  that residual records a `REFUND_UNRECORDED` anomaly carrying the provider
	 *  refundRef alongside the always-set reconciliation flag. Optional so pure
	 *  ledger tests need not wire it; the service always does. */
	paymentEventStore?: PaymentEventStore;
	/** Timestamp source for the anomaly record; used only with
	 *  `paymentEventStore`. */
	clock?: Clock;
}

export interface RefundOrderCommand {
	orderId: OrderId;
	/** The amount to refund (integer minor units) — must be positive and in the
	 *  order's currency. */
	amount: Cents;
	currency: Currency;
	/** Optional free-text reason — trimmed; a blank/absent value normalizes to
	 *  null (like `cancelOrder`'s optional `detail`). */
	reason?: string | null;
	/** Who issued/recorded it — trimmed + required non-empty (mirrors an order
	 *  note's `author`; the domain does not model admin identity). */
	refundedBy: string;
	/** Every command carries one (CLAUDE.md); the ledger enforces once-only AND
	 *  (for a gateway refund) it is Stripe's native `Idempotency-Key`. */
	idempotencyKey: IdempotencyKey;
}

export type RefundOrderFailure =
	| "ORDER_NOT_FOUND"
	| "EMPTY_REFUNDED_BY"
	/** `amount` was not a positive minor-unit value. */
	| "INVALID_AMOUNT"
	/** The refund currency does not match the order's currency. */
	| "CURRENCY_MISMATCH"
	/** A gateway refund was requested but no captured payment exists to refund
	 *  against (an unpaid order, or a settlement that recorded no `succeeded`
	 *  payment for this gateway). */
	| "NO_CAPTURED_PAYMENT"
	/** `Σ active refunds + amount` would exceed what we actually captured — the
	 *  ceiling binds at `Σ captured` (a short-capture order, `settle-order.ts`
	 *  anomaly). Rejected at RESERVATION time — before any gateway call. */
	| "REFUND_EXCEEDS_CAPTURED"
	/** `Σ active refunds + amount` would exceed the frozen `order_totals.total`.
	 *  Rejected at RESERVATION time — before any gateway call. */
	| "REFUND_EXCEEDS_TOTAL"
	/** The Stripe refund-time pre-flight found provider-side refunds already
	 *  diverge from our view (or this refund would over-refund at the provider):
	 *  NOTHING was issued; the reservation is voided (capacity released) —
	 *  reconcile before retrying. */
	| "PROVIDER_ALREADY_REFUNDED"
	/** A transient transport failure before issuance is confirmed — the
	 *  reservation is KEPT, so a retry with the SAME idempotency key resumes it
	 *  (and Stripe's native key dedupes provider-side). */
	| "GATEWAY_RETRYABLE"
	/** A definite provider rejection — the reservation is voided (capacity
	 *  released); retrying the same request will not help. */
	| "GATEWAY_TERMINAL"
	/** The ambiguous timeout — `refunds.create` errored with an unknown fate.
	 *  The reservation is marked UNVERIFIED and KEEPS holding ceiling capacity
	 *  (the safe direction). Do NOT blind-retry; re-check the provider first. */
	| "GATEWAY_UNVERIFIED"
	/** The gateway declared itself unable to refund at the moment of the call
	 *  (a defensive mapping — the use-case already branches on `refundable`, so a
	 *  well-behaved gateway never reaches here). The reservation is voided. */
	| "REFUND_NOT_SUPPORTED"
	/** The LOUD residual (impossible by construction under reserve-before-issue):
	 *  the gateway confirmed issuance but the reserved ledger row could not be
	 *  finalized. The provider refundRef is recorded as a `REFUND_UNRECORDED`
	 *  anomaly + a reconciliation flag — never silently dropped — and this
	 *  DISTINCT reason (its own 409 at the service) is returned so it can never
	 *  be mistaken for a clean pre-issuance rejection. */
	| "REFUND_ISSUED_UNRECORDED";

export type RefundOrderOutcome =
	| {
			ok: true;
			/** True iff a NEW ledger row was written; false ⇒ an idempotent replay
			 *  (`duplicate`), returning the existing refund. */
			recorded: boolean;
			duplicate: boolean;
			/** True iff the FINALIZED `Σ` reached the ceiling and the order flipped
			 *  `→ refunded`. */
			fullyRefunded: boolean;
			refund: RefundRecord;
			order: Order;
	  }
	| { ok: false; reason: RefundOrderFailure };

/** `Σ captured` — the succeeded `payments` amounts (ADR-0008). */
export function sumCapturedPayments(payments: CapturedPayment[]): Cents {
	let total = 0;
	for (const p of payments) if (p.status === "succeeded") total += p.amount;
	return cents(total);
}

/** The refund ceiling: `min(Σ captured, frozen total)` (ADR-0008 review condition
 *  2). `settleOrder` admits short captures, so the money we actually hold can be
 *  LESS than the frozen total — the smaller bound wins; the frozen total is a hard
 *  upper bound never exceeded even if a capture over-recorded. */
export function computeRefundCeiling(capturedTotal: Cents, frozenTotal: Cents): Cents {
	return cents(Math.min(capturedTotal, frozenTotal));
}

/** `Σ` over the ledger's ACTIVE rows (everything but `voided`) — the capacity
 *  the ceiling arbitrates against: finalized money AND held reservations /
 *  unverified attempts all consume it. */
export function sumRefunds(refunds: RefundRecord[]): number {
	let total = 0;
	for (const r of refunds) if (r.status !== "voided") total += r.amount;
	return total;
}

/** `Σ` over the FINALIZED (`recorded`) rows only — money that actually came
 *  back; what the derived partial/fully-refunded badge and the `→ refunded`
 *  flip are based on. */
export function sumFinalizedRefunds(refunds: RefundRecord[]): number {
	let total = 0;
	for (const r of refunds) if (r.status === "recorded") total += r.amount;
	return total;
}

/**
 * Issue or record a refund on an order (ADR-0008). Pure orchestration — no IO of
 * its own: validate, branch on the gateway's declared `refundable` capability,
 * then run the **reserve-before-issue** protocol against the store:
 *
 *  1. **Reserve** the ledger slot: `reserveRefund` performs the atomic ceiling
 *     arbitration (`Σ active ≤ min(Σ captured, total)`) under the `orders` row
 *     lock and inserts a `reserved` row. A loser is rejected HERE — before any
 *     gateway call — so no interleaving can let money leave the provider only
 *     for the ledger to refuse it afterward.
 *  2. **Issue** at the gateway (Stripe pre-flight → `refunds.create`, our key as
 *     Stripe's native `Idempotency-Key`).
 *  3. **Settle the reservation** by the gateway outcome:
 *     - success   → `finalizeRefund` (stamps refundRef; flips `→ refunded` iff
 *                   the FINALIZED Σ reached the ceiling);
 *     - fail-closed / terminal / unsupported → `voidRefund` (nothing issued —
 *                   capacity released, audit row kept);
 *     - retryable → reservation KEPT (`reserved`): a same-key retry resumes it
 *                   (crash-heal: re-issues under the same provider key);
 *     - ambiguous → `markRefundUnverified` (capacity HELD — the safe direction —
 *                   until a human re-checks the provider).
 *
 * The MANUAL path (`refundable:false` — x402 / no Stripe secret) has no gateway
 * leg, so it stays the one-shot atomic `recordRefund` (insert finalized + flip),
 * which is reserve-and-finalize collapsed into one transaction.
 *
 * "Issued but unrecorded" is impossible by construction: issuance strictly
 * follows a committed reservation, and `finalizeRefund` updates that existing
 * row (it cannot lose arbitration — the capacity is already held). The residual
 * guard (a finalize that finds no row) records a `REFUND_UNRECORDED` anomaly
 * carrying the provider refundRef + flags reconciliation, and returns the
 * distinct `REFUND_ISSUED_UNRECORDED` — never a silent drop, never confusable
 * with a clean rejection.
 */
export async function refundOrder(
	deps: RefundOrderDeps,
	gateway: PaymentGateway,
	cmd: RefundOrderCommand,
): Promise<RefundOrderOutcome> {
	const refundedBy = cmd.refundedBy.trim();
	if (refundedBy.length === 0) return { ok: false, reason: "EMPTY_REFUNDED_BY" };
	if (!Number.isSafeInteger(cmd.amount) || cmd.amount <= 0) {
		return { ok: false, reason: "INVALID_AMOUNT" };
	}
	const trimmedReason = (cmd.reason ?? "").trim();
	const reason = trimmedReason.length === 0 ? null : trimmedReason;

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
	if (cmd.currency !== order.totals.currency) return { ok: false, reason: "CURRENCY_MISMATCH" };

	// Idempotent replay: disambiguate on the existing row's status. `recorded` ⇒
	// the benign duplicate (no second gateway call). `unverified` ⇒ the prior
	// attempt's fate is still unknown — re-check before anything retries (the
	// capacity is held; NEVER re-issue blind). `voided` ⇒ the key was consumed by
	// a definitively-rejected attempt. `reserved` ⇒ a crash/retryable-failure
	// window — RESUME it below (same key re-issues; Stripe's native idempotency
	// dedupes provider-side).
	const existing = await deps.orderStore.getRefundByIdempotencyKey(cmd.idempotencyKey);
	if (existing !== null && existing.status === "recorded") {
		return {
			ok: true,
			recorded: false,
			duplicate: true,
			fullyRefunded: order.state === "refunded",
			refund: existing,
			order,
		};
	}
	if (existing !== null && existing.status === "unverified") {
		return { ok: false, reason: "GATEWAY_UNVERIFIED" };
	}
	if (existing !== null && existing.status === "voided") {
		return { ok: false, reason: "GATEWAY_TERMINAL" };
	}
	const resuming = existing !== null; // status === "reserved"

	const kind = gateway.refundable ? "gateway" : "manual";
	const payments = await deps.orderStore.getCapturedPayments(cmd.orderId);

	if (kind === "manual") {
		// No gateway leg ⇒ the one-shot atomic record (arbitration + finalized
		// insert + conditional flip in one transaction).
		const res = await deps.orderStore.recordRefund({
			orderId: cmd.orderId,
			amount: cmd.amount,
			currency: cmd.currency,
			kind,
			gateway: gateway.id,
			refundRef: null,
			reason,
			refundedBy,
			idempotencyKey: cmd.idempotencyKey,
		});
		return settleRecordOutcome(res);
	}

	// -- gateway path: reserve → issue → finalize/void/unverify -----------------

	// The charge/PI to refund against: a succeeded payment recorded by settle for
	// THIS gateway (the money we captured through it). Checked before reserving —
	// a reservation without an issuable target is pointless.
	const captured = payments.find((p) => p.status === "succeeded" && p.gateway === gateway.id);
	if (captured === undefined) return { ok: false, reason: "NO_CAPTURED_PAYMENT" };

	// 1. RESERVE — the atomic arbitration. A ceiling loser is rejected here,
	// BEFORE any provider call, with the reason label computed from the
	// AUTHORITATIVE in-transaction sums the store returns (never a stale
	// pre-check read). A resume skips this (its reservation already exists).
	if (!resuming) {
		const reserved = await deps.orderStore.reserveRefund({
			orderId: cmd.orderId,
			amount: cmd.amount,
			currency: cmd.currency,
			kind,
			gateway: gateway.id,
			refundRef: null,
			reason,
			refundedBy,
			idempotencyKey: cmd.idempotencyKey,
		});
		if (reserved.outcome === "order_not_found") return { ok: false, reason: "ORDER_NOT_FOUND" };
		if (reserved.outcome === "exceeds_ceiling") {
			return { ok: false, reason: exceedsReason(reserved.capturedTotal, reserved.frozenTotal) };
		}
		// `duplicate` here means a concurrent same-key call inserted between our
		// replay check and the reserve — both now hold the SAME single reservation;
		// proceed to issue (the provider-side native key dedupes the issue too).
	}

	// 2. ISSUE — only ever reached with a committed reservation holding the
	// capacity. The ledger can no longer refuse this money.
	const gwRes = await gateway.refund({
		orderId: cmd.orderId,
		providerRef: captured.providerRef,
		amount: cmd.amount,
		currency: cmd.currency,
		priorRefunded: cents(sumFinalizedRefunds(await deps.orderStore.listRefunds(cmd.orderId))),
		idempotencyKey: cmd.idempotencyKey,
	});

	// 3. SETTLE the reservation by outcome.
	if (!gwRes.ok) {
		switch (gwRes.reason) {
			case "RETRYABLE":
				// Definitely not processed; keep the reservation so a same-key retry
				// resumes it (capacity stays held meanwhile — the safe direction).
				return { ok: false, reason: "GATEWAY_RETRYABLE" };
			case "UNVERIFIED":
				// Fate unknown: hold the capacity, demand a human re-check.
				await deps.orderStore.markRefundUnverified(cmd.idempotencyKey);
				return { ok: false, reason: "GATEWAY_UNVERIFIED" };
			case "PROVIDER_ALREADY_REFUNDED":
				// Fail-closed pre-flight: nothing issued — release the capacity.
				await deps.orderStore.voidRefund(cmd.idempotencyKey);
				return { ok: false, reason: "PROVIDER_ALREADY_REFUNDED" };
			case "TERMINAL":
				await deps.orderStore.voidRefund(cmd.idempotencyKey);
				return { ok: false, reason: "GATEWAY_TERMINAL" };
			case "UNSUPPORTED":
				await deps.orderStore.voidRefund(cmd.idempotencyKey);
				return { ok: false, reason: "REFUND_NOT_SUPPORTED" };
		}
	}

	const finalized = await deps.orderStore.finalizeRefund({
		idempotencyKey: cmd.idempotencyKey,
		refundRef: gwRes.refundRef,
	});
	if (!finalized.found || finalized.refund === null || finalized.order === null) {
		// The LOUD residual — impossible by construction (the reservation was
		// committed before issuance and only this key-scoped flow settles it), but
		// if it EVER fires: money left the provider. NOT reached by a concurrent
		// same-key double-issue: the loser's finalize finds the row already
		// `recorded` with the SAME refundRef (Stripe's native key guarantees one
		// refund) and the store returns it as a BENIGN duplicate (`found:true,
		// alreadyFinalized:true`) — only a DIFFERENT refundRef lands here. Record
		// the refundRef as a REFUND_UNRECORDED anomaly + flag reconciliation; the
		// distinct reason keeps it unconfusable with a clean rejection. Never a
		// silent drop.
		const detail = `gateway refund ${gwRes.refundRef} (${String(cmd.amount)} ${cmd.currency}, key ${cmd.idempotencyKey}) issued but the reserved ledger row could not be finalized`;
		if (deps.paymentEventStore !== undefined) {
			await deps.paymentEventStore.recordAnomaly({
				orderId: cmd.orderId,
				gateway: gateway.id,
				kind: "REFUND_UNRECORDED",
				detail,
				now: (deps.clock ?? { now: () => new Date() }).now().toISOString(),
			});
		}
		await deps.orderStore.flagReconciliation(cmd.orderId, detail);
		return { ok: false, reason: "REFUND_ISSUED_UNRECORDED" };
	}
	// A benign same-ref duplicate (a concurrent same-key caller finalized first)
	// surfaces as `duplicate:true, recorded:false` — the shape a pre-issuance
	// replay already returns; a fresh finalize is `recorded:true`.
	return {
		ok: true,
		recorded: !finalized.alreadyFinalized,
		duplicate: finalized.alreadyFinalized,
		fullyRefunded: finalized.fullyRefunded,
		refund: finalized.refund,
		order: finalized.order,
	};
}

/** Map a one-shot `recordRefund` result (the manual path) to the outcome. */
function settleRecordOutcome(
	res: Awaited<ReturnType<OrderStore["recordRefund"]>>,
): RefundOrderOutcome {
	if (res.outcome === "order_not_found") return { ok: false, reason: "ORDER_NOT_FOUND" };
	if (res.outcome === "exceeds_ceiling") {
		return { ok: false, reason: exceedsReason(res.capturedTotal, res.frozenTotal) };
	}
	if (res.refund === null || res.order === null) {
		return { ok: false, reason: "ORDER_NOT_FOUND" }; // defensive
	}
	return {
		ok: true,
		recorded: res.outcome === "recorded",
		duplicate: res.outcome === "duplicate",
		fullyRefunded: res.fullyRefunded,
		refund: res.refund,
		order: res.order,
	};
}

/** Pick the tighter ceiling bound for an over-refund (ADR-0008) from the
 *  AUTHORITATIVE in-transaction sums the store's arbitration returned: the
 *  ceiling is `min(captured, total)`, so the rejection exceeded the SMALLER
 *  bound — `REFUND_EXCEEDS_CAPTURED` when captured binds (a short capture),
 *  else `REFUND_EXCEEDS_TOTAL`. */
function exceedsReason(
	capturedTotal: number,
	frozenTotal: number,
): "REFUND_EXCEEDS_CAPTURED" | "REFUND_EXCEEDS_TOTAL" {
	return capturedTotal < frozenTotal ? "REFUND_EXCEEDS_CAPTURED" : "REFUND_EXCEEDS_TOTAL";
}
