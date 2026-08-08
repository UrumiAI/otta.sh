import {
	cents,
	currency,
	idempotencyKey,
	money,
	productId,
	sku,
	SkuStockConflictError,
} from "@otta-sh/domain";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyInventoryStore, KyselyProductCommerceStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// THE SKU-RENAME RULE at VARIANT grain, under REAL concurrency
// (Postgres-required, independent connections — better-sqlite3 serializes every
// writer onto one connection and therefore cannot race at all).
//
// The rule belongs to the `sku` COLUMN rather than to one caller: `inventory` is
// keyed by the bare sku and knows nothing about products or variants. So the
// variant writer is simply a THIRD writer of that column, and it has to be raced
// on its own — the two product-level writers being green proves the carry, not
// that a new caller reaches it correctly.
//
// The last case races something the product level has no analogue for: two
// FIRST-PRICINGS of two different sizes of ONE product, in different currencies.
// Each has its own compare-and-set target, so nothing but the parent row lock
// orders them, and without it a product ends up holding two currencies.

const PG = process.env.PG_CONNECTION_STRING;

/**
 * A clock that ADVANCES a millisecond per reading. A `FixedClock` would make
 * `updated_at` identical on every write, silently turning the compare-and-set
 * into a guard that always passes — a race that "passes" while proving nothing.
 */
class TickingClock {
	#at: number;

	constructor(start: string) {
		this.#at = new Date(start).getTime();
	}

	now(): Date {
		this.#at += 1;
		return new Date(this.#at);
	}
}

interface PgFixture {
	products: KyselyProductCommerceStore;
	inventory: KyselyInventoryStore;
	db: Kysely<Database>;
	/** A product row with no price of its own — the realistic variants shape,
	 *  where the sizes carry the money. */
	seedProduct(id: string): Promise<void>;
	/** A declared, sku-bearing, stocked variant; returns the `updatedAt`
	 *  watermark its next guarded edit has to pass back. */
	seedVariant(id: string, key: string, s: string, onHand: number): Promise<string>;
	/** A declared variant with no sku and no price; returns its watermark. */
	declareVariant(id: string, key: string): Promise<string>;
	onHand(s: string): Promise<number | null>;
	skuOfVariant(id: string, key: string): Promise<string | null>;
	currencies(id: string): Promise<string[]>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** A schema-isolated store whose pool holds `poolMax` connections, so the
 *  concurrent writers below each get an INDEPENDENT one (a real race). */
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
		async seedProduct(id) {
			await products.upsert({ productId: productId(id) }, idempotencyKey(`seed-${id}`));
		},
		async declareVariant(id, key) {
			const row = await products.upsertVariant(
				{ productId: productId(id), variantKey: key, title: `Variant ${key}` },
				idempotencyKey(`declare-${id}-${key}`),
			);
			return row.updatedAt.toISOString();
		},
		async seedVariant(id, key, s, onHand) {
			const declared = await products.upsertVariant(
				{ productId: productId(id), variantKey: key, title: `Variant ${key}` },
				idempotencyKey(`declare-${id}-${key}`),
			);
			const res = await products.updateVariantFields(
				{ productId: productId(id), variantKey: key, sku: sku(s) },
				idempotencyKey(`price-${id}-${key}`),
				declared.updatedAt.toISOString(),
			);
			if (!res.ok) throw new Error(`seedVariant: ${id}/${key} could not take a sku`);
			await db
				.insertInto("inventory")
				.values({ sku: s, on_hand: onHand })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: onHand }))
				.execute();
			return res.variant.updatedAt.toISOString();
		},
		async onHand(s) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", s)
				.executeTakeFirst();
			return row?.on_hand ?? null;
		},
		async skuOfVariant(id, key) {
			const row = await db
				.selectFrom("product_variants")
				.select("sku")
				.where("product_id", "=", id)
				.where("variant_key", "=", key)
				.executeTakeFirst();
			return row?.sku ?? null;
		},
		async currencies(id) {
			const rows = await db
				.selectFrom("product_variants")
				.select("price_currency")
				.where("product_id", "=", id)
				.where("price_currency", "is not", null)
				.execute();
			return [...new Set(rows.map((r) => r.price_currency ?? ""))].toSorted();
		},
	};
}

