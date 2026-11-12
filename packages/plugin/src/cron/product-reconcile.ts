/**
 * PRODUCT RECONCILE (issue #95): the `product-reconcile` sweep leg, which
 * re-derives `product_commerce` from the PUBLISHED CMS content for every product
 * whose sync was lost.
 *
 * WHY A SWEEP. Every content hook is fire-and-forget: commerce runs in-process on
 * `ctx.storage` now, so the risk is a failed storage write, not a network hop — but
 * such a write is still lost, and nothing else retries it. Publish atomicity made
 * the cost visible: a save of LIVE content sends nothing, so a row left behind is
 * no longer healed by the merchant's next save. The states this repairs:
 *
 *  - FIRST PUBLISH LOST (fail-closed): the product is content-live but has no row,
 *    or an inactive one — listed, unbuyable. Repaired: the row is created and
 *    activated.
 *  - A PUBLISH OF PENDING CHANGES LOST: the row is active with the OLD title (the
 *    value an order line snapshots), its sync watermark behind the content's.
 *    Repaired: the live title is written at the content's watermark.
 *  - A LEAKED DRAFT TITLE whose draft was then DISCARDED (`handleContentDiscardDraft`
 *    fires no plugin hook): the row carries a title no published content ever had,
 *    often at a watermark NEWER than the live content's (the draft save's).
 *    Repaired from the live content — never the draft — at the row's own
 *    watermark, which an equal watermark is allowed to overwrite and any genuinely
 *    newer publish still beats.
 *  - A LOST UNPUBLISH: the row is active while the document is not published.
 *    Repaired: deactivated at the document's watermark under the unpublish key.
 *  - A LOST VARIANT SYNC on a published product: a declared size missing, a
 *    dropped one still live, a name out of date (`variantsDrift`).
 *
 * OUT OF SCOPE, stated so nobody has to discover it:
 *  - A LEAKED PRICE from before PR 1b. The sync carries no commercial field any
 *    more, and the published content holds no price to compare against, so a row
 *    that took a leaked draft price keeps it: that is a merchant/admin repair
 *    (Pricing & inventory), not something this sweep can derive.
 *  - A VARIANT ORPHANED BY A LEAKED DRAFT that the live repeater still declares.
 *    The orphan carries the draft save's watermark, and a declare resurrects only
 *    on a STRICTLY newer one, so no sync from the older live content can bring it
 *    back; `variantsDrift` does not report it, so the sweep does not retry it
 *    every pass. Publishing the product again (a newer watermark) resurrects it.
 *
 * THE REPAIR IS THE PUBLISH. A published product out of sync runs `syncLiveProduct`
 * — the very function `content:afterPublish` runs, with its derivation, its
 * idempotency keys, its fail-closed upsert-then-activate and its variant
 * projection — on the content `ctx.content` returns. That is the LIVE content:
 * EmDash's `get`/`list` read the content table's columns, and on a
 * revision-supporting collection a draft lives only in its revision until it is
 * published (the draft is hydrated into `data` by the admin API and the save hook,
 * never by `ctx.content`). The sync carries no commercial field at all (PR 1b), so
 * a repair can never put a price live, and it never touches an order: orders
 * snapshot their own price and title.
 *
 * THE LIST NOMINATES; EACH REPAIR READS ITS OWN ROW, THEN ITS DOCUMENT. The page is
 * listed BEFORE its rows are read, so a publish (or unpublish) that lands between
 * the two leaves a stale document beside a fresh row. Planned from that pair, the
 * sync would run at the fresh row's NEWER watermark with the stale content: the
 * title reverted, a size the publish just added orphaned at the publish's own
 * watermark (which a later declare at that watermark cannot resurrect), its sku
 * claim released. So the list only nominates, and each repair is planned afresh
 * from a read of the product's row and THEN of its document: a publish landing
 * between those two leaves a NEWER document beside an older row, and the sync runs
 * at the newer watermark with the newer content — the publish's own write. The same
 * fresh read keeps a repair from activating a product unpublished since the list
 * (its `afterUnpublish` deactivate is a no-op on a row already inactive, so it
 * stamps no gate watermark that would otherwise outrank the activate).
 *
 * THE FLIP WINDOW, AND THE CHECK THAT CLOSES IT. One window is left between the
 * repair's document read and its activate (or deactivate): a merchant unpublish
 * (or republish) landing there finds the row not yet in the state the repair then
 * puts it in, so the hook's own flip is a no-op that stamps nothing, and the repair's
 * flip then leaves the product wrongly buyable (or wrongly unbuyable). So every
 * repair leaves its product nominated, to be CHECKED on its next visit — later in
 * the same tick when the budget allows, else the next tick the leg runs — by the same
 * row-then-document read: a repair that held is counted then; a document that moved
 * meanwhile is repaired again from the current content at its own watermark (the
 * corrective flip); a repair that did not hold on an unchanged document is an
 * anomaly. The wrong state therefore lasts until that visit — not until the next
 * pass. It also assumes both reads see the PRIMARY (one D1 session): with read
 * replication (issue #490) a replica's older document could pass for the current
 * one, and the ordering argument here must be revisited before that is enabled.
 *
 * WHAT IT NEVER DOES:
 *  - activate a product the content does not say is PUBLISHED, or write a
 *    not-published product's title (its columns are not the draft the merchant
 *    saved; an inactive row's title is not on sale) — as of its read of the
 *    document: an unpublish landing between that read and the activate leaves the
 *    product buyable until the repair's check visit (THE FLIP WINDOW, above);
 *  - resurrect a tombstone (a row soft-deleted while its document lives is the
 *    delete/restore paths' business, and `activate` refuses one anyway);
 *  - overrule a NEWER lifecycle event: every flip is watermarked, so an unpublish
 *    that lands after the re-read beats the activate whatever the order, and a flip
 *    the stored gate watermark already outranks is not even attempted;
 *  - write anything for a product already in sync: the decision is made from the
 *    document and the row in hand, so an in-sync catalogue costs only its pages.
 *
 * STALENESS, precisely, for a published document at watermark W (its `updatedAt`,
 * normalized), against a LIVE row R:
 *  - R.contentUpdatedAt is null or older than W (a lost publish or save);
 *  - R's title (or title rejection) differs from what `deriveContent` makes of the
 *    live content (a leaked or lost title, at whatever watermark);
 *  - R is inactive, and R's gate watermark does not outrank the sync's;
 *  - the live repeater and R's variants disagree (`variantsDrift`).
 * The sync then runs at max(W, R.contentUpdatedAt): never older than what the row
 * holds (so a leaked draft's newer watermark cannot refuse the repair) and never
 * newer than anything the CMS or the row has actually said.
 *
 * A REPAIR IS COUNTED ONLY WHEN IT HELD. The check visit (above) plans the fresh
 * row against the fresh document: only a product that is now in sync counts as
 * repaired. One that is not, on an unchanged document — a variant write that failed
 * and was swallowed, a guarded no-op — is an ANOMALY, logged as "attempted, still out
 * of sync", never as "re-synced".
 *
 * BOUNDED AND RESUMABLE, AND ALWAYS MOVING. One CMS page (`RECONCILE_PAGE_SIZE`) at
 * a time, behind the host's own keyset cursor (`createdAt DESC, id`), kept in
 * `ctx.kv`; each page's rows are read in `RECONCILE_ROW_READ_QUERIES` `in` reads;
 * each repair is gated on its measured cost. The page's NOMINATED products are kept
 * in the cursor document, and a run the budget stops part-way resumes them by id —
 * the page is listed ONCE a pass, whatever it costs to repair. Each product leaves
 * the nominated set when its repair has been ATTEMPTED — repaired, failed, or left
 * out of sync — so a product a repair cannot fix never costs another run its unit
 * and the walk cannot wedge on it. The attempt is saved BEFORE the repair, so even a
 * repair the tick's ceiling cuts short is counted: one cut short
 * `RECONCILE_MAX_INTERRUPTS` times in a row is stepped past, logged. The end of the
 * catalogue completes the pass; the next starts `reconcilePassIntervalMs` after this
 * one STARTED, and every product stepped past is tried again then. A lost or garbled
 * cursor restarts the pass — a re-read, never a wrong write.
 *
 * D1 ROWS READ, the cost that matters on Workers Free. EmDash's `findMany` runs an
 * unbounded `COUNT(*)` over the whole collection beside every page, so a pass over N
 * products reads about N·⌈N/100⌉ rows for the counts, N for the pages and N for the
 * commerce rows — about N²/100 + 2N — plus a handful per product repaired. Hence the
 * page size (100), the list-once rule above, and the pass interval.
 *
 * D1 ROWS WRITTEN, the other Free limit. A repair writes about 150 rows (see
 * `RECONCILE_REPAIRS_PER_DAY_FREE`), so on Workers Free the leg makes at most 200
 * syncs a UTC day, counted in the cursor document in thirds of a repair (a lost
 * unpublish's deactivation, one document write, spends one third), with a reserve of
 * thirty more units only deactivations may spend. A capped day keeps the pass exactly
 * where it is — its start, its page, its nominated products — and the walk waits
 * until 00:00 UTC. Meanwhile, while a deactivation still fits, a separate LAP lists
 * the whole catalogue once per pass interval for lost unpublishes alone (THE SCAN FOR
 * LOST UNPUBLISHES, in `reconcileProductCommerce`), so a withdrawn product is not left
 * on sale behind the first syncs. It reads what a pass reads (about N²/100 + 2N rows)
 * and writes only the cursor document and its deactivations.
 */
