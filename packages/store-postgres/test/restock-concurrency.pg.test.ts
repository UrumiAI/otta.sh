import { idempotencyKey } from "@urumi/domain";
import { FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyInventoryStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// Merchant restock / removeStock must uphold the headline no-oversell invariant
// under REAL concurrency (Postgres-required, independent connections;
// better-sqlite3 serializes on one connection and cannot race). A restock is an
// unconditional commutative increment (can never oversell); a removeStock is a
// guarded decrement (WHERE on_hand >= qty) that competes for the same units a
// reserve does — neither can drive on_hand negative or honor a reservation that
// wasn't backed by real stock.

const PG = process.env.PG_CONNECTION_STRING;

interface PgFixture {
	store: KyselyInventoryStore;
	db: Kysely<Database>;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** A schema-isolated pg store whose pool can hold `poolMax` connections, so N
 *  concurrent movements each acquire an INDEPENDENT connection (a real race). */
async function freshPgStore(poolMax: number): Promise<PgFixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;
	const store = new KyselyInventoryStore({
		db,
		idGen: uuidIdGen,
		clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
	});
	return {
		store,
		db,
		async seed(sku, qty) {
			await db
				.insertInto("inventory")
				.values({ sku, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
	};
}

describe.skipIf(PG === undefined)("restock / removeStock concurrency [postgres]", () => {
	test("no oversell: a restock of +N races M reservations — successes bounded by real units, exact conservation, losers fail cleanly, never negative — Postgres", async () => {
		const INITIAL = 5;
		const RESTOCK = 10;
		const M = 40; // reservations of 1 unit each
		const LOOPS = 15;
		const h = await freshPgStore(M + 8);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.db.deleteFrom("reservations").execute();
			await h.seed("SKU-1", INITIAL);

			// One restock (+N) racing M single-unit reservations on INDEPENDENT
			// connections. The restock only ever RAISES availability, so no
			// reservation it commutes with can be pushed into oversell.
			//
			// NOTE the success COUNT is deliberately asserted as a RANGE, not an
			// exact number: how many reservations land depends on WHEN the restock
			// commits relative to them. A reservation that runs after the initial
			// units are drained but BEFORE the restock commits legitimately fails
			// OUT_OF_STOCK — a terminal, key-consuming outcome (R2), NOT a bug.
			// "Every reservation that could fit after +N succeeds" is a timing
			// assumption, not an invariant; only the bounds below hold under EVERY
			// legal interleaving. (The deterministic sequenced test that follows
			// pins the "restock landed ⇒ new units are reservable" liveness.)
			const restockP = h.store.restock("SKU-1", RESTOCK, idempotencyKey(`rs-${loop}`));
			const reserveP = Array.from({ length: M }, (_u, i) =>
				h.store.reserve("SKU-1", 1, idempotencyKey(`rv-${loop}-${i}`)),
			);
			const [restock, ...reserves] = await Promise.all([restockP, ...reserveP]);

			expect(restock.ok, `loop ${loop}: restock ok`).toBe(true);
			const okReserves = reserves.filter((r) => r.ok).length;
			const capacity = INITIAL + RESTOCK;

			// (a) NO OVERSELL — the invariant: successes can never exceed the real
			// units that ever existed (initial + restocked).
			expect(okReserves, `loop ${loop}: no oversell`).toBeLessThanOrEqual(Math.min(M, capacity));
			// Lower bound: a 1-unit guarded decrement only fails when on_hand = 0 at
			// its moment, which requires ≥ INITIAL prior successes — so at least the
			// initial units are ALWAYS honored, whatever the restock timing.
			expect(okReserves, `loop ${loop}: initial units honored`).toBeGreaterThanOrEqual(
				Math.min(M, INITIAL),
			);
			// (c) every loser failed CLEANLY with OUT_OF_STOCK (never a throw — all
			// M promises resolved into the union) and its key stays consumed.
			for (const r of reserves) {
				if (!r.ok) expect(r.reason, `loop ${loop}: clean failure`).toBe("OUT_OF_STOCK");
			}

			// (b) EXACT CONSERVATION — forbids both a lost restock and a phantom
			// unit: final on_hand = initial + N − (successful reservations × 1).
			const finalOnHand = await h.onHand("SKU-1");
			expect(finalOnHand, `loop ${loop}: conservation`).toBe(capacity - okReserves);
			expect(finalOnHand, `loop ${loop}: never negative`).toBeGreaterThanOrEqual(0);
		}
	}, 120_000);

	test("liveness: once a restock has COMMITTED, the added units are reservable — M reservations then honor exactly min(M, initial + N) — Postgres", async () => {
		const INITIAL = 5;
		const RESTOCK = 10;
		const M = 40;
		const LOOPS = 10;
		const h = await freshPgStore(M + 8);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.db.deleteFrom("reservations").execute();
			await h.seed("SKU-1", INITIAL);

			// SEQUENCED, not raced: the restock is awaited (durably committed)
			// BEFORE any reservation starts. Now the exact count IS an invariant:
			// every unit of initial + N is visible to the guarded decrements, so
			// exactly min(M, capacity) reservations must be honored — pinning that a
			// landed restock is never masked by ledger locking or a stale read.
			const restock = await h.store.restock("SKU-1", RESTOCK, idempotencyKey(`rs-${loop}`));
			expect(restock).toEqual({ ok: true, onHand: INITIAL + RESTOCK });

			const reserves = await Promise.all(
				Array.from({ length: M }, (_u, i) =>
					h.store.reserve("SKU-1", 1, idempotencyKey(`rv-${loop}-${i}`)),
				),
			);
			const okReserves = reserves.filter((r) => r.ok).length;
			const capacity = INITIAL + RESTOCK;
			expect(okReserves, `loop ${loop}: exact honor count`).toBe(Math.min(M, capacity));
			expect(await h.onHand("SKU-1"), `loop ${loop}: conservation`).toBe(capacity - okReserves);
		}
	}, 120_000);

	test("concurrent restock replays (same idempotency key) add the units exactly once — Postgres", async () => {
		const N = 24;
		const LOOPS = 12;
		const h = await freshPgStore(N + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.seed("SKU-1", 3);
			const key = idempotencyKey(`same-restock-${loop}`);

			const results = await Promise.all(
				Array.from({ length: N }, () => h.store.restock("SKU-1", 7, key)),
			);

			// Exactly-once: every racer resolves to the SAME recorded result and the
			// +7 lands ONCE (3 → 10), never N times.
			const first = results[0];
			if (first === undefined) throw new Error("no results");
			for (const r of results) expect(r).toEqual(first);
			expect(first).toEqual({ ok: true, onHand: 10 });
			expect(await h.onHand("SKU-1"), `loop ${loop}: added once`).toBe(10);

			// One ledger row for the key.
			const rows = await h.db
				.selectFrom("inventory_stock_movements")
				.selectAll()
				.where("idempotency_key", "=", key)
				.execute();
			expect(rows, `loop ${loop}: single ledger row`).toHaveLength(1);
		}
	}, 120_000);

	test("no oversell under removal: N guarded removals race M reservations — total units removed ≤ initial, on_hand never negative, losers fail cleanly — Postgres", async () => {
		const INITIAL = 12;
		const REMOVERS = 20; // removeStock of 1 unit each
		const RESERVERS = 20; // reserve of 1 unit each
		const LOOPS = 15;
		const h = await freshPgStore(REMOVERS + RESERVERS + 8);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.db.deleteFrom("reservations").execute();
			await h.seed("SKU-1", INITIAL);

			// N guarded removals AND M guarded reservations all competing for the same
			// INITIAL units on independent connections. Both are `WHERE on_hand >= 1`
			// decrements, so the DB serializes them and the total that succeed can
			// never exceed INITIAL — no over-removal, no oversell.
			const removeP = Array.from({ length: REMOVERS }, (_u, i) =>
				h.store.removeStock("SKU-1", 1, idempotencyKey(`rm-${loop}-${i}`)),
			);
			const reserveP = Array.from({ length: RESERVERS }, (_u, i) =>
				h.store.reserve("SKU-1", 1, idempotencyKey(`rv-${loop}-${i}`)),
			);
			const [removeResults, reserveResults] = await Promise.all([
				Promise.all(removeP),
				Promise.all(reserveP),
			]);

			const removed = removeResults.filter((r) => r.ok).length;
			const reserved = reserveResults.filter((r) => r.ok).length;
			// Every loser fails cleanly — a removal with INSUFFICIENT_STOCK, a reserve
			// with OUT_OF_STOCK; never a throw, never negative stock.
			for (const r of removeResults) {
				if (!r.ok) expect(r.reason, `loop ${loop}`).toBe("INSUFFICIENT_STOCK");
			}
			// CONSERVATION: exactly INITIAL units are accounted for — each successful
			// removal permanently retires a unit, each successful reserve holds one.
			expect(removed + reserved, `loop ${loop}: total consumed = initial`).toBe(INITIAL);
			expect(await h.onHand("SKU-1"), `loop ${loop}: on_hand exhausted, never negative`).toBe(0);
		}
	}, 120_000);

	test("concurrent removeStock replays (same idempotency key) remove the units exactly once — Postgres", async () => {
		const N = 24;
		const LOOPS = 12;
		const h = await freshPgStore(N + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.seed("SKU-1", 10);
			const key = idempotencyKey(`same-remove-${loop}`);

			const results = await Promise.all(
				Array.from({ length: N }, () => h.store.removeStock("SKU-1", 4, key)),
			);

			const first = results[0];
			if (first === undefined) throw new Error("no results");
			for (const r of results) expect(r).toEqual(first);
			expect(first).toEqual({ ok: true, onHand: 6 });
			// Removed ONCE (10 → 6), never N times, never negative.
			expect(await h.onHand("SKU-1"), `loop ${loop}: removed once`).toBe(6);
		}
	}, 120_000);
});
