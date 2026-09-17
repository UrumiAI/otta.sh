/**
 * The scheduled sweep: nine legs, one tick (INC-C4).
 *
 * WHY THIS FILE EXISTS AT ALL. ADR-0019 §7 says it plainly — the aggregates are
 * one document each, a coupling that spans two of them is made *idempotently
 * completable by any replayer* rather than transactional, and **a missing sweeper
 * is a correctness bug**, not a missing optimization. Four of these legs are the
 * service worker's `scheduled()` handler moved in unchanged; the other five are
 * the completers ADR-0019's two-tier write strategy always owed and that nothing
 * had yet run on a schedule.
 *
 * EVERY LEG IN ITS OWN TRY/CATCH, WITH ITS OWN LABEL — mirroring the service's
 * `scheduled()` handler, and for its reason: a sweep that throws must not starve
 * the eight beside it. A tick therefore always returns a summary, and a failed
 * leg is a `{ ok: false, error }` row in it rather than a rejected hook.
 *
 * AND EVERY LEG LOGS, which is the other half of that mirror and was missing from
 * the first cut of this file. The summary is the hook's RETURN VALUE and the host's
 * cron executor does not persist it, so a leg that fails forever would otherwise be
 * indistinguishable from a leg that has nothing to do — exactly the failure mode an
 * unattended path must not have. Each leg emits one `[otta] cron sweep …` line on
 * success and one `console.error` with its own label on failure, matching
 * `packages/service/src/worker.ts`'s `scheduled()` shape. An anomaly is louder
 * still: it is logged AND written to the order through `flagReconciliation`.
 *
 * EVERY LEG IS IDEMPOTENT, which is what makes running them every fifteen minutes
 * safe and is the property the suite pins with two ticks and one effect. None of
 * them is a "do the work again" path: each finds outstanding work from the
 * documents themselves and completes it exactly once, because the completion is
 * always a guarded write the second caller loses.
 *
 * DISCOVERY IS INDEX-ONLY. A declared index is a READ CONTRACT (D3): filtering on
 * a field the collection never declared *throws* `StorageQueryError` rather than
 * running slowly. So every scan below filters on a declared field — `holdsPendingAt`
 * for the hold intents, `createdAt` for the index heal and the product scan,
 * `createdAt`+`holdsUse` for the coupon orphans — and anything else is decided
 * from the document once it is in hand.
 *
 * NO SCAN MAY STARVE, and this is the property the first cut got wrong. A sweep
 * that pages a collection `createdAt ASC` from a FIXED lower bound, capped at a
 * page budget, reads the same oldest rows on every tick forever: past that budget
 * the tail is unreachable and the gap never heals, silently. So every unbounded
 * collection here is walked behind an ADVANCING CURSOR kept in `ctx.kv` (the
 * plugin's own ungated store):
 *
 *  - `order_sku_index` and the coupon orphans walk FORWARD: the cursor is the last
 *    `createdAt` read, less a small overlap so a row written slightly out of order
 *    is still seen, and a tick that runs out of budget resumes where it stopped.
 *  - the product catalog ROTATES: there is no "swept" marker on a product to narrow
 *    by, so the cursor advances to the end and then wraps to the beginning. Every
 *    product is reached within one rotation regardless of catalog size.
 *  - the hold intents need no cursor: `holdsPendingAt` is null once the order owes
 *    nothing, so that predicate narrows by itself as the work completes.
 *
 * A LOST CURSOR IS ALWAYS SAFE. It costs a re-read, never correctness: every leg's
 * work is a guarded write, so re-reading a row it already handled does nothing.
 * That is why a `ctx.kv` failure is logged and shrugged off rather than failing the
 * leg — the sweep is strictly better off running without a cursor than not running.
 *
 * THE TWO HAZARDS, both named because both are easy to re-introduce:
 *
 *  1. `commitMany` SKIPS a reservation id already terminal in `reservation_index`,
 *     so a partial commit can never be healed by replaying the batch. The
 *     hold-intent leg therefore drives the ORDER STORE's per-id completers
 *     (`completeHoldAdoption`/`completeHoldCommit`/`completeHoldRelease`), which
 *     walk the order's own recorded intent one reservation at a time. Nothing here
 *     may reach for a batch method.
 *
 *  2. Those completers read a NON-VERSIONED `get`. Between that read and their
 *     per-id writes the order can legitimately move on — an order that expired
 *     mid-adoption has had its holds released by the expiry path, and the adoption
 *     completer will then report those ids as `lost`. That is normal, not an
 *     anomaly. So a non-empty `lost` set is RE-READ against the order's current
 *     `state` before it is counted: only a `lost` id on an order still sitting in
 *     the state that owns the intent is a real anomaly — and one that survives that
 *     filter is written to the order with `flagReconciliation`, because ADR-0019
 *     §7.13 says an anomaly must always be RECORDABLE and a return value nothing
 *     reads is not a record.
 *
 * THE HOLD-TTL PARITY GAP CLOSES HERE. `in-process-commerce-stores.ts` records it
 * as a MUST-CLOSE item and says where it closes: "with the settings and scheduled-sweep
 * wiring, where the value is loaded once and the sweeps that expire holds run". This
 * is that place — one settings read per tick, feeding `expireHolds`' `ttlMs`, rather
 * than a read on every cart request for a value that changes almost never.
 */
