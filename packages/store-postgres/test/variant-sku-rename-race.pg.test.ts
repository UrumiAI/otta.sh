import {
	cents,
	currency,
	idempotencyKey,
	money,
	productId,
	sku,
	SkuConflictError,
	SkuStockConflictError,
} from "@otta-sh/domain";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyInventoryStore, KyselyProductCommerceStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";
import { TickingClock } from "./ticking-clock.js";

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

interface PgFixture {
	products: KyselyProductCommerceStore;
	inventory: KyselyInventoryStore;
	db: Kysely<Database>;
	/** A product row with no sku and no price of its own — the realistic variants
	 *  shape, where the sizes carry the money. Returns the `updatedAt` watermark
	 *  its next guarded edit has to pass back. */
	seedProduct(id: string): Promise<string>;
	/** A declared, sku-bearing, stocked variant; returns the `updatedAt`
	 *  watermark its next guarded edit has to pass back. */
	seedVariant(id: string, key: string, s: string, onHand: number): Promise<string>;
	/** A declared variant with no sku and no price; returns its watermark. */
	declareVariant(id: string, key: string): Promise<string>;
	onHand(s: string): Promise<number | null>;
	skuOfVariant(id: string, key: string): Promise<string | null>;
	/** A live, sku-bearing PRODUCT row; returns the watermark its next guarded
	 *  edit has to pass back. The other kind of live sellable unit. */
	seedPricedProduct(id: string, s: string, cur: string): Promise<string>;
	skuOfProduct(id: string): Promise<string | null>;
	currencyOfProduct(id: string): Promise<string | null>;
	currencies(id: string): Promise<string[]>;
}

/**
 * A few milliseconds of lead, so one of two overlapping transactions reliably
 * reaches a contended row lock first. The transactions still OVERLAP — the point
 * is to decide WHICH holds the lock when the other arrives, not to sequence them.
 */
function headStart(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 15);
	});
}

