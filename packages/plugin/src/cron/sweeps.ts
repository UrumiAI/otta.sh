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
 *     the state that owns the intent is a real anomaly.
 *
 * THE HOLD-TTL PARITY GAP CLOSES HERE. `in-process-commerce-stores.ts` records it
 * as a MUST-CLOSE item and says where it closes: "with the settings and scheduled-sweep
 * wiring, where the value is loaded once and the sweeps that expire holds run". This
 * is that place — one settings read per tick, feeding `expireHolds`' `ttlMs`, rather
 * than a read on every cart request for a value that changes almost never.
 */
import {
	dispatchOrderEmails,
	expireHolds,
	expireOrders,
	orderId as toOrderId,
	type EmailSender,
	type OrderState,
} from "@otta-sh/domain";
import {
	collectionOf,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	orderSkuKeys,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type ProductCommerceDoc,
	type StorageAccess as AdapterStorageAccess,
} from "@otta-sh/store-emdash";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
} from "../commerce/in-process-commerce-stores.js";
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
	/** Loud, human-readable markers a leg wants surfaced (a genuinely lost hold). */
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
	 * The outbox's sender. ABSENT TODAY: the plugin has no `EmailSender` until
	 * INC-C5 builds one over `ctx.http`, and C5 depends on this increment. Without
	 * one the `order-emails` leg reports `skipped` rather than pretending to drain
	 * an outbox — a silent no-op here would look exactly like an empty outbox.
	 */
	readonly emailSender?: EmailSender;
	/** Deterministic time, for a suite that pins deadlines. Default: real time. */
	readonly now?: Date;
	/** Rows per scan page. The host clamps `limit` to 100, so this is a floor. */
	readonly pageSize?: number;
	/** Safety cap on scan pages per leg per tick — a sweep must never become an
	 *  unbounded table walk on a large store. */
	readonly maxPages?: number;
	/** How far back the `order_sku_index` heal looks. An older gap is a backfill,
	 *  not a sweep. Default: 48 hours. */
	readonly skuIndexLookbackMs?: number;
	/** How long a claimed redemption may sit before the coupon sweeper judges it
	 *  orphaned. Default: 1 hour — comfortably past any checkout. */
	readonly couponGraceMs?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SKU_INDEX_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const DEFAULT_COUPON_GRACE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
	const now = options.now ?? stores.clock.now();
	const nowIso = now.toISOString();
	const legs: SweepLegOutcome[] = [];

	const run = async (
		leg: SweepLeg,
		body: () => Promise<Omit<SweepLegOutcome, "leg" | "ok">>,
	): Promise<void> => {
		try {
			legs.push({ leg, ok: true, ...(await body()) });
		} catch (err) {
			// One label, one catch — a leg that throws must not starve the rest.
			legs.push({
				leg,
				ok: false,
				count: 0,
				error: err instanceof Error ? err.message : String(err),
			});
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
		const emailSender = options.emailSender;
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
		count: await sweepSkuTransfers(storage, stores, options),
	}));

	await run("order-sku-index", async () => ({
		count: await healOrderSkuIndex(storage, now, options),
	}));

	await run(
		"hold-intents",
		async () => await completeHoldIntents(storage, stores, nowIso, options),
	);

	await run("reporting-heal", async () => {
		// The CLOSED day, as a matter of course — a live day is reconciled on demand
		// (the reporting store's own rule), never from a schedule.
		const closed = new Date(now.getTime() - DAY_MS);
		const day = closed.toISOString().slice(0, 10);
		const result = await stores.reportingStore.reconcile({
			from: `${day}T00:00:00.000Z`,
			to: `${day}T23:59:59.999Z`,
		});
		return { count: result.documentsWritten };
	});

	await run("coupon-orphans", async () => ({
		count: await releaseOrphanedRedemptions(stores, now, options),
	}));

	return { task, scheduledAt: nowIso, legs };
}

/**
 * Page a collection on a DECLARED index, bounded by `maxPages`.
 *
 * A sweep's scan is the one place an unbounded walk would hide, so the bound is
 * structural here rather than remembered at each call site.
 */
async function* scan<T>(
	collection: ReturnType<typeof collectionOf<T>>,
	query: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> },
	options: CommerceSweepOptions,
): AsyncGenerator<{ id: string; data: T }> {
	const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	let cursor: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const result = await collection.query({
			...query,
			limit,
			...(cursor === undefined ? {} : { cursor }),
		} as Parameters<typeof collection.query>[0]);
		for (const item of result.items) yield item;
		if (!result.hasMore || result.cursor === undefined) return;
		cursor = result.cursor;
	}
}

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
 */