import {
	DEFAULT_COUPON_GRACE_MS,
	dispatchOrderEmails,
	expireHolds,
	expireOrders,
	orderId as toOrderId,
	type EmailSender,
	type OrderState,
} from "@otta-sh/domain";
import {
	collectionOf,
	COUPON_REDEMPTIONS_COLLECTION,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	orderSkuKeys,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	type CouponRedemptionDoc,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type ProductCommerceDoc,
	type StorageAccess as AdapterStorageAccess,
} from "@otta-sh/store-emdash";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
} from "../commerce/in-process-commerce-stores.js";
import { makeEmailSender } from "../email/ctx-http-email-sender.js";
import { IN_PROCESS_EGRESS_URLS } from "../manifest.js";
import type { PluginContext } from "../types.js";

/** The nine legs, in the order a tick runs them. The four ported sweeps first,
 *  then the five completers ADR-0019 owes. */
export const SWEEP_LEGS = [
	"expire-holds",
	"expire-orders",
	"order-emails",
	"prune-challenges",
	"sku-transfers",
	"order-sku-index",
	"hold-intents",
	"reporting-heal",
	"coupon-orphans",
] as const;

export type SweepLeg = (typeof SWEEP_LEGS)[number];

/** What one leg did. `count` is the leg's own unit of work — orders expired,
 *  pointers written, carries finished — and is `0` for a leg that found nothing. */
export interface SweepLegOutcome {
	readonly leg: SweepLeg;
	readonly ok: boolean;
	readonly count: number;
	/** Present and true for a leg this deployment cannot run yet (see
	 *  `order-emails`), which is NOT a failure and must not read as one. */
	readonly skipped?: boolean;
	/** The failure message, when `ok` is false. */
	readonly error?: string;
	/** Loud, human-readable markers a leg wants surfaced (a genuinely lost hold).
	 *  Also logged, and — for a hold anomaly — written to the order itself. */
	readonly anomalies?: readonly string[];
}

/** One tick's report. Always returned — a leg that threw is a row in here. */
export interface CommerceSweepSummary {
	readonly task: string;
	readonly scheduledAt: string;
	readonly legs: readonly SweepLegOutcome[];
}

export interface CommerceSweepOptions {
	/**
	 * The outbox's sender — an OVERRIDE since INC-C5, not the only source. Left
	 * unset, the tick builds the in-process `CtxHttpEmailSender` from the context
	 * and this bundle's email API URL; a suite sets it to pin the outbox against a
	 * fake without any egress. Neither one existing (no injection, no configured
	 * URL) makes the `order-emails` leg report `skipped` rather than pretend to
	 * drain an outbox — a silent no-op here would look exactly like an empty one.
	 */
	readonly emailSender?: EmailSender;
	/** Deterministic time, for a suite that pins deadlines. Default: real time. */
	readonly now?: Date;
	/** Rows per scan page. The host clamps `limit` to 100, so this is a floor. */
	readonly pageSize?: number;
	/** Safety cap on scan pages per leg per tick — a sweep must never become an
	 *  unbounded table walk on a large store. Exhausting it is not a truncation
	 *  here: the leg's cursor resumes at the next tick. */
	readonly maxPages?: number;
	/** How far back the `order_sku_index` heal's cursor may be pulled when it has
	 *  none (first run, or a lost cursor). An older gap is a backfill, not a
	 *  sweep. Default: 48 hours. */
	readonly skuIndexLookbackMs?: number;
	/** How long a claimed redemption may sit before the coupon sweeper judges it
	 *  orphaned. Default: the DOMAIN's own `DEFAULT_COUPON_GRACE_MS`, so the sweep
	 *  and `reconcileCouponRedemptions` cannot disagree about what "stale" means. */
	readonly couponGraceMs?: number;
	/** How many CLOSED days back the reporting heal may reach when it has no
	 *  cursor, and how many days one tick may reconcile. Defaults: 7 and 7. */
	readonly reportingBackfillDays?: number;
	readonly reportingMaxDaysPerTick?: number;
	/**
	 * Cursor persistence. Defaults to `ctx.kv`; a suite injects its own to pin a
	 * leg's window instead of inheriting whatever the previous case left behind.
	 */
	readonly cursors?: SweepCursorStore;
}

