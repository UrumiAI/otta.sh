/**
 * The order document is the one arbiter (L3): its status, moved only by
 * compareAndSet, is the only decision. Stock completion (commit or release of
 * every hold) follows deterministically from that status and is safe to replay
 * by any request or by the sweep.
 */
import type { PluginContext } from "emdash/plugin";
import { stockId, type OrderDoc, type PublicOrder } from "./model.js";
import { applyStock } from "./stock.js";
import { coll, nowIso, type Coll } from "./util.js";

export const ORDER_ID = /^ord_[0-9a-f]{32}$/;

export type Versioned = { value: OrderDoc; revision: string };

export const orders = (ctx: PluginContext): Coll<OrderDoc> => coll<OrderDoc>(ctx, "orders");

/** Every order write goes through this: `open` always matches status and stock work. */
export const withOpen = (d: OrderDoc): OrderDoc => {
	const open = d.status === "pending" || d.stockPending === 1 ? 1 : 0;
	const prunable =
		(d.status === "expired" || d.status === "canceled") &&
		d.stockPending === 0 &&
		d.stock === "released" &&
		d.paymentIntentId === null &&
		d.amountPaid === null &&
		d.paidAt === null &&
		d.attention === null
			? 1
			: 0;
	// The buyer tag only serves the open-order cap: it does not outlive the open order.
	return { ...d, open, prunable, ipTag: open === 1 ? d.ipTag : null };
};

/**
 * Re-read-and-retry update (L4: a lost write is never a decision). `step`
 * returns the next document, or null to leave the order as it is. Starts from
 * `cur` when the caller already holds a fresh read (saves one bridge call).
 */
export async function updateOrder(
	ctx: PluginContext,
	id: string,
	step: (doc: OrderDoc) => OrderDoc | null,
	cur?: Versioned | null,
): Promise<Versioned | null> {
	const c = orders(ctx);
	for (let i = 0; i < 5; i++) {
		const v = cur ?? (await c.getVersioned(id));
		cur = undefined;
		if (!v) return null;
		const stepped = step(v.value);
		if (stepped === null) return v;
		const next = withOpen({ ...stepped, updatedAt: nowIso() });
		const w = await c.compareAndSet(id, v.revision, next);
		if (w.applied) return { value: next, revision: w.revision };
	}
	throw new Error(`order ${id}: too many concurrent writers`);
}

/**
 * Finish a `committing` or `releasing` order: apply the stock operation to
 * every tracked line (each exactly-once), then clear the sweep flag.
 * 2 bridge calls per tracked line + 1 (or 2 after a lost race).
 */
export async function completeStock(
	ctx: PluginContext,
	id: string,
	cur: Versioned,
): Promise<Versioned> {
	const doc = cur.value;
	if (doc.stock !== "committing" && doc.stock !== "releasing") return cur;
	const commit = doc.stock === "committing";
	let oversold = false;
	for (const it of doc.items) {
		if (!it.trackStock) continue;
		const r = await applyStock(
			ctx,
			stockId(it),
			commit
				? { kind: "commit", orderId: id, qty: it.qty, unheld: doc.unheldSale }
				: { kind: "release", orderId: id },
		);
		if (!r.ok) throw new Error(`order ${id}: stock ${r.code} on ${it.productId}`);
		// Only a commit this call applied can have oversold (a replay returns the
		// current document, which another order may have taken below zero).
		if (commit && r.applied && r.doc.onHand < 0) oversold = true;
	}
	const target = commit ? "committed" : "released";
	const done = await updateOrder(
		ctx,
		id,
		(d) =>
			d.stock !== doc.stock
				? null
				: {
						...d,
						stock: target,
						stockPending: 0,
						attention: oversold ? (d.attention ?? "OVERSOLD") : d.attention,
					},
		cur,
	);
	return done ?? cur;
}

/**
 * An order as an admin, MCP tool or export may see it: never the buyer's
 * secret order key (it lets anyone read the order), wherever it appears, and
 * never the buyer tag. The stored URLs had the key filled in; it is masked
 * back to the {ORDER_KEY} placeholder.
 */
export function redactOrder(o: OrderDoc): Omit<OrderDoc, "orderKey" | "ipTag"> {
	const { orderKey, ipTag: _t, ...rest } = o;
	const mask = (u: string) =>
		orderKey && typeof u === "string" ? u.split(orderKey).join("{ORDER_KEY}") : u;
	return { ...rest, successUrl: mask(rest.successUrl), cancelUrl: mask(rest.cancelUrl) };
}

export function toPublicOrder(id: string, d: OrderDoc): PublicOrder {
	return {
		id,
		status: d.status,
		items: d.items.map((i) => ({ title: i.title, qty: i.qty, unitPrice: i.unitPrice })),
		currency: d.currency,
		subtotal: d.subtotal,
		shipping: d.shipping,
		total: d.total,
		discount: d.discount,
		amountPaid: d.amountPaid,
		refundedAmount: d.refundedAmount,
		createdAt: d.createdAt,
		paidAt: d.paidAt,
	};
}
