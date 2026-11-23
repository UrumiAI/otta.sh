/**
 * Resync products: re-derive every product document from EmDash content, the
 * repair for a dropped content hook or a changed `productsCollection` setting.
 *
 * It applies each item through the SAME step the hooks use (products.ts
 * syncProduct: same staleness rule, same pending-draft rule, same contentSet
 * stock guard), so a resync can never roll a product back, never resurrect one
 * that was unpublished or deleted later, and never re-apply a stock value over
 * sales. Safe to re-run at any time; a run with nothing to repair writes nothing.
 *
 * ctx.content.get/list (EmDash 1.5) return the content TABLE COLUMNS, which
 * always hold the live version: a draft edit to a published item is staged in
 * a revision (draftRevisionId) and only copied into the columns on publish. So:
 *   phase "content": page through the products collection; published -> publish
 *     semantics with the live data, anything else -> off.
 *   phase "orphans": page through Core's active `products` documents; deactivate
 *     any whose content no longer exists in the products collection (deleted,
 *     trashed, or the setting now names another collection) or is not published.
 *
 * Bridge budget (the sandbox allows 30 per invocation; every ctx.* call counts,
 * ctx.log included). The route meters its own calls and reserves an item's
 * worst case before starting it, stopping mid-page with a resume cursor:
 *   content:  settings 1 + list 1 + products getMany 1 = 3 fixed; an item the
 *             getMany shows is already settled costs 0; one that needs work
 *             costs at most 8 (product read 1 + stock 2 x 2 + CAS 1 + one
 *             lost race 2), typically 2 (untracked) or 4 (tracked).
 *   orphans:  settings 1 + products query 1 = 2 fixed; an inactive product
 *             costs 0, an active one content get 1, plus at most 4 when it is deactivated
 *             (2 attempts x read + CAS), typically 2.
 *   Items start only while used + worst case <= BUDGET (27), leaving 3 calls:
 *   one for the error log and 2 of margin. So a call never exceeds 28.
 */
import type { PluginContext } from "emdash/plugin";
import type { ProductDoc } from "./model.js";
import {
	eventAt,
	settled,
	syncProduct,
	type StepOptions,
	type StepResult,
	type SyncMode,
} from "./products.js";
import { loadSettings } from "./settings.js";
import { asId, asRecord, coll, fail, nowIso } from "./util.js";

export const BRIDGE_LIMIT = 30;
/** Calls an item may start under; the rest is the error log (1) and margin (2). */
export const BUDGET = 27;
/** Content items per list page (settled ones cost nothing past the getMany). */
export const CONTENT_PAGE = 20;
/** Products per orphan page (inactive ones cost nothing; the meter stops early when many need work). */
export const ORPHAN_PAGE = 20;
/** Tighter than the hooks' retries (a lost race resumes at the item on the next call). */
const STEP: StepOptions = { attempts: 2, stockAttempts: 2, stockFirst: true };
const WORST_CONTENT_ITEM = 8;
const WORST_ORPHAN_ITEM = 5;

type Phase = "content" | "orphans";
type ContentItem = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>>;

