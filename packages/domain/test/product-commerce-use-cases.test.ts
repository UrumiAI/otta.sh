import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, sku } from "../src/money/ids.js";
import type { InventoryStore } from "../src/ports/inventory-store.js";
import {
	InvalidProductFieldError,
	MissingProductIdError,
	SkuStockConflictError,
} from "../src/product-commerce/errors.js";
import type { ProductCommerceDeps } from "../src/product-commerce/use-cases.js";
import {
	activateProductCommerce,
	deactivateProductCommerce,
	deactivateProductVariant,
	getProductCommerce,
	listProductVariants,
	softDeleteProductCommerce,
	updateProductCommerceFields,
	updateProductVariantFields,
	upsertProductCommerce,
	upsertProductVariant,
} from "../src/product-commerce/use-cases.js";
import { CountingIdGen, FixedClock } from "../src/testing/deterministic.js";
import { InMemoryInventoryStore } from "../src/testing/in-memory-inventory-store.js";
import { InMemoryProductCommerceStore } from "../src/testing/in-memory-product-commerce-store.js";

describe("product-commerce use-cases (over the in-memory fakes)", () => {
	let productCommerce: InMemoryProductCommerceStore;
	let inventory: InMemoryInventoryStore;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	beforeEach(() => {
		productCommerce = new InMemoryProductCommerceStore({ clock });
		inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
	});

	test("upsertProductCommerce seeds initial on_hand effectively once: create-if-absent on every save with a known sku", async () => {
		const pid = productId("prod-1");

		// Bare content sync (no sku/price yet, e.g. content:afterSave before any
		// pricing) creates the row but must NOT seed stock — there is no sku.
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid },
			idempotencyKey("sync-1"),
		);
		expect(inventory.onHand("SKU-1")).toBe(0);

		// The panel Save action sets sku/price/stock together: the
		// create-then-price moment, and seeds on_hand.
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-1"), price: money(cents(1999), currency("USD")) },
			idempotencyKey("panel-1"),
			10,
		);
		expect(inventory.onHand("SKU-1")).toBe(10);

		// A later edit carrying a stock figure re-ATTEMPTS the seed (B1:
		// always-attempt, so a stranded row can heal), but seedOnHand's
		// create-if-absent guard makes it a no-op — the live on_hand is never
		// clobbered (the field is create-only, Phase 1 §5/§8 Risk 4).
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, price: money(cents(2500), currency("USD")) },
			idempotencyKey("panel-2"),
			999,
		);
		expect(inventory.onHand("SKU-1")).toBe(10);
	});

	test("a save retried after a failed seedOnHand heals the missing inventory row (B1)", async () => {
		const pid = productId("prod-b1");
		// A flaky inventory adapter: the FIRST seed write dies after the
		// product upsert has already committed — the exact partial-failure
		// window review B1 flagged.
		const flakyInventory = recordingInventory(inventory);
		flakyInventory.failNextSeed();

		const deps = { productCommerce, inventory: flakyInventory };
		const input = {
			productId: pid,
			sku: sku("SKU-B1"),
			price: money(cents(700), currency("USD")),
		};

		// First attempt: upsert commits, seed fails, the command FAILS LOUDLY
		// (never swallowed) — leaving the stranded state: priced row, no stock.
		await expect(upsertProductCommerce(deps, input, idempotencyKey("k-b1"), 7)).rejects.toThrow(
			"injected seed fault",
		);
		expect((await productCommerce.getByProductId(pid))?.sku).toBe("SKU-B1");
		expect(inventory.onHand("SKU-B1")).toBe(0);

		// Retry of the SAME save (same idempotency key — the upsert replays as
		// a no-op) re-attempts the seed and heals the missing inventory row.
		await upsertProductCommerce(deps, input, idempotencyKey("k-b1"), 7);
		expect(inventory.onHand("SKU-B1")).toBe(7);
	});

	test("a STALE (reordered) sync delivery seeds nothing for its rejected sku — the seed follows the STORED row", async () => {
		// A delayed `content:afterSave` carrying an OLDER content watermark is a
		// no-op: the store applies nothing and re-reads the current row. The seed
		// must therefore follow the RETURNED row's sku, never the input's — the
		// input's belongs to a payload that was rejected, so seeding it would mint
		// an inventory row for a sku no product owns.
		const pid = productId("prod-reorder");
		const recorder = recordingInventory(inventory);
		const deps = { productCommerce, inventory: recorder };

		await upsertProductCommerce(
			deps,
			{
				productId: pid,
				sku: sku("SKU-CURRENT"),
				contentUpdatedAt: "2026-07-10T02:00:00.000Z",
			},
			idempotencyKey("sync-newer"),
		);
		expect(recorder.seeds).toEqual([{ sku: "SKU-CURRENT", qty: 0 }]);

		// The reordered, older delivery — a DIFFERENT sku, so a naive
		// `input.sku ?? row.sku` would seed it.
		const returned = await upsertProductCommerce(
			deps,
			{
				productId: pid,
				sku: sku("SKU-REJECTED"),
				contentUpdatedAt: "2026-07-10T01:00:00.000Z",
			},
			idempotencyKey("sync-older"),
		);

		// The stale write applied nothing…
		expect(returned.sku).toBe("SKU-CURRENT");
		expect((await getProductCommerce(productCommerce, pid))?.sku).toBe("SKU-CURRENT");
		// …and the seed re-attempted the STORED sku, never the rejected one.
		expect(recorder.seeds).toEqual([
			{ sku: "SKU-CURRENT", qty: 0 },
			{ sku: "SKU-CURRENT", qty: 0 },
		]);
		expect(await inventory.restock("SKU-REJECTED", 1, idempotencyKey("probe-rejected"))).toEqual({
			ok: false,
			reason: "UNKNOWN_SKU",
		});
	});

	test("upsertProductCommerce without an initialOnHand figure still seeds a ZERO row (the sku ⇒ inventory-row invariant)", async () => {
		const pid = productId("prod-2");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-2"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k1"),
			// initialOnHand omitted
		);
		// A sku is now enough: the integrator path (`PUT /products/:id/commerce`)
		// can no longer mint a SKU with no inventory row, so a later restock has
		// something to add to.
		expect(inventory.onHand("SKU-2")).toBe(0);
		expect(await inventory.restock("SKU-2", 4, idempotencyKey("probe-2"))).toEqual({
			ok: true,
			onHand: 4,
		});
	});

	test("upsertProductCommerce with a missing product_id rejects before any row or stock is minted", async () => {
		await expect(
			upsertProductCommerce(
				{ productCommerce, inventory },
				// Simulates a hand-crafted / mis-wired caller bypassing the branded
				// constructor — the use-case must still defend the invariant.
				{ productId: "" as ReturnType<typeof productId>, sku: sku("SKU-X") },
				idempotencyKey("k1"),
				5,
			),
		).rejects.toThrow(MissingProductIdError);
		expect(inventory.onHand("SKU-X")).toBe(0);
	});

	test("getProductCommerce / softDeleteProductCommerce delegate to the store", async () => {
		const pid = productId("prod-3");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-3") },
			idempotencyKey("k1"),
		);

		const read = await getProductCommerce(productCommerce, pid);
		expect(read?.sku).toBe("SKU-3");

		await softDeleteProductCommerce(productCommerce, pid, idempotencyKey("del-1"));
		const afterDelete = await getProductCommerce(productCommerce, pid);
		expect(afterDelete?.deletedAt).not.toBeNull();
		expect(afterDelete?.active).toBe(false);
	});

	// -- activateProductCommerce (the afterPublish→activate follow-up) ------

	test("activateProductCommerce delegates to the store: a live row flips active=true", async () => {
		const pid = productId("prod-4");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-4"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k1"),
		);

		await activateProductCommerce(
			productCommerce,
			pid,
			idempotencyKey("pub-1"),
			"2026-07-10T01:00:00.000Z",
		);

		const read = await getProductCommerce(productCommerce, pid);
		expect(read?.active).toBe(true);
	});

	test("activateProductCommerce on a soft-deleted product does NOT resurrect it", async () => {
		const pid = productId("prod-5");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-5"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k1"),
		);
		await softDeleteProductCommerce(productCommerce, pid, idempotencyKey("del-1"));

		await activateProductCommerce(
			productCommerce,
			pid,
			idempotencyKey("pub-1"),
			"2026-07-10T01:00:00.000Z",
		);

		const read = await getProductCommerce(productCommerce, pid);
		expect(read?.active).toBe(false);
		expect(read?.deletedAt).not.toBeNull();
	});

	// -- deactivateProductCommerce (the afterUnpublish→deactivate follow-up) -

	test("deactivateProductCommerce delegates to the store: an active row flips active=false", async () => {
		const pid = productId("prod-6");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-6"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k1"),
		);
		await activateProductCommerce(
			productCommerce,
			pid,
			idempotencyKey("pub-1"),
			"2026-07-10T01:00:00.000Z",
		);

		await deactivateProductCommerce(
			productCommerce,
			pid,
			idempotencyKey("unpub-1"),
			"2026-07-10T02:00:00.000Z",
		);

		const read = await getProductCommerce(productCommerce, pid);
		expect(read?.active).toBe(false);
		// Deactivation is not a soft delete — the row stays live.
		expect(read?.deletedAt).toBeNull();
	});

	test("deactivateProductCommerce on a soft-deleted product leaves it soft-deleted", async () => {
		const pid = productId("prod-7");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-7"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k1"),
		);
		await softDeleteProductCommerce(productCommerce, pid, idempotencyKey("del-1"));

		await deactivateProductCommerce(
			productCommerce,
			pid,
			idempotencyKey("unpub-1"),
			"2026-07-10T02:00:00.000Z",
		);

		const read = await getProductCommerce(productCommerce, pid);
		expect(read?.active).toBe(false);
		expect(read?.deletedAt).not.toBeNull();
	});

	test("updateProductCommerceFields rejects a mixed-currency edit atomically (400, nothing written)", async () => {
		// Increment 2 slice 5: within-edit currency consistency (Layer A) — a single
		// edit whose price / compare-at / cost disagree on currency is a client bug,
		// rejected BEFORE any store write (never partially applied).
		const pid = productId("prod-mix");
		const seeded = await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-MIX"), price: money(cents(2000), currency("USD")) },
			idempotencyKey("seed-mix"),
		);

		await expect(
			updateProductCommerceFields(
				{ productCommerce, inventory },
				{
					productId: pid,
					price: money(cents(2000), currency("USD")),
					compareAtPrice: money(cents(3000), currency("EUR")),
				},
				idempotencyKey("mix-edit"),
				seeded.updatedAt.toISOString(),
			),
		).rejects.toBeInstanceOf(InvalidProductFieldError);

		// The store row is untouched — no compare-at landed.
		expect((await getProductCommerce(productCommerce, pid))?.compareAtPrice).toBeNull();
	});

	test("upsertProductCommerce with an explicit initialOnHand seeds it, and a re-upsert never clobbers a DECREMENTED on_hand", async () => {
		const pid = productId("prod-dec");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-DEC"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k-dec-1"),
			7,
		);
		expect(inventory.onHand("SKU-DEC")).toBe(7);

		// A reservation decrements the live on_hand — the state the always-attempt
		// seed must never undo (the oversell-critical direction).
		const reserved = await inventory.reserve("SKU-DEC", 3, idempotencyKey("res-dec"));
		expect(reserved.ok).toBe(true);
		expect(inventory.onHand("SKU-DEC")).toBe(4);

		// Re-sending the SAME initialOnHand is a create-if-absent no-op, not a
		// reset to 7 — `INSERT … ON CONFLICT (sku) DO NOTHING`.
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-DEC"), price: money(cents(600), currency("USD")) },
			idempotencyKey("k-dec-2"),
			7,
		);
		expect(inventory.onHand("SKU-DEC")).toBe(4);
	});
});