/** Where an advancing scan keeps its place between ticks. */
export interface SweepCursorStore {
	read(name: string): Promise<string | null>;
	write(name: string, value: string): Promise<void>;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SKU_INDEX_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const DEFAULT_REPORTING_BACKFILL_DAYS = 7;
const DEFAULT_REPORTING_MAX_DAYS_PER_TICK = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far BACK an advancing cursor is rewound from the newest row it read.
 *
 * Not a nicety: `createdAt` is stamped by the writer, so two rows can land in an
 * order the index does not agree with (a slow writer, a clock a few seconds off).
 * A cursor parked exactly on the newest row read would step over such a row
 * forever. Five minutes of deliberate overlap costs a handful of re-reads — each
 * of which is a guarded no-op — and closes that hole.
 */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

/** `ctx.kv` keys. Namespaced, because kv is shared with settings and display prefs. */
const CURSOR_KEY_PREFIX = "cron:sweep:cursor:";
const SKU_TRANSFER_CURSOR = "sku-transfers";
const SKU_INDEX_CURSOR = "order-sku-index";
const COUPON_CURSOR = "coupon-orphans";
const REPORTING_CURSOR = "reporting-heal";

/** The states in which an order still OWES the matching hold intent. A `lost`
 *  reservation reported against an order that has left these is the non-versioned
 *  read losing a race, not a lost hold (hazard 2). */
const INTENT_OWNER_STATE: Record<"adopt" | "commit" | "release", readonly OrderState[]> = {
	adopt: ["pending"],
	commit: ["paid", "processing", "shipped", "delivered", "completed", "refunded"],
	release: ["expired", "cancelled"],
};

/**
 * Run every leg of the commerce sweep once.
 *
 * Never rejects for a leg failure: the summary carries each leg's own outcome, so
 * a broken sweep is visible without taking the other eight down with it. It DOES
 * reject when the context carries no document store, because that is a wiring
 * fault rather than a sweep result.
 */
export async function runCommerceSweeps(
	ctx: PluginContext,
	task: string,
	options: CommerceSweepOptions = {},
): Promise<CommerceSweepSummary> {
	const stores = createInProcessCommerceStores(ctx);
	// `createInProcessCommerceStores` already threw if this were undefined.
	const storage = ctx.storage as AdapterStorageAccess;
	const cursors = options.cursors ?? kvCursors(ctx);
	const now = options.now ?? stores.clock.now();
	const nowIso = now.toISOString();
	const legs: SweepLegOutcome[] = [];

	const run = async (
		leg: SweepLeg,
		body: () => Promise<Omit<SweepLegOutcome, "leg" | "ok">>,
	): Promise<void> => {
		try {
			const outcome = { leg, ok: true, ...(await body()) };
			legs.push(outcome);
			// The tick's one durable trace. `worker.ts`'s `scheduled()` logged each
			// leg's count under its own label and this is that line, carried over.
			console.log(
				`[otta] cron sweep ${leg} ${String(outcome.count)}` +
					(outcome.skipped === true ? " (skipped — not wired on this deployment)" : ""),
			);
			for (const anomaly of outcome.anomalies ?? []) {
				console.error(`[otta] cron sweep ${leg} ANOMALY ${anomaly}`);
			}
		} catch (err) {
			// One label, one catch — a leg that throws must not starve the rest.
			legs.push({
				leg,
				ok: false,
				count: 0,
				error: err instanceof Error ? err.message : String(err),
			});
			console.error(`[otta] cron sweep ${leg} FAILED:`, err);
		}
	};

	await run("expire-holds", async () => {
		// The parity gap, closed: ONE settings read per tick drives the TTL that
		// both the cart hold and this sweep are measured against.
		const settings = await stores.settingsStore.get();
		return {
			count: await expireHolds(
				{
					cartStore: stores.cartStore,
					inventoryStore: stores.inventory,
					clock: stores.clock,
					ttlMs: settings.holdTtlMinutes * 60_000,
				},
				now,
			),
		};
	});

	await run("expire-orders", async () => ({
		count: await expireOrders(
			{
				orderStore: stores.orderStore,
				inventoryStore: stores.inventory,
				couponStore: stores.couponStore,
				clock: stores.clock,
			},
			now,
		),
	}));

	await run("order-emails", async () => {
		// INC-C5 closes the gap this leg's `skipped` arm was placeholding. When no
		// sender is INJECTED (a suite pinning the outbox with a fake), one is built
		// from the context: the in-process `CtxHttpEmailSender`, egressing through
		// `ctx.http` to the email host `allowedHosts` already grants. It is STILL
		// `undefined` on a deployment whose bundle carries no email API URL, and
		// that still reports `skipped` rather than pretending to drain the outbox —
		// an undrained outbox and a silently discarded one look identical from here.
		const emailSender =
			options.emailSender ??
			(await makeEmailSender(ctx, { apiUrl: IN_PROCESS_EGRESS_URLS.emailApiUrl }));
		if (emailSender === undefined) return { count: 0, skipped: true };
		return {
			count: await dispatchOrderEmails({
				orderStore: stores.orderStore,
				emailSender,
				customerStore: stores.customerStore,
				clock: stores.clock,
			}),
		};
	});

	await run("prune-challenges", async () => ({
		count: await stores.credentialVerifier.pruneChallenges(nowIso),
	}));

	await run("sku-transfers", async () => ({
		count: await sweepSkuTransfers(storage, stores, cursors, options),
	}));

	await run(
		"order-sku-index",
		async () => await healOrderSkuIndex(storage, stores, now, cursors, options),
	);

	await run(
		"hold-intents",
		async () => await completeHoldIntents(storage, stores, nowIso, options),
	);

	await run("reporting-heal", async () => ({
		count: await healReportingRollups(stores, now, cursors, options),
	}));

	await run("coupon-orphans", async () => ({
		count: await releaseOrphanedRedemptions(storage, stores, now, cursors, options),
	}));

	return { task, scheduledAt: nowIso, legs };
}

// ── cursors ─────────────────────────────────────────────────────────────────

/**
 * The default cursor store: `ctx.kv`, which is ungated and plugin-scoped.
 *
 * BOTH HALVES SWALLOW THEIR FAILURES, on purpose and with a log line. A cursor is
 * an optimisation over a correct-but-wasteful full re-read: losing one costs a
 * repeat of work that is idempotent by construction. Failing the leg because its
 * bookmark could not be saved would trade a cheap re-read for no sweep at all.
 */
function kvCursors(ctx: PluginContext): SweepCursorStore {
	return {
		async read(name) {
			try {
				const value = await ctx.kv.get<string>(`${CURSOR_KEY_PREFIX}${name}`);
				return typeof value === "string" && value !== "" ? value : null;
			} catch (err) {
				console.error(`[otta] cron sweep cursor read failed (${name}):`, err);
				return null;
			}
		},
		async write(name, value) {
			try {
				await ctx.kv.set(`${CURSOR_KEY_PREFIX}${name}`, value);
			} catch (err) {
				console.error(`[otta] cron sweep cursor write failed (${name}):`, err);
			}
		},
	};
}

/** One bounded pass over a declared index. */
interface ScannedWindow<T> {
	readonly items: readonly { id: string; data: T }[];
	/** True when the window was read to its END inside the page budget — which is
	 *  what tells a rotating cursor to wrap and a forward cursor that it is caught
	 *  up. False means "more to come", never "silently truncated". */
	readonly reachedEnd: boolean;
}

/**
 * Page a collection on a DECLARED index, bounded by `maxPages`.
 *
 * The bound is structural here rather than remembered at each call site, and —
 * unlike the adapters' `ScanPageLimitError` convention, which exists because a
 * caller asking for "all expirable orders" must never be handed a short list — a
 * short read is CORRECT for a sweep: every caller below carries a cursor, so the
 * rows this pass did not reach are the rows the next tick starts from. What must
 * never happen is a short read with no cursor, which is the bug this replaced.
 */
async function scanWindow<T>(
	collection: ReturnType<typeof collectionOf<T>>,
	query: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> },
	options: CommerceSweepOptions,
): Promise<ScannedWindow<T>> {
	const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const items: { id: string; data: T }[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const result = await collection.query({
			...query,
			limit,
			...(cursor === undefined ? {} : { cursor }),
		} as Parameters<typeof collection.query>[0]);
		items.push(...result.items);
		if (!result.hasMore || result.cursor === undefined) return { items, reachedEnd: true };
		cursor = result.cursor;
	}
	return { items, reachedEnd: false };
}

