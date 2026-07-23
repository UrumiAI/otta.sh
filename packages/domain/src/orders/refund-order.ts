import type { Cents, Currency } from "../money/cents.js";
import { cents } from "../money/cents.js";
import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { CapturedPayment, OrderStore, RefundRecord } from "../ports/order-store.js";
import type { PaymentGateway } from "../ports/payment-gateway.js";
import type { Order } from "./model.js";

export interface RefundOrderDeps {
	orderStore: OrderStore;
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
	/** `Σ refunds + amount` would exceed what we actually captured — the ceiling
	 *  binds at `Σ captured` (a short-capture order, `settle-order.ts` anomaly). */
	| "REFUND_EXCEEDS_CAPTURED"
	/** `Σ refunds + amount` would exceed the frozen `order_totals.total`. */
	| "REFUND_EXCEEDS_TOTAL"
	/** The Stripe refund-time pre-flight found provider-side refunds already
	 *  diverge from our view (or this refund would over-refund at the provider):
	 *  NOTHING was issued or recorded — reconcile before retrying. */
	| "PROVIDER_ALREADY_REFUNDED"
	/** A transient transport failure before issuance is confirmed — safe to retry
	 *  with the SAME idempotency key. */
	| "GATEWAY_RETRYABLE"
	/** A definite provider rejection — retrying the same request will not help. */
	| "GATEWAY_TERMINAL"
	/** The ambiguous timeout — `refunds.create` errored with an unknown fate. Do
	 *  NOT blind-retry; re-check the provider first. */
	| "GATEWAY_UNVERIFIED"
	/** The gateway declared itself unable to refund at the moment of the call
	 *  (a defensive mapping — the use-case already branches on `refundable`, so a
	 *  well-behaved gateway never reaches here). */
	| "REFUND_NOT_SUPPORTED";

export type RefundOrderOutcome =
	| {
			ok: true;
			/** True iff a NEW ledger row was written; false ⇒ an idempotent replay
			 *  (`duplicate`), returning the existing refund. */
			recorded: boolean;
			duplicate: boolean;
			/** True iff `Σ refunds` reached the ceiling and the order flipped
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

/**
 * Issue or record a refund on an order (ADR-0008). Pure orchestration — no IO of
 * its own: validate, branch on the gateway's declared `refundable` capability,
 * (for a gateway refund) call the provider, then delegate the ceiling-guarded,
 * append-only ledger write — which drives the `→ refunded` flip atomically when a
 * refund reaches the ceiling — to the store.
 *
 * Money movement, so maximum rigor:
 *  - **Capability, not discovery.** `gateway.refundable` decides the path — Stripe
 *    (`true`) issues a real refund; x402 (`false`) is a `manual`, record-only
 *    ledger entry (the admin sent the return out of band). Never a `try/catch` to
 *    learn refundability.
 *  - **Idempotent once-only.** A replay of the same `idempotencyKey` returns the
 *    existing refund WITHOUT a second gateway call (checked before issuance) and
 *    the ledger's `UNIQUE(idempotency_key)` is the structural backstop; the same
 *    key is Stripe's native `Idempotency-Key` on the gateway leg.
 *  - **Ceiling-bound.** `Σ refunds ≤ min(Σ captured, total)`, enforced ATOMICALLY
 *    in `recordRefund` (a concurrent refund that raced past the pre-check is a
 *    0-row guarded write, never an over-refund). Over-refund is a typed rejection.
 *  - **Fail closed on provider divergence.** A Stripe `PROVIDER_ALREADY_REFUNDED`
 *    from the mandatory pre-flight surfaces as-is: nothing issued, nothing
 *    recorded.
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

	// Idempotent replay: a refund already exists for this key ⇒ return it, and
	// (critically for a gateway refund) DO NOT call the provider again. The
	// ledger's UNIQUE(idempotency_key) is the structural authority under a race;
	// this pre-check keeps the common replay off the gateway entirely.
	const existing = await deps.orderStore.getRefundByIdempotencyKey(cmd.idempotencyKey);
	if (existing !== null) {
		return {
			ok: true,
			recorded: false,
			duplicate: true,
			fullyRefunded: order.state === "refunded",
			refund: existing,
			order,
		};
	}

	// Ceiling pre-check (a read; the store re-checks atomically under the row
	// lock). Nothing captured ⇒ ceiling 0 ⇒ any positive amount is rejected —
	// refunding an unpaid order is impossible by construction.
	const payments = await deps.orderStore.getCapturedPayments(cmd.orderId);
	const capturedTotal = sumCapturedPayments(payments);
	const ceiling = computeRefundCeiling(capturedTotal, order.totals.total);
	const prior = sumRefunds(await deps.orderStore.listRefunds(cmd.orderId));
	if (prior + cmd.amount > ceiling) {
		return {
			ok: false,
			reason: exceedsReason(prior + cmd.amount, capturedTotal, order.totals.total),
		};
	}

	const kind = gateway.refundable ? "gateway" : "manual";
	let refundRef: string | null = null;

	if (kind === "gateway") {
		// The charge/PI to refund against: a succeeded payment recorded by settle
		// for THIS gateway (the money we captured through it).
		const captured = payments.find((p) => p.status === "succeeded" && p.gateway === gateway.id);
		if (captured === undefined) return { ok: false, reason: "NO_CAPTURED_PAYMENT" };

		const gwRes = await gateway.refund({
			orderId: cmd.orderId,
			providerRef: captured.providerRef,
			amount: cmd.amount,
			currency: cmd.currency,
			priorRefunded: cents(prior),
			idempotencyKey: cmd.idempotencyKey,
		});
		if (!gwRes.ok) return { ok: false, reason: mapGatewayFailure(gwRes.reason) };
		refundRef = gwRes.refundRef;
	}

	const res = await deps.orderStore.recordRefund({
		orderId: cmd.orderId,
		amount: cmd.amount,
		currency: cmd.currency,
		kind,
		gateway: gateway.id,
		refundRef,
		reason,
		refundedBy,
		idempotencyKey: cmd.idempotencyKey,
	});

	if (res.outcome === "order_not_found") return { ok: false, reason: "ORDER_NOT_FOUND" };
	if (res.outcome === "exceeds_ceiling") {
		// A concurrent refund won between the pre-check and the guarded write. For a
		// gateway refund the provider leg already issued (the narrow read-then-issue
		// race the ADR accepts) — the ledger is still bounded; the caller reconciles.
		return {
			ok: false,
			reason: exceedsReason(prior + cmd.amount, res.capturedTotal, res.frozenTotal),
		};
	}
	if (res.refund === null || res.order === null) {
		// Defensive: a recorded/duplicate outcome always carries the row + order.
		return { ok: false, reason: "ORDER_NOT_FOUND" };
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

/** `Σ refunds` over a ledger (integer minor units). */
export function sumRefunds(refunds: RefundRecord[]): number {
	let total = 0;
	for (const r of refunds) total += r.amount;
	return total;
}

/** Pick the tighter ceiling bound for an over-refund (ADR-0008): the ceiling is
 *  `min(captured, total)`, so an amount over the ceiling is over the SMALLER
 *  bound — `REFUND_EXCEEDS_CAPTURED` when captured is the binding (short-capture)
 *  bound, else `REFUND_EXCEEDS_TOTAL`. */
function exceedsReason(
	wouldBe: number,
	capturedTotal: number,
	frozenTotal: number,
): "REFUND_EXCEEDS_CAPTURED" | "REFUND_EXCEEDS_TOTAL" {
	if (wouldBe > capturedTotal && capturedTotal < frozenTotal) return "REFUND_EXCEEDS_CAPTURED";
	return "REFUND_EXCEEDS_TOTAL";
}

function mapGatewayFailure(
	reason: "UNSUPPORTED" | "PROVIDER_ALREADY_REFUNDED" | "RETRYABLE" | "TERMINAL" | "UNVERIFIED",
): RefundOrderFailure {
	switch (reason) {
		case "UNSUPPORTED":
			return "REFUND_NOT_SUPPORTED";
		case "PROVIDER_ALREADY_REFUNDED":
			return "PROVIDER_ALREADY_REFUNDED";
		case "RETRYABLE":
			return "GATEWAY_RETRYABLE";
		case "TERMINAL":
			return "GATEWAY_TERMINAL";
		case "UNVERIFIED":
			return "GATEWAY_UNVERIFIED";
	}
}
