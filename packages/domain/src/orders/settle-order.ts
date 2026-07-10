import { idempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { ConfirmationResult } from "../ports/payment-gateway.js";
import type { EntitlementStore } from "../ports/entitlement-store.js";
import { type InventoryStore, ReservationCommitLostError } from "../ports/inventory-store.js";
import type { OrderStore } from "../ports/order-store.js";
import type { PaymentEventStore } from "../ports/payment-event-store.js";
import type { PaymentGateway, RawConfirmation } from "../ports/payment-gateway.js";
import type { SettleFailure } from "./errors.js";
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
 * commit-or-grant**. Both Stripe (webhook bytes) and x402 (page-gate proof)
 * converge here.
 *
 * 1. `gateway.verifyConfirmation(raw)` — a reject (bad signature / unknown /
 *    malformed) is a typed failure (HTTP 400). All crypto is adapter-side.
 * 2. Record the delivery in `payment_events` (UNIQUE `dedupeKey` — the audit
 *    trail). **A duplicate does NOT short-circuit**: every delivery re-DRIVES the
 *    idempotent, state-guarded steps below, so a crash between any two of them
 *    (dedupe→flip, flip→commit/grant) is healed by the next gateway retry — the
 *    Phase-3 claim/resume idiom. "Settles once" is enforced by the guarded
 *    `pending → paid` flip, the `provider_ref`-keyed payment record, the
 *    state-guarded `commit`, and the grant-once entitlement key — never by
 *    blind-trusting the dedupe row.
 * 3. Amount + currency MUST equal `order_totals.total` — mismatch ⇒ reject +
 *    record anomaly (§9 Risk 3); no auto-refund.
 * 4. Guarded `pending → paid`; record the `payments` row; per line: physical ⇒
 *    `commit(reservationId)` (a lost adopted hold is the loud 0-row anomaly, §5);
 *    digital ⇒ grant entitlement (grant-once). An already-`paid` order re-drives
 *    the side-effects idempotently and no-ops.
 * 5. **Losing the `pending → paid` flip mid-flight** (an expiry/failure raced the
 *    settle between load and flip) is exactly as LOUD as finding the order
 *    already terminal: `PAID_FLIP_LOST` anomaly + manual-reconciliation flag —
 *    money was captured while stock was released; never a silent no-op.
 *
 * A verified `failed` event (`payment_intent.payment_failed`) instead drives
 * `pending → failed` + `release` (§5), re-driving the release on a retry after a
 * crash between the flip and the release.
 */
export async function settleOrder(
	deps: SettleDeps,
	gateway: PaymentGateway,
	raw: RawConfirmation,
): Promise<SettleResult> {
	const conf = await gateway.verifyConfirmation(raw);
	if (!conf.ok) return { ok: false, reason: conf.reason };

	const now = deps.clock.now().toISOString();

	// 2. Record the delivery (UNIQUE dedupe_key = the audit row). Deliberately
	// NOT a short-circuit — see the function doc: replays re-drive by state.
	await deps.paymentEventStore.dedupe(conf.dedupeKey, conf.orderId, conf.gateway, now);

	const order = await deps.orderStore.getById(conf.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	// A verified FAILURE event: guarded pending → failed, then release. The
	// release runs whenever the order IS failed (fresh flip or a retry resuming a
	// crash between flip and release) — `release` is state-guarded/idempotent, so
	// stock returns exactly once.
	if (conf.outcome === "failed") {
		const won = await deps.orderStore.markFailed(order.id);
		const fresh = (await deps.orderStore.getById(order.id)) ?? order;
		if (fresh.state === "failed") await releaseAll(deps, fresh);
		return { ok: true, order: fresh, noop: !won };
	}

	// 3. Amount + currency must equal the order-total snapshot — checked on every
	// drive (a crash-window resume can never skip it).
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

	// Already paid (webhook-before-redirect, duplicate delivery, or a retry after
	// a crash between the flip and its side-effects): RE-DRIVE the side-effects —
	// each is idempotent (provider_ref-keyed payment record, state-guarded
	// commit, grant-once entitlement) — then no-op.
	if (order.state === "paid") {
		await applyPaidSideEffects(deps, conf, order, now);
		const fresh = await deps.orderStore.getById(order.id);
		return { ok: true, order: fresh, noop: true };
	}

	// Terminal non-paid + a verified success: money moved but cannot settle →
	// anomaly + manual reconciliation (no auto-refund, v1). Gated on the flag so
	// a gateway's retry storm records the incident once, not once per delivery.
	if (order.state !== "pending") {
		if (order.reconciliationFlag === null) {
			await deps.paymentEventStore.recordAnomaly({
				orderId: order.id,
				gateway: conf.gateway,
				kind: "SETTLE_ON_NON_PENDING",
				detail: `verified success on order in state=${order.state}`,
				now,
			});
			await deps.orderStore.flagReconciliation(order.id, `settle on ${order.state}`);
		}
		const fresh = await deps.orderStore.getById(order.id);
		return { ok: true, order: fresh, noop: true };
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
		// expiry/failure — the customer was charged while the stock was released.
		// Exactly as loud as the already-terminal-at-load case above.
		const lostTo = fresh?.state ?? "missing";
		if (fresh === null || fresh.reconciliationFlag === null) {
			await deps.paymentEventStore.recordAnomaly({
				orderId: order.id,
				gateway: conf.gateway,
				kind: "PAID_FLIP_LOST",
				detail: `verified success lost the pending→paid flip; order is now state=${lostTo}`,
				now,
			});
			await deps.orderStore.flagReconciliation(
				order.id,
				`lost pending→paid flip to state=${lostTo}`,
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

	for (const line of order.lines) {
		if (line.fulfillmentKind === "physical" && line.reservationId !== null) {
			try {
				await deps.inventoryStore.commit(line.reservationId);
			} catch (err) {
				if (err instanceof ReservationCommitLostError) {
					// The adopted hold was lost (released) — stock was resold under a paid
					// order. Loud anomaly + manual reconciliation, NEVER a silent no-op.
					// Gated on the flag: the first drive records it; a later re-drive of
					// an already-flagged order does not spam one row per gateway retry.
					if (order.reconciliationFlag === null) {
						await deps.paymentEventStore.recordAnomaly({
							orderId: order.id,
							gateway: conf.gateway,
							kind: "COMMIT_LOST",
							detail: `commit matched 0 rows for reservation ${line.reservationId}`,
							now,
						});
						await deps.orderStore.flagReconciliation(
							order.id,
							`commit lost for reservation ${line.reservationId}`,
						);
					}
				} else {
					throw err;
				}
			}
		} else if (line.fulfillmentKind === "digital") {
			await deps.entitlementStore.grant({
				orderId: order.id,
				productId: line.productId,
				sku: line.sku,
				buyerRef: order.buyerRef,
				source: conf.gateway === "x402" ? "x402" : "order_paid",
				// Deterministic grant-once key per (order, sku): replay grants nothing.
				grantIdempotencyKey: idempotencyKey(`ent:${order.id}:${line.sku}`),
			});
		}
	}
}

/** Release every adopted reservation on an order (idempotent per reservation). */
async function releaseAll(deps: SettleDeps, order: Order): Promise<void> {
	for (const line of order.lines) {
		if (line.reservationId !== null) await deps.inventoryStore.release(line.reservationId);
	}
}
