/** Product sync: EmDash content -> `products` collection + initial stock. */
import type { PluginContext } from "emdash/plugin";
import { SCHEMA_VERSION, type ProductDoc } from "./model.js";
import { loadSettings, type Settings } from "./settings.js";
import { applyStock } from "./stock.js";
import { asId, asInt, asRecord, asString, coll, nowIso, toMinor } from "./util.js";

/** A content hook event, or one shaped like it (resync builds these from ctx.content reads). */
export type SyncEvent = { content?: Record<string, unknown>; collection?: string; id?: string };
export type SyncMode = "save" | "publish" | "off";

/** Same predicate as full Otta: a staged draft over live content. */
function pendingDraft(c: Record<string, unknown>): boolean {
	const d = c["draftRevisionId"];
	if (typeof d !== "string" || !d) return false;
	const l = c["liveRevisionId"];
	return typeof l === "string" && l ? l !== d : c["status"] === "published";
}

/**
 * Bridge calls: settings 1 + product read 1 + CAS 1 (+2 when stock is applied),
 * +2 per lost race (at most WRITE_ATTEMPTS attempts).
 */
const WRITE_ATTEMPTS = 4;

/** The product id an event is about (a delete or unpublish names it in `id`). */
function eventId(ev: SyncEvent, mode: SyncMode): string | null {
	return asId(mode === "off" ? ev.id : ev.content?.["id"]);
}

/** Pure: whether the event is a product event at all (no bridge calls). */
function eligible(ev: SyncEvent, mode: SyncMode): boolean {
	if (!eventId(ev, mode)) return false;
	const c = ev.content ?? {};
	return !(mode === "save" && pendingDraft(c) && c["status"] === "published");
}

/** Event time: the content's updatedAt; a delete carries none, so it is "now". */
export function eventAt(ev: SyncEvent, mode: SyncMode, now: string): string {
	const u = ev.content?.["updatedAt"];
	return (mode === "off" && !ev.content) || typeof u !== "string" || u === "" ? now : u;
}

/**
 * Nothing to do for an event at `at` against the stored product:
 *  - stale: older than the last applied event. On a tie, unpublish/delete win
 *    (failing to take a product off sale is the dangerous direction);
 *  - or an off event the product already records (inactive at this same time),
 *    whose write would change nothing but `updatedAt`.
 * contentAt only ever moves forward (every write is CAS-guarded and passes
 * this check), so a verdict of true stays true: a caller may decide it from an
 * earlier, unversioned read.
 */
export function settled(cur: ProductDoc | null, at: string, mode: SyncMode): boolean {
	if (cur?.contentAt == null) return false;
	// Resync's own "content not found" deactivation yields to live content at the same time.
	if (cur.orphaned === true && mode !== "off" && at >= cur.contentAt) return false;
	if (at < cur.contentAt || (at === cur.contentAt && mode !== "off")) return true;
	return mode === "off" && at === cur.contentAt && !cur.active;
}

export interface StepOptions {
	/** Product read + CAS attempts (default WRITE_ATTEMPTS). */
	attempts?: number;
	/** Stock read + CAS attempts (default: applyStock's). */
	stockAttempts?: number;
	/**
	 * When the content stock cannot be applied, write nothing and report
	 * "conflict", so the caller can retry the item. Hooks keep the default: the
	 * product still syncs (and logs a warning); the stock waits for the next
	 * content change.
	 */
	stockFirst?: boolean;
	/** Resync found no content for this product: off without moving its time. */
	orphan?: boolean;
}

export type StepResult =
	| { kind: "applied"; before: ProductDoc | null; after: ProductDoc }
	/** Stale, or already in this state: nothing written. */
	| { kind: "settled" }
	/** Not a product event: bad id, pending draft, another collection. */
	| { kind: "skipped" }
	/** Lost every write attempt (or, with stockFirst, the stock write). Nothing decided. */
	| { kind: "conflict" };

/**
 * The per-item step every product write goes through (hooks and resync), with
 * the settings already loaded. Throws on a bridge failure; every write is a
 * CAS, so a throw at any point leaves a consistent state to re-run.
 *
 * Bridge calls: product read 1 + CAS 1 (+2 for stock, at most 2 x
 * stockAttempts), +2 per lost race (at most `attempts` attempts), +1 warning
 * log when the stock is not applied and stockFirst is off.
 */