import { InProcessCommerceClient } from "../commerce/in-process-commerce-client.js";
import { ALLOWED_HOSTS } from "../manifest.js";
import {
	deriveSaveIdempotencyKey,
	deriveUnpublishIdempotencyKey,
} from "../sync/derive-idempotency-key.js";
import {
	deriveContent,
	PRODUCTS_COLLECTION,
	PUBLISHED_STATUS,
	syncLiveProduct,
	titleHeld,
	type LiveSyncOutcome,
	type TitleStateView,
} from "../sync/hooks.js";
import { normalizeWatermark } from "../sync/normalize-watermark.js";
import { variantsDrift, type StoredVariantView } from "../sync/variants.js";
import type { ContentReadAccess, PluginContext } from "../types.js";
import {
	CONTENT_LIST_QUERIES,
	CONTENT_READ_QUERIES,
	isInvalidCursorError,
} from "./content-reads.js";
import {
	BACKGROUND_WORK_PRESETS,
	WORKERS_FREE_MAX_QUERY_BUDGET,
} from "./background-work-setting.js";
import type { SweepCursorStore } from "./sweep-cursor-store.js";
import { isSweepQueryCeilingError, type LegBudget } from "./tick-budget.js";

/** The Paid preset's query budget (`BACKGROUND_WORK_PRESETS`). */
const PAID_PRESET_QUERIES = Math.max(...BACKGROUND_WORK_PRESETS.map((preset) => preset.value));

/** The leg's place between ticks, in the sweep's cursor store. */
export const PRODUCT_RECONCILE_CURSOR = "product-reconcile";

/**
 * Products per CMS page: the most EmDash 1.3's `ContentRepository.findMany` returns
 * (it clamps `limit` to 100). The page size is the ROWS-READ lever, not the query
 * lever: every page runs, beside the page query, an unbounded
 * `COUNT(*) … WHERE deleted_at IS NULL` over the whole collection
 * (`countWithResolvedFilters`), so a pass over N products reads about N²/P rows for
 * the counts alone. 100 halves that against 50. The cost is one more query a page:
 * the commerce rows' `in` read is split at `RECONCILE_IN_BATCH`.
 */
export const RECONCILE_PAGE_SIZE = 100;

/** The most products the cursor document keeps nominated: a page's own, and as
 *  many again found by the lap for lost unpublishes (which lists no page while more
 *  than a page's worth are nominated, so a page it adds stays under this). A release
 *  from before #664 parses only the first 100: the walk's own nominations come first
 *  and the lap's are appended after them, so a rollback drops only lap nominations,
 *  which the next lap finds again. */
const RECONCILE_MAX_PENDING = 2 * RECONCILE_PAGE_SIZE;

/**
 * Ids per commerce-row `in` read: D1 binds at most 100 parameters a statement and
 * the host binds `plugin_id`, `collection` and the `limit` beside the values, so a
 * page of 100 ids is over it — the store's own `IN_BATCH` (50, issue #578).
 */
export const RECONCILE_IN_BATCH = 50;

/** The `in` reads one page's commerce rows take. */
export const RECONCILE_ROW_READ_QUERIES = Math.ceil(RECONCILE_PAGE_SIZE / RECONCILE_IN_BATCH);

/**
 * What one PAGE costs: the CMS list (`CONTENT_LIST_QUERIES`), the page's commerce
 * rows (`RECONCILE_ROW_READ_QUERIES`), and the cursor write that saves the place past
 * it. An in-sync page costs exactly this and writes nothing else.
 */
export const RECONCILE_PAGE_QUERIES = CONTENT_LIST_QUERIES + RECONCILE_ROW_READ_QUERIES + 1;

/**
 * The gap between the STARTS of two passes. A pass is not cheap in D1 ROWS READ even
 * when it is cheap in queries: its counts read about N²/100 rows (see
 * `RECONCILE_PAGE_SIZE`) — 250 000 for a 5 000-product catalogue, a million for
 * 10 000 — and D1's Free plan allows 5 000 000 rows read a day for the whole store.
 * Measured from the pass's START, so a pass that runs long cannot pull the next one
 * closer, and an unfinished pass still resumes every tick until it ends.
 *  - Workers Free (any budget below the Paid preset): 24 hours. A 10 000-product
 *    catalogue then costs about a fifth of the day's rows; at 6 hours it would cost
 *    four fifths, which is an outage of every D1 query (storefront, checkout,
 *    admin) waiting for one more busy day.
 *  - Workers Paid (the Paid preset and up): 6 hours. Paid D1 includes 25 billion
 *    rows read a month (about 800 million a day), so four passes a day of even a
 *    10 000-product catalogue (about 4 million rows) are noise, and a lost sync
 *    heals within a quarter of a day.
 * A merchant who sees a product out of sync does not wait for either: "Publish
 * changes" repairs it at once.
 */