/** The newest `createdAt` a window read, rewound by the overlap — the next tick's
 *  lower bound. `null` for an empty window, which leaves the cursor where it was. */
function nextForwardCursor(items: readonly { data: { createdAt?: string } }[]): string | null {
	let newest: string | null = null;
	for (const item of items) {
		const at = item.data.createdAt;
		if (typeof at !== "string") continue;
		if (newest === null || at > newest) newest = at;
	}
	if (newest === null) return null;
	const rewound = new Date(Date.parse(newest) - CURSOR_OVERLAP_MS);
	return Number.isNaN(rewound.getTime()) ? null : rewound.toISOString();
}

// ── the five completers ──────────────────────────────────────────────────────

/**
 * SKU-TRANSFER COMPLETION (ADR-0019 sweeper concern 5).
 *
 * A rename moves units between two `inventory/{sku}` documents while the decision
 * lives in a third (`product_commerce/{productId}`), so the intent is RECORDED in
 * the same compare-and-set that commits the new sku and whoever finds it finishes
 * it. This is the "whoever" of last resort.
 *
 * DISCOVERY GOES THROUGH PRODUCTS, not inventory, and that is forced rather than
 * chosen: `INVENTORY_COLLECTIONS` declares ZERO indexes, so `transferOut` is not a
 * queryable field and a stamped source sku cannot be found by asking for stamped
 * source skus. `product_commerce` declares `createdAt`, so the products are
 * scannable, and a product that owes nothing costs one already-fetched document
 * to rule out.
 *
 * AND THE CURSOR ROTATES, because `product_commerce` declares nothing that says
 * "this product has a pending rename" — there is no `holdsPendingAt` analogue to
 * narrow by, so the predicate cannot shrink as the work completes. A fixed
 * `createdAt ASC` scan would therefore re-read the oldest page every tick and
 * never reach a stranded carry on a catalog larger than one tick's budget. So the
 * cursor advances through the catalog and WRAPS at the end: every product is
 * visited within one rotation, whatever the catalog's size.
 */