describe.skipIf(PG === undefined)("variant sku rename concurrency [postgres]", () => {
	test("two SIZES of one product renaming onto ONE free target: exactly one lands, the loser leaves no trace, and the units are conserved", async () => {
		const LOOPS = 12;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `prod-${loop}`;
			const skuL = `V-L-${loop}`;
			const skuS = `V-S-${loop}`;
			const target = `V-T-${loop}`;
			await h.seedProduct(id);
			const wmL = await h.seedVariant(id, "large", skuL, 40);
			const wmS = await h.seedVariant(id, "small", skuS, 7);

			// Two sizes of the same product reach for one free sku on independent
			// connections. Two guards can arbitrate it — the live-sku partial index
			// on `product_variants` and the rename rule's own inventory claim — and
			// which fires is a timing detail. What this pins is the OUTCOME: one
			// winner, a clean loser, every unit accounted for.
			const results = await Promise.allSettled([
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(target) },
					idempotencyKey(`rename-l-${loop}`),
					wmL,
				),
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "small", sku: sku(target) },
					idempotencyKey(`rename-s-${loop}`),
					wmS,
				),
			]);

			const winners = results.filter((r) => r.status === "fulfilled");
			const losers = results.filter((r) => r.status === "rejected");
			expect(winners, `loop ${loop}: exactly one winner`).toHaveLength(1);
			expect(losers, `loop ${loop}: exactly one loser`).toHaveLength(1);

			// The loser failed with a TYPED domain error, never a raw constraint
			// violation surfacing as a 500.
			const reason: unknown = (losers[0] as PromiseRejectedResult).reason;
			expect(reason, `loop ${loop}: typed refusal`).toBeInstanceOf(Error);
			expect(
				["SkuConflictError", "SkuStockConflictError"],
				`loop ${loop}: typed refusal, got ${String((reason as Error).message)}`,
			).toContain((reason as Error).name);

			// The loser's SIZE is untouched — still its own sku, still its own units.
			const largeWon = (await h.skuOfVariant(id, "large")) === target;
			const loserKey = largeWon ? "small" : "large";
			const loserSku = largeWon ? skuS : skuL;
			const loserUnits = largeWon ? 7 : 40;
			const winnerUnits = largeWon ? 40 : 7;
			expect(await h.skuOfVariant(id, loserKey), `loop ${loop}: loser keeps its sku`).toBe(
				loserSku,
			);
			expect(await h.onHand(loserSku), `loop ${loop}: loser keeps its units`).toBe(loserUnits);

			// CONSERVATION: the target holds exactly the winner's count — not both
			// merged, not a fresh zero beside the winner's orphaned units.
			expect(await h.onHand(target), `loop ${loop}: target holds the winner's units`).toBe(
				winnerUnits,
			);
			const winnerOldSku = largeWon ? skuL : skuS;
			expect(await h.onHand(winnerOldSku), `loop ${loop}: source retained at zero`).toBe(0);
			const total =
				((await h.onHand(target)) ?? 0) +
				((await h.onHand(winnerOldSku)) ?? 0) +
				((await h.onHand(loserSku)) ?? 0);
			expect(total, `loop ${loop}: 47 units in, 47 units out`).toBe(47);
		}
	}, 120_000);

	test("two variant renames onto one ALREADY-OCCUPIED target: both refuse, and no size adopts the parked units", async () => {
		const LOOPS = 12;
		const h = await freshPg(8);

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `occ-${loop}`;
			const skuL = `VO-L-${loop}`;
			const skuS = `VO-S-${loop}`;
			const parked = `VO-PARKED-${loop}`;
			await h.seedProduct(id);
			const wmL = await h.seedVariant(id, "large", skuL, 10);
			const wmS = await h.seedVariant(id, "small", skuS, 3);
			// Units parked under a sku NO live sellable unit holds — what an earlier
			// rename leaves behind, and the state the rule refuses to arbitrate.
			await h.db.insertInto("inventory").values({ sku: parked, on_hand: 99 }).execute();

			const results = await Promise.allSettled([
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(parked) },
					idempotencyKey(`occ-l-${loop}`),
					wmL,
				),
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "small", sku: sku(parked) },
					idempotencyKey(`occ-s-${loop}`),
					wmS,
				),
			]);

			for (const r of results) {
				expect(r.status, `loop ${loop}: both refuse`).toBe("rejected");
				expect(
					(r as PromiseRejectedResult).reason,
					`loop ${loop}: the stock refusal, not the index's`,
				).toBeInstanceOf(SkuStockConflictError);
			}

			expect(await h.skuOfVariant(id, "large"), `loop ${loop}`).toBe(skuL);
			expect(await h.skuOfVariant(id, "small"), `loop ${loop}`).toBe(skuS);
			expect(await h.onHand(skuL), `loop ${loop}`).toBe(10);
			expect(await h.onHand(skuS), `loop ${loop}`).toBe(3);
			expect(await h.onHand(parked), `loop ${loop}: parked units untouched`).toBe(99);
		}
	}, 120_000);

	test("a variant rename racing a SEED of the target sku: the claim decides it, and the loser is still a typed refusal", async () => {
		const LOOPS = 30;
		const h = await freshPg(8);
		// An interleaving case that only ever took ONE branch would assert half of
		// what it claims and never say so. Counted, then asserted at the end.
		let renameWon = 0;
		let seedWon = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `seed-race-${loop}`;
			const from = `VSR-FROM-${loop}`;
			const target = `VSR-TO-${loop}`;
			await h.seedProduct(id);
			const wm = await h.seedVariant(id, "large", from, 40);

			// The one contention no unique index can arbitrate: `seedOnHand` is
			// attempted on every sku-bearing save, so another writer can be creating
			// the target's inventory row at the very moment the rename claims it.
			const [renamed] = await Promise.allSettled([
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(target) },
					idempotencyKey(`vsr-${loop}`),
					wm,
				),
				h.inventory.seedOnHand(target, 0),
			]);

			if (renamed === undefined) throw new Error("no result");
			if (renamed.status === "rejected") {
				seedWon++;
				// The seed got there first. A naive "look, then insert" would surface
				// that as a raw duplicate-key violation — a 500 where the operator
				// should have been told the sku is taken.
				expect(renamed.reason, `loop ${loop}: typed, never a raw constraint error`).toBeInstanceOf(
					SkuStockConflictError,
				);
				// …and it refused ATOMICALLY: the size kept its sku and its units.
				expect(await h.skuOfVariant(id, "large"), `loop ${loop}`).toBe(from);
				expect(await h.onHand(from), `loop ${loop}`).toBe(40);
				expect(await h.onHand(target), `loop ${loop}: the seed's empty row`).toBe(0);
			} else {
				renameWon++;
				expect(renamed.value.ok, `loop ${loop}`).toBe(true);
				expect(await h.skuOfVariant(id, "large"), `loop ${loop}`).toBe(target);
				expect(await h.onHand(target), `loop ${loop}: carried, not reset`).toBe(40);
				expect(await h.onHand(from), `loop ${loop}: source retained at zero`).toBe(0);
			}

			// Either way, 40 units in, 40 units out — never 80, never 0.
			const total = ((await h.onHand(from)) ?? 0) + ((await h.onHand(target)) ?? 0);
			expect(total, `loop ${loop}: conservation`).toBe(40);
		}

		expect(renameWon, "the rename-first branch fired").toBeGreaterThan(0);
		expect(seedWon, "the seed-first branch fired").toBeGreaterThan(0);
	}, 120_000);

	test("two sizes FIRST-PRICED at once in different currencies: one lands, and the product never ends up holding two currencies", async () => {
		const LOOPS = 25;
		const h = await freshPg(8);
		let mismatches = 0;

		// Warm the pool before racing anything: a first use of a connection pays for
		// the TCP connect and session setup, which is enough to decide which writer
		// reaches the parent row first. The assertions do not depend on the order.
		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `cur-${loop}`;
			await h.seedProduct(id);
			const wmL = await h.declareVariant(id, "large");
			const wmS = await h.declareVariant(id, "small");

			// Two sizes, each with its OWN compare-and-set target, priced at the same
			// moment in disagreeing currencies. Neither CAS can see the other, and the
			// product row carries no price to read, so the only thing that can order
			// them is the parent row lock the currency resolution takes. Without it
			// both read "no currency yet" and both apply.
			const results = await Promise.allSettled([
				h.products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "large",
						price: money(cents(3000), currency("GBP")),
					},
					idempotencyKey(`cur-l-${loop}`),
					wmL,
				),
				h.products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "small",
						price: money(cents(2500), currency("USD")),
					},
					idempotencyKey(`cur-s-${loop}`),
					wmS,
				),
			]);

			// Neither may THROW — a currency disagreement is a reported outcome the
			// console renders, not an exception.
			for (const r of results) {
				expect(r.status, `loop ${loop}: resolves, never throws`).toBe("fulfilled");
			}
			const outcomes = results.map((r) =>
				r.status === "fulfilled" ? (r.value.ok ? "ok" : r.value.reason) : "threw",
			);
			const applied = outcomes.filter((o) => o === "ok");
			// At least one has to land — refusing both would be the rule deadlocking
			// itself out of two legal first pricings.
			expect(applied.length, `loop ${loop}: ${outcomes.join("/")}`).toBeGreaterThanOrEqual(1);
			if (outcomes.includes("currency_mismatch")) mismatches++;

			// THE ASSERTION THAT BITES: whatever the schedule, the product ends
			// holding ONE currency. Two would give it no honest total, no honest
			// picker and no honest cart.
			expect(await h.currencies(id), `loop ${loop}: one currency per product`).toHaveLength(1);
		}

		// The refusal genuinely fired: without it every loop would have ended with
		// two currencies, and the assertion above would already have caught it — but
		// this pins that the race really was raced rather than serialized by luck.
		expect(mismatches, "the currency refusal fired at least once").toBeGreaterThan(0);
	}, 120_000);
});