export const RECONCILE_PASS_INTERVAL_FREE_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_PASS_INTERVAL_PAID_MS = 6 * 60 * 60 * 1000;

/** The pass interval for a tick's query budget: the Paid interval from the Paid
 *  preset up (`BACKGROUND_WORK_PRESETS`), the Free one below it. */
export function reconcilePassIntervalMs(queryBudget: number): number {
	return queryBudget >= PAID_PRESET_QUERIES
		? RECONCILE_PASS_INTERVAL_PAID_MS
		: RECONCILE_PASS_INTERVAL_FREE_MS;
}

/**
 * At most this many repairs a UTC day at any budget Workers Free can run
 * (`WORKERS_FREE_MAX_QUERY_BUDGET`, 50, or less), counted in the leg's cursor
 * document. D1 Free allows 100,000 rows written a day, and once a store passes it
 * every write fails — add-to-cart and checkout included — until the UTC reset.
 *
 * What a repair writes, by DEPLOYMENT.md's index-row model: every `_plugin_storage`
 * document write is about 52 rows written (the row, its primary-key autoindex, the
 * host's list index and Otta's 49 declared expression indexes, none of them
 * partial), and a sync is about three document writes (the upsert, the activate,
 * the variant write) plus its sku claims — about 156 rows a product. 200 repairs is
 * then about 31,000 rows written a day, and the deactivations' reserve
 * (`RECONCILE_DEACTIVATION_RESERVE_UNITS`) about 1,600 more. Beside `prune-carts`' own
 * cap (`ABANDONED_CARTS_PER_DAY_FREE`, about 31,000) and the reporting backfill's
 * (`REPORTING_BACKFILL_DAYS_PER_DAY_FREE`, about 16,000–21,000), all three at once
 * write about 85,000–90,000, which leaves the store's traffic about 10,000–15,000. On
 * the deploy day of a new index layout all three spend nothing (`indexBuildHold`).
 * Without it a first install over an existing catalogue — every product
 * without a row — heals at the leg's pace, about 460 repairs a day measured, about
 * 70,000 rows written a day, for as many days as that takes. With it a catalogue of
 * N products missing their rows heals in N / 200 days ("Publish changes" repairs any
 * one product at once).
 *
 * Counted when a repair's writes are SENT (a sync or a deactivation) — not for a
 * check visit, a product found in sync, or a plan the upsert would replay — and
 * saved even when the tick's ceiling stops the run part-way through the writes.
 * Overlapping ticks (each reads the count before either writes it) can pass the cap
 * by one run's repairs. Paid has no daily rows-written limit, so a larger budget has
 * no cap.
 */
export const RECONCILE_REPAIRS_PER_DAY_FREE = 200;

/**
 * Deactivations that count as ONE repair against the day's cap (issue #664). A lost
 * unpublish's deactivation is one document write (about 52 rows written), a sync
 * about three (about 156), so three of them write what one sync does. The day's
 * count is therefore kept in UNITS of a third of a repair (`reconcileCostUnits`): a
 * sync spends three, a deactivation one, against a cap of
 * `RECONCILE_REPAIRS_PER_DAY_FREE` × 3. Counted at that share rather than not at all,
 * so a run of lost unpublishes stays inside the same rows-written bound.
 *
 * Why a deactivation is worth the special case: a lost unpublish leaves a withdrawn
 * product ON SALE, while a lost publish only leaves one off sale (fail-closed). So a
 * page's deactivations are nominated before its syncs, deactivations keep a reserve
 * no sync can spend (`RECONCILE_DEACTIVATION_RESERVE_UNITS`), and while the cap holds
 * the walk the leg runs a LAP over the catalogue for lost unpublishes
 * (`reconcileProductCommerce`).
 */
export const RECONCILE_DEACTIVATIONS_PER_REPAIR = 3;

/**
 * Units of the day's count (thirds of a repair) that only deactivations may spend, ON
 * TOP of the syncs' `RECONCILE_REPAIRS_PER_DAY_FREE` × 3. A first-install day is spent
 * entirely by syncs; without a reserve the cap would then have no room left for the
 * deactivation of a lost unpublish, and the lap that finds one would never start.
 * Thirty units are thirty deactivations, about 1,560 rows written (ten syncs' worth):
 * the leg's daily bound is about 31,200 + 1,560 ≈ 32,800 rows written. Syncs spend at
 * most `RECONCILE_REPAIRS_PER_DAY_FREE` × 3 of the total; deactivations spend any of it.
 */
export const RECONCILE_DEACTIVATION_RESERVE_UNITS = 30;

/** What one repair of `kind` spends of the day's cap, in thirds of a repair. */
export function reconcileCostUnits(kind: "sync" | "deactivate"): number {
	return kind === "sync" ? RECONCILE_DEACTIVATIONS_PER_REPAIR : 1;
}

/** The daily repair cap for a tick whose query budget is `queryBudget`: the Free
 *  cap at any budget Workers Free can run, none above it — the threshold
 *  `prune-carts`' daily cap uses (`ABANDONED_CARTS_CAPPED_BUDGET`). */
export function reconcileRepairsDailyCap(queryBudget: number): number | null {
	return queryBudget <= WORKERS_FREE_MAX_QUERY_BUDGET ? RECONCILE_REPAIRS_PER_DAY_FREE : null;
}

/**
 * The leg's entry (`LEG_QUERY_COSTS`): the cursor read, the page's list and its row
 * reads. The cursor write that closes the walk is paid from the leg's reserve
 * (`legReserveQueries`: a maintenance leg keeps two calls back for its trailing
 * writes); a write between pages is inside the next page's gate
 * (`RECONCILE_PAGE_QUERIES`).
 */
export const PRODUCT_RECONCILE_ENTRY_QUERIES =
	1 + CONTENT_LIST_QUERIES + RECONCILE_ROW_READ_QUERIES;

/** The writes of a sync (`syncLiveProduct`): the upsert's versioned read and
 *  compare-and-set, the activate's, and — for a document with a repeater — the one
 *  variant write's. */
export const SYNC_WRITE_CALLS = 6;

/** The writes of a deactivation: its versioned read and compare-and-set. */
export const DEACTIVATE_WRITE_CALLS = 2;

/** What every visit to a nominated product reads before it decides anything: the
 *  cursor write that records the attempt, then the product's row, then its document
 *  (`CONTENT_READ_QUERIES`). */