/** Our cursor: the host cursor of the page plus the last item done on it. */
interface Token {
	p: Phase;
	c: string | null;
	a: string | null;
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (t: Token) => b64url(JSON.stringify(t));
function decode(s: string): Token | null {
	try {
		const t = asRecord(JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
		const p = t["p"];
		const c = t["c"];
		const a = t["a"];
		if (p !== "content" && p !== "orphans") return null;
		if (c !== null && (typeof c !== "string" || c.length > 2000)) return null;
		if (a !== null && asId(a) === null) return null;
		return { p, c: c as string | null, a: a as string | null };
	} catch {
		return null;
	}
}

/** ctx with every method call counted (over-counts local helpers such as url(): safe). */
function metered(ctx: PluginContext) {
	let n = 0;
	const wrap = <T extends object>(o: T): T =>
		new Proxy(o, {
			get(t, k) {
				const v = Reflect.get(t, k) as unknown;
				if (typeof v === "function")
					return (...a: unknown[]) => {
						n++;
						return (v as (...x: unknown[]) => unknown).apply(t, a);
					};
				return v !== null && typeof v === "object" ? wrap(v) : v;
			},
		});
	return { ctx: wrap(ctx), used: () => n };
}

export interface ResyncResult {
	ok: true;
	phase: Phase;
	/** Product documents written by this call. */
	synced: number;
	/** Of those, products taken off sale (active before, inactive after). */
	deactivated: number;
	/** Pass back with nextPhase; null = start of that phase. */
	nextCursor: string | null;
	/** The phase to call next; null = the resync is complete. */
	nextPhase: Phase | null;
}

/** Private route `products/resync`. Input `{ cursor?, phase? = "content" }`. */
export async function resyncProducts(input: unknown, ctx: PluginContext) {
	const i = asRecord(input);
	const phase = i["phase"] ?? "content";
	if (phase !== "content" && phase !== "orphans")
		return fail("BAD_INPUT", 'phase must be "content" or "orphans"');
	let tok: Token = { p: phase, c: null, a: null };
	if (i["cursor"] != null) {
		const t =
			typeof i["cursor"] === "string" && i["cursor"].length <= 4000 ? decode(i["cursor"]) : null;
		if (!t || t.p !== phase)
			return fail(
				"BAD_INPUT",
				"cursor is not valid for this phase. Pass back the nextCursor you got together with its nextPhase.",
			);
		tok = t;
	}
	if (!ctx.content)
		return fail(
			"NOT_AVAILABLE",
			"Resync needs permission to read your content (content:read), and it has not been granted. Approve it in the plugin's permissions, then run resync again.",
		);
	try {
		const m = metered(ctx);
		return phase === "content" ? await contentPhase(m, tok) : await orphanPhase(m, tok);
	} catch (e) {
		try {
			await ctx.log?.error?.("otta-core resync failed", { phase, error: String(e) });
		} catch {
			// The answer below matters more than the log.
		}
		// Every write is a CAS: re-running from the same cursor is safe.
		return {
			...fail(
				"RESYNC_FAILED",
				"Resync stopped part way. Nothing is lost: run it again with the same phase and cursor.",
			),
			phase,
			cursor: i["cursor"] ?? null,
		};
	}
}

type Meter = ReturnType<typeof metered>;
type Tally = { synced: number; deactivated: number };

function count(r: StepResult, t: Tally) {
	if (r.kind !== "applied") return;
	t.synced++;
	if (r.before?.active === true && !r.after.active) t.deactivated++;
}

/** Where to start on a re-listed page: after the last item done (or the top, if it is gone). */
const startOf = (ids: string[], after: string | null) =>
	after === null ? 0 : ids.indexOf(after) + 1;

async function contentPhase(m: Meter, tok: Token): Promise<ResyncResult> {
	const s = await loadSettings(m.ctx);
	const page = await m.ctx.content!.list(s.productsCollection, {
		limit: CONTENT_PAGE,
		orderBy: { createdAt: "desc" },
		...(tok.c ? { cursor: tok.c } : {}),
	});
	const items = page.items;
	const from = startOf(
		items.map((x) => x.id),
		tok.a,
	);
	const known = await coll<ProductDoc>(m.ctx, "products").getMany(
		items
			.slice(from)
			.map((x) => x.id)
			.filter((id) => asId(id) !== null),
	);
	const t: Tally = { synced: 0, deactivated: 0 };
	const now = nowIso();
	for (let k = from; k < items.length; k++) {
		const item = items[k]!;
		const mode: SyncMode = item.status === "published" ? "publish" : "off";
		const ev = {
			content: item as unknown as Record<string, unknown>,
			collection: s.productsCollection,
			id: item.id,
		};
		// Free pre-filter, same rule as the step (a settled verdict cannot go stale).
		if (settled(known.get(item.id) ?? null, eventAt(ev, mode, now), mode)) continue;
		const resume = {
			ok: true as const,
			phase: "content" as const,
			...t,
			nextPhase: "content" as const,
		};
		if (m.used() + WORST_CONTENT_ITEM > BUDGET)
			return {
				...resume,
				nextCursor: encode({ p: "content", c: tok.c, a: k > 0 ? items[k - 1]!.id : null }),
			};
		const r = await syncProduct(ev, s, m.ctx, mode, STEP);
		// A lost race: nothing decided; the next call starts at this item.
		if (r.kind === "conflict")
			return {
				...resume,
				nextCursor: encode({ p: "content", c: tok.c, a: k > 0 ? items[k - 1]!.id : null }),
			};
		count(r, t);
	}
	const more = page.hasMore && !!page.cursor;
	return {
		ok: true,
		phase: "content",
		...t,
		nextCursor: more ? encode({ p: "content", c: page.cursor!, a: null }) : null,
		nextPhase: more ? "content" : "orphans",
	};
}

async function orphanPhase(m: Meter, tok: Token): Promise<ResyncResult> {
	const s = await loadSettings(m.ctx);
	// Unordered query: a keyset cursor on (created_at, id). No `active` filter:
	// the host binds no booleans in a where (SQLite/D1 refuse them), and
	// inactive products are skipped below for free.
	const page = await coll<ProductDoc>(m.ctx, "products").query({
		limit: ORPHAN_PAGE,
		...(tok.c ? { cursor: tok.c } : {}),
	});
	const items = page.items;
	const from = startOf(
		items.map((x) => x.id),
		tok.a,
	);
	const t: Tally = { synced: 0, deactivated: 0 };
	for (let k = from; k < items.length; k++) {
		const id = items[k]!.id;
		// Only a product on sale can need taking off.
		if (!items[k]!.data.active) continue;
		const resume = {
			ok: true as const,
			phase: "orphans" as const,
			...t,
			nextPhase: "orphans" as const,
		};
		const here = () => encode({ p: "orphans", c: tok.c, a: k > 0 ? items[k - 1]!.id : null });
		if (m.used() + WORST_ORPHAN_ITEM > BUDGET) return { ...resume, nextCursor: here() };
		const item: ContentItem | null = asId(id)
			? await m.ctx.content!.get(s.productsCollection, id)
			: null;
		// Published content is live: phase "content" owns it.
		if (item && item.status === "published") continue;
		// Unpublished: off at its own updatedAt. Not found (deleted, or the setting
		// names another collection): off WITHOUT moving the product's time, marked
		// orphaned, so a later resync (or publish) of live content can restore it.
		const ev = item
			? {
					content: item as unknown as Record<string, unknown>,
					collection: s.productsCollection,
					id,
				}
			: { collection: s.productsCollection, id };
		const r = await syncProduct(ev, s, m.ctx, "off", item ? STEP : { ...STEP, orphan: true });
		if (r.kind === "conflict") return { ...resume, nextCursor: here() };
		count(r, t);
	}
	const more = page.hasMore && !!page.cursor;
	return {
		ok: true,
		phase: "orphans",
		...t,
		nextCursor: more ? encode({ p: "orphans", c: page.cursor!, a: null }) : null,
		nextPhase: more ? "orphans" : null,
	};
}
