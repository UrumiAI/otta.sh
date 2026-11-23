/**
 * Stock: one document per tracked product; every write is ONE compareAndSet
 * that carries the guard, the movement and the record of who applied it (L1).
 *
 *  - reserve(order)   adds `holds[order]`; refused when available < qty.
 *  - commit(order)    the sale. With a hold: the hold becomes the sale (drop it,
 *                     take qty off on-hand). Without one: nothing, unless the
 *                     order is an UNHELD sale (paid after its holds were
 *                     released), recorded permanently in `sold[order]`.
 *  - release(order)   drops the hold and tombstones `<order>:x`.
 *  - set              merchant sets on-hand. From content: applied only when
 *                     the content is newer and its value differs (the value and
 *                     its timestamp live in this same document, so the decision
 *                     and the write are one CAS). From MCP: a one-off key.
 *
 * Idempotency never depends on the bounded `applied` ring for a SALE: a held
 * sale is guarded by the hold itself (gone once applied), an unheld sale by
 * `sold` (never evicted, and only late payments use it). The ring only carries
 * release tombstones and one-off set keys, where an evicted record can at worst
 * leave a stale reserve's hold for the order's own completion to clean up.
 *
 * The ORDER document decides which of commit/release happens (L3); this module
 * only makes each step exactly-once. A lost race re-reads (L4).
 */
import type { PluginContext } from "emdash/plugin";
import { SCHEMA_VERSION, type StockDoc } from "./model.js";
import { coll, nowIso } from "./util.js";

/** Tombstones and set keys remembered per product. */
const RING = 200;
const ATTEMPTS = 5;

export type StockOp =
	| { kind: "reserve"; orderId: string; qty: number }
	| { kind: "commit"; orderId: string; qty: number; unheld?: boolean }
	| { kind: "release"; orderId: string }
	/** expected: the on-hand the caller last saw; a different value refuses (STOCK_CHANGED). */
	| { kind: "set"; key: string; onHand: number; expected?: number }
	| { kind: "contentSet"; onHand: number; at: string };

export type StockResult =
	| { ok: true; doc: StockDoc; applied: boolean }
	| { ok: false; code: "OUT_OF_STOCK" | "CONFLICT" | "STOCK_CHANGED" };

export const emptyStock = (productId: string): StockDoc => ({
	v: SCHEMA_VERSION,
	productId,
	onHand: 0,
	holds: {},
	sold: {},
	contentStock: null,
	contentAt: null,
	applied: [],
	updatedAt: nowIso(),
});

export const held = (d: StockDoc): number => Object.values(d.holds).reduce((a, b) => a + b, 0);

export const available = (d: StockDoc | null): number => (d ? Math.max(0, d.onHand - held(d)) : 0);

/**
 * The next document, "noop" when there is nothing to do, null when out of
 * stock, or "changed" when a set's expected on-hand no longer holds.
 */
export function applyOp(doc: StockDoc, op: StockOp): StockDoc | "noop" | "changed" | null {
	const has = (id: string) => doc.applied.includes(id);
	const holds = { ...doc.holds };
	const sold = { ...doc.sold };
	let { onHand } = doc;
	let { contentStock, contentAt } = doc;
	let record: string | null = null;
	if (op.kind === "reserve") {
		const o = op.orderId;
		if (o in holds || o in sold || has(`${o}:x`) || has(`${o}:c`)) return "noop";
		if (onHand - held(doc) < op.qty) return null;
		holds[op.orderId] = op.qty;
	} else if (op.kind === "commit") {
		const o = op.orderId;
		const h = holds[o];
		if (op.unheld) {
			// A late sale: `sold` is its permanent record, whether or not a hold
			// was still there to convert, so a replay can never take it twice.
			if (o in sold) return "noop";
			sold[o] = h ?? op.qty;
			delete holds[o];
			onHand -= h ?? op.qty;
		} else if (h !== undefined) {
			delete holds[o];
			onHand -= h;
			// Tombstone for stale reserves only; the sale itself is guarded by the hold.
			record = `${o}:c`;
		} else return "noop";
	} else if (op.kind === "release") {
		record = `${op.orderId}:x`;
		if (!(op.orderId in holds) && has(record)) return "noop";
		delete holds[op.orderId];
	} else if (op.kind === "set") {
		record = `set:${op.key}`;
		if (has(record)) return "noop";
		if (op.expected !== undefined && op.expected !== doc.onHand) return "changed";
		onHand = op.onHand;
	} else {
		// A host that sends no updatedAt ("") cannot order events; fall back to value-change.
		if (op.at !== "" && contentAt != null && op.at <= contentAt) return "noop";
		if (op.at === "" && op.onHand === contentStock) return "noop";
		if (op.onHand !== contentStock) onHand = op.onHand;
		contentStock = op.onHand;
		contentAt = op.at;
	}
	const applied =
		record === null || has(record) ? doc.applied : [...doc.applied, record].slice(-RING);
	return {
		...doc,
		v: SCHEMA_VERSION,
		onHand,
		holds,
		sold,
		contentStock,
		contentAt,
		applied,
		updatedAt: nowIso(),
	};
}

/**
 * Two bridge calls in the common case: one read, one conditional write.
 * At most 2 x `attempts` (default ATTEMPTS); a caller with a tight bridge
 * budget (resync) passes fewer.
 */
export async function applyStock(
	ctx: PluginContext,
	productId: string,
	op: StockOp,
	attempts: number = ATTEMPTS,
): Promise<StockResult> {
	const stock = coll<StockDoc>(ctx, "stock");
	for (let i = 0; i < attempts; i++) {
		const cur = await stock.getVersioned(productId);
		const doc = cur?.value ?? emptyStock(productId);
		const next = applyOp(doc, op);
		if (next === "noop") return { ok: true, doc, applied: false };
		if (next === null) return { ok: false, code: "OUT_OF_STOCK" };
		if (next === "changed") return { ok: false, code: "STOCK_CHANGED" };
		const w = await stock.compareAndSet(productId, cur?.revision ?? null, next);
		if (w.applied) return { ok: true, doc: next, applied: true };
	}
	return { ok: false, code: "CONFLICT" };
}