const VISIT_READ_CALLS = 1 + 1 + CONTENT_READ_QUERIES;

/**
 * The calls one repair of a PUBLISHED product makes at most, measured in
 * `cron-product-reconcile.test.ts` ("the cost table"): the visit's reads (5) and the
 * sync's writes (6). Eleven, and no headroom on top: the leg must START inside an
 * idle Workers Free tick (its entry plus one unit, beside the tick's own reads and the
 * reserve — `cron-leg-costs.test.ts`). A repair that costs more — a compare-and-set
 * retry, a variant write releasing sku claims — is what the tick's ceiling is for:
 * the attempt is recorded before the repair, and one cut short
 * `RECONCILE_MAX_INTERRUPTS` times in a row is stepped past.
 */
export const PRODUCT_RECONCILE_REPAIR_CALLS = VISIT_READ_CALLS + SYNC_WRITE_CALLS;

/** A lost unpublish's repair: the visit's reads and the deactivation's writes. */
export const PRODUCT_RECONCILE_DEACTIVATE_CALLS = VISIT_READ_CALLS + DEACTIVATE_WRITE_CALLS;

/** The visit that CHECKS a repair: its reads alone. (A check that finds the
 *  document moved goes on to a repair, gated on that repair's writes.) */
export const PRODUCT_RECONCILE_CHECK_CALLS = VISIT_READ_CALLS;

/**
 * How many runs in a row a product's repair may be cut short by the tick's query
 * ceiling before the walk steps past it (logged) — the `product-orphans` rule
 * (`ORPHAN_MAX_READ_FAILURES`) applied here, so one product whose repair always
 * costs more than a tick has cannot pin the walk.
 */
export const RECONCILE_MAX_INTERRUPTS = 3;

/** What `planReconcile` reads of a commerce row, written structurally so this
 *  module's exported signatures keep `@urumi.ai/otta-store-emdash`'s document types
 *  out of the plugin's emitted declarations (`bundle-imports.test.ts`).
 *  `ProductCommerceDoc` satisfies it. */
export interface ReconcileRowView extends TitleStateView {
	readonly lifecycle: string;
	readonly active: boolean;
	readonly contentUpdatedAt: string | null;
	readonly activeUpdatedAt: string | null;
	readonly variants: Readonly<Record<string, StoredVariantView>>;
	/** The replay key of the row's last applied write. */
	readonly idempotencyKey?: string | null;
}

/** The commerce rows the walk reads, as the sweep hands them over. */
export interface ReconcileRows {
	/** The rows of `ids`, by product id (`ids` is at most a page), in
	 *  `RECONCILE_ROW_READ_QUERIES` queries at most. */
	many(ids: readonly string[]): Promise<ReadonlyMap<string, ReconcileRowView>>;
	/** One product's row, in ONE query: the read that proves a repair held. */
	one(id: string): Promise<ReconcileRowView | undefined>;
}

/** What one product needs. */
export type ReconcilePlan =
	| { readonly kind: "none" }
	| { readonly kind: "unordered" }
	/** Out of sync only in a way the sync cannot change: a title written under the
	 *  very save key the live content derives (a pending pre-fix leaked draft at the
	 *  same `updatedAt` and `version`), which the upsert would replay as a no-op. */
	| { readonly kind: "replayed" }
	| { readonly kind: "deactivate"; readonly watermark: string }
	| { readonly kind: "sync"; readonly watermark: string; readonly reasons: readonly string[] };

const NOTHING: ReconcilePlan = { kind: "none" };

/**
 * Decide, from the CMS document and its commerce row alone, what (if anything)
 * the reconcile owes this product. Pure; see the head comment for the rules.
 */
export function planReconcile(
	doc: Record<string, unknown>,
	row: ReconcileRowView | undefined,
): ReconcilePlan {
	// No parseable watermark: no write can be ordered, so none is made — the
	// publish hook takes the same stance. Its own kind, so the walk can say so.
	const watermark = normalizeWatermark(doc["updatedAt"]);
	if (watermark === undefined) return { kind: "unordered" };
	const live = row !== undefined && row.lifecycle === "live";
	if (doc["status"] !== PUBLISHED_STATUS) {
		// Not published: the only thing to assert is that it is not on sale — and only
		// when no newer lifecycle event already spoke.
		if (!live || !row.active) return NOTHING;
		if (row.activeUpdatedAt !== null && row.activeUpdatedAt > watermark) return NOTHING;
		return { kind: "deactivate", watermark };
	}
	// A tombstone is never touched (see the head comment).
	if (row !== undefined && row.lifecycle === "deleted") return NOTHING;
	if (!live) return { kind: "sync", watermark, reasons: ["no commerce row"] };
	const at =
		row.contentUpdatedAt !== null && row.contentUpdatedAt > watermark
			? row.contentUpdatedAt
			: watermark;
	const reasons: string[] = [];
	if (row.contentUpdatedAt === null || row.contentUpdatedAt < watermark) {
		reasons.push("behind the content");
	}
	// A title the upsert would REPLAY rather than write: the row's last write was
	// made under the save key this document derives, so the store returns it as is.
	// Not a reason to sync (nothing the sync sends can change it); said separately.
	let replayed = false;
	if (!titleHeld(deriveContent(doc).body, row)) {
		const saveKey = deriveSaveIdempotencyKey(
			PRODUCTS_COLLECTION,
			String(doc["id"]),
			doc["updatedAt"],
			doc["version"],
		);
		if (row.idempotencyKey === saveKey) replayed = true;
		else reasons.push("title differs");
	}
	if (!row.active && (row.activeUpdatedAt === null || row.activeUpdatedAt <= at)) {
		reasons.push("inactive");
	}
	if (variantsDrift(doc, row.variants, watermark, at)) reasons.push("variants differ");
	if (reasons.length > 0) return { kind: "sync", watermark: at, reasons };
	return replayed ? { kind: "replayed" } : NOTHING;
}

/** One product the current page nominated for repair, and which repair. */
interface PendingRepair {
	id: string;
	deactivate?: true;
	/** Set once the product's repair has run: the next visit CHECKS it (see
	 *  `reconcileProductCommerce`) against the document the repair was made from. */
	check?: RepairCheck;
}

/** What a repair recorded for the visit that checks it. */
interface RepairCheck {
	/** The document's `status` and raw `updatedAt` the repair was made from. */
	status: string;
	updatedAt: string;
	/** What the repair did, for the line the check logs when it held. */
	did: "first-sync" | "sync" | "deactivate";
	/** The plan's reasons, for the line the check logs when the repair held. */
	why: string;
	/** What the repair's writes reported, for the anomaly when it did not. */
	note: string;
}

