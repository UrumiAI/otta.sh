import { idempotencyKey, productId, sku, SkuStockConflictError } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyInventoryStore, KyselyProductCommerceStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

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
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
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
			// independent connections. Nothing outside the two transactions
			// serializes them — the claim inside the rule has to.
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