async function sweepSkuTransfers(
	storage: AdapterStorageAccess,
	stores: InProcessCommerceStores,
	options: CommerceSweepOptions,
): Promise<number> {
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	let finished = 0;
	for await (const item of scan(products, { orderBy: { createdAt: "asc" } }, options)) {
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
	return finished;
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
 * BOUNDED BY A LOOKBACK, because a gap older than the window is a backfill rather
 * than a sweep, and a sweep that walks every order ever placed is not a sweep.
 */
async function healOrderSkuIndex(
	storage: AdapterStorageAccess,
	now: Date,
	options: CommerceSweepOptions,
): Promise<number> {
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const pointers = collectionOf<OrderSkuIndexDoc>(storage, ORDER_SKU_INDEX_COLLECTION);
	const since = new Date(
		now.getTime() - (options.skuIndexLookbackMs ?? DEFAULT_SKU_INDEX_LOOKBACK_MS),
	).toISOString();
	let written = 0;
	for await (const item of scan(
		orders,
		{ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } },
		options,
	)) {
		const doc = item.data;
		for (const foldedSku of orderSkuKeys(doc)) {
			const id = orderSkuIndexId(foldedSku, doc.orderId);
			if ((await pointers.get(id)) !== null) continue;
			const applied = await pointers.compareAndSet(id, null, {
				sku: foldedSku,
				orderId: doc.orderId,
				createdAt: doc.createdAt,
			});
			if (applied.applied) written++;
		}
	}
	return written;
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
 * HAZARD 1 lives here and is respected by construction: the completers below walk
 * the order's own intent and drive per-id calls. `commitMany` skips ids already
 * terminal in `reservation_index`, so replaying a batch over a partly-committed set
 * would silently complete nothing and stamp the intent done.
 *
 * HAZARD 2 is handled below the calls: their guard reads a non-versioned `get`, so
 * a `lost` id is re-judged against the order's CURRENT state before it counts as an
 * anomaly.
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
	for await (const item of scan(
		orders,
		{ where: { holdsPendingAt: { lte: nowIso } }, orderBy: { holdsPendingAt: "asc" } },
		options,
	)) {
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
		for (const attempt of lost) {
			if (state === null) continue;
			if (!INTENT_OWNER_STATE[attempt.kind].includes(state as OrderState)) continue;
			for (const reservationId of attempt.result.lost) {
				anomalies.push(`${item.data.orderId}:${attempt.kind}:${reservationId}`);
			}
		}
	}
	return anomalies.length === 0 ? { count: completed } : { count: completed, anomalies };
}

/**
 * THE COUPON SWEEPER (ADR-0019 sweeper concern 6).
 *
 * A redemption claims its once-only key, then claims a per-customer slot, then
 * bumps the coupon's global counter — three documents, no transaction. A checkout
 * that dies after the claim leaves a redemption holding a use and a slot for an
 * order that never became durable: the coupon looks exhausted, and the customer
 * looks like they already used it.
 *
 * DETECTION is the port's own reconciliation read (`listRedemptionsCreatedBefore`,
 * `holdsUse: "yes"` — both fields declared indexes) paired with the order it names,
 * which is precisely what that method's contract says it exists for. A redemption
 * older than the grace window whose order is ABSENT, EXPIRED or CANCELLED is
 * orphaned; anything else is a live checkout and is left alone. The grace window is
 * what keeps an in-flight checkout out of the sweep's reach.
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
	stores: InProcessCommerceStores,
	now: Date,
	options: CommerceSweepOptions,
): Promise<number> {
	const cutoff = new Date(
		now.getTime() - (options.couponGraceMs ?? DEFAULT_COUPON_GRACE_MS),
	).toISOString();
	const candidates = await stores.couponStore.listRedemptionsCreatedBefore(cutoff);
	let released = 0;
	for (const redemption of candidates.slice(0, options.pageSize ?? DEFAULT_PAGE_SIZE)) {
		const order = await stores.orderStore.getById(redemption.orderId);
		const orphaned = order === null || order.state === "expired" || order.state === "cancelled";
		if (!orphaned) continue;
		await stores.couponStore.release(redemption.id);
		released++;
	}
	return released;
}