/** The leg's kv document:
 *  - `cursor`: the host's cursor BEFORE the current page (null at the top);
 *  - `pending`: the products that page nominated and that are not yet done — while
 *    any are left, the walk resumes them by id and does NOT list the page again;
 *  - `next`: the cursor past that page, or null when it is the last;
 *  - `interrupted`: how many runs in a row each pending product was cut short;
 *  - `passStartedAt`: when the pass in progress STARTED (null between passes), and
 *    `lastPassStartedAt`: when the last COMPLETED one did — what the next waits on;
 *  - `day` and `unitsToday`: the UTC day (`YYYY-MM-DD`) of the last repair sent, and
 *    what that day's repairs spent of the cap, in thirds of a repair
 *    (`reconcileCostUnits`). `repairsToday` beside them is the same count in whole
 *    repairs, ROUNDED UP — what a release from before #664 reads, so a same-day
 *    rollback stops at the cap rather than starting the day's count again;
 *  - the scan for lost unpublishes: `scanStartedAt`, when the lap in progress
 *    started (null when none), `scan`, the cursor of the next page it lists (null at
 *    the top), and `lastScanStartedAt`, when the last lap started — the next waits
 *    the pass interval. */
interface ReconcileState {
	cursor: string | null;
	pending: PendingRepair[];
	next: string | null;
	interrupted: Record<string, number>;
	passStartedAt: string | null;
	lastPassStartedAt: string | null;
	day: string | null;
	repairsToday: number;
	unitsToday: number;
	scan: string | null;
	scanStartedAt: string | null;
	lastScanStartedAt: string | null;
}

/** A count stored in the document: a safe, non-negative integer, else undefined. */
function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseCheck(value: unknown): RepairCheck | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { status, updatedAt, did, why, note } = value as Record<string, unknown>;
	if (
		typeof status !== "string" ||
		typeof updatedAt !== "string" ||
		typeof why !== "string" ||
		typeof note !== "string"
	) {
		return undefined;
	}
	if (did !== "first-sync" && did !== "sync" && did !== "deactivate") return undefined;
	return { status, updatedAt, did, why, note };
}

/** An ISO instant, or null. */
function instant(value: unknown): string | null {
	return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function parseReconcileState(raw: string | null): ReconcileState {
	const state: ReconcileState = {
		cursor: null,
		pending: [],
		next: null,
		interrupted: {},
		passStartedAt: null,
		lastPassStartedAt: null,
		day: null,
		repairsToday: 0,
		unitsToday: 0,
		scan: null,
		scanStartedAt: null,
		lastScanStartedAt: null,
	};
	if (raw === null || raw === "") return state;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return state;
		const { cursor, pending, next, interrupted, passStartedAt, lastPassStartedAt } =
			parsed as Record<string, unknown>;
		const { day, repairsToday, unitsToday } = parsed as Record<string, unknown>;
		const { scan, scanStartedAt, lastScanStartedAt } = parsed as Record<string, unknown>;
		if (typeof cursor === "string" && cursor !== "") state.cursor = cursor;
		if (typeof next === "string" && next !== "") state.next = next;
		// A page in progress is kept only whole: without its `next` it cannot be left
		// (`null` is a real "last page"), so a document missing it re-lists the page.
		if (Array.isArray(pending) && "next" in (parsed as object)) {
			for (const entry of pending.slice(0, RECONCILE_MAX_PENDING)) {
				if (typeof entry !== "object" || entry === null) continue;
				const { id, deactivate, check } = entry as Record<string, unknown>;
				if (typeof id !== "string" || id.length === 0) continue;
				const parsedCheck = parseCheck(check);
				state.pending.push({
					id,
					...(deactivate === true ? { deactivate: true as const } : {}),
					...(parsedCheck === undefined ? {} : { check: parsedCheck }),
				});
			}
		}
		if (typeof interrupted === "object" && interrupted !== null) {
			for (const [id, n] of Object.entries(interrupted).slice(0, RECONCILE_MAX_PENDING)) {
				if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) state.interrupted[id] = n;
			}
		}
		state.passStartedAt = instant(passStartedAt);
		state.lastPassStartedAt = instant(lastPassStartedAt);
		// The day's count is kept only whole: a count without its day is no count.
		if (
			typeof day === "string" &&
			/^\d{4}-\d{2}-\d{2}$/.test(day) &&
			typeof repairsToday === "number" &&
			Number.isSafeInteger(repairsToday) &&
			repairsToday >= 0
		) {
			state.day = day;
			state.repairsToday = repairsToday;
			// Units are what this release reads. Absent or garbled (a document from before
			// #664), the whole repairs stand for them. Never fewer than the whole repairs
			// say: a release from before #664 that ran meanwhile counted only those.
			const whole = repairsToday * RECONCILE_DEACTIVATIONS_PER_REPAIR;
			const units = count(unitsToday);
			state.unitsToday =
				units === undefined
					? whole
					: Math.max(units, whole - RECONCILE_DEACTIVATIONS_PER_REPAIR + 1);
		}
		// A lap in progress is its start, and its place (none: the top).
		state.scanStartedAt = instant(scanStartedAt);
		if (state.scanStartedAt !== null && typeof scan === "string" && scan !== "") {
			state.scan = scan;
		}
		state.lastScanStartedAt = instant(lastScanStartedAt);
		return state;
	} catch {
		return state;
	}
}

/** Why a repair that ran did not hold, for the anomaly line. */
function notHeldBecause(outcome: LiveSyncOutcome | "deactivated"): string {
	if (outcome === "deactivated") return "the deactivate did not apply";
	if (outcome.kind === "upsert-failed") return "the commerce upsert failed";
	const why: string[] = [];
	if (outcome.upsert === "watermark-outranked") why.push("the upsert was refused by a newer row");
	if (outcome.variants === "failed") why.push("the variant write failed");
	if (outcome.variants === "withheld") why.push("the variant sync was withheld");
	// Every write returned and none says it was refused: a guarded no-op.
	return why.length > 0 ? why.join("; ") : "a write was a no-op";
}

/** Said when a repair's check finds it held. */
function sayRepaired(id: string, check: RepairCheck): void {
	if (check.did === "deactivate") {
		console.warn(
			`[otta] cron sweep product-reconcile: product_id=${id} is not published (status ${check.status}) but its commerce row was active — deactivated (a lost unpublish)`,
		);
	} else if (check.did === "first-sync") {
		// No row at all: a catalogue published before the plugin, or a lost FIRST
		// publish. On a first install that is every product, so it is said at info.
		console.info(
			`[otta] cron sweep product-reconcile: product_id=${id} had no commerce row — created and activated from its published content (a first sync)`,
		);
	} else {
		console.warn(
			`[otta] cron sweep product-reconcile: product_id=${id} re-synced from its published content (${check.why}) — a lost publish sync`,
		);
	}
}

/** Said when a plan needs no write: `unordered` and `replayed` are logged (once a
 *  pass: a page is nominated from once a pass), `none` is silent. */
