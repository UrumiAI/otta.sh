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
 * THE DOCUMENT IS RE-READ BEFORE EVERY REPAIR. The page is listed BEFORE its rows
 * are read, so a publish (or unpublish) that lands between the two leaves the
 * planner a stale document beside a fresh row. Planned from that pair, the sync
 * would run at the fresh row's NEWER watermark with the stale content: the title
 * reverted, a size the publish just added orphaned at the publish's own watermark
 * (which a later declare at that watermark cannot resurrect), its sku claim
 * released. So each repair first re-reads the document with `ctx.content.get` and
 * proceeds only when it is still there, still in the state planned from, at the
 * same `updatedAt` and `version`; otherwise the product is left to the hook that
 * moved it and to the next pass. The same re-read keeps a repair from activating a
 * product unpublished since the list: its `afterUnpublish` deactivate is a no-op on
 * a row that is already inactive, so it does not stamp the gate watermark, and an
 * activate at the older watermark would otherwise win.
 *
 * WHAT IT NEVER DOES:
 *  - activate a product the content does not say is PUBLISHED, or write a
 *    not-published product's title (its columns are not the draft the merchant
 *    saved; an inactive row's title is not on sale);
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
 * A REPAIR IS COUNTED ONLY WHEN IT HELD. After the sync the row is read again and
 * planned against the same document: only a product that is now in sync counts as
 * repaired. One that is not — an upsert that was a provable no-op (a same-key
 * replay: a pending leaked draft can carry the very save key the live content
 * derives), a variant write that failed and was swallowed — is an ANOMALY, logged
 * as "attempted, still out of sync", never as "re-synced".
 *
 * BOUNDED AND RESUMABLE, AND ALWAYS MOVING. One CMS page (`RECONCILE_PAGE_SIZE`) at
 * a time, behind the host's own keyset cursor (`createdAt DESC, id`), kept in
 * `ctx.kv` and saved after every page; each page's rows are ONE `in` read; each
 * repair is gated on its measured cost. A run the budget stops part-way through a
 * page keeps the cursor BEFORE that page, and every product it ATTEMPTED there —
 * repaired, failed, or left out of sync — is remembered (at most a page of them)
 * and stepped past on the re-read, so a product a repair cannot fix never costs
 * another run its unit and the walk cannot wedge on it. The attempt is saved
 * BEFORE the repair, so even a repair the tick's ceiling cuts short is counted: one
 * cut short `RECONCILE_MAX_INTERRUPTS` times in a row is stepped past, logged. The
 * end of the catalogue wraps the cursor and completes the pass; the leg is a
 * maintenance leg, so the next pass starts a cadence later, and every product
 * stepped past is tried again then. A lost or garbled cursor restarts the pass — a
 * re-read, never a wrong write.
 */
import { InProcessCommerceClient } from "../commerce/in-process-commerce-client.js";
import { ALLOWED_HOSTS } from "../manifest.js";
import { deriveUnpublishIdempotencyKey } from "../sync/derive-idempotency-key.js";
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
import type { SweepCursorStore } from "./sweep-cursor-store.js";
import { isSweepQueryCeilingError, type LegBudget } from "./tick-budget.js";

/** The leg's place between ticks, in the sweep's cursor store. */
export const PRODUCT_RECONCILE_CURSOR = "product-reconcile";

/**
 * Products per CMS page: EmDash clamps a list at 100, and the commerce store's `in`
 * read is chunked at 50 ids per statement (D1's 100-parameter bound), so 50 is the
 * largest page whose commerce rows are ONE query.
 */
export const RECONCILE_PAGE_SIZE = 50;

/**
 * What one PAGE costs: the CMS list (`CONTENT_LIST_QUERIES`), the page's commerce
 * rows in one `in` read, and the cursor write that saves the place past it. An
 * in-sync page costs exactly this and writes nothing else.
 */
export const RECONCILE_PAGE_QUERIES = CONTENT_LIST_QUERIES + 2;

/** The leg's entry (`LEG_QUERY_COSTS`): the cursor read, then one page. */
export const PRODUCT_RECONCILE_ENTRY_QUERIES = 1 + RECONCILE_PAGE_QUERIES;

/**
 * The calls one repair of a PUBLISHED product makes at most. Measured in
 * `cron-product-reconcile.test.ts` ("the cost table"):
 *  - the cursor write that records the attempt before the repair: 1;
 *  - the re-read of the document (`CONTENT_READ_QUERIES`): 3;
 *  - the publish's own sync (`syncLiveProduct`): the upsert's versioned read and
 *    compare-and-set, the activate's, and — for a document with a repeater — the
 *    one variant write's: 6;
 *  - the re-read of the row that proves the repair held: 1.
 * Eleven measured; thirteen leaves room for one compare-and-set retry. A repair
 * that costs more (a variant write releasing sku claims) is what the tick's ceiling
 * is for: see `RECONCILE_MAX_INTERRUPTS`.
 */
