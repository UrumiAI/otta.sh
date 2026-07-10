import { beforeEach, describe, expect, test } from "vitest";
import { idempotencyKey, sku } from "../src/money/ids.js";
import { commit, release, reserve } from "../src/inventory/use-cases.js";
import { InMemoryInventoryStore } from "../src/testing/in-memory-inventory-store.js";
import { CountingIdGen, FixedClock } from "../src/testing/deterministic.js";

describe("inventory use-cases (over the in-memory fake)", () => {
	let store: InMemoryInventoryStore;

	beforeEach(() => {
		store = new InMemoryInventoryStore({
			idGen: new CountingIdGen("res"),
			clock: new FixedClock(new Date("2026-01-01T00:00:00Z")),
			seed: [{ sku: "SKU-1", onHand: 5 }],
		});
	});

	test("reserve within stock decrements and returns ok", async () => {
		const result = await reserve(store, sku("SKU-1"), 2, idempotencyKey("k1"));
		expect(result.ok).toBe(true);
		expect(store.onHand("SKU-1")).toBe(3);
	});

	test("reserve beyond stock returns OUT_OF_STOCK and does not decrement", async () => {
		const result = await reserve(store, sku("SKU-1"), 6, idempotencyKey("k1"));
		expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		expect(store.onHand("SKU-1")).toBe(5);
	});

	test("reserve replayed with same IdempotencyKey returns same reservationId and decrements once", async () => {
		const first = await reserve(store, sku("SKU-1"), 2, idempotencyKey("k1"));
		const replay = await reserve(store, sku("SKU-1"), 2, idempotencyKey("k1"));
		expect(first.ok).toBe(true);
		expect(replay).toEqual(first);
		expect(store.onHand("SKU-1")).toBe(3);
	});

	test("commit finalizes; release returns stock; double-commit and double-release are no-ops", async () => {
		const a = await reserve(store, sku("SKU-1"), 2, idempotencyKey("ka"));
		const b = await reserve(store, sku("SKU-1"), 1, idempotencyKey("kb"));
		if (!a.ok || !b.ok) throw new Error("seeded reserves must succeed");

		await commit(store, a.reservationId);
		await commit(store, a.reservationId); // double-commit: no-op
		expect(store.onHand("SKU-1")).toBe(2); // committed stock stays removed

		await release(store, b.reservationId);
		expect(store.onHand("SKU-1")).toBe(3); // released stock returns
		await release(store, b.reservationId); // double-release: no-op
		expect(store.onHand("SKU-1")).toBe(3);
	});
});