function sayNoWrite(
	id: string,
	doc: Record<string, unknown>,
	kind: "unordered" | "replayed",
): void {
	if (kind === "unordered") {
		console.warn(
			`[otta] cron sweep product-reconcile: product_id=${id} has no parseable updatedAt (${JSON.stringify(doc["updatedAt"])}) — no write can be ordered, so it is not reconciled`,
		);
		return;
	}
	console.info(
		`[otta] cron sweep product-reconcile: product_id=${id} carries a title its published content does not, written under the save key that content derives (a pending pre-fix draft leak) — a sync would replay it as a no-op, so none is sent; publishing the product again repairs it`,
	);
}

/**
 * Walk the catalogue one page at a time and repair what `planReconcile` finds.
 * `content` and `rows` are the tick's COUNTED readers; the repairs write through
 * an in-process commerce client over `ctx`'s counted storage.
 *
 * A PAGE IS LISTED ONCE A PASS. The list (with the host's whole-collection count
 * beside it) only NOMINATES: the products it finds out of sync are kept in the
 * cursor document, and each is then repaired from a fresh read of ITS row and THEN
 * its document — in that order, so a publish landing between the two leaves a
 * NEWER document beside an older row (the sync runs at the newer watermark with the
 * newer content, as the publish's own does), never the reverse. A run the budget
 * stops part-way resumes the nominated products by id on the next tick, without
 * listing the page again, so the rows a pass reads do not grow with the number of
 * products it has to repair.
 *
 * A DAY'S REPAIRS ARE CAPPED on Workers Free (`timing.dailyRepairCap`,
 * `RECONCILE_REPAIRS_PER_DAY_FREE`; a deactivation counts a third of one,
 * `RECONCILE_DEACTIVATIONS_PER_REPAIR`). Once the day's count reaches it, a product that
 * still needs writes stays nominated and the run stops — after the checks of the
 * repairs it already made, which write nothing, and the scan for lost unpublishes
 * while a deactivation still fits (see `scanAhead` below) — returning `waitsCadence`
 * once there is nothing left to scan, so the leg is stamped and comes back at its
 * cadence; the pass is never ended and no product is stepped past, and the walk
 * resumes the same nominations after 00:00 UTC.
 */
