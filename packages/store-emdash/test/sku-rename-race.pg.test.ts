/**
 * THE SKU-RENAME RULE under REAL concurrency, ported to the document store.
 * Postgres only: better-sqlite3 serializes every writer onto one connection and
 * therefore cannot race at all, and miniflare runs one isolate on one thread.
 *
 * The rule's whole point is that a rename MOVES units rather than stranding them,
 * and a move is only safe if exactly one mover can ever win a target sku. Two
 * renames aimed at one target is the case that decides it: the loser must fail
 * cleanly and leave BOTH products exactly as they were, and the units must be
 * conserved to the unit — never duplicated onto the target, never lost between the
 * two documents.
 *
 * BOTH WRITERS ARE RACED, deliberately, and what protects each of them has changed
 * shape without changing the outcome:
 *
 * - `updateCommerceFields` was protected by a compare-and-set on `updated_at` and
 *   still is, now evaluated inside the document's own compare-and-set.
 * - `upsert` had NO such guard, so in SQL its before-read had to take the product
 *   ROW LOCK: without it a loser read the old sku, the winner moved the units, and
 *   the loser then carried an already-empty source to its own target, stranding
 *   everything with no error raised anywhere. There is no lock here. What replaces
 *   it is that the write's whole decision — the before-read, the carry and the row
 *   write — is one retried compare-and-set step: a peer that commits first makes
 *   the step lose, and the RE-RUN reads the peer's result rather than a stale
 *   snapshot. Cases 4 to 7 are the ones that fail if that is not true, which is why
 *   they are ported unchanged.
 *
 * The pool is sized so each concurrent writer holds its OWN connection: a pool
 * narrower than the crowd serializes the writers and weakens the race.
 */
import {
	idempotencyKey,
	productId,
	sku,
	SkuStockConflictError,
	type IdempotencyKey,
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
 * A few milliseconds of lead, so one of two overlapping calls reliably reaches a
 * contended document first. The two still OVERLAP — the point is to decide WHICH
 * holds the document when the other arrives, not to sequence them.
 */
function headStart(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 15);
	});
}

/** One settled outcome, so a crowd can be classified instead of the first rejection
 *  aborting the lot. */
async function settle<T>(
	call: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
	try {
		return { status: "fulfilled", value: await call };
	} catch (reason: unknown) {
		return { status: "rejected", reason };
	}
}

