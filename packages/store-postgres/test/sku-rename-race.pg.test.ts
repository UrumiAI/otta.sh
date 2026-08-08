import { idempotencyKey, productId, sku, SkuStockConflictError } from "@otta-sh/domain";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyInventoryStore, KyselyProductCommerceStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";
import { TickingClock } from "./ticking-clock.js";

// THE SKU-RENAME RULE under REAL concurrency (Postgres-required, independent
// connections — better-sqlite3 serializes every writer onto one connection and
// therefore cannot race at all).
//
// The rule's whole point is that a rename MOVES units rather than stranding
// them, and a move is only safe if exactly one mover can ever win a target sku.
// Two renames aimed at one target is the case that decides it: the loser must
// fail cleanly and leave BOTH products exactly as they were, and the units must
// be conserved to the unit — never duplicated onto the target, never lost
// between the two rows.
//
// BOTH WRITERS ARE RACED, deliberately. `updateCommerceFields` is protected by
// its compare-and-set on `updated_at`; `upsert` has NO such guard, so it is the
// one whose before-read has to take the row lock itself, and the one whose
// races below would go quiet first if that lock were dropped.

const PG = process.env.PG_CONNECTION_STRING;

interface PgFixture {
	products: KyselyProductCommerceStore;
	inventory: KyselyInventoryStore;
	db: Kysely<Database>;
	/** A live, sku-bearing product with a stocked inventory row; returns the
	 *  `updatedAt` watermark its next guarded edit has to pass back. */
	seedProduct(id: string, s: string, onHand: number): Promise<string>;
	onHand(s: string): Promise<number | null>;
	skuOf(id: string): Promise<string | null>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** A schema-isolated store whose pool holds `poolMax` connections, so the
 *  concurrent renames below each get an INDEPENDENT one (a real race). */
async function freshPg(poolMax: number): Promise<PgFixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;
	const clock = new TickingClock("2026-07-10T00:00:00.000Z");
	const products = new KyselyProductCommerceStore({ db, clock });
	const inventory = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	return {
		products,
		inventory,
		db,
		async seedProduct(id, s, onHand) {
			const row = await products.upsert(
				{ productId: productId(id), sku: sku(s) },
				idempotencyKey(`seed-${id}`),
			);
			await db
				.insertInto("inventory")
				.values({ sku: s, on_hand: onHand })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: onHand }))
				.execute();
			return row.updatedAt.toISOString();
		},
		async onHand(s) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", s)
				.executeTakeFirst();
			return row?.on_hand ?? null;
		},
		async skuOf(id) {
			const row = await db
				.selectFrom("product_commerce")
				.select("sku")
				.where("product_id", "=", id)
				.executeTakeFirst();
			return row?.sku ?? null;
		},
	};
}

