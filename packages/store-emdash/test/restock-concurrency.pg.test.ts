/**
 * Merchant `restock` / `removeStock` must uphold the headline no-oversell
 * invariant under REAL concurrency. Postgres only: one process over
 * better-sqlite3 serializes writers, so no compare-and-set can lose there.
 *
 * Ported from the SQL adapter's race of the same name, with the same shapes and
 * the same invariants. A restock is an unconditional commutative increment and can
 * never oversell; a `removeStock` is the same guarded decrement a `reserve` makes,
 * competing for the same units, and neither may drive the count negative or honour
 * a reservation that was not backed by real stock.
 *
 * Two things differ from the SQL original, both because of the adapter and not the
 * shape:
 *
 * 1. **A fresh sku per loop** replaces "delete the reservations and re-seed".
 *    Emptying the storage table between loops would drop the revision trigger the
 *    whole design depends on, and the holds live inside the aggregate anyway.
 * 2. **A caller may exhaust the compare-and-set budget.** The SQL adapter degraded
 *    gracefully under a single guarded `UPDATE`; this one retries a
 *    read-modify-write, and R2 accepts that with a documented budget and a typed
 *    retryable error. So every settled promise is classified, a contention failure
 *    is counted and REPORTED rather than silently tolerated, and the invariants are
 *    asserted in the form that holds under every legal interleaving: no oversell,
 *    exact conservation, never negative, and every ordinary loser failing cleanly.
 *    A contention failure writes nothing, which is why conservation still pins it.
 *    `settle()` below COUNTS those failures (it does not swallow them), each case's
 *    count and depth are reported under that case's own label, and the merchant
 *    shape asserts a loose ceiling on both. The SEQUENCED restock case is what
 *    catches an "everything contends" regression: it has no contention to hide
 *    behind, so if the retry loop ever degraded, its exact honour count would fail.
 *
 * One harness note: the database is per FILE and is never emptied between cases
 * (emptying it would drop the revision trigger), so every case namespaces BOTH its
 * skus and its idempotency keys. A key shared with an earlier case would replay
 * that case's recorded answer against a different sku, which looks exactly like an
 * oversell in the arithmetic.
 */