/**
 * PR 1a — the invariant "a product with a SKU has an inventory row", asserted
 * against the PORT interface (the fakes), on BOTH write paths.
 *
 * Before this, `initialOnHand` was `seedOnHand`'s only caller: the admin edit
 * path never touched inventory, so a product priced through the console had a
 * SKU and no inventory row, and `POST /admin/products/:id/restock` 409'd
 * NO_INVENTORY_ROW forever. These cases pin both halves of the fix, including
 * the guard-classification chain that makes the CAS path self-heal.
 */
describe("the sku ⇒ inventory-row invariant (PR 1a)", () => {
	let productCommerce: InMemoryProductCommerceStore;
	let inventory: InMemoryInventoryStore;
	let recorder: RecordingInventory;
	let deps: ProductCommerceDeps;
	// A LOCAL clock: these cases advance it so `updatedAt` genuinely moves
	// between writes (the classification case needs a stale watermark).
	let clock: FixedClock;

	beforeEach(() => {
		clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		productCommerce = new InMemoryProductCommerceStore({ clock });
		inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
		recorder = recordingInventory(inventory);
		deps = { productCommerce, inventory: recorder };
	});

	// Row-PRESENCE probes. `getOnHand` cannot answer this — a missing row reads
	// as 0 by port contract — but `restock` can: it never auto-creates, so
	// UNKNOWN_SKU means "no row". It is also the exact call the admin console
	// makes, i.e. the bug 1a fixes.
	let probeSeq = 0;
	async function expectNoInventoryRow(s: string): Promise<void> {
		const key = idempotencyKey(`probe-${s}-${probeSeq++}`);
		// A rejected restock consumes nothing and mutates nothing.
		expect(await inventory.restock(s, 1, key)).toEqual({ ok: false, reason: "UNKNOWN_SKU" });
	}
	/** Unlike its sibling, this one MUTATES on success: the row exists, so the
	 *  probe's unit actually lands. Call it last, or account for the +1. */
	async function expectRestockAdds(s: string, expectedOnHand: number): Promise<void> {
		const key = idempotencyKey(`probe-${s}-${probeSeq++}`);
		expect(await inventory.restock(s, 1, key)).toEqual({ ok: true, onHand: expectedOnHand });
	}

	async function bareRow(id: string): Promise<string> {
		const row = await upsertProductCommerce(
			deps,
			{ productId: productId(id) },
			idempotencyKey(`sync-${id}`),
		);
		clock.advance(1000);
		return row.updatedAt.toISOString();
	}

	test("setting the FIRST sku on a bare row creates the inventory row at on_hand = 0", async () => {
		const watermark = await bareRow("prod-first-sku");
		await expectNoInventoryRow("SKU-FIRST");

		const res = await updateProductCommerceFields(
			deps,
			{ productId: productId("prod-first-sku"), sku: sku("SKU-FIRST") },
			idempotencyKey("edit-1"),
			watermark,
		);

		expect(res.ok).toBe(true);
		expect(recorder.seeds).toEqual([{ sku: "SKU-FIRST", qty: 0 }]);
		expect(await inventory.getOnHand("SKU-FIRST")).toBe(0);
		// The point of the whole PR: the console's restock now has a row to add to.
		expect(await inventory.restock("SKU-FIRST", 5, idempotencyKey("restock-1"))).toEqual({
			ok: true,
			onHand: 5,
		});
	});

	test("a SECOND edit re-attempts the seed but never resets a stock level that has since moved", async () => {
		const watermark = await bareRow("prod-second");
		await updateProductCommerceFields(
			deps,
			{ productId: productId("prod-second"), sku: sku("SKU-SECOND") },
			idempotencyKey("edit-1"),
			watermark,
		);
		await inventory.restock("SKU-SECOND", 9, idempotencyKey("restock-1"));
		expect(await inventory.getOnHand("SKU-SECOND")).toBe(9);

		const fresh = await getProductCommerce(productCommerce, productId("prod-second"));
		clock.advance(1000);
		const second = await updateProductCommerceFields(
			deps,
			{
				productId: productId("prod-second"),
				price: money(cents(1500), currency("USD")),
			},
			idempotencyKey("edit-2"),
			fresh!.updatedAt.toISOString(),
		);

		expect(second.ok).toBe(true);
		// Always-attempt (never gated on "the sku changed"), so a stranded row can
		// always heal — but create-if-absent, so the live count is untouched.
		expect(recorder.seeds).toEqual([
			{ sku: "SKU-SECOND", qty: 0 },
			{ sku: "SKU-SECOND", qty: 0 },
		]);
		expect(await inventory.getOnHand("SKU-SECOND")).toBe(9);
	});

	test("an edit on a still-sku-less row performs NO inventory write", async () => {
		const watermark = await bareRow("prod-skuless");
		const res = await updateProductCommerceFields(
			deps,
			{ productId: productId("prod-skuless"), taxClass: "standard" },
			idempotencyKey("edit-1"),
			watermark,
		);

		expect(res.ok).toBe(true);
		expect(recorder.seeds).toEqual([]);
	});

	test("not_found / stale / currency_mismatch perform NO inventory write — only an `ok` seeds", async () => {
		// not_found: an edit is not a create, so nothing is minted either side.
		const missing = await updateProductCommerceFields(
			deps,
			{ productId: productId("ghost"), sku: sku("SKU-GHOST") },
			idempotencyKey("edit-ghost"),
			"2026-07-10T00:00:00.000Z",
		);
		expect(missing).toEqual({ ok: false, reason: "not_found" });

		// stale: another writer moved the row since the admin loaded the detail.
		await bareRow("prod-guards");
		const stale = await updateProductCommerceFields(
			deps,
			{ productId: productId("prod-guards"), sku: sku("SKU-STALE") },
			idempotencyKey("edit-stale"),
			"1999-01-01T00:00:00.000Z",
		);
		expect(stale.ok).toBe(false);
		expect(stale).toMatchObject({ ok: false, reason: "stale" });

		// currency_mismatch: a compare-at on an unpriced row.
		const fresh = await getProductCommerce(productCommerce, productId("prod-guards"));
		const mismatch = await updateProductCommerceFields(
			deps,
			{
				productId: productId("prod-guards"),
				sku: sku("SKU-CUR"),
				compareAtPrice: money(cents(3000), currency("USD")),
			},
			idempotencyKey("edit-cur"),
			fresh!.updatedAt.toISOString(),
		);
		expect(mismatch.ok).toBe(false);
		expect(mismatch).toMatchObject({ ok: false, reason: "currency_mismatch" });

		expect(recorder.seeds).toEqual([]);
	});

	test("a DOUBLE-SUBMIT after the seed threw is classified as a REPLAY, returns ok ahead of the stale guard, and the seed lands", async () => {
		// This models a double-click or a transport-level retry of the
		// BYTE-IDENTICAL request — the only retry that carries the SAME key.
		// (The merchant clicking Save again is the OTHER path: the save handler
		// reloads the fresh detail, so the re-submit carries a new
		// expectedUpdatedAt and therefore a new content-derived key, and heals
		// through the ordinary CAS instead — the next test.)
		const pid = productId("prod-heal");
		const watermark = await bareRow("prod-heal");
		const key = idempotencyKey("edit-heal");
		const input = { productId: pid, sku: sku("SKU-HEAL") };

		// The CAS commits; the seed then dies. `updateCommerceFields` is a CAS,
		// NOT an upsert, so `updatedAt` has already moved — a naive retry would
		// be `stale` and the product would be stranded with a sku and no row.
		recorder.failNextSeed();
		await expect(updateProductCommerceFields(deps, input, key, watermark)).rejects.toThrow(
			"injected seed fault",
		);
		const stranded = await getProductCommerce(productCommerce, pid);
		expect(stranded?.sku).toBe("SKU-HEAL");
		expect(stranded?.updatedAt.toISOString()).not.toBe(watermark);
		await expectNoInventoryRow("SKU-HEAL");

		// CLASSIFICATION CONTROL — the same now-stale watermark under a DIFFERENT
		// key takes the `stale` branch. This is what makes the assertion below a
		// statement about the guard ORDER rather than about the end state: the CAS
		// genuinely no longer matches, so an `ok` can only come from the replay
		// branch, which the port pins AHEAD of staleness
		// (not_found → replay → stale → currency_mismatch).
		const otherKey = await updateProductCommerceFields(
			deps,
			input,
			idempotencyKey("some-other-key"),
			watermark,
		);
		expect(otherKey).toMatchObject({ ok: false, reason: "stale" });

		// The same-key retry: `ok`, carrying the STORED row (a replay applies
		// nothing — the returned watermark is the stranded row's, not a fresh one).
		const replay = await updateProductCommerceFields(deps, input, key, watermark);
		expect(replay.ok).toBe(true);
		if (!replay.ok) throw new Error("unreachable");
		expect(replay.product.updatedAt.toISOString()).toBe(stranded?.updatedAt.toISOString());

		// …so the always-attempt seed runs a second time, and lands.
		expect(recorder.seeds).toEqual([
			{ sku: "SKU-HEAL", qty: 0 },
			{ sku: "SKU-HEAL", qty: 0 },
		]);
		await expectRestockAdds("SKU-HEAL", 1);
	});

	test("the merchant re-saving after the seed threw heals through the ORDINARY CAS path (fresh watermark, new key)", async () => {
		const pid = productId("prod-resave");
		const watermark = await bareRow("prod-resave");
		const input = { productId: pid, sku: sku("SKU-RESAVE") };

		recorder.failNextSeed();
		await expect(
			updateProductCommerceFields(deps, input, idempotencyKey("edit-1"), watermark),
		).rejects.toThrow("injected seed fault");
		await expectNoInventoryRow("SKU-RESAVE");

		// Save again: the panel reloads the fresh detail first, so the re-submit
		// carries the CURRENT watermark and a different content-derived key.
		const fresh = await getProductCommerce(productCommerce, pid);
		clock.advance(1000);
		const resave = await updateProductCommerceFields(
			deps,
			input,
			idempotencyKey("edit-2"),
			fresh!.updatedAt.toISOString(),
		);

		expect(resave.ok).toBe(true);
		await expectRestockAdds("SKU-RESAVE", 1);
	});
});