describe.skipIf(!PG_ENABLED)("sku rename concurrency [postgres]", () => {
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

	/** `null` when the sku has no inventory document at all. */
	async function onHand(s: string): Promise<number | null> {
		const doc = await inventoryDocs.get(s);
		return doc === null ? null : doc.onHand;
	}

	async function skuOf(id: string): Promise<string | null> {
		const doc = await productDocs.get(id);
		return doc?.sku ?? null;
	}

	/** Create or overwrite one inventory document's count, holds preserved. */
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

	/** A live, sku-bearing product with a stocked inventory document; returns the
	 *  `updatedAt` watermark its next guarded edit has to pass back. */
	async function seedProduct(id: string, s: string, stock: number): Promise<string> {
		const row = await products.upsert(
			{ productId: productId(id), sku: sku(s) },
			idempotencyKey(`seed-${id}`),
		);
		await setOnHand(s, stock);
		return row.updatedAt.toISOString();
	}

	test("two renames onto ONE free target: exactly one lands, the loser leaves no trace, and the units are conserved", async () => {
		const LOOPS = 12;
		for (let loop = 0; loop < LOOPS; loop++) {
			const a = `prod-a-${String(loop)}`;
			const b = `prod-b-${String(loop)}`;
			const skuA = `SKU-A-${String(loop)}`;
			const skuB = `SKU-B-${String(loop)}`;
			const target = `SKU-T-${String(loop)}`;
			const wmA = await seedProduct(a, skuA, 40);
			const wmB = await seedProduct(b, skuB, 7);

			// Both products reach for the same, currently free, target sku on
			// independent connections. Two guards can arbitrate this — the `sku_owners`
			// claim document and the carry's own inventory claim — and which one fires
			// is a timing detail. What this case pins is the OUTCOME, whichever does:
			// one winner, a clean loser, and every unit accounted for.
			const results = await Promise.allSettled([
				products.updateCommerceFields(
					{ productId: productId(a), sku: sku(target) },
					idempotencyKey(`rename-a-${String(loop)}`),
					wmA,
				),
				products.updateCommerceFields(
					{ productId: productId(b), sku: sku(target) },
					idempotencyKey(`rename-b-${String(loop)}`),
					wmB,
				),
			]);

			const winners = results.filter((r) => r.status === "fulfilled");
			const losers = results.filter((r) => r.status === "rejected");

			// (a) EXACTLY ONE renamed. Two winners would mean two products sharing one
			// sku and one inventory document; zero would mean the rule refused itself
			// out of a legal rename.
			expect(winners, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
			expect(losers, `loop ${String(loop)}: exactly one loser`).toHaveLength(1);

			// (b) The loser failed with a TYPED domain error, never a raw storage
			// failure surfacing as a 500.
			const reason: unknown = (losers[0] as PromiseRejectedResult).reason;
			expect(reason, `loop ${String(loop)}: typed refusal`).toBeInstanceOf(Error);
			expect(
				["SkuConflictError", "SkuStockConflictError"],
				`loop ${String(loop)}: typed refusal, got ${String((reason as Error).message)}`,
			).toContain((reason as Error).name);

			// (c) The loser's product is UNTOUCHED — still its own sku, still its own
			// units. A partially applied rename would leave a product pointing at stock
			// it does not own.
			const renamedA = (await skuOf(a)) === target;
			const loserId = renamedA ? b : a;
			const loserSku = renamedA ? skuB : skuA;
			const loserUnits = renamedA ? 7 : 40;
			const winnerUnits = renamedA ? 40 : 7;
			expect(await skuOf(loserId), `loop ${String(loop)}: loser keeps its sku`).toBe(loserSku);
			expect(await onHand(loserSku), `loop ${String(loop)}: loser keeps its units`).toBe(
				loserUnits,
			);

			// (d) CONSERVATION: the target holds exactly the winner's count — not both
			// counts merged, not a fresh zero beside the winner's orphaned units — and
			// the winner's old document is retained, emptied.
			expect(await onHand(target), `loop ${String(loop)}: target holds the winner's units`).toBe(
				winnerUnits,
			);
			const winnerOldSku = renamedA ? skuA : skuB;
			expect(await onHand(winnerOldSku), `loop ${String(loop)}: source retained at zero`).toBe(0);
			const total =
				((await onHand(target)) ?? 0) +
				((await onHand(winnerOldSku)) ?? 0) +
				((await onHand(loserSku)) ?? 0);
			expect(total, `loop ${String(loop)}: 47 units in, 47 units out`).toBe(47);
		}
	}, 180_000);

	test("two renames onto one ALREADY-OCCUPIED target: both refuse as a STOCK conflict, and no product adopts the parked units", async () => {
		const LOOPS = 12;
		for (let loop = 0; loop < LOOPS; loop++) {
			const a = `occ-a-${String(loop)}`;
			const b = `occ-b-${String(loop)}`;
			const skuA = `SKU-OA-${String(loop)}`;
			const skuB = `SKU-OB-${String(loop)}`;
			const parked = `SKU-PARKED-${String(loop)}`;
			const wmA = await seedProduct(a, skuA, 10);
			const wmB = await seedProduct(b, skuB, 3);
			// Units parked under a sku NO live product holds — what an earlier rename
			// leaves behind, and the state the rule refuses to arbitrate.
			await setOnHand(parked, 99);

			const results = await Promise.allSettled([
				products.updateCommerceFields(
					{ productId: productId(a), sku: sku(parked) },
					idempotencyKey(`occ-a-${String(loop)}`),
					wmA,
				),
				products.updateCommerceFields(
					{ productId: productId(b), sku: sku(parked) },
					idempotencyKey(`occ-b-${String(loop)}`),
					wmB,
				),
			]);

			// Both lose, and both lose the SAME way: the rule never picks a winner for a
			// target that already has a document. The loser of the claim race is told
			// the STOCK reason rather than the sku one, because the claim it collided
			// with is unbacked — nothing living holds that sku, which is precisely what
			// makes the parked units the operator's problem to resolve.
			for (const r of results) {
				expect(r.status, `loop ${String(loop)}: both refuse`).toBe("rejected");
				expect(
					(r as PromiseRejectedResult).reason,
					`loop ${String(loop)}: the stock refusal, not the claim's`,
				).toBeInstanceOf(SkuStockConflictError);
			}

			expect(await skuOf(a), `loop ${String(loop)}`).toBe(skuA);
			expect(await skuOf(b), `loop ${String(loop)}`).toBe(skuB);
			expect(await onHand(skuA), `loop ${String(loop)}`).toBe(10);
			expect(await onHand(skuB), `loop ${String(loop)}`).toBe(3);
			expect(await onHand(parked), `loop ${String(loop)}: parked units untouched`).toBe(99);
		}
	}, 180_000);

	test("a rename racing a SEED of the target sku: the claim decides it, and the loser is still a typed refusal", async () => {
		const LOOPS = 30;
		// An interleaving case that only ever took ONE branch would assert half of what
		// it claims and never say so. Counted, then asserted at the end.
		let renameWon = 0;
		let seedWon = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `seed-race-${String(loop)}`;
			const from = `SKU-SR-FROM-${String(loop)}`;
			const target = `SKU-SR-TO-${String(loop)}`;
			const wm = await seedProduct(id, from, 40);

			// `seedOnHand` is attempted on every product save, and a sku a soft-deleted
			// product still names is free for a live product to rename onto — so a sync
			// save of that tombstone seeds the target's inventory document while a live
			// product is renaming onto it. Both creators reach for the same document
			// with nothing above them to serialize the attempt, and the create-if-absent
			// IS the arbiter.
			//
			// The HEAD START is alternated rather than left to the scheduler, and that is
			// a correction of the SQL suite's own setup rather than a convenience. The
			// seed is ONE write; the rename reads the product document, settles the sku
			// claim and reads the source's holds before it claims anything, so issued in
			// the same tick the seed wins every single time and the rename-first branch
			// below — the one that asserts the carry survived a losing seed — is never
			// reached. Both transactions still OVERLAP; what the head start decides is
			// only WHICH of them reaches the contended document first.
			const renameFirst = loop % 2 === 0;
			const rename = (): Promise<unknown> =>
				products.updateCommerceFields(
					{ productId: productId(id), sku: sku(target) },
					idempotencyKey(`seed-race-${String(loop)}`),
					wm,
				);
			const seed = (): Promise<void> => inventory.seedOnHand(target, 0);
			// Start one, let it reach the contended document, then start the other — so
			// both are in flight together and the WINNER is decided rather than left to
			// which call had less work to do before it got there.
			const leader = renameFirst ? rename() : seed();
			const leaderSettled = settle(leader);
			await headStart();
			const follower = settle(renameFirst ? seed() : rename());
			const [a, b] = await Promise.all([leaderSettled, follower]);
			const renamed = renameFirst ? a : b;

			if (renamed.status === "rejected") seedWon++;
			else renameWon++;
			if (renamed.status === "rejected") {
				// The seed got there first. That MUST arrive as the typed refusal — a
				// naive "look, then create" would surface the collision as a raw
				// conflict instead, i.e. a 500 where the operator should have been told
				// the sku is taken.
				expect(
					renamed.reason,
					`loop ${String(loop)}: typed, never a raw storage error`,
				).toBeInstanceOf(SkuStockConflictError);
				// …and it refused ATOMICALLY: the product kept its sku and its units.
				expect(await skuOf(id), `loop ${String(loop)}`).toBe(from);
				expect(await onHand(from), `loop ${String(loop)}`).toBe(40);
				expect(await onHand(target), `loop ${String(loop)}: the seed's empty document`).toBe(0);
			} else {
				// The rename got there first: it owns the document, and the seed that
				// followed found it and left the carried units alone.
				expect((renamed.value as { ok: boolean }).ok, `loop ${String(loop)}`).toBe(true);
				expect(await skuOf(id), `loop ${String(loop)}`).toBe(target);
				expect(await onHand(target), `loop ${String(loop)}: carried, not reset`).toBe(40);
				expect(await onHand(from), `loop ${String(loop)}: source retained at zero`).toBe(0);
			}

			// Either way, 40 units in, 40 units out — never 80, never 0.
			const total = ((await onHand(from)) ?? 0) + ((await onHand(target)) ?? 0);
			expect(total, `loop ${String(loop)}: conservation`).toBe(40);
		}

		// Both interleavings actually happened, so both branches above were genuinely
		// asserted rather than merely written down.
		expect(renameWon, "the rename-first branch fired").toBeGreaterThan(0);
		expect(seedWon, "the seed-first branch fired").toBeGreaterThan(0);
	}, 180_000);

	// -- upsert: the writer with no watermark guard of its own ------------------

	test("upsert: two concurrent renames of ONE product to DIFFERENT skus chain — the second carries from the first's result, not from a stale read", async () => {
		const LOOPS = 40;
		let bWon = 0;
		let cWon = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-diff-${String(loop)}`;
			const from = `SKU-UD-FROM-${String(loop)}`;
			const toB = `SKU-UD-B-${String(loop)}`;
			const toC = `SKU-UD-C-${String(loop)}`;
			await seedProduct(id, from, 40);

			// This is the silent-stranding case: with a before-read that is not
			// re-evaluated, the loser reads `from`, the winner moves the units to its own
			// target, and the loser then carries an already-empty `from` to ITS target —
			// leaving 40 units under a sku no product owns, with no error anywhere.
			//
			// The two calls are ALTERNATED rather than left to the scheduler: both start
			// in the same tick and the first issued reliably reaches the document first,
			// so a fixed order would exercise one interleaving forty times over and
			// quietly leave the other unproven.
			const bFirst = loop % 2 === 0;
			const renameB = () =>
				products.upsert(
					{ productId: productId(id), sku: sku(toB) },
					idempotencyKey(`ud-b-${String(loop)}`),
				);
			const renameC = () =>
				products.upsert(
					{ productId: productId(id), sku: sku(toC) },
					idempotencyKey(`ud-c-${String(loop)}`),
				);
			const results = await Promise.allSettled(
				bFirst ? [renameB(), renameC()] : [renameC(), renameB()],
			);

			// Both writes are legal — they serialize rather than conflict — so both must
			// succeed, and the row ends on whichever committed last.
			for (const r of results) {
				const why = r.status === "rejected" ? String((r.reason as Error).message) : "";
				expect(r.status, `loop ${String(loop)}: both upserts apply — ${why}`).toBe("fulfilled");
			}
			const finalSku = await skuOf(id);
			if (finalSku === null) throw new Error(`loop ${String(loop)}: the product lost its sku`);
			expect([toB, toC], `loop ${String(loop)}`).toContain(finalSku);
			if (finalSku === toB) bWon++;
			else cWon++;

			// THE ASSERTION THAT BITES: every unit is under the sku the product actually
			// holds. A before-read that is not re-evaluated parks them under the other
			// target.
			expect(await onHand(finalSku), `loop ${String(loop)}: units follow the product`).toBe(40);
			const orphan = finalSku === toB ? toC : toB;
			expect(await onHand(from), `loop ${String(loop)}: original source emptied`).toBe(0);
			expect(await onHand(orphan), `loop ${String(loop)}: intermediate sku emptied`).toBe(0);
			const total =
				((await onHand(from)) ?? 0) + ((await onHand(toB)) ?? 0) + ((await onHand(toC)) ?? 0);
			expect(total, `loop ${String(loop)}: conservation`).toBe(40);
		}

		// Both orderings really did run, so the conservation assertions above were
		// exercised in both directions.
		expect(bWon, "the B-last ordering occurred").toBeGreaterThan(0);
		expect(cWon, "the C-last ordering occurred").toBeGreaterThan(0);
	}, 300_000);

	test("upsert: two concurrent renames of one product to the SAME sku both succeed — the second sees the rename already done, not a conflict it did not cause", async () => {
		const LOOPS = 20;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-same-${String(loop)}`;
			const from = `SKU-US-FROM-${String(loop)}`;
			const to = `SKU-US-TO-${String(loop)}`;
			await seedProduct(id, from, 18);

			const results = await Promise.allSettled([
				products.upsert(
					{ productId: productId(id), sku: sku(to) },
					idempotencyKey(`us-1-${String(loop)}`),
				),
				products.upsert(
					{ productId: productId(id), sku: sku(to) },
					idempotencyKey(`us-2-${String(loop)}`),
				),
			]);

			// A before-read that is not re-evaluated makes the second racer think it is
			// renaming from → to all over again, find `to`'s document already there, and
			// refuse a conflict the operator never created. Because the sku is ALREADY
			// this product's own claim by then, the carry recognises the target as its
			// own and the intent-claim's idempotence decides there is nothing left to
			// move.
			for (const r of results) {
				const why = r.status === "rejected" ? String((r.reason as Error).message) : "";
				expect(r.status, `loop ${String(loop)}: no spurious refusal — ${why}`).toBe("fulfilled");
			}
			expect(await skuOf(id), `loop ${String(loop)}`).toBe(to);
			expect(await onHand(to), `loop ${String(loop)}: carried exactly once`).toBe(18);
			expect(await onHand(from), `loop ${String(loop)}: source emptied`).toBe(0);
		}
	}, 180_000);

	test("upsert RACING a guarded edit: whoever loses writes nothing, and the units are never split", async () => {
		const LOOPS = 25;
		let editStale = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-cas-${String(loop)}`;
			const from = `SKU-UC-FROM-${String(loop)}`;
			const viaUpsert = `SKU-UC-UP-${String(loop)}`;
			const viaEdit = `SKU-UC-ED-${String(loop)}`;
			const wm = await seedProduct(id, from, 12);

			// The two writers with different guards, aimed at one document at the same
			// moment: the integrator PUT and the console's guarded edit, renaming to
			// different skus.
			//
			// The edit USUALLY loses, and not by luck: whichever write commits first
			// bumps `updatedAt`, and the edit's watermark then no longer matches — the
			// guard doing exactly its job. Both schedules are legal, so the assertions
			// describe the OUTCOME rather than the order: whichever way it falls, no
			// writer leaves units behind and none are duplicated.
			const [up, ed] = await Promise.allSettled([
				products.upsert(
					{ productId: productId(id), sku: sku(viaUpsert) },
					idempotencyKey(`uc-up-${String(loop)}`),
				),
				products.updateCommerceFields(
					{ productId: productId(id), sku: sku(viaEdit) },
					idempotencyKey(`uc-ed-${String(loop)}`),
					wm,
				),
			]);

			// The upsert has no watermark to lose, so it always applies; the edit either
			// applied or reported `stale`. Neither may throw, and neither may half-apply.
			expect(up?.status, `loop ${String(loop)}: the upsert applies`).toBe("fulfilled");
			expect(ed?.status, `loop ${String(loop)}: the edit resolves, never throws`).toBe("fulfilled");
			if (ed?.status === "fulfilled" && !ed.value.ok) {
				expect(ed.value.reason, `loop ${String(loop)}`).toBe("stale");
				editStale++;
			}

			// The product ends on the upsert's sku either way — it is the writer with no
			// watermark to lose — and every unit is under whichever sku the product
			// actually holds.
			expect(await skuOf(id), `loop ${String(loop)}`).toBe(viaUpsert);
			expect(await onHand(viaUpsert), `loop ${String(loop)}: units follow the product`).toBe(12);
			expect(
				(await onHand(viaEdit)) ?? 0,
				`loop ${String(loop)}: no units left under the sku the product does not hold`,
			).toBe(0);
			// Conservation across EVERY sku that was named — the assertion that catches a
			// split, whichever writer did the splitting.
			const total =
				((await onHand(from)) ?? 0) +
				((await onHand(viaEdit)) ?? 0) +
				((await onHand(viaUpsert)) ?? 0);
			expect(total, `loop ${String(loop)}: conservation`).toBe(12);
		}

		// At least one loop genuinely exercised the watermark rejection — without this
		// the case could pass having never raced at all. Deliberately NOT an equality: a
		// loop where the edit wins is a legal schedule, not a failure.
		expect(editStale, "the watermark guard rejected the edit at least once").toBeGreaterThan(0);
	}, 180_000);

	test("upsert renaming AFTER a guarded edit landed: the before-read comes from the STORED document, not from the caller's input", async () => {
		const LOOPS = 25;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `up-seq-${String(loop)}`;
			const from = `SKU-US2-FROM-${String(loop)}`;
			const viaEdit = `SKU-US2-ED-${String(loop)}`;
			const viaUpsert = `SKU-US2-UP-${String(loop)}`;
			const wm = await seedProduct(id, from, 12);

			// SEQUENCED, not raced, and it does NOT discriminate the re-read — worth
			// saying plainly, because the name invites the opposite reading. The edit is
			// fully committed before the upsert starts, so there is no concurrent window.
			//
			// What it DOES pin is that the before-read is taken from the STORED document
			// at all, rather than from anything the caller knows. The upsert's own input
			// names only the destination, and its caller last saw the product on `from` —
			// so a carry sourced from caller state moves the wrong units. The re-read's
			// own necessity is pinned by the three concurrent cases above.
			const ed = await products.updateCommerceFields(
				{ productId: productId(id), sku: sku(viaEdit) },
				idempotencyKey(`us2-ed-${String(loop)}`),
				wm,
			);
			expect(ed.ok, `loop ${String(loop)}: the edit lands`).toBe(true);
			expect(await onHand(viaEdit), `loop ${String(loop)}`).toBe(12);

			const up = await products.upsert(
				{ productId: productId(id), sku: sku(viaUpsert) },
				idempotencyKey(`us2-up-${String(loop)}`),
			);

			expect(up.sku, `loop ${String(loop)}`).toBe(viaUpsert);
			expect(await onHand(viaUpsert), `loop ${String(loop)}: carried from the edit's sku`).toBe(12);
			expect(await onHand(viaEdit), `loop ${String(loop)}: the intermediate sku is emptied`).toBe(
				0,
			);
			const total =
				((await onHand(from)) ?? 0) +
				((await onHand(viaEdit)) ?? 0) +
				((await onHand(viaUpsert)) ?? 0);
			expect(total, `loop ${String(loop)}: conservation`).toBe(12);
		}
	}, 180_000);

	test("a rename racing a restock of the sku it is leaving conserves every unit", async () => {
		const LOOPS = 15;
		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `mv-${String(loop)}`;
			const from = `SKU-MV-FROM-${String(loop)}`;
			const to = `SKU-MV-TO-${String(loop)}`;
			const wm = await seedProduct(id, from, 20);

			// The merchant renames while the warehouse books in 5 more units under the
			// old label. The carry decides its quantity INSIDE the write that zeroes the
			// source, so it cannot copy a count that then changes underneath it:
			// whichever order the two commit in, no unit is invented and none disappears.
			const [renamed, restocked] = await Promise.all([
				products.updateCommerceFields(
					{ productId: productId(id), sku: sku(to) },
					idempotencyKey(`mv-rename-${String(loop)}`),
					wm,
				),
				inventory.restock(from, 5, idempotencyKey(`mv-restock-${String(loop)}`) as IdempotencyKey),
			]);

			expect(renamed.ok, `loop ${String(loop)}: the rename lands`).toBe(true);
			expect(restocked.ok, `loop ${String(loop)}: the restock lands`).toBe(true);
			expect(await skuOf(id), `loop ${String(loop)}`).toBe(to);

			const total = ((await onHand(from)) ?? 0) + ((await onHand(to)) ?? 0);
			expect(total, `loop ${String(loop)}: 25 units in, 25 units out`).toBe(25);
			// Whatever the interleaving, no document goes negative or loses a unit to the
			// gap between reading the source and zeroing it.
			expect(
				await onHand(to),
				`loop ${String(loop)}: the product's units moved`,
			).toBeGreaterThanOrEqual(20);
		}
	}, 180_000);
	// Reported per FILE rather than per case: every case here writes the same two
	// document shapes, so one number describes the shape honestly and a per-case
	// breakdown would only repeat it. Runs LAST, so it sees every case's depth.
	test("the contention budget these shapes spend, measured", () => {
		console.info(
			`[sku rename] max compare-and-set depth ${String(maxCasDepth)}/${String(CAS_MAX_ATTEMPTS)}`,
		);
		expect(maxCasDepth, "the contention budget was not exhausted").toBeLessThanOrEqual(
			CAS_MAX_ATTEMPTS,
		);
		expect(maxCasDepth, "the shapes really did contend").toBeGreaterThan(0);
	});
});