export async function reconcileProductCommerce(
	ctx: PluginContext,
	rows: ReconcileRows,
	content: ContentReadAccess,
	cursors: SweepCursorStore,
	budget: LegBudget,
	timing: {
		readonly now: Date;
		readonly passIntervalMs: number;
		/** The day's repair cap (`reconcileRepairsDailyCap`); none when absent. */
		readonly dailyRepairCap?: number | null;
	},
): Promise<{
	count: number;
	incomplete?: true;
	notDue?: true;
	waitsCadence?: true;
	anomalies?: readonly string[];
}> {
	let saved = await cursors.read(PRODUCT_RECONCILE_CURSOR);
	const state = parseReconcileState(saved);
	// BETWEEN PASSES, the next one waits for the interval from the last one's START.
	// A pass in progress (a place in the catalogue, or a start stamped) always goes on.
	const nowMs = timing.now.getTime();
	if (state.cursor === null && state.passStartedAt === null && state.lastPassStartedAt !== null) {
		const last = Date.parse(state.lastPassStartedAt);
		// A stamp from the future (a clock stepped back) does not hold the leg off.
		if (last <= nowMs && nowMs - last < timing.passIntervalMs) return { count: 0, notDue: true };
	}
	// A cap of none (an index-build day on Free, `indexBuildHold` in sweeps.ts): one kv
	// read, nothing walked or written, and the leg waits its cadence.
	if (timing.dailyRepairCap === 0) return { count: 0, incomplete: true, waitsCadence: true };
	state.passStartedAt ??= timing.now.toISOString();
	// The day's count is the stored one only when it is today's.
	const dailyCap = timing.dailyRepairCap ?? null;
	const today = timing.now.toISOString().slice(0, 10);
	/** What today's repairs have spent of the cap, in thirds of a repair. */
	let usedUnits = state.day === today ? state.unitsToday : 0;
	/** Whether today's cap has room for one more repair of `kind`
	 *  (`reconcileCostUnits`). Syncs stop at `dailyCap` × 3 units; deactivations may
	 *  also spend the reserve above it (`RECONCILE_DEACTIVATION_RESERVE_UNITS`), so a
	 *  day the syncs spent still deactivates a lost unpublish, and neither kind passes
	 *  its own limit. */
	const capRoomFor = (kind: "sync" | "deactivate"): boolean =>
		dailyCap === null ||
		usedUnits + reconcileCostUnits(kind) <=
			dailyCap * RECONCILE_DEACTIVATIONS_PER_REPAIR +
				(kind === "deactivate" ? RECONCILE_DEACTIVATION_RESERVE_UNITS : 0);
	/** Said once, by the run whose repairs leave no room for another sync. */
	const syncRoomAtStart = capRoomFor("sync");
	/** Counted BEFORE the writes, so a run the ceiling stops in them keeps it. */
	const countRepair = (kind: "sync" | "deactivate"): void => {
		usedUnits += reconcileCostUnits(kind);
		state.day = today;
		state.unitsToday = usedUnits;
		state.repairsToday = Math.ceil(usedUnits / RECONCILE_DEACTIVATIONS_PER_REPAIR);
	};
	let capped = false;
	const save = async (): Promise<void> => {
		const next = JSON.stringify(state);
		if (next === saved) return;
		await cursors.write(PRODUCT_RECONCILE_CURSOR, next);
		saved = next;
	};
	// Built once, and only when a repair needs it: no kv read, no gateway — the
	// writes it makes are the hooks' own, over the tick's COUNTED storage.
	let client: InProcessCommerceClient | undefined;
	const anomalies: string[] = [];
	let repaired = 0;
	let reachedEnd = false;
	/** The current page is done: step past it (and end the pass after the last). */
	const advance = (): void => {
		state.cursor = state.next;
		state.next = null;
		state.pending = [];
		state.interrupted = {};
		if (state.cursor === null) {
			state.lastPassStartedAt = state.passStartedAt;
			state.passStartedAt = null;
			reachedEnd = true;
		}
	};
	const pageGate = budget.gate(0, RECONCILE_PAGE_QUERIES);
	/** The scan's lap is over (it reached the end, or its cursor died). */
	const endLap = (): void => {
		if (state.scanStartedAt !== null) state.lastScanStartedAt = state.scanStartedAt;
		state.scan = null;
		state.scanStartedAt = null;
	};
	/**
	 * THE SCAN FOR LOST UNPUBLISHES (issue #664). While the cap holds the walk on its
	 * page, a lost unpublish anywhere else would wait for the walk — on a page ahead of
	 * it, behind every first sync before it; on a page behind it, for the next pass: on
	 * a large Free first install, about N / 200 days either way, still on sale. So,
	 * while the cap holds the syncs and still has room for a deactivation (the reserve
	 * no sync can spend, `RECONCILE_DEACTIVATION_RESERVE_UNITS`), the leg lists the catalogue in a
	 * separate lap, one page per call: the list and its row reads
	 * (`RECONCILE_PAGE_QUERIES`, gated like the walk's own page), nothing written but
	 * the cursor document. A product found active while its document is not published
	 * is nominated for a deactivation beside the walk's nominations, and visited,
	 * checked and counted (a third of a repair) like any other. Nothing else is
	 * nominated: the syncs wait for the walk.
	 *
	 * A lap runs from the top of the catalogue to its end at most once per pass
	 * interval (`timing.passIntervalMs`: it reads what a pass reads), and its place
	 * persists in the cursor document across ticks and days. Returns whether it listed
	 * a page.
	 */
	const scanAhead = async (): Promise<boolean> => {
		// Only while the cap holds the syncs (else the walk finds what the lap would),
		// and while a deactivation still fits.
		if (capRoomFor("sync") || !capRoomFor("deactivate")) return false;
		if (state.pending.length > RECONCILE_PAGE_SIZE) return false;
		if (state.scanStartedAt === null) {
			const last =
				state.lastScanStartedAt === null ? Number.NaN : Date.parse(state.lastScanStartedAt);
			// A stamp from the future (a clock stepped back) does not hold the lap off.
			if (last <= nowMs && nowMs - last < timing.passIntervalMs) return false;
			state.scan = null;
			state.scanStartedAt = timing.now.toISOString();
		}
		if (!pageGate()) return false;
		let page: Awaited<ReturnType<ContentReadAccess["list"]>>;
		try {
			page = await content.list(PRODUCTS_COLLECTION, {
				limit: RECONCILE_PAGE_SIZE,
				...(state.scan === null ? {} : { cursor: state.scan }),
			});
		} catch (err) {
			if (isInvalidCursorError(err)) {
				// A cursor the host can no longer decode: the lap starts again from the top
				// (keeping its start, so it still runs once per interval). The top needs no
				// cursor; if even that is refused, the lap ends.
				if (state.scan !== null) {
					console.warn(
						"[otta] cron sweep product-reconcile: the CMS refused the lap's cursor; the lap restarts from the top",
					);
					state.scan = null;
					return true;
				}
				endLap();
				return false;
			}
			throw err;
		}
		const items = page.items.filter(
			(item): item is Record<string, unknown> & { id: string } =>
				typeof item["id"] === "string" && item["id"].length > 0,
		);
		const found = items.length > 0 ? await rows.many(items.map((item) => item.id)) : new Map();
		for (const item of items) {
			if (planReconcile(item, found.get(item.id)).kind !== "deactivate") continue;
			const at = state.pending.findIndex((entry) => entry.id === item.id);
			if (at === -1) {
				state.pending.push({ id: item.id, deactivate: true });
			} else if (state.pending[at]?.check === undefined && state.pending[at]?.deactivate !== true) {
				// Nominated by the walk as a sync, now unpublished: as a sync it would wait
				// behind the syncs' cap, still on sale.
				state.pending[at] = { id: item.id, deactivate: true };
			}
		}
		if (page.hasMore && page.cursor !== undefined) {
			state.scan = page.cursor;
		} else {
			endLap();
		}
		await save();
		return true;
	};
	try {
		walk: for (;;) {
			if (state.pending.length === 0) {
				if (!pageGate()) break;
				let page: Awaited<ReturnType<ContentReadAccess["list"]>>;
				try {
					page = await content.list(PRODUCTS_COLLECTION, {
						limit: RECONCILE_PAGE_SIZE,
						...(state.cursor === null ? {} : { cursor: state.cursor }),
					});
				} catch (err) {
					// A cursor the host can no longer decode restarts the pass; any other
					// failure fails the leg loudly and is retried at its cadence.
					if (state.cursor !== null && isInvalidCursorError(err)) {
						console.warn(
							"[otta] cron sweep product-reconcile: the CMS refused the saved cursor; the pass restarts",
						);
						state.cursor = null;
						state.next = null;
						state.pending = [];
						state.interrupted = {};
						continue;
					}
					throw err;
				}
				const items = page.items.filter(
					(item): item is Record<string, unknown> & { id: string } =>
						typeof item["id"] === "string" && item["id"].length > 0,
				);
				const found = items.length > 0 ? await rows.many(items.map((item) => item.id)) : new Map();
				// A lost unpublish leaves a product ON SALE that the merchant withdrew; a
				// lost publish leaves one off sale (fail-closed). So the page's
				// deactivations are nominated FIRST: on a capped Free day they are not
				// queued behind the page's first syncs.
				const syncs: PendingRepair[] = [];
				for (const item of items) {
					const plan = planReconcile(item, found.get(item.id));
					if (plan.kind === "none") continue;
					if (plan.kind === "unordered" || plan.kind === "replayed") {
						sayNoWrite(item.id, item, plan.kind);
						continue;
					}
					if (plan.kind === "deactivate") state.pending.push({ id: item.id, deactivate: true });
					else syncs.push({ id: item.id });
				}
				state.pending.push(...syncs);
				state.next = page.hasMore && page.cursor !== undefined ? page.cursor : null;
				if (state.pending.length === 0) {
					advance();
					if (reachedEnd) break;
					// Saved now: a later page the ceiling cuts short must not cost this one again.
					await save();
					continue;
				}
			}
			// Each unit is hinted with its own cost; the gate starts at the cheapest.
			const unitGate = budget.gate(0, PRODUCT_RECONCILE_CHECK_CALLS);
			// `done()` replaces `state.pending` with a new array, so this one is stable.
			for (const nominated of state.pending) {
				const id = nominated.id;
				const interrupts = state.interrupted[id] ?? 0;
				const done = (): void => {
					state.pending = state.pending.filter((entry) => entry.id !== id);
					delete state.interrupted[id];
				};
				/** Keep the product pending as the repair its FRESH plan needs, not the
				 *  one the page (or a check) nominated it for, so its next visit is gated
				 *  on that repair's cost. Not counted against it. A CHECK's record is
				 *  dropped: its document moved, so the next visit plans a repair afresh,
				 *  and the earlier repair is not reported as held. */
				const renominate = (kind: "sync" | "deactivate"): void => {
					state.interrupted[id] = interrupts;
					if (interrupts === 0) delete state.interrupted[id];
					state.pending = state.pending.map((entry) =>
						entry.id !== id
							? entry
							: kind === "deactivate"
								? { id, deactivate: true as const }
								: { id },
					);
				};
				/** Keep the product pending, now as a check of the repair just made. */
				const toCheck = (check: RepairCheck): void => {
					state.pending = state.pending.map((entry) => (entry.id === id ? { id, check } : entry));
					delete state.interrupted[id];
				};
				if (interrupts >= RECONCILE_MAX_INTERRUPTS) {
					const line = `the repair of product ${id} was cut short by the tick's query ceiling on ${String(interrupts)} runs in a row; it is stepped past until the next pass`;
					console.error(`[otta] cron sweep product-reconcile: ${line}`);
					anomalies.push(line);
					done();
					continue;
				}
				// The day's repairs are spent: a product that still needs writes stays
				// nominated for tomorrow. Checks (reads alone) still run, and so does a
				// deactivation the cap still has a third of a repair's room for.
				if (
					nominated.check === undefined &&
					!capRoomFor(nominated.deactivate === true ? "deactivate" : "sync")
				) {
					capped = true;
					continue;
				}
				const cost =
					nominated.check !== undefined
						? PRODUCT_RECONCILE_CHECK_CALLS
						: nominated.deactivate === true
							? PRODUCT_RECONCILE_DEACTIVATE_CALLS
							: PRODUCT_RECONCILE_REPAIR_CALLS;
				// Stopped inside the page: what is left stays nominated for the next tick.
				// The explicit check first: the gate admits an OVERSIZED first unit (clamped
				// to what is left) so a leg is never refused forever, but this leg's start
				// floor already guarantees one whole unit, and a repair started without room
				// to finish would be cut after its writes.
				if (budget.remainingQueries() < cost) {
					budget.stopped = true;
					break walk;
				}
				if (!unitGate(cost)) break walk;
				// Recorded BEFORE the visit, so a run the ceiling cuts short still counts
				// against the product (and the products done before it are saved too).
				state.interrupted[id] = interrupts + 1;
				await save();
				try {
					// The row FIRST, then the document (see the function's comment).
					const row = await rows.one(id);
					const doc = await content.get(PRODUCTS_COLLECTION, id);
					if (doc === null) {
						// Gone since the page was read: the delete paths' business.
						done();
						continue;
					}
					const plan = planReconcile(doc, row);
					const check = nominated.check;
					if (check !== undefined) {
						const same =
							doc["status"] === check.status && String(doc["updatedAt"]) === check.updatedAt;
						if (plan.kind === "none" || plan.kind === "replayed") {
							// THE REPAIR HELD — read after its writes, on a fresh document.
							sayRepaired(id, check);
							repaired++;
							done();
							continue;
						}
						if (same) {
							// Same document, still out of sync: the repair did not hold.
							const line = `product ${id} was attempted and is still out of sync (${check.note}); it is retried on the next pass`;
							console.error(`[otta] cron sweep product-reconcile: ${line}`);
							anomalies.push(line);
							done();
							continue;
						}
						// The document MOVED between the repair's read and its writes — an
						// unpublish (or a republish) whose own hook flip was a no-op on a row
						// not yet in the state the repair then put it in. Repaired again from
						// this document, at its watermark, below.
						console.warn(
							`[otta] cron sweep product-reconcile: product_id=${id} changed while it was being repaired (now ${String(doc["status"])} at ${String(doc["updatedAt"])}); repairing it again from the current content`,
						);
					}
					if (plan.kind === "none") {
						// Brought into sync since the page was read (its own hook, most often).
						done();
						continue;
					}
					if (plan.kind === "unordered" || plan.kind === "replayed") {
						sayNoWrite(id, doc, plan.kind);
						done();
						continue;
					}
					// Gated again on the FRESH plan: a product nominated for a deactivation
					// may now need a sync. Without room for its writes, nothing is written;
					// the product stays pending — nominated now as what the fresh plan needs,
					// so the next tick gates it on THAT cost — and this visit does not count
					// against it.
					const writes = plan.kind === "deactivate" ? DEACTIVATE_WRITE_CALLS : SYNC_WRITE_CALLS;
					if (budget.remainingQueries() < writes) {
						renominate(plan.kind);
						budget.stopped = true;
						break walk;
					}
					// The day's cap, on the fresh plan too (a check that found its document
					// moved): no visit counted against it, and nominated again as a repair,
					// so it is not read again before tomorrow.
					if (!capRoomFor(plan.kind)) {
						renominate(plan.kind);
						capped = true;
						continue;
					}
					countRepair(plan.kind);
					client ??= new InProcessCommerceClient(ctx);
					const recorded = {
						status: String(doc["status"]),
						updatedAt: String(doc["updatedAt"]),
					};
					if (plan.kind === "deactivate") {
						await client.deactivateProductCommerce(
							id,
							deriveUnpublishIdempotencyKey(PRODUCTS_COLLECTION, id, doc["updatedAt"]),
							plan.watermark,
						);
						toCheck({
							...recorded,
							did: "deactivate",
							why: "a lost unpublish",
							note: notHeldBecause("deactivated"),
						});
					} else {
						const outcome = await syncLiveProduct(client, {
							collection: PRODUCTS_COLLECTION,
							id,
							content: doc,
							watermark: plan.watermark,
							hook: "cron sweep product-reconcile",
							allowedHosts: ALLOWED_HOSTS,
							rethrow: isSweepQueryCeilingError,
						});
						toCheck({
							...recorded,
							did: row === undefined ? "first-sync" : "sync",
							why: plan.reasons.join(", "),
							note: notHeldBecause(outcome),
						});
					}
					continue;
				} catch (err) {
					// The tick's own ceiling: the attempt is already counted; stop the run.
					if (isSweepQueryCeilingError(err)) throw err;
					const line = `the repair of product ${id} failed; it is retried on the next pass`;
					console.error(`[otta] cron sweep product-reconcile: ${line}:`, err);
					anomalies.push(line);
				}
				done();
			}
			// Capped for the day: what is left waits for tomorrow — once the checks of
			// this run's repairs (left pending as checks) have run, and the scan ahead has
			// looked for lost unpublishes while the budget and the cap allow.
			if (capped && !state.pending.some((entry) => entry.check !== undefined)) {
				if (await scanAhead()) continue;
				break;
			}
			// A repair leaves its product pending, to be CHECKED: go round again while any
			// is left, rather than stepping past the page.
			if (state.pending.length > 0) continue;
			// Every nominated product is done: step past the page.
			advance();
			if (reachedEnd) break;
			await save();
		}
	} finally {
		await save();
	}
	// Said once a day, by the run whose repairs left no room for another sync.
	if (dailyCap !== null && syncRoomAtStart && !capRoomFor("sync")) {
		console.info(
			`[otta] cron sweep product-reconcile: no room for another sync today (the Workers Free cap of ${String(dailyCap)} repairs);` +
				` lost unpublishes are still deactivated from a reserve of ${String(RECONCILE_DEACTIVATION_RESERVE_UNITS)}, and the pass carries on after 00:00 UTC`,
		);
	}
	// Stopped by the cap alone, the leg waits its cadence (it is stamped, and not run
	// again on the second pass). Stopped by the budget too, it goes again next tick:
	// the checks left must not wait a cadence.
	const waits = capped && !budget.stopped && !reachedEnd;
	if (!reachedEnd && !waits) budget.stopped = true;
	return {
		count: repaired,
		...(reachedEnd ? {} : { incomplete: true as const }),
		...(waits ? { waitsCadence: true as const } : {}),
		...(anomalies.length > 0 ? { anomalies } : {}),
	};
}