/**
 * THE SKU-RENAME RULE, from the CALLER's side. The rule itself is the
 * store's — only it can move stock atomically with the row write, and the
 * contract suite pins it there, on every adapter. What can only be seen from
 * here is the COMPOSITION: `updateProductCommerceFields` follows every `ok`
 * with an unconditional `seedOnHand(sku, 0)`, and that call is precisely the
 * one that used to strand the units, because it is create-if-absent on the
 * natural key. These cases pin that it now lands on the row the rename already
 * carried and no-ops on it — the seed stays unconditional, and the count
 * survives it.
 *
 * The two fakes share ONE inventory table here (the product-commerce fake
 * writes through the inventory fake), which is what makes "the store carried
 * it, then the caller seeded over the top" observable at all.
 */
describe("a sku rename survives the caller's always-attempt seed", () => {
	let productCommerce: InMemoryProductCommerceStore;
	let inventory: InMemoryInventoryStore;
	let recorder: RecordingInventory;
	let deps: ProductCommerceDeps;
	let clock: FixedClock;

	beforeEach(() => {
		clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
		productCommerce = new InMemoryProductCommerceStore({
			clock,
			inventoryOnHand: (s) => inventory.peekOnHand(s),
			writeInventoryOnHand: (s, onHand) => {
				inventory.seed(s, onHand);
			},
		});
		recorder = recordingInventory(inventory);
		deps = { productCommerce, inventory: recorder };
	});

	/** A priced, stocked, live product — and the watermark its next edit needs. */
	async function seedStocked(id: string, s: string, onHand: number): Promise<string> {
		const row = await upsertProductCommerce(
			deps,
			{ productId: productId(id), sku: sku(s), price: money(cents(1000), currency("USD")) },
			idempotencyKey(`seed-${id}`),
			onHand,
		);
		clock.advance(1000);
		return row.updatedAt.toISOString();
	}

	test("the units follow the rename, and the seed that follows the rename does NOT reset them", async () => {
		const watermark = await seedStocked("prod-rename", "SKU-FROM", 40);
		expect(inventory.onHand("SKU-FROM")).toBe(40);

		const res = await updateProductCommerceFields(
			deps,
			{ productId: productId("prod-rename"), sku: sku("SKU-TO") },
			idempotencyKey("rename-1"),
			watermark,
		);

		expect(res.ok).toBe(true);
		expect(inventory.onHand("SKU-TO")).toBe(40);
		// The seed still ran — always-attempt is the heal path and stays
		// unconditional — and it still targeted the sku the row now holds…
		expect(recorder.seeds).toEqual([
			{ sku: "SKU-FROM", qty: 40 }, // the create-then-price save
			{ sku: "SKU-TO", qty: 0 }, // the rename's always-attempt seed
		]);
		// …but create-if-absent found the carried row and left it alone. This is
		// the exact call that used to mint a fresh zero row beside 40 orphaned
		// units.
		expect(inventory.onHand("SKU-TO")).toBe(40);
		// The source row is retained, holding nothing — never deleted.
		expect(inventory.peekOnHand("SKU-FROM")).toBe(0);
	});

	test("a REPLAY of the rename moves nothing a second time and re-seeds nothing", async () => {
		const watermark = await seedStocked("prod-replay", "SKU-R-FROM", 25);
		const key = idempotencyKey("rename-replay");
		const input = { productId: productId("prod-replay"), sku: sku("SKU-R-TO") };

		await updateProductCommerceFields(deps, input, key, watermark);
		expect(inventory.onHand("SKU-R-TO")).toBe(25);

		// The double-submit: same key, now-stale watermark ⇒ the replay branch,
		// which applies nothing. A re-run carry could not stay quiet — SKU-R-TO
		// now has a row, so it would REFUSE rather than return ok.
		const replay = await updateProductCommerceFields(deps, input, key, watermark);

		expect(replay.ok).toBe(true);
		expect(inventory.onHand("SKU-R-TO")).toBe(25);
		expect(inventory.peekOnHand("SKU-R-FROM")).toBe(0);
	});

	test("a refused rename propagates the typed error, writes nothing, and never reaches the seed", async () => {
		const watermark = await seedStocked("prod-refuse", "SKU-X-FROM", 6);
		// Units parked under a sku no live product holds — the case the rule
		// exists for, and the one a merchant hits after an earlier rename.
		inventory.seed("SKU-X-TAKEN", 11);
		const seedsBefore = recorder.seeds.length;

		await expect(
			updateProductCommerceFields(
				deps,
				{ productId: productId("prod-refuse"), sku: sku("SKU-X-TAKEN") },
				idempotencyKey("rename-refuse"),
				watermark,
			),
		).rejects.toBeInstanceOf(SkuStockConflictError);

		// Neither side moved, and the caller never got as far as seeding.
		expect((await getProductCommerce(productCommerce, productId("prod-refuse")))?.sku).toBe(
			"SKU-X-FROM",
		);
		expect(inventory.onHand("SKU-X-FROM")).toBe(6);
		expect(inventory.onHand("SKU-X-TAKEN")).toBe(11);
		expect(recorder.seeds).toHaveLength(seedsBefore);
	});

	test("the error names both skus, so an operator can act on it without opening the database", async () => {
		const watermark = await seedStocked("prod-legible", "SKU-L-FROM", 2);
		inventory.seed("SKU-L-TAKEN", 0);

		await expect(
			updateProductCommerceFields(
				deps,
				{ productId: productId("prod-legible"), sku: sku("SKU-L-TAKEN") },
				idempotencyKey("rename-legible"),
				watermark,
			),
		).rejects.toMatchObject({
			name: "SkuStockConflictError",
			fromSku: "SKU-L-FROM",
			toSku: "SKU-L-TAKEN",
			message: expect.stringContaining("SKU-L-FROM"),
		});
	});

	test("a rename leaves the restock path working on the NEW sku, at the carried count", async () => {
		const watermark = await seedStocked("prod-restock", "SKU-RS-FROM", 15);

		await updateProductCommerceFields(
			deps,
			{ productId: productId("prod-restock"), sku: sku("SKU-RS-TO") },
			idempotencyKey("rename-restock"),
			watermark,
		);

		// The admin console's restock adds to the carried count, not to a zero
		// row — the end-to-end symptom a merchant would have reported.
		expect(await inventory.restock("SKU-RS-TO", 5, idempotencyKey("restock-1"))).toEqual({
			ok: true,
			onHand: 20,
		});
	});
});

