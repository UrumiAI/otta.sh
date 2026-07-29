import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, sku } from "../src/money/ids.js";
import type { InventoryStore } from "../src/ports/inventory-store.js";
import { InvalidProductFieldError, MissingProductIdError } from "../src/product-commerce/errors.js";
import type { ProductCommerceDeps } from "../src/product-commerce/use-cases.js";
import {
	activateProductCommerce,
	deactivateProductCommerce,
	getProductCommerce,
	softDeleteProductCommerce,
	updateProductCommerceFields,
	upsertProductCommerce,
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
