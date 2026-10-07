/**
 * THE SKU-RENAME RULE at VARIANT grain, plus the two cross-grain rules, under REAL
 * concurrency. Postgres only: better-sqlite3 serializes every writer onto one
 * connection, and miniflare runs one isolate on one thread, so neither can race.
 *
 * The rule belongs to the `sku` COLUMN rather than to one caller — `inventory` is
 * keyed by the bare sku and knows nothing about products or variants — so the
 * variant writer is simply a THIRD writer of that column and has to be raced on its
 * own account. The product-level races being green proves the carry, not that a new
 * caller reaches it correctly.
 *
 * **What the document model changes about these cases, stated plainly.** The SQL
 * adapter held these invariants together with a written-down lock order
 * (`product_commerce → inventory, in sku order → product_variants`), and the last
 * three cases exist because two writers ordering those locks differently DEADLOCK:
 * Postgres raises `40P01`, an unmapped raw error where the port promises a typed
 * refusal. Here the variants live INSIDE the product document, so:
 *
 * - every intra-product pair contends for ONE revision rather than a sequence of
 *   locks, which is why two sizes priced at once in different currencies is decided
 *   by the loser re-reading the winner's value instead of by a lock order;
 * - there is no lock anywhere, so a lock-order cycle is unreachable by construction
 *   and the residual the SQL adapter recorded as unclosed (the product-side writers
 *   taking a unique-index lock ahead of the inventory locks) goes with it.
 *
 * The deadlock assertions are ported ANYWAY, unchanged. They now pass by
 * construction rather than by design care — and that is exactly what wants pinning,
 * because it is the claim this document model makes about the mechanism it removed.
 */
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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	CAS_MAX_ATTEMPTS,
	collectionOf,
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	normalizeInventoryDoc,
	PRODUCT_COMMERCE_COLLECTION,
	uuidIdGen,
	type InventoryDoc,
	type ProductCommerceDoc,
	type StorageAccess,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { TickingClock } from "./ticking-clock.js";

const POOL = 8;