/**
 * The variant use-cases, from the CALLER's side. The store's own semantics
 * (guard order, the presence watermark, THE SKU-RENAME RULE) are pinned by the
 * contract suite on every adapter; what only this layer can show is the
 * COMPOSITION — which use-case validates what before the write, and which one
 * follows an `ok` with the always-attempt `seedOnHand` that holds the "a
 * sellable unit with a sku has an inventory row" invariant.
 */
describe("variant use-cases (over the in-memory fakes)", () => {
	let productCommerce: InMemoryProductCommerceStore;
	let inventory: InMemoryInventoryStore;
	let recorder: RecordingInventory;
	let deps: ProductCommerceDeps;
	let clock: FixedClock;

	beforeEach(() => {
		clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
		inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
		// The two fakes share ONE inventory table, so "the store carried it, then
		// the caller seeded over the top" is observable at all.
		productCommerce = new InMemoryProductCommerceStore({
			clock,
			inventoryOnHand: (s) => inventory.peekOnHand(s),
			writeInventoryOnHand: (s, onHand) => {
				inventory.seed(s, onHand);
			},
		});
		recorder = recordingInventory(inventory);
		deps = { productCommerce, inventory: recorder };
	});

	/** Declare a variant the way the CMS does, then return the watermark its
	 *  first guarded edit has to pass back. */
	async function declared(pid: string, key: string): Promise<string> {
		const row = await upsertProductVariant(
			productCommerce,
			{ productId: productId(pid), variantKey: key, title: `Variant ${key}` },
			idempotencyKey(`declare-${pid}-${key}`),
		);
		clock.advance(1000);
		return row.updatedAt.toISOString();
	}

	test("upsertProductVariant declares without touching inventory — the CMS channel carries no sku, so there is nothing to seed", async () => {
		const row = await upsertProductVariant(
			productCommerce,
			{ productId: productId("prod-v"), variantKey: "large", title: "Large" },
			idempotencyKey("declare-1"),
		);

		expect(row.title).toBe("Large");
		expect(row.sku).toBeNull();
		// The deliberate contrast with `upsertProductCommerce`, which always
		// attempts a seed precisely because its input CAN carry a sku.
		expect(recorder.seeds).toEqual([]);
	});

	test("listProductVariants passes the store's projection through unchanged", async () => {
		await declared("prod-list", "small");
		await declared("prod-list", "large");

		const rows = await listProductVariants(productCommerce, productId("prod-list"));
		expect(rows.map((v) => v.variantKey)).toEqual(["large", "small"]);
		expect(rows.every((v) => v.onHand === null)).toBe(true);
	});

	test("updateProductVariantFields rejects a non-positive price BEFORE the store write — a $0 size is a missing price, not a price", async () => {
		const watermark = await declared("prod-zero", "large");

		await expect(
			updateProductVariantFields(
				deps,
				{
					productId: productId("prod-zero"),
					variantKey: "large",
					price: money(cents(0), currency("USD")),
				},
				idempotencyKey("zero-1"),
				watermark,
			),
		).rejects.toBeInstanceOf(InvalidProductFieldError);

		// Nothing was written on either side, and the seed was never reached.
		const [row] = await listProductVariants(productCommerce, productId("prod-zero"));
		expect(row?.price).toBeNull();
		expect(recorder.seeds).toEqual([]);
	});

	test("updateProductVariantFields seeds a create-if-absent inventory row for a FIRST sku — the one case the rename rule never covers", async () => {
		const watermark = await declared("prod-first", "large");

		const res = await updateProductVariantFields(
			deps,
			{ productId: productId("prod-first"), variantKey: "large", sku: sku("V-FIRST") },
			idempotencyKey("first-1"),
			watermark,
		);

		expect(res.ok).toBe(true);
		expect(recorder.seeds).toEqual([{ sku: "V-FIRST", qty: 0 }]);
		// A sellable unit with a sku now has an inventory row — the invariant that
		// keeps a later restock from being a permanent NO_INVENTORY_ROW refusal.
		expect(inventory.peekOnHand("V-FIRST")).toBe(0);
	});

	test("a variant rename survives the caller's always-attempt seed: the carried units are never reset to zero", async () => {
		const watermark = await declared("prod-carry", "large");
		const priced = await updateProductVariantFields(
			deps,
			{ productId: productId("prod-carry"), variantKey: "large", sku: sku("V-FROM") },
			idempotencyKey("carry-price"),
			watermark,
		);
		if (!priced.ok) throw new Error("unreachable");
		await inventory.restock("V-FROM", 40, idempotencyKey("carry-restock"));
		clock.advance(1000);

		const res = await updateProductVariantFields(
			deps,
			{ productId: productId("prod-carry"), variantKey: "large", sku: sku("V-TO") },
			idempotencyKey("carry-rename"),
			priced.variant.updatedAt.toISOString(),
		);

		expect(res.ok).toBe(true);
		// The seed still ran — always-attempt is the heal path and stays
		// unconditional — and create-if-absent found the carried row and left it
		// alone. This is the exact call that would otherwise mint a fresh zero row
		// beside 40 orphaned units.
		expect(recorder.seeds).toEqual([
			{ sku: "V-FROM", qty: 0 },
			{ sku: "V-TO", qty: 0 },
		]);
		expect(inventory.onHand("V-TO")).toBe(40);
		expect(inventory.peekOnHand("V-FROM")).toBe(0);
	});

	test("a refused variant rename propagates the typed error and never reaches the seed", async () => {
		const watermark = await declared("prod-refuse", "large");
		const priced = await updateProductVariantFields(
			deps,
			{ productId: productId("prod-refuse"), variantKey: "large", sku: sku("V-SRC") },
			idempotencyKey("refuse-price"),
			watermark,
		);
		if (!priced.ok) throw new Error("unreachable");
		inventory.seed("V-TAKEN", 12);
		clock.advance(1000);

		await expect(
			updateProductVariantFields(
				deps,
				{ productId: productId("prod-refuse"), variantKey: "large", sku: sku("V-TAKEN") },
				idempotencyKey("refuse-1"),
				priced.variant.updatedAt.toISOString(),
			),
		).rejects.toBeInstanceOf(SkuStockConflictError);

		// The store threw, so nothing was written on either side — and in
		// particular the caller never seeded a row for a sku the write refused.
		expect(recorder.seeds).toEqual([{ sku: "V-SRC", qty: 0 }]);
		expect(inventory.peekOnHand("V-TAKEN")).toBe(12);
	});

	test("deactivateProductVariant orphans without deleting, and a not_found edit afterwards never seeds", async () => {
		const watermark = await declared("prod-orph", "large");
		const priced = await updateProductVariantFields(
			deps,
			{ productId: productId("prod-orph"), variantKey: "large", sku: sku("V-ORPH") },
			idempotencyKey("orph-price"),
			watermark,
		);
		if (!priced.ok) throw new Error("unreachable");

		await deactivateProductVariant(
			productCommerce,
			productId("prod-orph"),
			"large",
			idempotencyKey("orph-1"),
			"2026-07-10T01:00:00.000Z",
		);

		const [row] = await listProductVariants(productCommerce, productId("prod-orph"));
		expect(row?.orphanedAt).not.toBeNull();
		expect(row?.sku).toBe("V-ORPH");

		const res = await updateProductVariantFields(
			deps,
			{ productId: productId("prod-orph"), variantKey: "large", sku: sku("V-ORPH-2") },
			idempotencyKey("orph-2"),
			priced.variant.updatedAt.toISOString(),
		);
		expect(res).toEqual({ ok: false, reason: "not_found" });
		// A zero-row outcome wrote no sku, so there is none for the seed to claim.
		expect(recorder.seeds).toEqual([{ sku: "V-ORPH", qty: 0 }]);
	});
});