async function sweepSkuTransfers(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
): Promise<number> {
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const from = await cursors.read(SKU_TRANSFER_CURSOR);
	const window = await scanWindow<ProductCommerceDoc>(
		products,
		{
			...(from === null ? {} : { where: { createdAt: { gt: from } } }),
			orderBy: { createdAt: "asc" },
		},
		options,
	);
	let finished = 0;
	for (const item of window.items) {
		const sources = new Set<string>();
		for (const record of Object.values(item.data.pendingRenames ?? {})) sources.add(record.fromSku);
		for (const variant of Object.values(item.data.variants ?? {})) {
			for (const record of Object.values(variant.pendingRenames ?? {})) sources.add(record.fromSku);
		}
		// Nothing recorded: not a candidate, and not a read.
		if (sources.size === 0) continue;
		finished += await stores.productCommerce.completeRecordedRenames(item.data.productId);
		// And the OTHER half of the same coupling: a carry whose product record was
		// already cleared can still have left `inventory/{fromSku}` stamped. One read
		// per source sku when there is no stamp, so it costs nothing in the common case.
		for (const sku of sources) {
			if (await stores.productCommerce.completePendingSkuTransfer(sku)) finished++;
		}
	}
	// WRAP at the end of the catalog; otherwise carry on from the newest row read.
	// The rotation is also what heals a row this pass stepped over at a page seam:
	// the next full turn reads it again.
	const next = window.reachedEnd ? "" : lastCreatedAt(window.items);
	if (next !== null) await cursors.write(SKU_TRANSFER_CURSOR, next);
	return finished;
}

/** The last row's `createdAt` in an ASC window — the exact resume point, with no
 *  overlap, because this cursor's safety net is the rotation rather than a rewind. */
function lastCreatedAt(items: readonly { data: { createdAt?: string } }[]): string | null {
	const last = items.at(-1);
	const at = last?.data.createdAt;
	return typeof at === "string" ? at : null;
}