import type { ReserveResult, StockRemovalResult } from "@otta-sh/domain";
import { idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InventoryDoc, MovementClaimDoc, StorageAccess } from "../src/index.js";
import {
	CAS_MAX_ATTEMPTS,
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	INVENTORY_MOVEMENTS_COLLECTION,
	isStorageContentionError,
	newInventoryDoc,
	stockClaimId,
	uuidIdGen,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { settleOne } from "./helpers/fault-injection.js";
import { INVENTORY_LAYOUT } from "./inventory-collections.js";

/** The widest crowd any case here races, and therefore the pool size. */
const WIDEST = 48;

/**
 * The loose ceiling on typed contention failures for the merchant removal shape,
 * counted across the whole case (15 loops × 40 callers = 600 calls).
 *
 * Measured 11–29 per run: 40 racers on 12 units, where a REFUSED removal still writes
 * its ledger entry, so the writes are NOT bounded by the units and the depth really
 * does reach the ceiling. Asserted at 90 — 15% of the calls the case makes — which is
 * high enough not to flake on a loaded machine and far below "every caller contends",
 * the retry-loop regression this is here to catch.
 */
const REMOVAL_CONTENTION_CEILING = 90;

/**
 * The ceiling for the SEQUENCED case, where the restock is already durable before any
 * reserve starts. A handful of retry exhaustions is possible on a loaded machine (15
 * units means up to 15 successful writes on one document); dozens would mean the
 * retry loop itself had degraded, which is the regression this case exists to catch.
 */
const SEQUENCED_CONTENTION_CEILING = 5;

/** One case's measurements, so a ceiling is attributed to a SHAPE by evidence. */
interface CaseMetrics {
	readonly label: string;
	maxAttempts: number;
	contentionFailures: number;
}

/**
 * Settle a crowd of calls, splitting typed contention failures from real answers and
 * COUNTING the former onto this case's metrics. Nothing is swallowed: a contention
 * failure wrote nothing, which is why the conservation assertions still hold
 * exactly, and its count is asserted and reported.
 */
async function settle<T>(
	metrics: CaseMetrics,
	calls: Array<Promise<T>>,
	where: string,
): Promise<T[]> {
	const settled = await Promise.all(calls.map((call) => settleOne(call)));
	const answers: T[] = [];
	for (const result of settled) {
		if (isStorageContentionError(result)) {
			metrics.contentionFailures++;
			continue;
		}
		if (result instanceof Error) throw new Error(`${where}: ${result.message}`);
		answers.push(result as T);
	}
	return answers;
}

describe.skipIf(!PG_ENABLED)("restock / removeStock concurrency [postgres]", () => {
	let storage: StorageAccess;
	let close: (() => Promise<void>) | undefined;
	const measured: CaseMetrics[] = [];

	beforeAll(async () => {
		const db = await makePgStorage(INVENTORY_LAYOUT, WIDEST + 8);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
		// One line PER CASE: a file-level maximum would attribute the deepest shape's
		// ceiling to the whole file, which is exactly the attribution this record is
		// for.
		for (const metrics of measured) {
			console.info(
				`[restock-concurrency] shape=${metrics.label} ` +
					`maxCasAttempts=${String(metrics.maxAttempts)}/${String(CAS_MAX_ATTEMPTS)} ` +
					`contentionFailures=${String(metrics.contentionFailures)}`,
			);
		}
	});

	/** Register a case's metrics and build the store that feeds them. */
	const measure = (label: string): CaseMetrics => {
		const metrics: CaseMetrics = { label, maxAttempts: 0, contentionFailures: 0 };
		measured.push(metrics);
		return metrics;
	};

	const makeStore = (metrics: CaseMetrics): EmdashInventoryStore =>
		new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			onCasAttempts: (_operation, attempts) => {
				if (attempts > metrics.maxAttempts) metrics.maxAttempts = attempts;
			},
		});

	const seed = async (sku: string, qty: number): Promise<void> => {
		await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).compareAndSet(
			sku,
			null,
			newInventoryDoc(sku, qty),
		);
	};

	it("no oversell: a restock of +N races M reservations — successes bounded by real units, exact conservation, losers fail cleanly, never negative", async () => {
		const INITIAL = 5;
		const RESTOCK = 10;
		const M = 40; // reservations of 1 unit each
		const LOOPS = 15;
		const metrics = measure("restock+reserve M40/units5+10");
		const store = makeStore(metrics);

		for (let loop = 0; loop < LOOPS; loop++) {
			const sku = `SKU-RS-RACE-${String(loop)}`;
			await seed(sku, INITIAL);

			// One restock (+N) racing M single-unit reservations. The restock only ever
			// RAISES availability, so no reservation it commutes with can be pushed
			// into oversell.
			//
			// NOTE the success COUNT is deliberately a RANGE, not an exact number: how
			// many reservations land depends on WHEN the restock commits relative to
			// them. A reservation that runs after the initial units are drained but
			// BEFORE the restock commits legitimately fails OUT_OF_STOCK — a terminal,
			// key-consuming outcome, not a bug. "Every reservation that could fit after
			// +N succeeds" is a timing assumption, not an invariant; only the bounds
			// below hold under every legal interleaving. (The sequenced case that
			// follows pins the "restock landed ⇒ the new units are reservable"
			// liveness.)
			const restockCall = store.restock(sku, RESTOCK, idempotencyKey(`race-rs-${String(loop)}`));
			const reserveCalls = Array.from({ length: M }, (_unused, i) =>
				store.reserve(sku, 1, idempotencyKey(`race-rv-${String(loop)}-${String(i)}`)),
			);
			const contendedBefore = metrics.contentionFailures;
			const [restock, reserves] = await Promise.all([
				settle<StockRemovalResult>(metrics, [restockCall], `loop ${String(loop)} restock`),
				settle<ReserveResult>(metrics, reserveCalls, `loop ${String(loop)} reserves`),
			]);
			const contendedHere = metrics.contentionFailures - contendedBefore;

			expect(restock[0]?.ok, `loop ${String(loop)}: restock ok`).toBe(true);
			const okReserves = reserves.filter((r) => r.ok).length;
			const capacity = INITIAL + RESTOCK;

			// (a) NO OVERSELL — successes can never exceed the real units that ever
			// existed (initial + restocked).
			expect(okReserves, `loop ${String(loop)}: no oversell`).toBeLessThanOrEqual(
				Math.min(M, capacity),
			);
			// (b) LOWER BOUND, the SQL original's: a 1-unit guarded decrement only fails
			// when the count is 0 at its moment, which requires at least INITIAL prior
			// successes — so at least the initial units are ALWAYS honoured, whatever the
			// restock timing. A caller that exhausted its retry budget never got to
			// decide, so it counts toward the bound rather than breaking it; that is what
			// keeps this a real floor instead of a floor contention could erase.
			expect(
				okReserves + contendedHere,
				`loop ${String(loop)}: initial units honoured`,
			).toBeGreaterThanOrEqual(Math.min(M, INITIAL));
			// (c) every ordinary loser failed CLEANLY with OUT_OF_STOCK, never with a
			// contention failure dressed up as "the item is gone".
			for (const r of reserves) {
				if (!r.ok) expect(r.reason, `loop ${String(loop)}: clean failure`).toBe("OUT_OF_STOCK");
			}
			// (d) EXACT CONSERVATION — forbids both a lost restock and a phantom unit.
			const finalOnHand = await store.getOnHand(sku);
			expect(finalOnHand, `loop ${String(loop)}: conservation`).toBe(capacity - okReserves);
			expect(finalOnHand, `loop ${String(loop)}: never negative`).toBeGreaterThanOrEqual(0);
		}
	}, 300_000);

	it("liveness: once a restock has COMMITTED, the added units are reservable — M reservations then honour exactly min(M, initial + N)", async () => {
		const INITIAL = 5;
		const RESTOCK = 10;
		const M = 40;
		const LOOPS = 10;
		const metrics = measure("restock-then-reserve M40/units15 (sequenced)");
		const store = makeStore(metrics);

		for (let loop = 0; loop < LOOPS; loop++) {
			const sku = `SKU-RS-SEQ-${String(loop)}`;
			await seed(sku, INITIAL);

			// SEQUENCED, not raced: the restock is awaited (durably committed) BEFORE
			// any reservation starts. Now the exact count IS an invariant — every unit
			// of initial + N is visible to the guarded decrements — which pins that a
			// landed restock is never masked by a stale read.
			const restock = await store.restock(sku, RESTOCK, idempotencyKey(`seq-rs-${String(loop)}`));
			expect(restock).toEqual({ ok: true, onHand: INITIAL + RESTOCK });

			// Almost no contention to hide behind, which is what makes this case the
			// detector for an "everything contends" regression in the retry loop.
			const contendedBefore = metrics.contentionFailures;
			const reserves = await settle<ReserveResult>(
				metrics,
				Array.from({ length: M }, (_unused, i) =>
					store.reserve(sku, 1, idempotencyKey(`seq-rv-${String(loop)}-${String(i)}`)),
				),
				`loop ${String(loop)} reserves`,
			);
			const contendedHere = metrics.contentionFailures - contendedBefore;
			const okReserves = reserves.filter((r) => r.ok).length;
			const capacity = INITIAL + RESTOCK;
			// The exact honour count, stated so that contention degrades it rather than
			// falsifying it: with nothing contending these two bounds MEET, pinning
			// exactly min(M, capacity) — a landed restock is never masked by a stale
			// read — and a caller that exhausted its budget never got to decide, so it
			// counts toward the lower bound instead of breaking it.
			expect(okReserves, `loop ${String(loop)}: no oversell`).toBeLessThanOrEqual(
				Math.min(M, capacity),
			);
			expect(
				okReserves + contendedHere,
				`loop ${String(loop)}: exact honour count`,
			).toBeGreaterThanOrEqual(Math.min(M, capacity));
			// And the regression guard the bounds above cannot make: if everything
			// contended, both bounds would still hold.
			expect(
				contendedHere,
				`loop ${String(loop)}: the sequenced shape barely contends`,
			).toBeLessThanOrEqual(SEQUENCED_CONTENTION_CEILING);
			expect(await store.getOnHand(sku), `loop ${String(loop)}: conservation`).toBe(
				capacity - okReserves,
			);
		}
	}, 300_000);

	it("concurrent restock replays (one idempotency key) add the units exactly once", async () => {
		const N = 24;
		const LOOPS = 12;
		const metrics = measure("restock same-key N24");
		const store = makeStore(metrics);
		const movements = collectionOf<MovementClaimDoc>(storage, INVENTORY_MOVEMENTS_COLLECTION);

		for (let loop = 0; loop < LOOPS; loop++) {
			const sku = `SKU-RS-SAME-${String(loop)}`;
			await seed(sku, 3);
			const key = idempotencyKey(`same-restock-${String(loop)}`);

			const results = await settle<StockRemovalResult>(
				metrics,
				Array.from({ length: N }, () => store.restock(sku, 7, key)),
				`loop ${String(loop)}`,
			);

			// Exactly-once: every racer resolves to the SAME recorded result and the +7
			// lands ONCE (3 → 10), never N times.
			const first = results[0];
			if (first === undefined) throw new Error("no results");
			for (const r of results) expect(r).toEqual(first);
			expect(first).toEqual({ ok: true, onHand: 10 });
			expect(await store.getOnHand(sku), `loop ${String(loop)}: added once`).toBe(10);

			// One claim document for the key, ending `applied` with that same answer —
			// the document-model equivalent of the SQL ledger's single row.
			const claim = await movements.get(stockClaimId(key));
			if (claim?.kind !== "stock") throw new Error(`loop ${String(loop)}: missing claim`);
			expect(claim.applied?.result, `loop ${String(loop)}: recorded answer`).toEqual(first);
			const doc = await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(sku);
			expect(
				(doc?.appliedMovements ?? []).filter((entry) => entry.key === key),
				`loop ${String(loop)}: ring holds the key once`,
			).toHaveLength(1);
		}
	}, 300_000);

	it("no oversell under removal: N guarded removals race M reservations — units removed never exceed the initial count, never negative, losers fail cleanly", async () => {
		const INITIAL = 12;
		const REMOVERS = 20; // removeStock of 1 unit each
		const RESERVERS = 20; // reserve of 1 unit each
		const LOOPS = 15;
		const metrics = measure("removeStock+reserve N20+M20/units12");
		const store = makeStore(metrics);

		for (let loop = 0; loop < LOOPS; loop++) {
			const sku = `SKU-RM-RACE-${String(loop)}`;
			await seed(sku, INITIAL);

			// N guarded removals AND M guarded reservations competing for the same
			// INITIAL units. Both are `onHand >= 1` decrements committed by a
			// compare-and-set on one document, so they serialize and the total that
			// succeed can never exceed INITIAL — no over-removal, no oversell.
			const removeCalls = Array.from({ length: REMOVERS }, (_unused, i) =>
				store.removeStock(sku, 1, idempotencyKey(`rmrace-rm-${String(loop)}-${String(i)}`)),
			);
			const reserveCalls = Array.from({ length: RESERVERS }, (_unused, i) =>
				store.reserve(sku, 1, idempotencyKey(`rmrace-rv-${String(loop)}-${String(i)}`)),
			);
			const [removals, reserves] = await Promise.all([
				settle<StockRemovalResult>(metrics, removeCalls, `loop ${String(loop)} removals`),
				settle<ReserveResult>(metrics, reserveCalls, `loop ${String(loop)} reserves`),
			]);

			const removed = removals.filter((r) => r.ok).length;
			const reserved = reserves.filter((r) => r.ok).length;
			// Every ordinary loser fails cleanly — a removal with INSUFFICIENT_STOCK, a
			// reserve with OUT_OF_STOCK; never a throw, never negative stock.
			for (const r of removals) {
				if (!r.ok) expect(r.reason, `loop ${String(loop)}`).toBe("INSUFFICIENT_STOCK");
			}
			for (const r of reserves) {
				if (!r.ok) expect(r.reason, `loop ${String(loop)}`).toBe("OUT_OF_STOCK");
			}
			// NO OVER-CONSUMPTION plus EXACT CONSERVATION: each successful removal
			// permanently retires a unit and each successful reserve holds one, and
			// what is left on the shelf is exactly the remainder.
			expect(removed + reserved, `loop ${String(loop)}: consumed ≤ initial`).toBeLessThanOrEqual(
				INITIAL,
			);
			// LIVENESS FLOOR: whatever contends, this shape must still move units. An
			// all-contend regression — or a guard that refused everyone — would leave
			// this at zero, and "consumed ≤ initial" alone would happily pass.
			expect(
				removed + reserved,
				`loop ${String(loop)}: at least one success`,
			).toBeGreaterThanOrEqual(1);
			expect(await store.getOnHand(sku), `loop ${String(loop)}: conservation`).toBe(
				INITIAL - removed - reserved,
			);
		}

		// The merchant shape is the one that genuinely reaches the compare-and-set
		// ceiling, because a REFUSED removal still writes its ledger entry and the
		// writes are therefore not bounded by the units. Both numbers are recorded in
		// this package's README, and both are asserted so the shape cannot quietly get
		// worse: the depth stays inside the budget the retry loop enforces, and the
		// typed failures stay a minority of the crowd rather than becoming the norm.
		expect(metrics.maxAttempts, "removal shape: depth within the ceiling").toBeLessThanOrEqual(
			CAS_MAX_ATTEMPTS,
		);
		expect(
			metrics.contentionFailures,
			"removal shape: typed contention failures stay loosely bounded",
		).toBeLessThanOrEqual(REMOVAL_CONTENTION_CEILING);
	}, 300_000);

	it("concurrent removeStock replays (one idempotency key) remove the units exactly once", async () => {
		const N = 24;
		const LOOPS = 12;
		const metrics = measure("removeStock same-key N24");
		const store = makeStore(metrics);

		for (let loop = 0; loop < LOOPS; loop++) {
			const sku = `SKU-RM-SAME-${String(loop)}`;
			await seed(sku, 10);
			const key = idempotencyKey(`same-remove-${String(loop)}`);

			const results = await settle<StockRemovalResult>(
				metrics,
				Array.from({ length: N }, () => store.removeStock(sku, 4, key)),
				`loop ${String(loop)}`,
			);

			const first = results[0];
			if (first === undefined) throw new Error("no results");
			for (const r of results) expect(r).toEqual(first);
			expect(first).toEqual({ ok: true, onHand: 6 });
			// Removed ONCE (10 → 6), never N times, never negative.
			expect(await store.getOnHand(sku), `loop ${String(loop)}: removed once`).toBe(6);
		}
	}, 300_000);
});