export async function syncProduct(
	ev: SyncEvent,
	s: Settings,
	ctx: PluginContext,
	mode: SyncMode,
	o: StepOptions = {},
): Promise<StepResult> {
	if (!eligible(ev, mode) || ev.collection !== s.productsCollection) return { kind: "skipped" };
	const id = eventId(ev, mode)!;
	const c = ev.content ?? {};
	const products = coll<ProductDoc>(ctx, "products");
	const now = nowIso();
	const at0 = eventAt(ev, mode, now);

	const live = mode === "publish" || (c["status"] === "published" && !pendingDraft(c));
	const d = asRecord(c["data"]);
	// With an invalid currency setting, never price in the fallback currency:
	// the product is synced unsellable and re-priced once the setting is fixed
	// and the product saved again.
	const price = s.currencyValid ? toMinor(d["price"], s.currency) : null;
	const tracked = d["stock"] !== undefined && d["stock"] !== null && d["stock"] !== "";
	const stock = tracked ? asInt(d["stock"], 0, 1_000_000) : null;
	let stockDone = false;
	let contentStock: number | null = null;

	// L4: a lost write is never a decision. Re-read, re-check staleness, retry.
	for (let attempt = 0; attempt < (o.attempts ?? WRITE_ATTEMPTS); attempt++) {
		const v = await products.getVersioned(id);
		const cur = v?.value ?? null;
		// An orphan deactivation keeps the product's own time (see ProductDoc.orphaned).
		const at = o.orphan && cur?.contentAt != null ? cur.contentAt : at0;
		if (o.orphan && cur?.orphaned === true && !cur.active) return { kind: "settled" };
		if (settled(cur, at, mode)) return { kind: "settled" };
		let next: ProductDoc;
		if (mode === "off") {
			// With no document yet, an inactive placeholder still records the
			// time, so a delayed older publish cannot put the product on sale.
			next = cur
				? { ...cur, active: false, contentAt: at, updatedAt: now, orphaned: o.orphan === true }
				: {
						v: SCHEMA_VERSION,
						productId: id,
						title: id,
						sku: null,
						price: null,
						currency: s.currency,
						active: false,
						trackStock: false,
						appliedContentStock: null,
						contentAt: at,
						updatedAt: now,
					};
		} else {
			if (tracked && live && stock !== null && !stockDone && attempt === 0) {
				// The stock document decides (its own CAS, ordered by the same time):
				// a crash or a stale event can never re-apply an old value over sales.
				const r = await applyStock(
					ctx,
					id,
					{
						kind: "contentSet",
						onHand: stock,
						at: typeof c["updatedAt"] === "string" ? c["updatedAt"] : "",
					},
					o.stockAttempts,
				);
				if (r.ok) {
					stockDone = true;
					contentStock = r.doc.contentStock;
				} else if (o.stockFirst) return { kind: "conflict" };
				else ctx.log?.warn?.("otta-core product sync: stock not applied", { id, code: r.code });
			}
			next = {
				v: SCHEMA_VERSION,
				productId: id,
				title: asString(d["title"]) ?? cur?.title ?? id,
				sku: asString(d["sku"]),
				price,
				currency: s.currency,
				active: live && price !== null && (!tracked || stock !== null),
				trackStock: tracked,
				appliedContentStock: !tracked
					? null
					: stockDone
						? contentStock
						: (cur?.appliedContentStock ?? null),
				contentAt: at,
				updatedAt: now,
			};
		}
		if ((await products.compareAndSet(id, v?.revision ?? null, next)).applied)
			return { kind: "applied", before: cur, after: next };
	}
	return { kind: "conflict" };
}

async function sync(ev: SyncEvent, ctx: PluginContext, mode: SyncMode): Promise<void> {
	try {
		// Checked before loading settings, so a non-product event costs no calls.
		if (!eligible(ev, mode)) return;
		const s = await loadSettings(ctx);
		const r = await syncProduct(ev, s, ctx, mode);
		if (r.kind === "conflict")
			ctx.log?.warn?.("otta-core product sync: too many concurrent writers", {
				id: eventId(ev, mode),
			});
	} catch (e) {
		ctx.log?.error?.("otta-core product sync failed", { error: String(e) });
	}
}

export const onAfterSave = (
	e: { content: Record<string, unknown>; collection: string; isNew?: boolean },
	ctx: PluginContext,
) => sync(e, ctx, "save");
export const onAfterPublish = (
	e: { content: Record<string, unknown>; collection: string },
	ctx: PluginContext,
) => sync(e, ctx, "publish");
export const onAfterUnpublish = (
	e: { content: Record<string, unknown>; collection: string },
	ctx: PluginContext,
) => sync({ ...e, id: String(e.content?.["id"] ?? "") }, ctx, "off");
export const onAfterDelete = (
	e: { id: string; collection: string; permanent?: boolean },
	ctx: PluginContext,
) => sync(e, ctx, "off");