/**
 * `order_sku_index` HEAL (ADR-0019 sweeper concern 7 — derived pointers).
 *
 * The by-sku search arm reads these pointers, and they are DERIVED: an order is
 * truth, a pointer is a cache of one of its facts. A crash between the order write
 * and its pointer writes makes an order invisible to a sku search while remaining
 * perfectly valid everywhere else — the exact failure a derived pointer has, and
 * the reason it must be swept rather than trusted.
 *
 * CREATE-IF-ABSENT ONLY, via `compareAndSet(id, null, …)`: the heal never
 * overwrites an existing pointer, so it cannot clobber a live writer, and two
 * sweeps racing the same gap produce one pointer because exactly one wins the
 * guarded create. A pointer with no order is deliberately NOT deleted here —
 * that is a different concern with a different failure mode, and this leg's whole
 * claim is that it only ever adds what an order already says.
 *
 * THE AGREEMENT CHECK IS THE ADAPTER'S, reproduced. `EmdashOrderStore` pairs its
 * own create-if-absent with `#assertPointerAgrees`: a create that did not apply is
 * fine when the incumbent names the SAME order and is a `DerivedPointerConflictError`
 * when it names another. Both of those are private, and the adapter exposes no
 * public heal — so this leg reproduces the write AND the check rather than the
 * write alone, which is what the first cut did. That duplication is a real seam and
 * is recorded as a follow-up: the right home is a public method on the adapter that
 * owns the collection, which is a `@otta-sh/store-emdash` change and outside this
 * increment.
 *
 * THE CURSOR ADVANCES rather than the window being pinned to `now - 48h`. A fixed
 * lower bound scanned `createdAt ASC` under a page budget can never reach the
 * NEWEST orders on a busy store — precisely the ones a crash just orphaned. The
 * lookback is now only the floor a cursor-less first run starts from.
 */
async function healOrderSkuIndex(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
): Promise<{ count: number; anomalies?: readonly string[] }> {
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const pointers = collectionOf<OrderSkuIndexDoc>(storage, ORDER_SKU_INDEX_COLLECTION);
	const floor = new Date(
		now.getTime() - (options.skuIndexLookbackMs ?? DEFAULT_SKU_INDEX_LOOKBACK_MS),
	).toISOString();
	const saved = await cursors.read(SKU_INDEX_CURSOR);
	const since = saved !== null && saved > floor ? saved : floor;
	const anomalies: string[] = [];
	let written = 0;
	const window = await scanWindow<OrderDoc>(
		orders,
		{ where: { createdAt: { gt: since } }, orderBy: { createdAt: "asc" } },
		options,
	);
	for (const item of window.items) {
		const doc = item.data;
		for (const foldedSku of orderSkuKeys(doc)) {
			const id = orderSkuIndexId(foldedSku, doc.orderId);
			const applied = await pointers.compareAndSet(id, null, {
				sku: foldedSku,
				orderId: doc.orderId,
				// The order's own creation instant, frozen: what makes the arm a keyset arm.
				createdAt: doc.createdAt,
			});
			if (applied.applied) {
				written++;
				continue;
			}
			// Did not apply: either the pointer is already this order's (the healthy
			// case, and the reason a heal is cheap) or it belongs to another order,
			// which is the conflict the adapter raises rather than overwrites.
			const incumbent = await pointers.get(id);
			if (incumbent === null || incumbent.orderId === doc.orderId) continue;
			anomalies.push(`${ORDER_SKU_INDEX_COLLECTION}/${id}: held by ${incumbent.orderId}`);
			await stores.orderStore.flagReconciliation(
				toOrderId(doc.orderId),
				`sku pointer ${id} is held by order ${incumbent.orderId}`,
			);
		}
	}
	const next = nextForwardCursor(window.items);
	if (next !== null) await cursors.write(SKU_INDEX_CURSOR, next);
	return anomalies.length === 0 ? { count: written } : { count: written, anomalies };
}

/**
 * PARTIAL ADOPT/COMMIT/RELEASE COMPLETION (D2, ADR-0019 sweeper concern 3).
 *
 * An order's holds are adopted, committed and released one reservation at a time,
 * and the SET of those per-id writes is not atomic with the order flip that decided
 * them. So the flip records its INTENT on the order — the reservation ids, and a
 * `completedAt` that stays null while work is owed — and `holdsPendingAt` carries
 * the earliest such intent as a DECLARED INDEX. That index is this leg's whole
 * discovery: the orders with outstanding hold work are exactly the orders whose
 * `holdsPendingAt` is at or before now.
 *
 * NO CURSOR HERE, and that is the point of the field: `holdsPendingAt` goes NULL
 * once the order owes nothing, so the predicate narrows by itself as the work
 * completes. A tick that runs out of budget leaves the remainder still matching,
 * and the next tick starts with them.
 *
 * HAZARD 1 lives here and is respected by construction: the completers below walk
 * the order's own intent and drive per-id calls. `commitMany` skips ids already
 * terminal in `reservation_index`, so replaying a batch over a partly-committed set
 * would silently complete nothing and stamp the intent done.
 *
 * HAZARD 2 is handled below the calls: their guard reads a non-versioned `get`, so
 * a `lost` id is re-judged against the order's CURRENT state before it counts as an
 * anomaly — and one that survives is WRITTEN TO THE ORDER, not merely returned.
 */