/** The reported outcome of a settled guarded write, flattened for assertions. */
function outcomeOf(r: PromiseSettledResult<{ ok: boolean; reason?: string }> | undefined): string {
	if (r?.status !== "fulfilled") return "threw";
	return r.value.ok ? "ok" : (r.value.reason ?? "refused");
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
			const row = await products.upsert({ productId: productId(id) }, idempotencyKey(`seed-${id}`));
			return row.updatedAt.toISOString();
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
		async seedPricedProduct(id, s, cur) {
			const row = await products.upsert(
				{
					productId: productId(id),
					sku: sku(s),
					price: money(cents(1000), currency(cur)),
				},
				idempotencyKey(`seed-product-${id}`),
			);
			return row.updatedAt.toISOString();
		},
		async skuOfProduct(id) {
			const row = await db
				.selectFrom("product_commerce")
				.select("sku")
				.where("product_id", "=", id)
				.executeTakeFirst();
			return row?.sku ?? null;
		},
		async currencyOfProduct(id) {
			const row = await db
				.selectFrom("product_commerce")
				.select("price_currency")
				.where("product_id", "=", id)
				.executeTakeFirst();
			return row?.price_currency ?? null;
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

	// -- across the pair: a product write and a variant write, at once ---------
	//
	// Uniqueness and currency integrity both span two tables, and no index spans
	// two tables, so both directions are app-level checks inside a transaction.
	// That makes the CROSSING race the one that decides whether the pair is one
	// rule or two half-rules that happen to agree when run apart.

	test("a PRODUCT and a VARIANT reaching for one free sku at once: never both, and the loser refuses typed", async () => {
		const LOOPS = 20;
		const h = await freshPg(8);
		let tookIt = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const varProd = `xp-v-${loop}`;
			const plainProd = `xp-p-${loop}`;
			const target = `XP-T-${loop}`;
			await h.seedProduct(varProd);
			const wmV = await h.declareVariant(varProd, "large");
			// BOTH sides are FIRST-sku assignments, deliberately: a rename onto an
			// occupied row would be refused by the rename rule before the cross-table
			// check was ever consulted, and the case would pass while proving nothing.
			// A first sku ADOPTS an existing row, so both writes are legal and the
			// cross-table rule is the ONLY thing that can arbitrate them.
			const wmP = await h.seedProduct(plainProd);
			// The target already has a stock row — the state every sku that has ever
			// been stocked, restocked or renamed onto is in, and the row the two
			// halves of the cross-table rule serialize on (see
			// `#lockSkuRowIfPresent`, which also records the never-used-sku bound).
			await h.db.insertInto("inventory").values({ sku: target, on_hand: 0 }).execute();

			// One free sku, two KINDS of sellable unit reaching for it on independent
			// connections. Neither side's unique index can see the other's table, so
			// if the cross-table checks were merely advisory both would land and one
			// `inventory` row would be named by two units — the state a later rename
			// of either one silently drains.
			const results = await Promise.allSettled([
				h.products.updateVariantFields(
					{ productId: productId(varProd), variantKey: "large", sku: sku(target) },
					idempotencyKey(`xp-v-${loop}`),
					wmV,
				),
				h.products.updateCommerceFields(
					{ productId: productId(plainProd), sku: sku(target) },
					idempotencyKey(`xp-p-${loop}`),
					wmP,
				),
			]);

			const landed = results.filter((r) => r.status === "fulfilled" && r.value.ok);
			expect(landed.length, `loop ${loop}: at most one unit takes the sku`).toBeLessThanOrEqual(1);

			const variantHas = (await h.skuOfVariant(varProd, "large")) === target;
			const productHas = (await h.skuOfProduct(plainProd)) === target;
			// THE ASSERTION THAT BITES: never both. One sku, one live sellable unit.
			expect(
				variantHas && productHas,
				`loop ${loop}: a sku may not name two live sellable units`,
			).toBe(false);
			if (variantHas || productHas) tookIt++;

			// A loser refuses TYPED, never a raw constraint violation surfacing as a
			// 500 — and never with a half-applied write behind it.
			for (const r of results) {
				if (r.status === "rejected") {
					expect(r.reason, `loop ${loop}: typed refusal`).toBeInstanceOf(SkuConflictError);
				}
			}
			// The loser is left exactly as it arrived: still sku-less, never half-way
			// into an assignment it was refused.
			if (!productHas) expect(await h.skuOfProduct(plainProd), `loop ${loop}`).toBeNull();
			if (!variantHas) expect(await h.skuOfVariant(varProd, "large"), `loop ${loop}`).toBeNull();
		}

		// Somebody won every loop: refusing both sides would be the pair deadlocking
		// itself out of a legal write rather than arbitrating one. Both sides are
		// FIRST assignments onto a sku that already has a stock row, so both adopt
		// and neither can be turned away by the rename rule — the cross-table check
		// is the only thing that decides, which is the point of the fixture.
		expect(tookIt, "the sku was claimed by exactly one kind of unit").toBe(LOOPS);
	}, 120_000);

	test("a PRODUCT repricing racing a VARIANT pricing: the product never ends in a currency its live sizes do not share", async () => {
		const LOOPS = 25;
		const h = await freshPg(8);
		let refusals = 0;
		let productSideRefused = 0;
		let variantSideRefused = 0;

		// Warm the pool: a first use of a connection pays for the TCP connect and
		// session setup, enough to decide which writer reaches the parent row first.
		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `xc-${loop}`;
			// UNPRICED, deliberately. A product that already carries a price refuses
			// the variant side at guard 4b — the variant's own "match the parent"
			// check — every single loop, so 4c, the reciprocal this case exists for,
			// is never reached and the case passes while proving nothing. With no
			// product-level price BOTH sides are FIRST pricings: each reads "no
			// currency yet" and only the lock order decides.
			const wmP = await h.seedProduct(id);
			const wmV = await h.declareVariant(id, "large");

			// Both directions of the currency rule fired at one instant. The
			// product-side guard reads the live variants and the variant-side guard
			// reads the product, so without ONE lock ordering each reads the other's
			// "before" state and both apply — leaving a product priced in GBP beside a
			// size priced in EUR, which has no honest total and no honest cart.
			// ALTERNATED, and with a real head start rather than a bare issue order.
			// The product side takes the parent's lock as its FIRST statement while the
			// variant side reads its own row before reaching for it, so simply issuing
			// the variant first is not enough to make it win — measured, it never did,
			// and guard 4c went unexercised for all twenty-five loops. A few
			// milliseconds is enough to decide which transaction holds the parent when
			// the other arrives; the transactions still OVERLAP, which is the whole
			// point, and the loser genuinely blocks on the lock rather than finding the
			// work already finished.
			const productFirst = loop % 2 === 0;
			const repriceProduct = () =>
				h.products.updateCommerceFields(
					{ productId: productId(id), price: money(cents(4000), currency("GBP")) },
					idempotencyKey(`xc-p-${loop}`),
					wmP,
				);
			const priceVariant = () =>
				h.products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "large",
						price: money(cents(2500), currency("EUR")),
					},
					idempotencyKey(`xc-v-${loop}`),
					wmV,
				);
			const lead = productFirst ? repriceProduct() : priceVariant();
			await headStart();
			const trail = productFirst ? priceVariant() : repriceProduct();
			const [first, second] = await Promise.allSettled([lead, trail]);
			const productResult = productFirst ? first : second;
			const variantResult = productFirst ? second : first;

			// A currency disagreement is a reported outcome, never an exception.
			for (const r of [productResult, variantResult]) {
				expect(r?.status, `loop ${loop}: resolves, never throws`).toBe("fulfilled");
			}
			const outcomes = [outcomeOf(productResult), outcomeOf(variantResult)];
			if (outcomes.includes("currency_mismatch")) refusals++;
			// WHICH side refused tells us WHICH guard fired: the product side is 4c
			// (it read the live variants), the variant side is 4b (it read the
			// parent). Counted separately so the case cannot quietly degrade into
			// exercising only the pre-existing direction again.
			if (outcomes[0] === "currency_mismatch") productSideRefused++;
			if (outcomes[1] === "currency_mismatch") variantSideRefused++;

			// THE ASSERTION THAT BITES: every currency under this product agrees.
			const productCurrency = await h.currencyOfProduct(id);
			const variantCurrencies = await h.currencies(id);
			const all = new Set([
				...(productCurrency === null ? [] : [productCurrency]),
				...variantCurrencies,
			]);
			expect(
				[...all],
				`loop ${loop}: one currency per product (${outcomes.join("/")})`,
			).toHaveLength(1);
		}

		// The refusal genuinely fired rather than the schedule sparing it — and 4c,
		// the direction this increment added, fired on its own account.
		expect(refusals, "the cross-table currency refusal fired at least once").toBeGreaterThan(0);
		expect(productSideRefused, "guard 4c (the product side) fired at least once").toBeGreaterThan(
			0,
		);
		expect(variantSideRefused + productSideRefused, "every loop was arbitrated").toBe(LOOPS);
	}, 120_000);

	test("the same two first-pricings with NO head start: overlapping, and still one currency", async () => {
		const LOOPS = 40;
		const h = await freshPg(8);
		let refusals = 0;

		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `xc0-${loop}`;
			const wmP = await h.seedProduct(id);
			const wmV = await h.declareVariant(id, "large");

			// THE COMPANION TO THE CASE ABOVE, and the one that actually discriminates
			// the lock ORDER. A head start decides which transaction holds the parent,
			// which is what makes guard 4c reachable — but at roughly a millisecond a
			// statement it also lets the leader COMMIT before the follower reads, so a
			// follower that read the live variants BEFORE taking the parent's lock
			// would still see committed data and still refuse. Issued in the same tick,
			// the two genuinely overlap: the follower's read lands inside the leader's
			// open transaction, and only the lock makes it wait for the answer.
			const results = await Promise.allSettled([
				h.products.updateCommerceFields(
					{ productId: productId(id), price: money(cents(4000), currency("GBP")) },
					idempotencyKey(`xc0-p-${loop}`),
					wmP,
				),
				h.products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "large",
						price: money(cents(2500), currency("EUR")),
					},
					idempotencyKey(`xc0-v-${loop}`),
					wmV,
				),
			]);

			for (const r of results) {
				expect(r.status, `loop ${loop}: resolves, never throws`).toBe("fulfilled");
			}
			const outcomes = results.map((r) =>
				r.status === "fulfilled" ? (r.value.ok ? "ok" : r.value.reason) : "threw",
			);
			if (outcomes.includes("currency_mismatch")) refusals++;

			const productCurrency = await h.currencyOfProduct(id);
			const all = new Set([
				...(productCurrency === null ? [] : [productCurrency]),
				...(await h.currencies(id)),
			]);
			expect(
				[...all],
				`loop ${loop}: one currency per product (${outcomes.join("/")})`,
			).toHaveLength(1);
		}

		expect(refusals, "the overlap was arbitrated at least once").toBeGreaterThan(0);
	}, 120_000);

	// -- the lock order itself -------------------------------------------------
	//
	// Both cases below deadlock (Postgres `40P01`, an unmapped raw error reaching
	// the caller) against an implementation whose locks are individually correct
	// but ordered differently in two writers. Neither can fail on better-sqlite3,
	// which serializes every writer onto one connection — which is exactly why
	// they live here and not in the contract suite.

	test("CROSSING RENAMES X→Y and Y→X, both stocked: one refuses typed, and neither deadlocks", async () => {
		const LOOPS = 300;
		const h = await freshPg(8);

		// Warm the pool: a cold connection's setup cost dwarfs the window these two
		// writers actually overlap in, and a pair that never overlaps proves nothing.
		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `cross-${loop}`;
			const skuX = `CR-X-${loop}`;
			const skuY = `CR-Y-${loop}`;
			await h.seedProduct(id);
			const wmX = await h.seedVariant(id, "large", skuX, 11);
			const wmY = await h.seedVariant(id, "small", skuY, 5);

			// Each rename's SOURCE is the other's TARGET. Locking the target before the
			// source makes these two writers take X,Y and Y,X — the textbook ABBA — and
			// Postgres breaks it with a deadlock, which is a raw 40P01 where the port
			// promises a typed refusal. Source-before-target makes both take the same
			// order, so one waits and then refuses on the occupied row.
			const results = await Promise.allSettled([
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(skuY) },
					idempotencyKey(`cross-l-${loop}`),
					wmX,
				),
				h.products.updateVariantFields(
					{ productId: productId(id), variantKey: "small", sku: sku(skuX) },
					idempotencyKey(`cross-s-${loop}`),
					wmY,
				),
			]);

			for (const r of results) {
				if (r.status === "rejected") {
					const err = r.reason as Error & { code?: string };
					// NEVER a deadlock: `40P01` is unmapped and would surface to a
					// merchant as a 500 on a legal edit.
					expect(err.code, `loop ${loop}: never a deadlock — ${err.message}`).not.toBe("40P01");
					expect(
						["SkuConflictError", "SkuStockConflictError"],
						`loop ${loop}: typed refusal, got ${err.name}: ${err.message}`,
					).toContain(err.name);
				}
			}

			// Both targets are occupied, so neither rename can honestly land: the pair
			// is refused and every unit stays where it was.
			expect(await h.onHand(skuX), `loop ${loop}: X untouched`).toBe(11);
			expect(await h.onHand(skuY), `loop ${loop}: Y untouched`).toBe(5);
			expect(await h.skuOfVariant(id, "large"), `loop ${loop}`).toBe(skuX);
			expect(await h.skuOfVariant(id, "small"), `loop ${loop}`).toBe(skuY);
		}
	}, 120_000);

	test("a RESURRECT racing a PRICE EDIT of a sibling size: no deadlock, and the product still holds one currency", async () => {
		const LOOPS = 25;
		const h = await freshPg(8);

		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `rvp-${loop}`;
			await h.seedProduct(id);
			// A priced orphan: the resurrect will have to resolve the product currency
			// to decide whether its price survives, which reaches the parent row.
			const wmL = await h.declareVariant(id, "large");
			const priced = await h.products.updateVariantFields(
				{
					productId: productId(id),
					variantKey: "large",
					price: money(cents(3000), currency("GBP")),
				},
				idempotencyKey(`rvp-price-${loop}`),
				wmL,
			);
			expect(priced.ok, `loop ${loop}: the orphan was priced`).toBe(true);
			await h.products.deactivateVariant(
				productId(id),
				"large",
				idempotencyKey(`rvp-orphan-${loop}`),
				"2026-07-10T01:00:00.000Z",
			);
			const wmS = await h.declareVariant(id, "small");

			// The declare walks parent → variant row; the price edit walks the same
			// two. Reverse either one and this is a clean ABBA between the CMS sync and
			// the console — the worst pairing available, because the sync has no
			// merchant to show an error to.
			const [declared, edited] = await Promise.allSettled([
				h.products.upsertVariant(
					{
						productId: productId(id),
						variantKey: "large",
						title: "Large",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey(`rvp-back-${loop}`),
				),
				h.products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "small",
						price: money(cents(2500), currency("USD")),
					},
					idempotencyKey(`rvp-edit-${loop}`),
					wmS,
				),
			]);

			// The CMS channel NEVER fails: not on a constraint, not on a deadlock.
			expect(declared?.status, `loop ${loop}: the declare resolves`).toBe("fulfilled");
			if (edited?.status === "rejected") {
				const err = edited.reason as Error & { code?: string };
				expect(err.code, `loop ${loop}: never a deadlock — ${err.message}`).not.toBe("40P01");
			}

			// Whichever order they landed in, the product holds ONE currency: either
			// the resurrect kept GBP and the USD edit was refused, or the edit landed
			// first and the resurrect handed its GBP price back as absent.
			const all = new Set(await h.currencies(id));
			expect([...all], `loop ${loop}: one currency per product`).toHaveLength(1);
		}
	}, 120_000);

	test("CROSSING RENAMES ACROSS TWO PARENTS: P1's size X→Y against P2's size Y→X, both stocked", async () => {
		const LOOPS = 300;
		const h = await freshPg(8);

		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const p1 = `xpar-1-${loop}`;
			const p2 = `xpar-2-${loop}`;
			const skuX = `XPAR-X-${loop}`;
			const skuY = `XPAR-Y-${loop}`;
			await h.seedProduct(p1);
			await h.seedProduct(p2);
			const wm1 = await h.seedVariant(p1, "large", skuX, 13);
			const wm2 = await h.seedVariant(p2, "large", skuY, 6);

			// THE CASE THE SORTED PAIR LOCK EXISTS FOR. Two DIFFERENT parents, so the
			// parent lock — which makes every intra-product cycle unreachable — has
			// nothing to say here: these two writers never contend on a product row or
			// on a variant row, only on the two `inventory` rows they share. Their
			// roles are mirrored, so ordering those by role (source, then target) sends
			// them round the cycle in opposite directions; ordering by SKU sends both
			// the same way.
			const results = await Promise.allSettled([
				h.products.updateVariantFields(
					{ productId: productId(p1), variantKey: "large", sku: sku(skuY) },
					idempotencyKey(`xpar-1-${loop}`),
					wm1,
				),
				h.products.updateVariantFields(
					{ productId: productId(p2), variantKey: "large", sku: sku(skuX) },
					idempotencyKey(`xpar-2-${loop}`),
					wm2,
				),
			]);

			for (const r of results) {
				if (r.status === "rejected") {
					const err = r.reason as Error & { code?: string };
					expect(err.code, `loop ${loop}: never a deadlock — ${err.message}`).not.toBe("40P01");
					expect(
						["SkuConflictError", "SkuStockConflictError"],
						`loop ${loop}: typed refusal, got ${err.name}: ${err.message}`,
					).toContain(err.name);
				}
			}

			// Both targets are held by a live unit, so neither rename can land, and
			// every unit stays where it was.
			expect(await h.skuOfVariant(p1, "large"), `loop ${loop}`).toBe(skuX);
			expect(await h.skuOfVariant(p2, "large"), `loop ${loop}`).toBe(skuY);
			expect(await h.onHand(skuX), `loop ${loop}`).toBe(13);
			expect(await h.onHand(skuY), `loop ${loop}`).toBe(6);
		}
	}, 180_000);

	test("a RESURRECT racing a PRODUCT claiming THE ORPHAN'S OWN SKU: no deadlock, and exactly one live unit ends up holding it", async () => {
		const LOOPS = 150;
		const h = await freshPg(8);
		let resurrectKept = 0;
		let editTookIt = 0;

		await Promise.all(Array.from({ length: 8 }, () => h.onHand("warm-up")));

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `rvs-${loop}`;
			const orphanSku = `RVS-S-${loop}`;
			await h.seedProduct(id);
			// An orphan carrying a SKU WITH A STOCK ROW — the only state in which the
			// declare reaches its third stage and takes an `inventory` lock at all. An
			// orphan that is merely priced never gets there, so a race built on one
			// would exercise the exception's comment rather than the exception.
			await h.seedVariant(id, "large", orphanSku, 9);
			await h.products.deactivateVariant(
				productId(id),
				"large",
				idempotencyKey(`rvs-orphan-${loop}`),
				"2026-07-10T01:00:00.000Z",
			);
			// The claimant is a PRODUCT of its own, and that is deliberate: a sibling
			// VARIANT reaching for the same sku is arbitrated by
			// `product_variants_live_sku_unique` whatever the declare does, so a race
			// built on one would pass with the declare's stage-3 lock deleted. No index
			// spans the two tables, so the product claimant is the case where that lock
			// is the only thing standing between a stale read and two live sellable
			// units on one sku.
			//
			// The same VARIANT cannot serve as the competitor either: while it is
			// orphaned every edit of it is `not_found`, and the moment the declare
			// revives it the edit's watermark is stale — so a literal same-variant pair
			// can never both hold locks, and the contention worth racing is over the
			// SKU rather than over the row.
			const claimant = `rvs-claimant-${loop}`;

			// THE PAIR THE HEADER'S ONE DELIBERATE INVERSION TURNS ON. The declare goes
			// parent → variant row → inventory(orphan's sku); every other writer goes
			// parent → inventory → variant row. Here they meet on the same stock row
			// from opposite directions: the declare holds `large` and wants the sku,
			// the edit holds the sku and wants `small`. Nobody waits on a row the other
			// holds, which is exactly the argument — and this is where it is checked.
			const [declared, edited] = await Promise.allSettled([
				h.products.upsertVariant(
					{
						productId: productId(id),
						variantKey: "large",
						title: "Large",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey(`rvs-back-${loop}`),
				),
				h.products.upsert(
					{ productId: productId(claimant), sku: sku(orphanSku) },
					idempotencyKey(`rvs-claim-${loop}`),
				),
			]);

			// The CMS channel never fails — not on a constraint, not on a deadlock.
			expect(declared?.status, `loop ${loop}: the declare resolves`).toBe("fulfilled");
			if (edited?.status === "rejected") {
				const err = edited.reason as Error & { code?: string };
				expect(err.code, `loop ${loop}: never a deadlock — ${err.message}`).not.toBe("40P01");
				expect(err.name, `loop ${loop}: typed refusal — ${err.message}`).toBe("SkuConflictError");
			}

			// However they interleaved: the variant is live again, and the sku names
			// exactly ONE live unit. Either the resurrect got there first and kept its
			// sku (so the edit was refused), or the edit got there first and the
			// revalidation handed the sku back as absent.
			const rows = await h.products.listVariants(productId(id));
			const large = rows.find((v) => v.variantKey === "large");
			const claimed = await h.skuOfProduct(claimant);
			expect(large?.orphanedAt, `loop ${loop}: the declare won presence`).toBeNull();
			const holders = [large?.sku, claimed].filter((x) => x === orphanSku);
			// THE ASSERTION THAT BITES: never both. No index spans the two tables, so
			// this holds only because the two writers met on the sku's stock row.
			expect(holders, `loop ${loop}: exactly one live unit holds the sku`).toHaveLength(1);
			if (large?.sku === orphanSku) {
				resurrectKept++;
				// Kept, units and all — the resurrect never touches `inventory`.
				expect(large?.onHand, `loop ${loop}`).toBe(9);
			} else {
				editTookIt++;
			}
		}

		// Both interleavings occurred, so both branches above were genuinely
		// asserted rather than merely written down.
		expect(resurrectKept, "the resurrect-first branch fired").toBeGreaterThan(0);
		expect(editTookIt, "the claimant-first branch fired").toBeGreaterThan(0);
	}, 180_000);
});
