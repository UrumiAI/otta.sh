import {
	addLine,
	createCart,
	currency,
	DEFAULT_HOLD_TTL_MS,
	expireHolds,
	getCart,
	idempotencyKey,
	sku,
} from "@urumi/domain";
import { describe, expect, test } from "vitest";
import { makeFakeCartHarness } from "./fake-harness.js";

const USD = currency("USD");

// B5 (required, §7/§8 Risk 2) — the reserve↔cart-line crash window. A hold that
// finalized (`held`) but whose cart-line write never landed is healed by
// idempotent replay, and — if never replayed — reclaimed by ordinary TTL/sweep.
describe("reserve ↔ cart-line crash window (fake)", () => {
	test("a replayed add heals the missing cart line without a second decrement", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const key = idempotencyKey("k1");

		// Crash simulation: the reserve finalized (stock removed, `held`) but the
		// cart-line write never ran — so there is a held reservation and no line.
		const reserved = await h.inventory.reserve("SKU-1", 2, key);
		if (!reserved.ok) throw new Error("seed reserve must succeed");
		expect(await h.onHand("SKU-1")).toBe(3);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);

		// The replay of the same add-to-cart key completes the line; the keyed
		// reserve returns the same hold, so stock is decremented exactly once.
		const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, key);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.line.reservationId).toBe(reserved.reservationId);
		expect(await h.onHand("SKU-1")).toBe(3); // still one decrement
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
	});

	test("an unreplayed dangling hold is reclaimed by the TTL sweep", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const key = idempotencyKey("k1");

		const reserved = await h.inventory.reserve("SKU-1", 2, key);
		if (!reserved.ok) throw new Error("seed reserve must succeed");
		expect(await h.onHand("SKU-1")).toBe(3);

		// Model the dangling hold's effective deadline (created_at + TTL) that the
		// real store reaps via `reservations.created_at`.
		const deadline = new Date(h.clock.now().getTime() + DEFAULT_HOLD_TTL_MS).toISOString();
		h.cartStore.seedDanglingHold(reserved.reservationId, "SKU-1", deadline);

		// Before the TTL passes, the hold survives; after, the sweep reclaims it.
		expect(await expireHolds(h.deps)).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(3);

		h.advance(DEFAULT_HOLD_TTL_MS + 60 * 1000);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);
	});
});