/**
 * A few milliseconds of lead, so one of two overlapping calls reliably reaches the
 * contended document first. The two still OVERLAP — the point is to decide WHICH
 * gets there first, not to sequence them.
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

describe.skipIf(!PG_ENABLED)("variant sku rename concurrency [postgres]", () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;
	let products: EmdashProductCommerceStore;
	let inventory: EmdashInventoryStore;
	let inventoryDocs: ReturnType<typeof collectionOf<InventoryDoc>>;
	let productDocs: ReturnType<typeof collectionOf<ProductCommerceDoc>>;
	// The contention budget these shapes actually spend, measured rather than assumed;
	// see the package README's contention table.
	let maxCasDepth = 0;

	beforeAll(async () => {
		const db = await makePgStorage(PRODUCT_COMMERCE_LAYOUT, POOL);
		storage = db.storage;
		close = db.close;
		const clock = new TickingClock("2026-07-10T00:00:00.000Z");
		products = new EmdashProductCommerceStore({
			storage,
			clock,
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxCasDepth) maxCasDepth = attempts;
			},
		});
		inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock });
		inventoryDocs = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		productDocs = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	async function onHand(s: string): Promise<number | null> {
		const doc = await inventoryDocs.get(s);
		return doc === null ? null : doc.onHand;
	}

	async function setOnHand(s: string, qty: number): Promise<void> {
		const current = await inventoryDocs.getVersioned(s);
		if (current === null) {
			await inventoryDocs.compareAndSet(s, null, newInventoryDoc(s, qty));
			return;
		}
		await inventoryDocs.compareAndSet(s, current.revision, {
			...normalizeInventoryDoc(current.value),
			onHand: qty,
		});
	}

	/** A product row with no sku and no price of its own — the realistic variants
	 *  shape, where the sizes carry the money. Returns its CAS watermark. */
	async function seedProduct(id: string): Promise<string> {
		const row = await products.upsert({ productId: productId(id) }, idempotencyKey(`seed-${id}`));
		return row.updatedAt.toISOString();
	}

	/** A declared variant with no sku and no price; returns its watermark. */
	async function declareVariant(id: string, key: string): Promise<string> {
		const row = await products.upsertVariant(
			{ productId: productId(id), variantKey: key, title: `Variant ${key}` },
			idempotencyKey(`declare-${id}-${key}`),
		);
		return row.updatedAt.toISOString();
	}

	/** A declared, sku-bearing, stocked variant; returns its watermark. */
	async function seedVariant(id: string, key: string, s: string, stock: number): Promise<string> {
		const declared = await declareVariant(id, key);
		const res = await products.updateVariantFields(
			{ productId: productId(id), variantKey: key, sku: sku(s) },
			idempotencyKey(`price-${id}-${key}`),
			declared,
		);
		if (!res.ok) throw new Error(`seedVariant: ${id}/${key} could not take a sku`);
		await setOnHand(s, stock);
		return res.variant.updatedAt.toISOString();
	}

	async function skuOfVariant(id: string, key: string): Promise<string | null> {
		const doc = await productDocs.get(id);
		return doc?.variants?.[key]?.sku ?? null;
	}

	async function skuOfProduct(id: string): Promise<string | null> {
		const doc = await productDocs.get(id);
		return doc?.sku ?? null;
	}

	async function currencyOfProduct(id: string): Promise<string | null> {
		const doc = await productDocs.get(id);
		return doc?.price?.currency ?? null;
	}

	/** Every distinct currency the product's variants are priced in, sorted. */
	async function currencies(id: string): Promise<string[]> {
		const doc = await productDocs.get(id);
		const found: string[] = [];
		for (const variant of Object.values(doc?.variants ?? {})) {
			if (variant.price !== null) found.push(variant.price.currency);
		}
		return [...new Set(found)].toSorted();
	}

	test("two SIZES of one product renaming onto ONE free target: exactly one lands, the loser leaves no trace, and the units are conserved", async () => {
		const LOOPS = 12;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `prod-${String(loop)}`;
			const skuL = `V-L-${String(loop)}`;
			const skuS = `V-S-${String(loop)}`;
			const target = `V-T-${String(loop)}`;
			await seedProduct(id);
			const wmL = await seedVariant(id, "large", skuL, 40);
			const wmS = await seedVariant(id, "small", skuS, 7);

			// Two sizes of the same product reach for one free sku on independent
			// connections. Two guards can arbitrate it — the `sku_owners` claim and the
			// carry's own inventory claim — and which fires is a timing detail. What
			// this pins is the OUTCOME: one winner, a clean loser, every unit accounted
			// for.
			const results = await Promise.allSettled([
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(target) },
					idempotencyKey(`rename-l-${String(loop)}`),
					wmL,
				),
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "small", sku: sku(target) },
					idempotencyKey(`rename-s-${String(loop)}`),
					wmS,
				),
			]);

			// Both sizes live in ONE document, so the two writes also contend for one
			// revision: the loser of that contention re-reads and is then refused by the
			// claim. Exactly one lands either way.
			const landed = results.filter((r) => r.status === "fulfilled" && r.value.ok);
			const refused = results.filter(
				(r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok),
			);
			expect(landed, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
			expect(refused, `loop ${String(loop)}: exactly one loser`).toHaveLength(1);

			// The loser failed with a TYPED domain refusal, never a raw storage failure
			// surfacing as a 500 — and BOTH shapes of loss are checked, because a loser can
			// lose in two ways here: refused by the claim (a throw) or, if the winner's
			// write moved its own watermark, reported `stale`. Nothing else is legal, and
			// an unchecked `ok: false` branch would let a currency or not_found answer pass
			// for arbitration.
			const loser = refused[0];
			if (loser?.status === "rejected") {
				const err = loser.reason as Error;
				expect(
					["SkuConflictError", "SkuStockConflictError"],
					`loop ${String(loop)}: typed refusal, got ${err.name}: ${err.message}`,
				).toContain(err.name);
			} else if (loser?.status === "fulfilled" && !loser.value.ok) {
				expect(loser.value.reason, `loop ${String(loop)}: the only legal reported loss`).toBe(
					"stale",
				);
			}

			// The loser's SIZE is untouched — still its own sku, still its own units.
			const largeWon = (await skuOfVariant(id, "large")) === target;
			const loserKey = largeWon ? "small" : "large";
			const loserSku = largeWon ? skuS : skuL;
			const loserUnits = largeWon ? 7 : 40;
			const winnerUnits = largeWon ? 40 : 7;
			expect(await skuOfVariant(id, loserKey), `loop ${String(loop)}: loser keeps its sku`).toBe(
				loserSku,
			);
			expect(await onHand(loserSku), `loop ${String(loop)}: loser keeps its units`).toBe(
				loserUnits,
			);

			// CONSERVATION: the target holds exactly the winner's count — not both
			// merged, not a fresh zero beside the winner's orphaned units.
			expect(await onHand(target), `loop ${String(loop)}: target holds the winner's units`).toBe(
				winnerUnits,
			);
			const winnerOldSku = largeWon ? skuL : skuS;
			expect(await onHand(winnerOldSku), `loop ${String(loop)}: source retained at zero`).toBe(0);
			const total =
				((await onHand(target)) ?? 0) +
				((await onHand(winnerOldSku)) ?? 0) +
				((await onHand(loserSku)) ?? 0);
			expect(total, `loop ${String(loop)}: 47 units in, 47 units out`).toBe(47);
		}
	}, 180_000);

	test("two variant renames onto one ALREADY-OCCUPIED target: both refuse, and no size adopts the parked units", async () => {
		const LOOPS = 12;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `occ-${String(loop)}`;
			const skuL = `VO-L-${String(loop)}`;
			const skuS = `VO-S-${String(loop)}`;
			const parked = `VO-PARKED-${String(loop)}`;
			await seedProduct(id);
			const wmL = await seedVariant(id, "large", skuL, 10);
			const wmS = await seedVariant(id, "small", skuS, 3);
			// Units parked under a sku NO live sellable unit holds — what an earlier
			// rename leaves behind, and the state the rule refuses to arbitrate.
			await setOnHand(parked, 99);

			const results = await Promise.allSettled([
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(parked) },
					idempotencyKey(`occ-l-${String(loop)}`),
					wmL,
				),
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "small", sku: sku(parked) },
					idempotencyKey(`occ-s-${String(loop)}`),
					wmS,
				),
			]);

			// Both lose, and both lose the SAME way: the rule never picks a winner for a
			// target that already has a document. The loser of the claim race is told the
			// STOCK reason rather than the sku one, because the claim it collided with is
			// unbacked — nothing living holds that sku, which is precisely what makes the
			// parked units the operator's problem to resolve.
			for (const r of results) {
				expect(r.status, `loop ${String(loop)}: both refuse`).toBe("rejected");
				expect(
					(r as PromiseRejectedResult).reason,
					`loop ${String(loop)}: the stock refusal, not the claim's`,
				).toBeInstanceOf(SkuStockConflictError);
			}

			expect(await skuOfVariant(id, "large"), `loop ${String(loop)}`).toBe(skuL);
			expect(await skuOfVariant(id, "small"), `loop ${String(loop)}`).toBe(skuS);
			expect(await onHand(skuL), `loop ${String(loop)}`).toBe(10);
			expect(await onHand(skuS), `loop ${String(loop)}`).toBe(3);
			expect(await onHand(parked), `loop ${String(loop)}: parked units untouched`).toBe(99);
		}
	}, 180_000);

	test("a variant rename racing a SEED of the target sku: the claim decides it, and the loser is still a typed refusal", async () => {
		const LOOPS = 30;
		let renameWon = 0;
		let seedWon = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `seed-race-${String(loop)}`;
			const from = `VSR-FROM-${String(loop)}`;
			const target = `VSR-TO-${String(loop)}`;
			await seedProduct(id);
			const wm = await seedVariant(id, "large", from, 40);

			// `seedOnHand` is attempted on every sku-bearing save, so another writer can
			// be creating the target's inventory document at the moment the rename claims
			// it, and the create-if-absent IS the arbiter.
			//
			// The HEAD START is alternated rather than left to the scheduler, correcting
			// the SQL suite's own setup: the seed is ONE write while the rename reads the
			// product document and settles the sku claim first, so issued in the same
			// tick the seed wins every time and the rename-first branch is never reached.
			const renameFirst = loop % 2 === 0;
			const rename = (): Promise<unknown> =>
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(target) },
					idempotencyKey(`vsr-${String(loop)}`),
					wm,
				);
			const seed = (): Promise<void> => inventory.seedOnHand(target, 0);
			const leader = settle(renameFirst ? rename() : seed());
			await headStart();
			const follower = settle(renameFirst ? seed() : rename());
			const [a, b] = await Promise.all([leader, follower]);
			const renamed = renameFirst ? a : b;

			if (renamed.status === "rejected") {
				seedWon++;
				// The seed got there first. A naive "look, then create" would surface that
				// as a raw conflict — a 500 where the operator should have been told the
				// sku is taken.
				expect(
					renamed.reason,
					`loop ${String(loop)}: typed, never a raw storage error`,
				).toBeInstanceOf(SkuStockConflictError);
				// …and it refused ATOMICALLY: the size kept its sku and its units.
				expect(await skuOfVariant(id, "large"), `loop ${String(loop)}`).toBe(from);
				expect(await onHand(from), `loop ${String(loop)}`).toBe(40);
				expect(await onHand(target), `loop ${String(loop)}: the seed's empty document`).toBe(0);
			} else {
				renameWon++;
				expect((renamed.value as { ok: boolean }).ok, `loop ${String(loop)}`).toBe(true);
				expect(await skuOfVariant(id, "large"), `loop ${String(loop)}`).toBe(target);
				expect(await onHand(target), `loop ${String(loop)}: carried, not reset`).toBe(40);
				expect(await onHand(from), `loop ${String(loop)}: source retained at zero`).toBe(0);
			}

			// Either way, 40 units in, 40 units out — never 80, never 0.
			const total = ((await onHand(from)) ?? 0) + ((await onHand(target)) ?? 0);
			expect(total, `loop ${String(loop)}: conservation`).toBe(40);
		}

		expect(renameWon, "the rename-first branch fired").toBeGreaterThan(0);
		expect(seedWon, "the seed-first branch fired").toBeGreaterThan(0);
	}, 180_000);

	test("two sizes FIRST-PRICED at once in different currencies: one lands, and the product never ends up holding two currencies", async () => {
		const LOOPS = 25;
		let mismatches = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `cur-${String(loop)}`;
			await seedProduct(id);
			const wmL = await declareVariant(id, "large");
			const wmS = await declareVariant(id, "small");

			// Two sizes priced at the same moment in disagreeing currencies, with the
			// product row carrying no price to read. In SQL only the parent row lock could
			// order them, and without it both read "no currency yet" and both applied.
			// Embedded, they contend for ONE document revision: the loser re-reads, sees
			// the winner's currency through `resolveProductCurrency`, and is refused.
			const results = await Promise.allSettled([
				products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "large",
						price: money(cents(3000), currency("GBP")),
					},
					idempotencyKey(`cur-l-${String(loop)}`),
					wmL,
				),
				products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "small",
						price: money(cents(2500), currency("USD")),
					},
					idempotencyKey(`cur-s-${String(loop)}`),
					wmS,
				),
			]);

			// Neither may THROW — a currency disagreement is a reported outcome the
			// console renders, not an exception.
			for (const r of results) {
				expect(r.status, `loop ${String(loop)}: resolves, never throws`).toBe("fulfilled");
			}
			const outcomes = results.map((r) => outcomeOf(r));
			const applied = outcomes.filter((o) => o === "ok");
			// At least one has to land — refusing both would be the rule refusing itself
			// out of two legal first pricings.
			expect(applied.length, `loop ${String(loop)}: ${outcomes.join("/")}`).toBeGreaterThanOrEqual(
				1,
			);
			if (outcomes.includes("currency_mismatch")) mismatches++;

			// THE ASSERTION THAT BITES: whatever the schedule, the product ends holding
			// ONE currency. Two would give it no honest total, no honest picker and no
			// honest cart.
			expect(await currencies(id), `loop ${String(loop)}: one currency per product`).toHaveLength(
				1,
			);
		}

		// The refusal genuinely fired, rather than the schedule sparing it.
		expect(mismatches, "the currency refusal fired at least once").toBeGreaterThan(0);
	}, 180_000);

	// -- across the pair: a product write and a variant write, at once ---------

	test("a PRODUCT and a VARIANT reaching for one free sku at once: never both, and the loser refuses typed", async () => {
		const LOOPS = 20;
		let tookIt = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const varProd = `xp-v-${String(loop)}`;
			const plainProd = `xp-p-${String(loop)}`;
			const target = `XP-T-${String(loop)}`;
			await seedProduct(varProd);
			const wmV = await declareVariant(varProd, "large");
			// BOTH sides are FIRST-sku assignments, deliberately: a rename onto an
			// occupied document would be refused by the carry before the cross-grain
			// rule was ever consulted, and the case would pass while proving nothing. A
			// first sku ADOPTS an existing document, so both writes are legal and the
			// claim document is the ONLY thing that can arbitrate them.
			const wmP = await seedProduct(plainProd);
			await setOnHand(target, 0);

			// One free sku, two KINDS of sellable unit reaching for it on independent
			// connections. In SQL neither side's unique index could see the other's
			// table; here there is one claim document and therefore one arbiter.
			const results = await Promise.allSettled([
				products.updateVariantFields(
					{ productId: productId(varProd), variantKey: "large", sku: sku(target) },
					idempotencyKey(`xp-v-${String(loop)}`),
					wmV,
				),
				products.updateCommerceFields(
					{ productId: productId(plainProd), sku: sku(target) },
					idempotencyKey(`xp-p-${String(loop)}`),
					wmP,
				),
			]);

			const landed = results.filter((r) => r.status === "fulfilled" && r.value.ok);
			expect(
				landed.length,
				`loop ${String(loop)}: at most one unit takes the sku`,
			).toBeLessThanOrEqual(1);

			const variantHas = (await skuOfVariant(varProd, "large")) === target;
			const productHas = (await skuOfProduct(plainProd)) === target;
			// THE ASSERTION THAT BITES: never both. One sku, one live sellable unit.
			expect(
				variantHas && productHas,
				`loop ${String(loop)}: a sku may not name two live sellable units`,
			).toBe(false);
			if (variantHas || productHas) tookIt++;

			// A loser refuses TYPED, never a raw storage failure — and never with a
			// half-applied write behind it.
			for (const r of results) {
				if (r.status === "rejected") {
					expect(r.reason, `loop ${String(loop)}: typed refusal`).toBeInstanceOf(SkuConflictError);
				}
			}
			if (!productHas) expect(await skuOfProduct(plainProd), `loop ${String(loop)}`).toBeNull();
			if (!variantHas) {
				expect(await skuOfVariant(varProd, "large"), `loop ${String(loop)}`).toBeNull();
			}
		}

		// Somebody won every loop: refusing both sides would be the pair refusing itself
		// out of a legal write rather than arbitrating one.
		expect(tookIt, "the sku was claimed by exactly one kind of unit").toBe(LOOPS);
	}, 180_000);

	test("a PRODUCT repricing racing a VARIANT pricing: the product never ends in a currency its live sizes do not share", async () => {
		const LOOPS = 25;
		let refusals = 0;
		let productSideRefused = 0;
		let variantSideRefused = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `xc-${String(loop)}`;
			// UNPRICED, deliberately. A product that already carries a price refuses the
			// variant side at guard 4b every loop, so 4c — the reciprocal this case
			// exists for — is never reached and the case passes while proving nothing.
			// With no product-level price BOTH sides are FIRST pricings.
			const wmP = await seedProduct(id);
			const wmV = await declareVariant(id, "large");

			// Both directions of the currency rule at one instant. The product-side guard
			// reads the live variants and the variant-side guard reads the product — in
			// SQL that needed ONE lock order, or each read the other's "before" state and
			// both applied. Embedded, they are the same document: whoever wins its
			// revision is the "before" the loser then reads.
			const productFirst = loop % 2 === 0;
			const repriceProduct = () =>
				products.updateCommerceFields(
					{ productId: productId(id), price: money(cents(4000), currency("GBP")) },
					idempotencyKey(`xc-p-${String(loop)}`),
					wmP,
				);
			const priceVariant = () =>
				products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "large",
						price: money(cents(2500), currency("EUR")),
					},
					idempotencyKey(`xc-v-${String(loop)}`),
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
				expect(r?.status, `loop ${String(loop)}: resolves, never throws`).toBe("fulfilled");
			}
			const outcomes = [outcomeOf(productResult), outcomeOf(variantResult)];
			if (outcomes.includes("currency_mismatch")) refusals++;
			// WHICH side refused says WHICH guard fired: the product side is 4c (it read
			// the live variants), the variant side is 4b (it read the parent). Counted
			// separately so the case cannot quietly degrade into exercising only one.
			if (outcomes[0] === "currency_mismatch") productSideRefused++;
			if (outcomes[1] === "currency_mismatch") variantSideRefused++;

			// THE ASSERTION THAT BITES: every currency under this product agrees.
			const productCurrency = await currencyOfProduct(id);
			const all = new Set([
				...(productCurrency === null ? [] : [productCurrency]),
				...(await currencies(id)),
			]);
			expect(
				[...all],
				`loop ${String(loop)}: one currency per product (${outcomes.join("/")})`,
			).toHaveLength(1);
		}

		expect(refusals, "the cross-grain currency refusal fired at least once").toBeGreaterThan(0);
		expect(productSideRefused, "guard 4c (the product side) fired at least once").toBeGreaterThan(
			0,
		);
		expect(variantSideRefused + productSideRefused, "every loop was arbitrated").toBe(LOOPS);
	}, 180_000);

	test("the same two first-pricings with NO head start: overlapping, and still one currency", async () => {
		const LOOPS = 40;
		let refusals = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `xc0-${String(loop)}`;
			const wmP = await seedProduct(id);
			const wmV = await declareVariant(id, "large");

			// THE COMPANION TO THE CASE ABOVE. A head start decides which writer reaches
			// the document first, which is what makes guard 4c reachable — but it also
			// lets the leader COMMIT before the follower reads, so a follower that read
			// the other side's state before taking its own guard would still see committed
			// data and still refuse. Issued in the same tick the two genuinely overlap,
			// and only the document's compare-and-set makes one of them recompute.
			const results = await Promise.allSettled([
				products.updateCommerceFields(
					{ productId: productId(id), price: money(cents(4000), currency("GBP")) },
					idempotencyKey(`xc0-p-${String(loop)}`),
					wmP,
				),
				products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "large",
						price: money(cents(2500), currency("EUR")),
					},
					idempotencyKey(`xc0-v-${String(loop)}`),
					wmV,
				),
			]);

			for (const r of results) {
				expect(r.status, `loop ${String(loop)}: resolves, never throws`).toBe("fulfilled");
			}
			const outcomes = results.map((r) => outcomeOf(r));
			if (outcomes.includes("currency_mismatch")) refusals++;

			const productCurrency = await currencyOfProduct(id);
			const all = new Set([
				...(productCurrency === null ? [] : [productCurrency]),
				...(await currencies(id)),
			]);
			expect(
				[...all],
				`loop ${String(loop)}: one currency per product (${outcomes.join("/")})`,
			).toHaveLength(1);
		}

		expect(refusals, "the overlap was arbitrated at least once").toBeGreaterThan(0);
	}, 180_000);

	// -- what used to be the lock order ----------------------------------------
	//
	// Both crossing-rename cases below DEADLOCK against an implementation whose locks
	// are individually correct but ordered differently in two writers: Postgres raises
	// `40P01`, an unmapped raw error where the port promises a typed refusal. There
	// are no locks here, so they pass by construction — which is the claim worth
	// pinning, since a fixed lock order is the mechanism the document model deleted.

	test("CROSSING RENAMES X→Y and Y→X, both stocked: one refuses typed, and neither deadlocks", async () => {
		const LOOPS = 120;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `cross-${String(loop)}`;
			const skuX = `CR-X-${String(loop)}`;
			const skuY = `CR-Y-${String(loop)}`;
			await seedProduct(id);
			const wmX = await seedVariant(id, "large", skuX, 11);
			const wmY = await seedVariant(id, "small", skuY, 5);

			// Each rename's SOURCE is the other's TARGET — the textbook ABBA, and a
			// `40P01` for any implementation that locks the target before the source.
			// Here each side's target sku is held by a LIVE sibling, so both are refused
			// by the claim document before any stock is touched.
			const results = await Promise.allSettled([
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "large", sku: sku(skuY) },
					idempotencyKey(`cross-l-${String(loop)}`),
					wmX,
				),
				products.updateVariantFields(
					{ productId: productId(id), variantKey: "small", sku: sku(skuX) },
					idempotencyKey(`cross-s-${String(loop)}`),
					wmY,
				),
			]);

			for (const r of results) {
				if (r.status === "rejected") {
					const err = r.reason as Error & { code?: string };
					// NEVER a deadlock: `40P01` is unmapped and would surface to a merchant
					// as a 500 on a legal edit.
					expect(err.code, `loop ${String(loop)}: never a deadlock — ${err.message}`).not.toBe(
						"40P01",
					);
					expect(
						["SkuConflictError", "SkuStockConflictError"],
						`loop ${String(loop)}: typed refusal, got ${err.name}: ${err.message}`,
					).toContain(err.name);
				}
			}

			// Both targets are occupied, so neither rename can honestly land: every unit
			// stays where it was.
			expect(await onHand(skuX), `loop ${String(loop)}: X untouched`).toBe(11);
			expect(await onHand(skuY), `loop ${String(loop)}: Y untouched`).toBe(5);
			expect(await skuOfVariant(id, "large"), `loop ${String(loop)}`).toBe(skuX);
			expect(await skuOfVariant(id, "small"), `loop ${String(loop)}`).toBe(skuY);
		}
	}, 300_000);

	test("a RESURRECT racing a PRICE EDIT of a sibling size: no deadlock, and the product still holds one currency", async () => {
		const LOOPS = 25;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `rvp-${String(loop)}`;
			await seedProduct(id);
			// A priced orphan: the resurrect has to resolve the product currency to
			// decide whether its price survives, which reads the same document the edit
			// is writing.
			const wmL = await declareVariant(id, "large");
			const priced = await products.updateVariantFields(
				{
					productId: productId(id),
					variantKey: "large",
					price: money(cents(3000), currency("GBP")),
				},
				idempotencyKey(`rvp-price-${String(loop)}`),
				wmL,
			);
			expect(priced.ok, `loop ${String(loop)}: the orphan was priced`).toBe(true);
			await products.deactivateVariant(
				productId(id),
				"large",
				idempotencyKey(`rvp-orphan-${String(loop)}`),
				"2026-07-10T01:00:00.000Z",
			);
			const wmS = await declareVariant(id, "small");

			// In SQL the declare walked parent → variant row and the price edit walked the
			// same two; reverse either and this is a clean ABBA between the CMS sync and
			// the console — the worst pairing available, because the sync has no merchant
			// to show an error to. Embedded, both are one compare-and-set on one document.
			const [declared, edited] = await Promise.allSettled([
				products.upsertVariant(
					{
						productId: productId(id),
						variantKey: "large",
						title: "Large",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey(`rvp-back-${String(loop)}`),
				),
				products.updateVariantFields(
					{
						productId: productId(id),
						variantKey: "small",
						price: money(cents(2500), currency("USD")),
					},
					idempotencyKey(`rvp-edit-${String(loop)}`),
					wmS,
				),
			]);

			// The CMS channel NEVER fails: not on a conflict, not on a deadlock.
			expect(declared?.status, `loop ${String(loop)}: the declare resolves`).toBe("fulfilled");
			if (edited?.status === "rejected") {
				const err = edited.reason as Error & { code?: string };
				expect(err.code, `loop ${String(loop)}: never a deadlock — ${err.message}`).not.toBe(
					"40P01",
				);
			}

			// Whichever order they landed in, the product holds ONE currency: either the
			// resurrect kept GBP and the USD edit was refused, or the edit landed first
			// and the resurrect handed its GBP price back as absent.
			expect(await currencies(id), `loop ${String(loop)}: one currency per product`).toHaveLength(
				1,
			);
		}
	}, 180_000);

	test("CROSSING RENAMES ACROSS TWO PARENTS: P1's size X→Y against P2's size Y→X, both stocked", async () => {
		const LOOPS = 120;
		for (let loop = 0; loop < LOOPS; loop++) {
			const p1 = `xpar-1-${String(loop)}`;
			const p2 = `xpar-2-${String(loop)}`;
			const skuX = `XPAR-X-${String(loop)}`;
			const skuY = `XPAR-Y-${String(loop)}`;
			await seedProduct(p1);
			await seedProduct(p2);
			const wm1 = await seedVariant(p1, "large", skuX, 13);
			const wm2 = await seedVariant(p2, "large", skuY, 6);

			// THE CASE THE SORTED PAIR LOCK EXISTED FOR. Two DIFFERENT parents, so
			// embedding buys nothing here: these two writers share no product document,
			// only the two skus. In SQL their mirrored roles sent them round the
			// inventory cycle in opposite directions unless the pair was locked in SKU
			// order. Here the claim document refuses both before any inventory write.
			const results = await Promise.allSettled([
				products.updateVariantFields(
					{ productId: productId(p1), variantKey: "large", sku: sku(skuY) },
					idempotencyKey(`xpar-1-${String(loop)}`),
					wm1,
				),
				products.updateVariantFields(
					{ productId: productId(p2), variantKey: "large", sku: sku(skuX) },
					idempotencyKey(`xpar-2-${String(loop)}`),
					wm2,
				),
			]);

			for (const r of results) {
				if (r.status === "rejected") {
					const err = r.reason as Error & { code?: string };
					expect(err.code, `loop ${String(loop)}: never a deadlock — ${err.message}`).not.toBe(
						"40P01",
					);
					expect(
						["SkuConflictError", "SkuStockConflictError"],
						`loop ${String(loop)}: typed refusal, got ${err.name}: ${err.message}`,
					).toContain(err.name);
				}
			}

			// Both targets are held by a live unit, so neither rename can land, and every
			// unit stays where it was.
			expect(await skuOfVariant(p1, "large"), `loop ${String(loop)}`).toBe(skuX);
			expect(await skuOfVariant(p2, "large"), `loop ${String(loop)}`).toBe(skuY);
			expect(await onHand(skuX), `loop ${String(loop)}`).toBe(13);
			expect(await onHand(skuY), `loop ${String(loop)}`).toBe(6);
		}
	}, 300_000);

	test("a RESURRECT racing a PRODUCT claiming THE ORPHAN'S OWN SKU: no deadlock, and exactly one live unit ends up holding it", async () => {
		const LOOPS = 80;
		let resurrectKept = 0;
		let editTookIt = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `rvs-${String(loop)}`;
			const orphanSku = `RVS-S-${String(loop)}`;
			await seedProduct(id);
			// An orphan carrying a SKU WITH A STOCK DOCUMENT — the state in which the
			// resurrect has to decide whether it may reclaim the sku at all.
			await seedVariant(id, "large", orphanSku, 9);
			await products.deactivateVariant(
				productId(id),
				"large",
				idempotencyKey(`rvs-orphan-${String(loop)}`),
				"2026-07-10T01:00:00.000Z",
			);
			// The claimant is a PRODUCT of its own, deliberately: a sibling VARIANT
			// reaching for the same sku would be arbitrated by the same claim document
			// whatever the resurrect did, so the cross-grain case is the one worth racing.
			const claimant = `rvs-claimant-${String(loop)}`;

			// The resurrect wants its released claim back; the claimant wants the same
			// released claim. Both take it over by compare-and-set on the released
			// document, so exactly one can win and the other is told so.
			const [declared, edited] = await Promise.allSettled([
				products.upsertVariant(
					{
						productId: productId(id),
						variantKey: "large",
						title: "Large",
						contentUpdatedAt: "2026-07-10T02:00:00.000Z",
					},
					idempotencyKey(`rvs-back-${String(loop)}`),
				),
				products.upsert(
					{ productId: productId(claimant), sku: sku(orphanSku) },
					idempotencyKey(`rvs-claim-${String(loop)}`),
				),
			]);

			// The CMS channel never fails — not on a conflict, not on a deadlock.
			expect(declared?.status, `loop ${String(loop)}: the declare resolves`).toBe("fulfilled");
			if (edited?.status === "rejected") {
				const err = edited.reason as Error & { code?: string };
				expect(err.code, `loop ${String(loop)}: never a deadlock — ${err.message}`).not.toBe(
					"40P01",
				);
				expect(err.name, `loop ${String(loop)}: typed refusal — ${err.message}`).toBe(
					"SkuConflictError",
				);
			}

			// However they interleaved: the variant is live again, and the sku names
			// exactly ONE live unit. Either the resurrect got there first and kept its
			// sku, or the claimant did and the revalidation handed the sku back as absent.
			const rows = await products.listVariants(productId(id));
			const large = rows.find((v) => v.variantKey === "large");
			const claimed = await skuOfProduct(claimant);
			expect(large?.orphanedAt, `loop ${String(loop)}: the declare won presence`).toBeNull();
			const holders = [large?.sku, claimed].filter((x) => x === orphanSku);
			// THE ASSERTION THAT BITES: never both.
			expect(holders, `loop ${String(loop)}: exactly one live unit holds the sku`).toHaveLength(1);
			if (large?.sku === orphanSku) {
				resurrectKept++;
				// Kept, units and all — the resurrect never touches `inventory`.
				expect(large?.onHand, `loop ${String(loop)}`).toBe(9);
			} else {
				editTookIt++;
			}
		}

		// Both interleavings occurred, so both branches above were genuinely asserted
		// rather than merely written down.
		expect(resurrectKept, "the resurrect-first branch fired").toBeGreaterThan(0);
		expect(editTookIt, "the claimant-first branch fired").toBeGreaterThan(0);
	}, 300_000);
	// Reported per FILE rather than per case: every case here writes the same two
	// document shapes, so one number describes the shape honestly and a per-case
	// breakdown would only repeat it. Runs LAST, so it sees every case's depth.
	test("the contention budget these shapes spend, measured", () => {
		console.info(
			`[variant sku rename] max compare-and-set depth ${String(maxCasDepth)}/${String(CAS_MAX_ATTEMPTS)}`,
		);
		expect(maxCasDepth, "the contention budget was not exhausted").toBeLessThanOrEqual(
			CAS_MAX_ATTEMPTS,
		);
		expect(maxCasDepth, "the shapes really did contend").toBeGreaterThan(0);
	});
});

/** One settled outcome, so a pair can be classified instead of the first rejection
 *  aborting both. */
async function settle<T>(
	call: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
	try {
		return { status: "fulfilled", value: await call };
	} catch (reason: unknown) {
		return { status: "rejected", reason };
	}
}
