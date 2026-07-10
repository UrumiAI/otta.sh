import { idempotencyKey } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
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

/**
 * The gateway-agnostic settlement use-case (§5): **verify → dedupe → transition →
 * commit-or-grant**. Both Stripe (webhook bytes) and x402 (page-gate proof)
 * converge here.
 *
 * 1. `gateway.verifyConfirmation(raw)` — a reject (bad signature / unknown /
 *    malformed) is a typed failure (HTTP 400). All crypto is adapter-side.
 * 2. Dedupe on `dedupeKey` via `payment_events` UNIQUE — a duplicate delivery
 *    (Stripe retry / double page-gate) is a **no-op success**.
 * 3. Load the order. Already `paid` ⇒ no-op success (webhook-before-redirect).
 * 4. Amount + currency MUST equal `order_totals.total` — mismatch ⇒ reject +
 *    record anomaly (§9 Risk 3); no auto-refund.
 * 5. Guarded `pending → paid`; record the `payments` row.
 * 6. Per line: physical ⇒ `commit(reservationId)` (a lost adopted hold is the
 *    loud 0-row anomaly, §5); digital ⇒ grant entitlement (grant-once).
 *
 * A verified `failed` event (`payment_intent.payment_failed`) instead drives
 * `pending → failed` + `release` (§5).
 */
export async function settleOrder(
	deps: SettleDeps,
	gateway: PaymentGateway,
	raw: RawConfirmation,
): Promise<SettleResult> {
	const conf = await gateway.verifyConfirmation(raw);
	if (!conf.ok) return { ok: false, reason: conf.reason };

	const now = deps.clock.now().toISOString();

	// 2. Dedupe: the UNIQUE dedupe_key makes redelivery a no-op success.
	const first = await deps.paymentEventStore.dedupe(
		conf.dedupeKey,
		conf.orderId,
		conf.gateway,
		now,
	);
	if (!first) {
		const order = await deps.orderStore.getById(conf.orderId);
		return { ok: true, order, noop: true };
	}

	const order = await deps.orderStore.getById(conf.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	// A verified FAILURE event: guarded pending → failed, then release adopted holds.
	if (conf.outcome === "failed") {
		const won = await deps.orderStore.markFailed(order.id);
		if (won) await releaseAll(deps, order);
		const fresh = await deps.orderStore.getById(order.id);
		return { ok: true, order: fresh, noop: !won };
	}

	// 3. Terminal / non-pending handling.
	if (order.state === "paid") return { ok: true, order, noop: true };
	if (order.state !== "pending") {
		// failed/expired + a late success: money moved but can't settle → anomaly +
		// manual reconciliation (no auto-refund, v1).
		await deps.paymentEventStore.recordAnomaly({
			orderId: order.id,
			gateway: conf.gateway,
			kind: "SETTLE_ON_NON_PENDING",
			detail: `verified success on order in state=${order.state}`,
			now,
		});
		await deps.orderStore.flagReconciliation(order.id, `settle on ${order.state}`);
		return { ok: true, order, noop: true };
	}

	// 4. Amount + currency must equal the order-total snapshot.
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

	// 5. Guarded pending → paid; record the payment.
	const won = await deps.orderStore.markPaid(order.id);
	if (!won) {
		const fresh = await deps.orderStore.getById(order.id);
		return { ok: true, order: fresh, noop: true };
	}
	await deps.orderStore.recordPayment({
		orderId: order.id,
		gateway: conf.gateway,
		providerRef: conf.providerRef,
		amount: conf.amount,
		currency: conf.currency,
		status: "succeeded",
	});

	// 6. Per-line: physical → commit; digital → grant entitlement.
	for (const line of order.lines) {
		if (line.fulfillmentKind === "physical" && line.reservationId !== null) {
			try {
				await deps.inventoryStore.commit(line.reservationId);
			} catch (err) {
				if (err instanceof ReservationCommitLostError) {
					// The adopted hold was lost (released) — stock was resold under a paid
					// order. Loud anomaly + manual reconciliation, NEVER a silent no-op.
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

	const finalOrder = await deps.orderStore.getById(order.id);
	return { ok: true, order: finalOrder, noop: false };
}

/** Release every adopted reservation on an order (idempotent per reservation). */
async function releaseAll(deps: SettleDeps, order: Order): Promise<void> {
	for (const line of order.lines) {
		if (line.reservationId !== null) await deps.inventoryStore.release(line.reservationId);
	}
}