export const PRODUCT_RECONCILE_REPAIR_CALLS = 13;

/** A lost unpublish's repair: the attempt's cursor write, the document re-read,
 *  the deactivate's versioned read and compare-and-set, and the row re-read. */
export const PRODUCT_RECONCILE_DEACTIVATE_CALLS = 1 + CONTENT_READ_QUERIES + 2 + 1;

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
}

/** The commerce rows the walk reads, as the sweep hands them over. */
export interface ReconcileRows {
	/** The rows of `ids`, by product id, in ONE query (`ids` is at most a page). */
	many(ids: readonly string[]): Promise<ReadonlyMap<string, ReconcileRowView>>;
	/** One product's row, in ONE query: the read that proves a repair held. */
	one(id: string): Promise<ReconcileRowView | undefined>;
}

/** What one product needs. */
export type ReconcilePlan =
	| { readonly kind: "none" }
	| { readonly kind: "unordered" }
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
	if (!titleHeld(deriveContent(doc).body, row)) reasons.push("title differs");
	if (!row.active && (row.activeUpdatedAt === null || row.activeUpdatedAt <= at)) {
		reasons.push("inactive");
	}
	if (variantsDrift(doc, row.variants, watermark, at)) reasons.push("variants differ");
	return reasons.length === 0 ? NOTHING : { kind: "sync", watermark: at, reasons };
}

/** The leg's kv document: the host's page cursor (null at the top of the
 *  catalogue), the products ATTEMPTED on that page, and how many runs in a row
 *  each product still pending there was cut short. */
interface ReconcileState {
	cursor: string | null;
	attempted: string[];
	interrupted: Record<string, number>;
}

function parseReconcileState(raw: string | null): ReconcileState {
	const state: ReconcileState = { cursor: null, attempted: [], interrupted: {} };
	if (raw === null || raw === "") return state;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return state;
		const { cursor, attempted, failed, interrupted } = parsed as Record<string, unknown>;
		if (typeof cursor === "string" && cursor !== "") state.cursor = cursor;
		// `failed` is the field's name before every attempt was recorded.
		const ids = Array.isArray(attempted) ? attempted : Array.isArray(failed) ? failed : [];
		state.attempted = ids
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.slice(0, RECONCILE_PAGE_SIZE);
		if (typeof interrupted === "object" && interrupted !== null) {
			for (const [id, n] of Object.entries(interrupted).slice(0, RECONCILE_PAGE_SIZE)) {
				if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) state.interrupted[id] = n;
			}
		}
		return state;
	} catch {
		return state;
	}
}

/** Whether the re-read document is still the one the plan was made from. */
function unchanged(
	listed: Record<string, unknown>,
	current: Record<string, unknown> | null,
): boolean {
	return (
		current !== null &&
		current["status"] === listed["status"] &&
		current["updatedAt"] === listed["updatedAt"] &&
		current["version"] === listed["version"]
	);
}

/** Why a repair that ran did not hold, for the anomaly line. */
function notHeldBecause(outcome: LiveSyncOutcome | "deactivated"): string {
	if (outcome === "deactivated") return "the deactivate did not apply";
	if (outcome.kind === "upsert-failed") return "the commerce upsert failed";
	const why: string[] = [];
	if (outcome.upsert === "watermark-outranked") why.push("the upsert was refused by a newer row");
	if (outcome.variants === "failed") why.push("the variant write failed");
	if (outcome.variants === "withheld") why.push("the variant sync was withheld");
	// Every write returned and none says it was refused: a guarded no-op, most often
	// the upsert replaying a save key the row already took (a pending leaked draft
	// at the same `updatedAt` and `version`).
	return why.length > 0 ? why.join("; ") : "a write was a no-op — most likely a replayed save key";
}

/**
 * Walk the catalogue one page at a time and repair what `planReconcile` finds.
 * `content` and `rows` are the tick's COUNTED readers; the repairs write through
 * an in-process commerce client over `ctx`'s counted storage.
 */
