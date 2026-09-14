/**
 * The sku-rename carry's CRASH SEAMS — the windows the intent-claim exists to make
 * survivable, driven with real fault injection over real storage.
 *
 * A rename moves units between two inventory documents while the decision to rename
 * lives in a third, and no primitive here writes two documents at once. So the move
 * is a recorded intent instead: the product write records the carry it owes, then the
 * source is zeroed and stamped in ONE write, then the target credits the units iff
 * its bounded ring lacks the token, then the source clears the stamp. Each step is a
 * no-op once it has happened, so ANY replayer finishes a partial.
 *
 * This file makes each of those windows real and then proves the property that
 * matters at it:
 *
 * | Crash point | What must be true |
 * |---|---|
 * | after the product write, before any stock moves | the recorded carry completes the move, exactly once |
 * | after the source is zeroed and stamped | the target is credited exactly once and the stamp is cleared |
 * | after the target is credited | the stamp is cleared, and the target is NOT credited twice |
 * | a hold lands between the decision and the stamp | the rename commits, the units are NOT lost, and the carry completes once the hold clears |
 *
 * **Stock is conserved at every seam**, and every case asserts it rather than
 * assuming it: while the stamp is present its quantity is recorded on the source
 * document, so the sum over the two skus is invariant even mid-flight.
 *
 * Injection is `mode: "after"` — the real write LANDS and only the continuation is
 * lost, which is what "the process died between these two writes" actually looks
 * like. Every case reads the documents back BEFORE replaying, so the state the
 * replay heals is the state the store really leaves behind rather than one the test
 * assumed.
 */
import {
	idempotencyKey,
	productId,
	sku,
	SkuConflictError,
	SkuHeldStockError,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	INVENTORY_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	SKU_OWNERS_COLLECTION,
	skuTransferToken,
	type InventoryDoc,
	type ProductCommerceDoc,
	type SkuOwnerDoc,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	delegatingCollection,
	failCall,
	InjectedCrashError,
	isUpdateWrite,
	onId,
	parkCall,
	withCollection,
} from "./helpers/fault-injection.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

/** A live product on `s`, stocked at `onHand`; returns its compare-and-set watermark. */
async function seedStocked(
	h: ReturnType<typeof makeProductCommerceHarness>,
	id: string,
	s: string,
	onHand: number,
): Promise<string> {
	const row = await h.store.upsert(
		{ productId: productId(id), sku: sku(s) },
		idempotencyKey(`seed-${id}`),
	);
	await h.seedStock(s, onHand);
	return row.updatedAt.toISOString();
}