async function completeHoldIntents(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	nowIso: string,
	options: CommerceSweepOptions,
): Promise<{ count: number; anomalies?: readonly string[] }> {
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const anomalies: string[] = [];
	let completed = 0;
	const window = await scanWindow<OrderDoc>(
		orders,
		{ where: { holdsPendingAt: { lte: nowIso } }, orderBy: { holdsPendingAt: "asc" } },
		options,
	);
	for (const item of window.items) {
		const id = toOrderId(item.data.orderId);
		const attempts = [
			{ kind: "adopt" as const, result: await stores.orderStore.completeHoldAdoption(id) },
			{ kind: "commit" as const, result: await stores.orderStore.completeHoldCommit(id) },
			{ kind: "release" as const, result: await stores.orderStore.completeHoldRelease(id) },
		];
		const lost = attempts.filter((attempt) => attempt.result.lost.length > 0);
		completed += attempts.filter((attempt) => attempt.result.completed).length;
		if (lost.length === 0) continue;
		// HAZARD 2. The completers decided from a non-versioned read; re-read the
		// order NOW and keep only the losses that are still the order's problem.
		const current = await orders.get(item.data.orderId);
		const state = current === null ? null : current.state;
		if (state === null) continue;
		const real: string[] = [];
		for (const attempt of lost) {
			if (!INTENT_OWNER_STATE[attempt.kind].includes(state as OrderState)) continue;
			for (const reservationId of attempt.result.lost) {
				anomalies.push(`${item.data.orderId}:${attempt.kind}:${reservationId}`);
				real.push(`${attempt.kind} ${reservationId}`);
			}
		}
		// ADR-0019 §7.13: an anomaly must always be RECORDABLE. The hook's return
		// value is not a record — the cron executor discards it — so the finding goes
		// onto the order, where an operator (and the admin's reconciliation surface)
		// will actually meet it.
		if (real.length > 0) {
			await stores.orderStore.flagReconciliation(
				id,
				`cron sweep: hold reservations lost while the order was ${state} — ${real.join(", ")}`,
			);
		}
	}
	return anomalies.length === 0 ? { count: completed } : { count: completed, anomalies };
}

/**
 * REPORTING ROLLUP HEAL (D3 item 4).
 *
 * The daily rollup is a different aggregate from the orders it counts, so a crash
 * between an order's write and its rollup delta leaves the day wrong. `reconcile`
 * recomputes a day from the orders themselves and rewrites it only when it differs,
 * which is what makes re-reconciling affordable.
 *
 * MORE THAN ONE DAY, deliberately. The first cut reconciled exactly `now - 24h` and
 * nothing else, so a day lost to a deploy outage, a paused cron or a day whose
 * reconcile kept failing was never healed by any later tick — the one gap the leg
 * exists to close was the one it could not close. A cursor now records the last day
 * healed and the leg walks forward from there.
 *
 * THE LIVE DAY IS NEVER RECONCILED FROM A SCHEDULE — that is the reporting store's
 * own rule (a live day is reconciled on demand) — so the walk always stops at the
 * CLOSED day, and the closed day itself is re-done on every tick because orders
 * from it can still settle. Everything older is healed once and left alone.
 *
 * BOUNDED AT BOTH ENDS. A cursor-less first run reaches back `reportingBackfillDays`
 * and no further (older than that is a backfill, not a sweep), and one tick
 * reconciles at most `reportingMaxDaysPerTick` days — the reporting store's own
 * docs ask a caller sweeping history to chunk it, because its page budget is per
 * day but its latency is not.
 */
async function healReportingRollups(
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
): Promise<number> {
	const closed = dayKey(new Date(now.getTime() - DAY_MS));
	const floor = addDays(
		closed,
		-(options.reportingBackfillDays ?? DEFAULT_REPORTING_BACKFILL_DAYS),
	);
	const saved = await cursors.read(REPORTING_CURSOR);
	// `YYYY-MM-DD` compares lexicographically exactly as it compares chronologically.
	let from = saved === null ? floor : addDays(saved, 1);
	if (from < floor) from = floor;
	if (from > closed) from = closed;
	const span = (options.reportingMaxDaysPerTick ?? DEFAULT_REPORTING_MAX_DAYS_PER_TICK) - 1;
	const capped = addDays(from, Math.max(span, 0));
	const to = capped < closed ? capped : closed;
	const result = await stores.reportingStore.reconcile({
		from: `${from}T00:00:00.000Z`,
		to: `${to}T23:59:59.999Z`,
	});
	await cursors.write(REPORTING_CURSOR, to);
	return result.documentsWritten;
}

function dayKey(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
	return dayKey(new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS));
}