interface RecordingInventory extends InventoryStore {
	/** Every `seedOnHand` ATTEMPT, in order — including one that threw. Lets a
	 *  case assert "no inventory write at all", which a stock-count assertion
	 *  cannot distinguish from "a write that happened to be a no-op". */
	readonly seeds: Array<{ sku: string; qty: number }>;
	/** Fault the next seed only — the partial-failure window where the guarded
	 *  UPDATE has committed but the inventory row has not landed. */
	failNextSeed(): void;
}

function recordingInventory(inner: InMemoryInventoryStore): RecordingInventory {
	const seeds: Array<{ sku: string; qty: number }> = [];
	let fail = false;
	return {
		seeds,
		failNextSeed() {
			fail = true;
		},
		reserve: (s, q, k) => inner.reserve(s, q, k),
		commit: (id) => inner.commit(id),
		release: (id) => inner.release(id),
		adjust: (id, q, k) => inner.adjust(id, q, k),
		adopt: (i) => inner.adopt(i),
		adoptMany: (i) => inner.adoptMany(i),
		commitMany: (ids) => inner.commitMany(ids),
		releaseAdopted: (id, o) => inner.releaseAdopted(id, o),
		getOnHand: (s) => inner.getOnHand(s),
		findOnHand: (s) => inner.findOnHand(s),
		restock: (s, q, k) => inner.restock(s, q, k),
		removeStock: (s, q, k) => inner.removeStock(s, q, k),
		seedOnHand: async (s, q) => {
			seeds.push({ sku: s, qty: q });
			if (fail) {
				fail = false;
				throw new Error("injected seed fault");
			}
			return inner.seedOnHand(s, q);
		},
	};
}
