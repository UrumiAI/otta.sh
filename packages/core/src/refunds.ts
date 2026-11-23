/**
 * Refunds made in Stripe (the dashboard or the API), recorded on the order.
 *
 * Stripe does not deliver events in order and may deliver one twice, so an
 * event is only a signal: Core re-reads the payment's refunds and MERGES them
 * per refund id into the order. A refund that failed or was canceled is final;
 * any other status counts. Merging per refund gives the same result whatever
 * order the reads land in (a stale read cannot drop a refund a newer read saw).
 *
 * Recording only: the order keeps its status and its stock is not returned.
 * Bridge calls: settings (caller) + query 1 + Stripe 1 + read 1 + CAS 1
 * (+ Stripe 1 + read 1 when the payment is not on an order yet).
 */
import type { PluginContext } from "emdash/plugin";
import type { OrderDoc } from "./model.js";
import { ORDER_ID, orders, updateOrder } from "./orders.js";
import { listRefunds, paymentIntentOrder } from "./stripe.js";

/** "retry": the payment is a Core order's that has not recorded it yet (answer 503). */
export type RefundOutcome = "recorded" | "noop" | "unknown_order" | "retry";

const TERMINAL = new Set(["failed", "canceled"]);

export async function applyRefunds(
	ctx: PluginContext,
	key: string,
	paymentIntentId: string,
): Promise<RefundOutcome> {
	const c = orders(ctx);
	const found = await c.query({ where: { paymentIntentId }, limit: 2 });
	if (found.items.length > 1) {
		ctx.log?.warn?.("otta-core refund: payment on more than one order", { paymentIntentId });
		return "noop";
	}
	const hit = found.items[0];
	if (!hit) {
		// The refund may have beaten the payment's own webhook. If the payment is
		// one of ours, ask Stripe to retry later instead of dropping the event.
		const pi = await paymentIntentOrder(ctx, key, paymentIntentId);
		if (!pi.ok) throw new Error(`payment ${paymentIntentId}: ${pi.code}`);
		const oid = pi.value.orderId;
		if (oid !== null && ORDER_ID.test(oid) && (await c.get(oid)) !== null) return "retry";
		return "unknown_order";
	}
	const r = await listRefunds(ctx, key, paymentIntentId);
	// Throw so the webhook answers 500 and Stripe retries later.
	if (!r.ok) throw new Error(`refunds for ${paymentIntentId}: ${r.code}`);
	const { refunds: fresh, complete } = r.value;
	let outcome: RefundOutcome = "noop";
	await updateOrder(ctx, hit.id, (d): OrderDoc | null => {
		outcome = "noop";
		const bad = fresh.find((x) => x.currency !== null && x.currency !== d.currency);
		if (bad) {
			return d.attention?.includes("REFUND_CURRENCY")
				? null
				: { ...d, attention: `${d.attention ?? ""} REFUND_CURRENCY:${bad.currency}`.trim() };
		}
		const merged: Record<string, { amount: number; terminal: boolean }> = { ...d.refunds };
		let changed = false;
		for (const x of fresh) {
			const prev = merged[x.id];
			if (prev?.terminal) continue; // final
			const next = { amount: x.amount, terminal: TERMINAL.has(x.status) };
			if (!prev || prev.amount !== next.amount || prev.terminal !== next.terminal) {
				merged[x.id] = next;
				changed = true;
			}
		}
		const truncated = !complete && !(d.attention ?? "").includes("REFUNDS_TRUNCATED");
		if (!changed && !truncated) return null;
		outcome = "recorded";
		const refundedAmount = Object.values(merged).reduce(
			(a, x) => a + (x.terminal ? 0 : x.amount),
			0,
		);
		return {
			...d,
			refunds: merged,
			refundedAmount,
			attention: truncated ? `${d.attention ?? ""} REFUNDS_TRUNCATED`.trim() : d.attention,
		};
	});
	return outcome;
}