/**
 * THE COUPON SWEEPER (ADR-0019 sweeper concern 6; the ratified INC-C4 brief
 * amendment).
 *
 * A redemption claims its once-only key, then claims a per-customer slot, then
 * bumps the coupon's global counter — three documents, no transaction. A checkout
 * that dies after the claim leaves a redemption holding a use and a slot for an
 * order that never became durable: the coupon looks exhausted, and the customer
 * looks like they already used it.
 *
 * ORPHANED MEANS THE ORDER DOES NOT EXIST, and nothing else. That is the domain's
 * own rule — `reconcileCouponRedemptions` in `@otta-sh/domain` releases exactly the
 * `getById === null` case — and it is the rule the brief amendment ratified. The
 * first cut also released redemptions whose order was `expired` or `cancelled`, and
 * both arms were wrong: `expireOrders` ALREADY calls `couponStore.releaseByOrder`,
 * so the expired arm was redundant, and `cancelOrder` deliberately releases no
 * coupon, so the cancelled arm silently reversed a shipped policy an hour after the
 * fact — handing back a per-customer slot for a coupon a real order consumed. A
 * change to that policy belongs in an ADR, not in a sweeper.
 *
 * WHY NOT JUST CALL `reconcileCouponRedemptions`. Its rule is reused verbatim and
 * its grace default is imported rather than re-picked, but its READ cannot be: it
 * calls `listRedemptionsCreatedBefore(cutoff)`, which collects EVERY redemption
 * still holding a use — up to a hundred thousand documents — on every fifteen-minute
 * tick. That read is the leg's other blocking defect, because `holdsUse` stays
 * `"yes"` for a terminal `applied` redemption: the list is dominated by legitimate
 * redemptions that will never be released, sorted oldest-first, so any fixed-size
 * bite out of its head is permanently occupied by them and a new orphan is never
 * reached. `state` is NOT a declared index, so it cannot be filtered on.
 *
 * SO THE WINDOW ADVANCES. The leg queries `coupon_redemptions` directly on the two
 * fields that ARE declared — `createdAt` and `holdsUse` — between a cursor and the
 * grace cutoff, and moves the cursor past everything it judged. A redemption ruled
 * live stays behind the cursor forever, which is correct: an order that exists now
 * exists for good, so it can never become an orphan later. An orphan is reached on
 * the tick that first sees it, whatever the collection's size.
 *
 * RELEASE is `CouponStore.release`, not a hand-rolled undo, and that matters: it
 * settles an ambiguous `bumping` redemption to a terminal state FIRST — rather than
 * guessing whether the counter was touched — then frees the per-customer slot, then
 * deletes the claim, and only decrements the global counter when the settled state
 * says it was actually consumed. Idempotent by construction: a second sweep finds
 * no redemption to release.
 *
 * WHAT THIS LEG DOES NOT DO, said plainly rather than left to be discovered:
 * ADR-0019 also requires a RECOUNT of the global counter, because a release that
 * dies between the guarded delete and the decrement leaves `usesCount` one HIGH and
 * a recount is the only thing that restores exactness. `CouponStore` exposes no
 * recount, and adding one is a `@otta-sh/store-emdash` change — out of this
 * increment's scope. The residual is in the SAFE direction (a use nobody holds
 * refuses a redemption that might have fit; it never grants one that does not).
 */
async function releaseOrphanedRedemptions(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	now: Date,
	cursors: SweepCursorStore,
	options: CommerceSweepOptions,
): Promise<number> {
	const redemptions = collectionOf<CouponRedemptionDoc>(storage, COUPON_REDEMPTIONS_COLLECTION);
	const cutoff = new Date(
		now.getTime() - (options.couponGraceMs ?? DEFAULT_COUPON_GRACE_MS),
	).toISOString();
	const from = await cursors.read(COUPON_CURSOR);
	const createdAt = from === null ? { lt: cutoff } : { gt: from, lt: cutoff };
	const window = await scanWindow<CouponRedemptionDoc>(
		redemptions,
		{ where: { createdAt, holdsUse: "yes" }, orderBy: { createdAt: "asc" } },
		options,
	);
	let released = 0;
	for (const item of window.items) {
		const order = await stores.orderStore.getById(toOrderId(item.data.orderId));
		// The ratified scope, and the domain's rule: an order that EXISTS is not this
		// sweeper's business, whatever state it is in.
		if (order !== null) continue;
		await stores.couponStore.release(item.data.redemptionId);
		released++;
	}
	const next = nextForwardCursor(window.items);
	if (next !== null) await cursors.write(COUPON_CURSOR, next);
	return released;
}