describeEachDialect("sku-rename crash seams", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	/** The carry a document still records, if any. */
	async function recorded(pid: string): Promise<Record<string, unknown>> {
		const doc = await bound.collection<ProductCommerceDoc>("product_commerce").get(pid);
		return doc?.pendingRenames ?? {};
	}

	/** The live-sku claim for a sku, if any. */
	async function claimOf(s: string): Promise<SkuOwnerDoc | null> {
		return bound.collection<SkuOwnerDoc>(SKU_OWNERS_COLLECTION).get(s);
	}

	/** The source document's in-flight stamp, if any. */
	async function stamp(s: string): Promise<InventoryDoc["transferOut"]> {
		const doc = await bound.collection<InventoryDoc>(INVENTORY_COLLECTION).get(s);
		return doc?.transferOut;
	}

	test("crash after the product write, before any stock moves: the recorded carry completes the move exactly once", async () => {
		const raw = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-seam-0", "SEAM0-FROM", 40);

		// Die on the write that would have zeroed and stamped the source — `instead`,
		// so no stock moved at all. The product write has already committed, which is
		// the whole point of the ordering: the rename is decided, and the move it owes
		// is written down.
		const failing = failCall(raw, onId("SEAM0-FROM", isUpdateWrite), { mode: "instead" });
		const crashing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, INVENTORY_COLLECTION, failing.collection),
		});
		await expect(
			crashing.store.updateCommerceFields(
				{ productId: productId("prod-seam-0"), sku: sku("SEAM0-TO") },
				idempotencyKey("seam0"),
				wm,
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// The state the crash really leaves: the rename is committed, the units have not
		// moved, and the document says where they are going.
		expect((await h.store.getByProductId(productId("prod-seam-0")))?.sku).toBe("SEAM0-TO");
		expect(await h.onHandOf("SEAM0-FROM")).toBe(40);
		expect(await h.onHandOf("SEAM0-TO")).toBe(0);
		const token = skuTransferToken("seam0", "SEAM0-FROM", "SEAM0-TO");
		expect(Object.keys(await recorded("prod-seam-0"))).toEqual([token]);

		// A replayer finishes it. Run TWICE: the second run must move nothing.
		expect(await h.store.completeRecordedRenames(productId("prod-seam-0"))).toBe(1);
		expect(await h.store.completeRecordedRenames(productId("prod-seam-0"))).toBe(0);

		expect(await h.onHandOf("SEAM0-TO")).toBe(40);
		expect(await h.onHandOf("SEAM0-FROM")).toBe(0);
		expect(await recorded("prod-seam-0")).toEqual({});
		expect((await h.onHandOf("SEAM0-FROM")) ?? 0).toBe(0);
	});

	test("crash after the source is zeroed and stamped: the target is credited exactly once, and the stamp is cleared", async () => {
		const raw = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-seam-1", "SEAM1-FROM", 30);

		// `after`: the stamping write LANDS and the continuation is lost. This is the
		// window where the units are on neither document's count — and the one the
		// recorded quantity exists to make survivable.
		const failing = failCall(raw, onId("SEAM1-FROM", isUpdateWrite), { mode: "after" });
		const crashing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, INVENTORY_COLLECTION, failing.collection),
		});
		await expect(
			crashing.store.updateCommerceFields(
				{ productId: productId("prod-seam-1"), sku: sku("SEAM1-TO") },
				idempotencyKey("seam1"),
				wm,
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		const token = skuTransferToken("seam1", "SEAM1-FROM", "SEAM1-TO");
		// Read the seam back rather than assuming it: source emptied and stamped,
		// target still at zero.
		expect(await h.onHandOf("SEAM1-FROM")).toBe(0);
		expect(await h.onHandOf("SEAM1-TO")).toBe(0);
		expect(await stamp("SEAM1-FROM")).toEqual({ token, toSku: "SEAM1-TO", qty: 30 });
		// CONSERVATION mid-flight: the units are recorded on the source even though its
		// count is zero, so nothing is unaccounted for at this seam.
		expect(
			((await h.onHandOf("SEAM1-FROM")) ?? 0) +
				((await h.onHandOf("SEAM1-TO")) ?? 0) +
				((await stamp("SEAM1-FROM"))?.qty ?? 0),
		).toBe(30);

		// The sweeper completes it from the source document alone, and twice is once.
		expect(await h.store.completePendingSkuTransfer("SEAM1-FROM")).toBe(true);
		expect(await h.store.completePendingSkuTransfer("SEAM1-FROM")).toBe(false);

		expect(await h.onHandOf("SEAM1-TO")).toBe(30);
		expect(await h.onHandOf("SEAM1-FROM")).toBe(0);
		expect(await stamp("SEAM1-FROM")).toBeUndefined();
	});

	test("crash after the target is credited: the stamp is cleared once, and the target is NOT credited twice", async () => {
		const raw = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-seam-2", "SEAM2-FROM", 25);

		// The crediting write is the first UPDATE on the target (its create-if-absent
		// claim came earlier, and is not an update).
		const failing = failCall(raw, onId("SEAM2-TO", isUpdateWrite), { mode: "after" });
		const crashing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, INVENTORY_COLLECTION, failing.collection),
		});
		await expect(
			crashing.store.updateCommerceFields(
				{ productId: productId("prod-seam-2"), sku: sku("SEAM2-TO") },
				idempotencyKey("seam2"),
				wm,
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		const token = skuTransferToken("seam2", "SEAM2-FROM", "SEAM2-TO");
		// The units have landed, and the source still says it owes them — the seam a
		// naive replay would turn into 50 units.
		expect(await h.onHandOf("SEAM2-TO")).toBe(25);
		expect(await h.onHandOf("SEAM2-FROM")).toBe(0);
		expect(await stamp("SEAM2-FROM")).toEqual({ token, toSku: "SEAM2-TO", qty: 25 });

		// The ring is what makes the replay safe: the token is already applied, so the
		// completion only drops the stamp.
		expect(await h.store.completePendingSkuTransfer("SEAM2-FROM")).toBe(true);
		expect(await h.onHandOf("SEAM2-TO")).toBe(25);
		expect(await stamp("SEAM2-FROM")).toBeUndefined();
		expect(((await h.onHandOf("SEAM2-FROM")) ?? 0) + ((await h.onHandOf("SEAM2-TO")) ?? 0)).toBe(
			25,
		);
	});

	test("a SECOND transfer of the same token is a no-op — the ring, not the caller, is what makes replay safe", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-seam-3", "SEAM3-FROM", 18);

		const res = await h.store.updateCommerceFields(
			{ productId: productId("prod-seam-3"), sku: sku("SEAM3-TO") },
			idempotencyKey("seam3"),
			wm,
		);
		expect(res.ok).toBe(true);
		expect(await h.onHandOf("SEAM3-TO")).toBe(18);

		// Re-stamp the source with the SAME token, as a crashed replayer would have
		// left it, and complete again. The target's ring already holds the token, so
		// nothing is added — and this is the case that would double the stock if the
		// token were minted per attempt instead of derived from the command.
		const inventory = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const source = await inventory.getVersioned("SEAM3-FROM");
		if (source === null) throw new Error("the source document was not retained");
		await inventory.compareAndSet("SEAM3-FROM", source.revision, {
			...source.value,
			transferOut: {
				token: skuTransferToken("seam3", "SEAM3-FROM", "SEAM3-TO"),
				toSku: "SEAM3-TO",
				qty: 18,
			},
		});

		expect(await h.store.completePendingSkuTransfer("SEAM3-FROM")).toBe(true);
		expect(await h.onHandOf("SEAM3-TO")).toBe(18);
		expect(await h.onHandOf("SEAM3-FROM")).toBe(0);
		expect(await stamp("SEAM3-FROM")).toBeUndefined();
	});

	test("a hold landing between the decision and the stamp: the rename commits, the units are never lost, and the carry completes once the hold clears", async () => {
		const raw = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-seam-4", "SEAM4-FROM", 12);

		// Park the write that would zero and stamp the source. By then the store has
		// read the source (no holds) and claimed the target, so this is exactly the
		// window in which a checkout can land a hold on the sku being renamed away
		// from.
		const parked = parkCall(raw, onId("SEAM4-FROM", isUpdateWrite));
		const racing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, INVENTORY_COLLECTION, parked.collection),
		});
		const rename = racing.store.updateCommerceFields(
			{ productId: productId("prod-seam-4"), sku: sku("SEAM4-TO") },
			idempotencyKey("seam4"),
			wm,
		);
		await parked.arrived;
		// A concurrent checkout takes a hold. It bumps the source's revision, so the
		// parked write is about to lose and the guard is re-evaluated against a document
		// that now HAS a live hold.
		await h.seedHold("SEAM4-FROM", 3);
		parked.release();
		const res = await rename;

		// The rename is committed — it was decided before the hold existed — and the
		// refusal it now meets is NOT reported as a failure, because the write already
		// landed. What it does instead is leave the carry recorded.
		expect(res.ok).toBe(true);
		expect((await h.store.getByProductId(productId("prod-seam-4")))?.sku).toBe("SEAM4-TO");
		// NEVER LOST: the source was not zeroed, so every unit is still exactly where a
		// release of that hold expects to find it.
		expect(await h.onHandOf("SEAM4-FROM")).toBe(12);
		expect(await h.onHandOf("SEAM4-TO")).toBe(0);
		expect(await stamp("SEAM4-FROM")).toBeUndefined();
		expect(Object.keys(await recorded("prod-seam-4"))).toHaveLength(1);

		// While the hold is live the carry still cannot move: the sweep reports it as
		// unfinished rather than pretending otherwise, and the refusal stays typed.
		expect(await h.store.completeRecordedRenames(productId("prod-seam-4"))).toBe(0);
		expect(await h.onHandOf("SEAM4-FROM")).toBe(12);
		await expect(
			h.store.updateCommerceFields(
				{ productId: productId("prod-seam-4"), sku: sku("SEAM4-OTHER") },
				idempotencyKey("seam4-again"),
				(await h.store.getByProductId(productId("prod-seam-4")))?.updatedAt.toISOString() ?? "",
			),
		).rejects.toBeInstanceOf(SkuHeldStockError);

		// The hold resolves (a cart expiring, an order finishing) and the carry finishes.
		await h.seedStock("SEAM4-FROM", 12);
		const inventory = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const held = await inventory.getVersioned("SEAM4-FROM");
		if (held === null) throw new Error("the source document was not retained");
		await inventory.compareAndSet("SEAM4-FROM", held.revision, { ...held.value, holds: {} });

		expect(await h.store.completeRecordedRenames(productId("prod-seam-4"))).toBe(1);
		expect(await h.onHandOf("SEAM4-TO")).toBe(12);
		expect(await h.onHandOf("SEAM4-FROM")).toBe(0);
		expect(await recorded("prod-seam-4")).toEqual({});
		expect(((await h.onHandOf("SEAM4-FROM")) ?? 0) + ((await h.onHandOf("SEAM4-TO")) ?? 0)).toBe(
			12,
		);
	});

	test("two completions of one recorded carry racing each other credit the target exactly once", async () => {
		const raw = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-seam-5", "SEAM5-FROM", 21);

		const failing = failCall(raw, onId("SEAM5-FROM", isUpdateWrite), { mode: "instead" });
		const crashing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, INVENTORY_COLLECTION, failing.collection),
		});
		await expect(
			crashing.store.updateCommerceFields(
				{ productId: productId("prod-seam-5"), sku: sku("SEAM5-TO") },
				idempotencyKey("seam5"),
				wm,
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// A sweep and an ordinary write can reach the same recorded carry at once, so
		// the completion has to be safe against itself and not merely against a serial
		// replay.
		const finished = await Promise.all([
			h.store.completeRecordedRenames(productId("prod-seam-5")),
			h.store.completeRecordedRenames(productId("prod-seam-5")),
		]);

		expect(finished.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
		expect(await h.onHandOf("SEAM5-TO")).toBe(21);
		expect(await h.onHandOf("SEAM5-FROM")).toBe(0);
		expect(await recorded("prod-seam-5")).toEqual({});
	});

	test("a second owner cannot claim a sku whose carry is still OWED, and can once it completes", async () => {
		const raw = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-owed", "OWED-FROM", 12);

		// Reach the state the previous case produces: a hold lands between the decision
		// and the move, so the rename commits with its carry owed and the units still on
		// the source.
		const parked = parkCall(raw, onId("OWED-FROM", isUpdateWrite));
		const racing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, INVENTORY_COLLECTION, parked.collection),
		});
		const rename = racing.store.updateCommerceFields(
			{ productId: productId("prod-owed"), sku: sku("OWED-TO") },
			idempotencyKey("owed-1"),
			wm,
		);
		await parked.arrived;
		await h.seedHold("OWED-FROM", 4);
		parked.release();
		expect((await rename).ok).toBe(true);
		expect(await h.onHandOf("OWED-FROM")).toBe(12);

		// THE ASSERTION THAT BITES. The source no longer belongs to any product's `sku`
		// field, so a naive release would leave it looking free — and a FIRST-sku
		// assignment ADOPTS an existing inventory document, units and all, by design. The
		// second owner would walk off with twelve units the carry is still going to move.
		expect(await claimOf("OWED-FROM")).toMatchObject({ live: true, ownerId: "prod-owed" });
		await expect(
			h.store.upsert(
				{ productId: productId("prod-owed-other"), sku: sku("OWED-FROM") },
				idempotencyKey("owed-other-1"),
			),
		).rejects.toBeInstanceOf(SkuConflictError);
		expect(await h.store.getByProductId(productId("prod-owed-other"))).toBeNull();
		expect(await h.onHandOf("OWED-FROM")).toBe(12);

		// The hold resolves and the carry finishes; only then is the sku given back.
		const inventory = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const held = await inventory.getVersioned("OWED-FROM");
		if (held === null) throw new Error("the source document was not retained");
		await inventory.compareAndSet("OWED-FROM", held.revision, { ...held.value, holds: {} });
		expect(await h.store.completeRecordedRenames(productId("prod-owed"))).toBe(1);
		expect(await h.onHandOf("OWED-TO")).toBe(12);
		expect(await h.onHandOf("OWED-FROM")).toBe(0);
		expect(await claimOf("OWED-FROM")).toMatchObject({ live: false });

		// And now the takeover is legitimate: the sku is free, and what it adopts is the
		// emptied document the rename left behind rather than the units it was owed.
		const adopted = await h.store.upsert(
			{ productId: productId("prod-owed-other"), sku: sku("OWED-FROM") },
			idempotencyKey("owed-other-2"),
		);
		expect(adopted.sku).toBe("OWED-FROM");
		expect(await h.onHandOf("OWED-FROM")).toBe(0);
		expect(((await h.onHandOf("OWED-FROM")) ?? 0) + ((await h.onHandOf("OWED-TO")) ?? 0)).toBe(12);
	});

	test("a crash between the sku claim and the product write leaves a residue a later writer clears on its own", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-wedge", "WEDGE-FROM", 9);

		// The window: the claim is written and the target's inventory document created,
		// and THEN the process dies before the product write commits. The in-process
		// `finally` would normally give both back, so this case takes that away too — the
		// release is an UPDATE on the claim (the claim itself was a create, which still
		// succeeds) and the withdrawal is a delete. What is left behind is durable, and
		// no retry can reach it: the writer is gone.
		const products = failCall(
			bound.collection<ProductCommerceDoc>(PRODUCT_COMMERCE_COLLECTION),
			isUpdateWrite,
			{ mode: "instead" },
		);
		const owners = failCall(bound.collection<SkuOwnerDoc>(SKU_OWNERS_COLLECTION), isUpdateWrite, {
			mode: "instead",
		});
		const rawInventory = bound.collection<InventoryDoc>(INVENTORY_COLLECTION);
		const inventory = delegatingCollection(rawInventory, {
			compareAndDelete(id) {
				throw new InjectedCrashError({ method: "compareAndDelete", id });
			},
		});
		const crashing = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(
				withCollection(
					withCollection(bound.storage, PRODUCT_COMMERCE_COLLECTION, products.collection),
					SKU_OWNERS_COLLECTION,
					owners.collection,
				),
				INVENTORY_COLLECTION,
				inventory,
			),
		});
		await expect(
			crashing.store.updateCommerceFields(
				{ productId: productId("prod-wedge"), sku: sku("WEDGE-TO") },
				idempotencyKey("wedge-1"),
				wm,
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// Read the residue back rather than assuming it: a live claim nothing references,
		// and an empty inventory document under the target.
		expect(await claimOf("WEDGE-TO")).toMatchObject({
			live: true,
			ownerId: "prod-wedge",
			createsTarget: true,
		});
		expect(await h.onHandOf("WEDGE-TO")).toBe(0);
		expect((await h.store.getByProductId(productId("prod-wedge")))?.sku).toBe("WEDGE-FROM");

		// Straight away, the residue is indistinguishable from a writer one round trip
		// from committing, so it is respected.
		const other = await h.store.upsert(
			{ productId: productId("prod-wedge-other") },
			idempotencyKey("wedge-other-seed"),
		);
		await h.seedStock("WEDGE-OTHER-FROM", 5);
		const claimant = await h.store.upsert(
			{ productId: productId("prod-wedge-other"), sku: sku("WEDGE-OTHER-FROM") },
			idempotencyKey("wedge-other-sku"),
		);
		void other;
		await expect(
			h.store.updateCommerceFields(
				{ productId: productId("prod-wedge-other"), sku: sku("WEDGE-TO") },
				idempotencyKey("wedge-other-early"),
				claimant.updatedAt.toISOString(),
			),
		).rejects.toMatchObject({ name: "SkuStockConflictError" });

		// Past the lease it is not. The claim is taken over, its inventory residue goes
		// with it — otherwise "occupied is occupied" would wedge this sku for good — and
		// the rename lands, units and all.
		h.clock.advance(61_000);
		const res = await h.store.updateCommerceFields(
			{ productId: productId("prod-wedge-other"), sku: sku("WEDGE-TO") },
			idempotencyKey("wedge-other-late"),
			claimant.updatedAt.toISOString(),
		);
		expect(res.ok).toBe(true);
		expect(await claimOf("WEDGE-TO")).toMatchObject({
			live: true,
			ownerId: "prod-wedge-other",
		});
		expect(await h.onHandOf("WEDGE-TO")).toBe(5);
		expect(await h.onHandOf("WEDGE-OTHER-FROM")).toBe(0);
		// The crashed product is untouched throughout — it never committed anything.
		expect((await h.store.getByProductId(productId("prod-wedge")))?.sku).toBe("WEDGE-FROM");
		expect(await h.onHandOf("WEDGE-FROM")).toBe(9);
	});
});