describe.skipIf(PG === undefined)("sku rename concurrency [postgres]", () => {
	test("two renames onto ONE free target: exactly one lands, the loser leaves no trace, and the units are conserved", async () => {
		const LOOPS = 12;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const a = `prod-a-${loop}`;
			const b = `prod-b-${loop}`;
			const skuA = `SKU-A-${loop}`;
			const skuB = `SKU-B-${loop}`;
			const target = `SKU-T-${loop}`;
			const wmA = await h.seedProduct(a, skuA, 40);
			const wmB = await h.seedProduct(b, skuB, 7);

			// Both products reach for the same, currently free, target sku on
			// independent connections. Two guards can arbitrate this — the live-sku
			// partial index on `product_commerce` and the rule's own inventory
			// claim — and which one fires is a timing detail. What this case pins
			// is the OUTCOME, whichever does: one winner, a clean loser, and every
			// unit accounted for. (The claim's own contention is the fourth case
			// below, where the index has nothing to say.)
			const results = await Promise.allSettled([
				h.products.updateCommerceFields(
					{ productId: productId(a), sku: sku(target) },
					idempotencyKey(`rename-a-${loop}`),
					wmA,
				),
				h.products.updateCommerceFields(
					{ productId: productId(b), sku: sku(target) },
					idempotencyKey(`rename-b-${loop}`),
					wmB,
				),
			]);

			const winners = results.filter((r) => r.status === "fulfilled");
			const losers = results.filter((r) => r.status === "rejected");

			// (a) EXACTLY ONE renamed. Two winners would mean two products sharing
			// one sku and one inventory row; zero would mean the rule deadlocked
			// itself out of a legal rename.
			expect(winners, `loop ${loop}: exactly one winner`).toHaveLength(1);
			expect(losers, `loop ${loop}: exactly one loser`).toHaveLength(1);

			// (b) The loser failed with a TYPED domain error, never a raw
			// constraint violation surfacing as a 500. Either refusal is legal
			// here and which one fires is a timing detail: the live-sku partial
			// index may reject the second product row before the rule is reached,
			// or the rule's own claim may find the target taken.
			const reason: unknown = (losers[0] as PromiseRejectedResult).reason;
			expect(reason, `loop ${loop}: typed refusal`).toBeInstanceOf(Error);
			expect(
				["SkuConflictError", "SkuStockConflictError"],
				`loop ${loop}: typed refusal, got ${String((reason as Error).message)}`,
			).toContain((reason as Error).name);

			// (c) The loser's product is UNTOUCHED — still its own sku, still its
			// own units. A partially applied rename is the failure mode that would
			// leave a product pointing at stock it does not own.
			const renamedA = (await h.skuOf(a)) === target;
			const loserId = renamedA ? b : a;
			const loserSku = renamedA ? skuB : skuA;
			const loserUnits = renamedA ? 7 : 40;
			const winnerUnits = renamedA ? 40 : 7;
			expect(await h.skuOf(loserId), `loop ${loop}: loser keeps its sku`).toBe(loserSku);
			expect(await h.onHand(loserSku), `loop ${loop}: loser keeps its units`).toBe(loserUnits);

			// (d) CONSERVATION: the target holds exactly the winner's count — not
			// both counts merged, not a fresh zero beside the winner's orphaned
			// units — and the winner's old row is retained, emptied.
			expect(await h.onHand(target), `loop ${loop}: target holds the winner's units`).toBe(
				winnerUnits,
			);
			const winnerOldSku = renamedA ? skuA : skuB;
			expect(await h.onHand(winnerOldSku), `loop ${loop}: source retained at zero`).toBe(0);
			const total =
				((await h.onHand(target)) ?? 0) +
				((await h.onHand(winnerOldSku)) ?? 0) +
				((await h.onHand(loserSku)) ?? 0);
			expect(total, `loop ${loop}: 47 units in, 47 units out`).toBe(47);
		}
	}, 120_000);

	test("two renames onto one ALREADY-OCCUPIED target: both refuse, and no product adopts the parked units", async () => {
		const LOOPS = 12;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const a = `occ-a-${loop}`;
			const b = `occ-b-${loop}`;
			const skuA = `SKU-OA-${loop}`;
			const skuB = `SKU-OB-${loop}`;
			const parked = `SKU-PARKED-${loop}`;
			const wmA = await h.seedProduct(a, skuA, 10);
			const wmB = await h.seedProduct(b, skuB, 3);
			// Units parked under a sku NO live product holds — what an earlier
			// rename leaves behind, and the state the rule refuses to arbitrate.
			await h.db.insertInto("inventory").values({ sku: parked, on_hand: 99 }).execute();

			const results = await Promise.allSettled([
				h.products.updateCommerceFields(
					{ productId: productId(a), sku: sku(parked) },
					idempotencyKey(`occ-a-${loop}`),
					wmA,
				),
				h.products.updateCommerceFields(
					{ productId: productId(b), sku: sku(parked) },
					idempotencyKey(`occ-b-${loop}`),
					wmB,
				),
			]);

			// Both lose, and both lose the SAME way: the rule never picks a winner
			// for a target that already has a row.
			for (const r of results) {
				expect(r.status, `loop ${loop}: both refuse`).toBe("rejected");
				expect(
					(r as PromiseRejectedResult).reason,
					`loop ${loop}: the stock refusal, not the index's`,
				).toBeInstanceOf(SkuStockConflictError);
			}

			expect(await h.skuOf(a), `loop ${loop}`).toBe(skuA);
			expect(await h.skuOf(b), `loop ${loop}`).toBe(skuB);
			expect(await h.onHand(skuA), `loop ${loop}`).toBe(10);
			expect(await h.onHand(skuB), `loop ${loop}`).toBe(3);
			expect(await h.onHand(parked), `loop ${loop}: parked units untouched`).toBe(99);
		}
	}, 120_000);

	test("a rename racing a SEED of the target sku: the claim decides it, and the loser is still a typed refusal", async () => {
		const LOOPS = 30;
		const h = await freshPg(8);
		// An interleaving case that only ever took ONE branch would assert half of
		// what it claims and never say so. Counted, then asserted at the end.
		let renameWon = 0;
		let seedWon = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `seed-race-${loop}`;
			const from = `SKU-SR-FROM-${loop}`;
			const target = `SKU-SR-TO-${loop}`;
			const wm = await h.seedProduct(id, from, 40);

			// The one contention the live-sku index CANNOT arbitrate. `seedOnHand`
			// is attempted on every product save, and live-sku uniqueness is a
			// PARTIAL index — a soft-deleted product may still hold the target sku,
			// so a sync save of that tombstone seeds the target's inventory row
			// while a live product is renaming onto it. Both creators reach for the
			// same row with nothing above them to serialize the attempt.
			const [renamed] = await Promise.allSettled([
				h.products.updateCommerceFields(
					{ productId: productId(id), sku: sku(target) },
					idempotencyKey(`seed-race-${loop}`),
					wm,
				),
				h.inventory.seedOnHand(target, 0),
			]);

			if (renamed === undefined) throw new Error("no result");
			if (renamed.status === "rejected") seedWon++;
			else renameWon++;
			if (renamed.status === "rejected") {
				// The seed got there first. That MUST arrive as the typed refusal —
				// a naive "look, then insert" would surface the collision as a raw
				// duplicate-key violation instead, i.e. a 500 where the operator
				// should have been told the sku is taken.
				expect(renamed.reason, `loop ${loop}: typed, never a raw constraint error`).toBeInstanceOf(
					SkuStockConflictError,
				);
				// …and it refused ATOMICALLY: the product kept its sku and its units.
				expect(await h.skuOf(id), `loop ${loop}`).toBe(from);
				expect(await h.onHand(from), `loop ${loop}`).toBe(40);
				expect(await h.onHand(target), `loop ${loop}: the seed's empty row`).toBe(0);
			} else {
				// The rename got there first: it owns the row, and the seed that
				// followed found it and left the carried units alone.
				expect(renamed.value.ok, `loop ${loop}`).toBe(true);
				expect(await h.skuOf(id), `loop ${loop}`).toBe(target);
				expect(await h.onHand(target), `loop ${loop}: carried, not reset`).toBe(40);
				expect(await h.onHand(from), `loop ${loop}: source retained at zero`).toBe(0);
			}

			// Either way, 40 units in, 40 units out — never 80, never 0.
			const total = ((await h.onHand(from)) ?? 0) + ((await h.onHand(target)) ?? 0);
			expect(total, `loop ${loop}: conservation`).toBe(40);
		}

		// Both interleavings actually happened, so both branches above were
		// genuinely asserted rather than merely written down.
		expect(renameWon, "the rename-first branch fired").toBeGreaterThan(0);
		expect(seedWon, "the seed-first branch fired").toBeGreaterThan(0);
	}, 120_000);

	// -- upsert: the writer with NO compare-and-set -------------------------
	//
	// `updateCommerceFields` is guarded by its CAS on `updated_at`, so an
	// interleaved write turns it into `stale` and the carry never runs on a sku
	// that moved underneath it. `upsert` has no such guard: its before-read is
	// the only thing standing between a concurrent rename and a carry against a
	// sku the row no longer holds, which is why the read takes the row lock and
	// why these three cases exist.

	test("upsert: two concurrent renames of ONE product to DIFFERENT skus chain — the second carries from the first's result, not from a stale read", async () => {
		const LOOPS = 40;
		const h = await freshPg(8);
		let bWon = 0;
		let cWon = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-diff-${loop}`;
			const from = `SKU-UD-FROM-${loop}`;
			const toB = `SKU-UD-B-${loop}`;
			const toC = `SKU-UD-C-${loop}`;
			await h.seedProduct(id, from, 40);

			// With a plain SELECT before-read this is the silent-stranding case: the
			// loser reads `from`, the winner moves the units to its own target, and
			// the loser then carries an already-empty `from` to ITS target — leaving
			// 40 units under a sku no product owns, with no error raised anywhere.
			//
			// The two calls are ALTERNATED rather than left to the scheduler. Both
			// start in the same tick and the first one issued always reaches the row
			// lock first, so a fixed order would exercise exactly one interleaving
			// forty times over and quietly leave the other unproven. Swapping which
			// is issued first drives both, deterministically.
			const bFirst = loop % 2 === 0;
			const renameB = () =>
				h.products.upsert(
					{ productId: productId(id), sku: sku(toB) },
					idempotencyKey(`ud-b-${loop}`),
				);
			const renameC = () =>
				h.products.upsert(
					{ productId: productId(id), sku: sku(toC) },
					idempotencyKey(`ud-c-${loop}`),
				);
			const results = await Promise.allSettled(
				bFirst ? [renameB(), renameC()] : [renameC(), renameB()],
			);

			// Both writes are legal — they serialize rather than conflict — so both
			// must succeed, and the row ends on whichever committed last.
			for (const r of results) {
				expect(r.status, `loop ${loop}: both upserts apply`).toBe("fulfilled");
			}
			const finalSku = await h.skuOf(id);
			if (finalSku === null) throw new Error(`loop ${loop}: the product lost its sku`);
			expect([toB, toC], `loop ${loop}`).toContain(finalSku);
			if (finalSku === toB) bWon++;
			else cWon++;

			// THE ASSERTION THAT BITES: every unit is under the sku the product
			// actually holds. A stale before-read parks them under the other target.
			expect(await h.onHand(finalSku), `loop ${loop}: units follow the product`).toBe(40);
			const orphan = finalSku === toB ? toC : toB;
			expect(await h.onHand(from), `loop ${loop}: original source emptied`).toBe(0);
			expect(await h.onHand(orphan), `loop ${loop}: intermediate sku emptied`).toBe(0);
			const total =
				((await h.onHand(from)) ?? 0) + ((await h.onHand(toB)) ?? 0) + ((await h.onHand(toC)) ?? 0);
			expect(total, `loop ${loop}: conservation`).toBe(40);
		}

		// Both orderings really did run, so the conservation assertions above were
		// exercised in both directions — and the row always ends on whichever
		// write was issued SECOND, which is itself the claim that the second
		// write read the first's result instead of a stale snapshot.
		expect(bWon, "the B-last ordering occurred").toBeGreaterThan(0);
		expect(cWon, "the C-last ordering occurred").toBeGreaterThan(0);
	}, 120_000);

	test("upsert: two concurrent renames of one product to the SAME sku both succeed — the second sees the rename already done, not a conflict it did not cause", async () => {
		const LOOPS = 20;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-same-${loop}`;
			const from = `SKU-US-FROM-${loop}`;
			const to = `SKU-US-TO-${loop}`;
			await h.seedProduct(id, from, 18);

			const results = await Promise.allSettled([
				h.products.upsert(
					{ productId: productId(id), sku: sku(to) },
					idempotencyKey(`us-1-${loop}`),
				),
				h.products.upsert(
					{ productId: productId(id), sku: sku(to) },
					idempotencyKey(`us-2-${loop}`),
				),
			]);

			// A stale before-read makes the second racer think it is renaming
			// from → to all over again, find `to` occupied by the first, and refuse
			// with a SkuStockConflictError against a conflict the operator never
			// created. Read through the lock, it sees the row already at `to`,
			// compares equal, and carries nothing.
			for (const r of results) {
				const why = r.status === "rejected" ? String((r.reason as Error).message) : "";
				expect(r.status, `loop ${loop}: no spurious refusal — ${why}`).toBe("fulfilled");
			}
			expect(await h.skuOf(id), `loop ${loop}`).toBe(to);
			expect(await h.onHand(to), `loop ${loop}: carried exactly once`).toBe(18);
			expect(await h.onHand(from), `loop ${loop}: source emptied`).toBe(0);
		}
	}, 120_000);

	test("upsert RACING a CAS edit: whoever loses writes nothing, and the units are never split", async () => {
		const LOOPS = 25;
		const h = await freshPg(8);
		let editStale = 0;

		// Warm the pool before timing anything. A first use of a connection pays
		// for the TCP connect and session setup, and that cost lands on whichever
		// side happens to open a fresh one — enough to change which writer reaches
		// the row first. Warming makes the ordering below the usual one rather
		// than a coin flip; the assertions inside the loop do not depend on it.
		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-cas-${loop}`;
			const from = `SKU-UC-FROM-${loop}`;
			const viaUpsert = `SKU-UC-UP-${loop}`;
			const viaEdit = `SKU-UC-ED-${loop}`;
			const wm = await h.seedProduct(id, from, 12);

			// The two writers with different guards, aimed at one row at the same
			// moment: the integrator PUT and the console's guarded edit, renaming to
			// different skus.
			//
			// The edit USUALLY loses, and not by luck: its before-read is a plain
			// SELECT that takes no lock, so the upsert's locking read slips between
			// that SELECT and the edit's guarded UPDATE whichever is issued first.
			// The edit then waits, the upsert commits and moves `updated_at`, and
			// the CAS no longer matches — the CAS doing exactly its job, which is
			// why the edit's before-read needs no lock of its own while the upsert's
			// does.
			//
			// "Usually" is deliberate. On a cold connection the setup cost can hand
			// the edit the row first, and then the edit legitimately applies and the
			// upsert renames again on top of it. Both are correct, so the assertions
			// below describe the OUTCOME rather than the schedule: whichever way it
			// falls, no writer leaves units behind and none are duplicated.
			const [up, ed] = await Promise.allSettled([
				h.products.upsert(
					{ productId: productId(id), sku: sku(viaUpsert) },
					idempotencyKey(`uc-up-${loop}`),
				),
				h.products.updateCommerceFields(
					{ productId: productId(id), sku: sku(viaEdit) },
					idempotencyKey(`uc-ed-${loop}`),
					wm,
				),
			]);

			// The upsert has no CAS, so it always applies; the edit either applied or
			// reported `stale`. Neither may throw, and neither may half-apply.
			expect(up?.status, `loop ${loop}: the upsert applies`).toBe("fulfilled");
			expect(ed?.status, `loop ${loop}: the edit resolves, never throws`).toBe("fulfilled");
			if (ed?.status === "fulfilled" && !ed.value.ok) {
				expect(ed.value.reason, `loop ${loop}`).toBe("stale");
				editStale++;
			}

			// OUTCOME-SHAPED, so both legal schedules pass a correct implementation.
			// The product ends on the upsert's sku either way — it is the writer
			// with no CAS to lose — and every unit is under whichever sku the
			// product actually holds. The edit's sku is left with no units whether
			// it never got one (the edit went stale) or was carried through (the
			// edit applied and the upsert then moved them on).
			const finalSku = await h.skuOf(id);
			expect(finalSku, `loop ${loop}`).toBe(viaUpsert);
			expect(await h.onHand(viaUpsert), `loop ${loop}: units follow the product`).toBe(12);
			expect(
				(await h.onHand(viaEdit)) ?? 0,
				`loop ${loop}: no units left under the sku the product does not hold`,
			).toBe(0);
			// Conservation across EVERY sku that was named — the assertion that
			// catches a split, whichever writer did the splitting.
			const total =
				((await h.onHand(from)) ?? 0) +
				((await h.onHand(viaEdit)) ?? 0) +
				((await h.onHand(viaUpsert)) ?? 0);
			expect(total, `loop ${loop}: conservation`).toBe(12);
		}

		// At least one loop genuinely exercised the CAS rejection — without this
		// the case could pass having never raced at all. It is deliberately NOT an
		// equality: a loop where the edit wins is a legal schedule, not a failure.
		expect(editStale, "the CAS rejected the edit at least once").toBeGreaterThan(0);
	}, 120_000);

	test("upsert renaming AFTER a CAS edit landed: the before-read comes from the STORED row, not from the caller's input", async () => {
		const LOOPS = 25;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-seq-${loop}`;
			const from = `SKU-US2-FROM-${loop}`;
			const viaEdit = `SKU-US2-ED-${loop}`;
			const viaUpsert = `SKU-US2-UP-${loop}`;
			const wm = await h.seedProduct(id, from, 12);

			// SEQUENCED, not raced, and it does NOT discriminate the row lock —
			// worth saying plainly, because the name invites the opposite reading.
			// The edit is fully committed before the upsert starts, so there is no
			// concurrent window and nothing for a snapshot to be stale about; a
			// plain SELECT would read the edit's sku here just as correctly.
			//
			// What it DOES pin is that the before-read is taken from the STORED row
			// at all, rather than from anything the caller knows. The upsert's own
			// input names only the destination, and its caller last saw the product
			// on `from` — so a carry sourced from caller state, or from a sku
			// remembered anywhere but the row, moves the wrong units. The lock's own
			// necessity is pinned by the three concurrent cases above, each of which
			// fails without it.
			const ed = await h.products.updateCommerceFields(
				{ productId: productId(id), sku: sku(viaEdit) },
				idempotencyKey(`us2-ed-${loop}`),
				wm,
			);
			expect(ed.ok, `loop ${loop}: the edit lands`).toBe(true);
			expect(await h.onHand(viaEdit), `loop ${loop}`).toBe(12);

			const up = await h.products.upsert(
				{ productId: productId(id), sku: sku(viaUpsert) },
				idempotencyKey(`us2-up-${loop}`),
			);

			// The upsert's before-read has to yield the EDIT's sku, because that is
			// what the row holds. Sourcing it from the caller's last-known value
			// would carry an already-empty `from` and strand all twelve units under
			// the edit's sku.
			expect(up.sku, `loop ${loop}`).toBe(viaUpsert);
			expect(await h.onHand(viaUpsert), `loop ${loop}: carried from the edit's sku`).toBe(12);
			expect(await h.onHand(viaEdit), `loop ${loop}: the intermediate sku is emptied`).toBe(0);
			const total =
				((await h.onHand(from)) ?? 0) +
				((await h.onHand(viaEdit)) ?? 0) +
				((await h.onHand(viaUpsert)) ?? 0);
			expect(total, `loop ${loop}: conservation`).toBe(12);
		}
	}, 120_000);

	test("a rename racing a restock of the sku it is leaving conserves every unit", async () => {
		const LOOPS = 15;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `mv-${loop}`;
			const from = `SKU-MV-FROM-${loop}`;
			const to = `SKU-MV-TO-${loop}`;
			const wm = await h.seedProduct(id, from, 20);

			// The merchant renames while the warehouse books in 5 more units under
			// the old label. The carry reads the source through a lock, so it
			// cannot copy a count that then changes underneath it: whichever order
			// the two commit in, no unit is invented and none disappears.
			const [renamed, restocked] = await Promise.all([
				h.products.updateCommerceFields(
					{ productId: productId(id), sku: sku(to) },
					idempotencyKey(`mv-rename-${loop}`),
					wm,
				),
				h.inventory.restock(from, 5, idempotencyKey(`mv-restock-${loop}`)),
			]);

			expect(renamed.ok, `loop ${loop}: the rename lands`).toBe(true);
			expect(restocked.ok, `loop ${loop}: the restock lands`).toBe(true);
			expect(await h.skuOf(id), `loop ${loop}`).toBe(to);

			const total = ((await h.onHand(from)) ?? 0) + ((await h.onHand(to)) ?? 0);
			expect(total, `loop ${loop}: 25 units in, 25 units out`).toBe(25);
			// Whatever the interleaving, no row ever goes negative or loses a unit
			// to the gap between reading the source and zeroing it.
			expect(await h.onHand(to), `loop ${loop}: the product's units moved`).toBeGreaterThanOrEqual(
				20,
			);
		}
	}, 120_000);
});
