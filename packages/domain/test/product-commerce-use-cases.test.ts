import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, sku } from "../src/money/ids.js";
import type { InventoryStore } from "../src/ports/inventory-store.js";
import { MissingProductIdError } from "../src/product-commerce/errors.js";
import {
	getProductCommerce,
	softDeleteProductCommerce,
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

	test("upsertProductCommerce seeds initial on_hand effectively once: create-if-absent on every save that carries a stock figure", async () => {
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
		let failNextSeed = true;
		// A flaky inventory adapter: the FIRST seed write dies after the
		// product upsert has already committed — the exact partial-failure
		// window review B1 flagged.
		const flakyInventory: InventoryStore = {
			reserve: (s, q, k) => inventory.reserve(s, q, k),
			commit: (id) => inventory.commit(id),
			release: (id) => inventory.release(id),
			adjust: (id, q, k) => inventory.adjust(id, q, k),
			seedOnHand: async (s, q) => {
				if (failNextSeed) {
					failNextSeed = false;
					throw new Error("injected seed fault");
				}
				return inventory.seedOnHand(s, q);
			},
		};

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

	test("upsertProductCommerce without an initialOnHand figure never touches inventory", async () => {
		const pid = productId("prod-2");
		await upsertProductCommerce(
			{ productCommerce, inventory },
			{ productId: pid, sku: sku("SKU-2"), price: money(cents(500), currency("USD")) },
			idempotencyKey("k1"),
			// initialOnHand omitted
		);
		expect(inventory.onHand("SKU-2")).toBe(0);
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
});