export async function reconcileProductCommerce(
	ctx: PluginContext,
	rows: ReconcileRows,
	content: ContentReadAccess,
	cursors: SweepCursorStore,
	budget: LegBudget,
): Promise<{ count: number; incomplete?: true; anomalies?: readonly string[] }> {
	let saved = await cursors.read(PRODUCT_RECONCILE_CURSOR);
	const state = parseReconcileState(saved);
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
	const pageGate = budget.gate(0, RECONCILE_PAGE_QUERIES);
	try {
		pages: for (;;) {
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
					state.attempted = [];
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
			const unitGate = budget.gate(0, PRODUCT_RECONCILE_REPAIR_CALLS);
			for (const item of items) {
				const id = item.id;
				if (state.attempted.includes(id)) continue;
				const plan = planReconcile(item, found.get(id));
				if (plan.kind === "none") continue;
				const attempt = (): void => {
					state.attempted.push(id);
					delete state.interrupted[id];
				};
				if (plan.kind === "unordered") {
					// Never judged, and said once a pass: recorded as attempted, so a re-read
					// of this page does not log it again.
					console.warn(
						`[otta] cron sweep product-reconcile: product_id=${id} has no parseable updatedAt (${JSON.stringify(item["updatedAt"])}) — no write can be ordered, so it is not reconciled`,
					);
					attempt();
					continue;
				}
				const interrupts = state.interrupted[id] ?? 0;
				if (interrupts >= RECONCILE_MAX_INTERRUPTS) {
					const line = `the repair of product ${id} was cut short by the tick's query ceiling on ${String(interrupts)} runs in a row; it is stepped past until the next pass`;
					console.error(`[otta] cron sweep product-reconcile: ${line}`);
					anomalies.push(line);
					attempt();
					continue;
				}
				const cost =
					plan.kind === "deactivate"
						? PRODUCT_RECONCILE_DEACTIVATE_CALLS
						: PRODUCT_RECONCILE_REPAIR_CALLS;
				if (!unitGate(cost)) {
					// Stopped inside the page: the cursor stays before it, and what was
					// attempted is stepped past next time.
					break pages;
				}
				// Recorded BEFORE the repair, so a run the ceiling cuts short still counts
				// against the product (and a completed attempt before it is saved too).
				state.interrupted[id] = interrupts + 1;
				await save();
				try {
					// Re-read: proceed only on the document the plan was made from.
					const current = await content.get(PRODUCTS_COLLECTION, id);
					if (!unchanged(item, current)) {
						console.info(
							`[otta] cron sweep product-reconcile: product_id=${id} changed since the page was read; left to its own hook and to the next pass`,
						);
						attempt();
						continue;
					}
					client ??= new InProcessCommerceClient(ctx);
					let outcome: LiveSyncOutcome | "deactivated";
					if (plan.kind === "deactivate") {
						await client.deactivateProductCommerce(
							id,
							deriveUnpublishIdempotencyKey(PRODUCTS_COLLECTION, id, item["updatedAt"]),
							plan.watermark,
						);
						outcome = "deactivated";
					} else {
						outcome = await syncLiveProduct(client, {
							collection: PRODUCTS_COLLECTION,
							id,
							content: item,
							watermark: plan.watermark,
							hook: "cron sweep product-reconcile",
							allowedHosts: ALLOWED_HOSTS,
							rethrow: isSweepQueryCeilingError,
						});
					}
					// Held only if the row now reads as in sync with the same document.
					const after = planReconcile(item, await rows.one(id));
					if (after.kind === "none") {
						console.warn(
							plan.kind === "deactivate"
								? `[otta] cron sweep product-reconcile: product_id=${id} is not published (status ${String(item["status"])}) but its commerce row was active — deactivated (a lost unpublish)`
								: `[otta] cron sweep product-reconcile: product_id=${id} re-synced from its published content (${plan.reasons.join(", ")}) — a lost publish sync`,
						);
						repaired++;
					} else {
						const line = `product ${id} was attempted and is still out of sync (${notHeldBecause(outcome)}); it is retried on the next pass`;
						console.error(`[otta] cron sweep product-reconcile: ${line}`);
						anomalies.push(line);
					}
				} catch (err) {
					// The tick's own ceiling: the attempt is already counted; stop the run.
					if (isSweepQueryCeilingError(err)) throw err;
					const line = `the repair of product ${id} failed; it is retried on the next pass`;
					console.error(`[otta] cron sweep product-reconcile: ${line}:`, err);
					anomalies.push(line);
				}
				attempt();
			}
			// The whole page is handled: move past it, and save the place now — a later
			// page the ceiling cuts short must not cost this one again.
			state.attempted = [];
			state.interrupted = {};
			if (!page.hasMore || page.cursor === undefined) {
				state.cursor = null;
				reachedEnd = true;
				break;
			}
			state.cursor = page.cursor;
			await save();
		}
	} finally {
		await save();
	}
	if (!reachedEnd) budget.stopped = true;
	return {
		count: repaired,
		...(reachedEnd ? {} : { incomplete: true as const }),
		...(anomalies.length > 0 ? { anomalies } : {}),
	};
}
