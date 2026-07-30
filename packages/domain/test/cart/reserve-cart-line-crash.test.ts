import {
	addLine,
	createCart,
	currency,
	DEFAULT_HOLD_TTL_MS,
	expireHolds,
	getCart,
	idempotencyKey,
	removeLine,
	sku,
} from "@otta-sh/domain";
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

	test("a late add replay after the sweep reaped its crashed hold does not resurrect a line (HOLD_EXPIRED)", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const key = idempotencyKey("k1");

		// Crash simulation, faithful to the ledger-first choreography: the add
		// claimed its key and the reserve finalized (held, stock removed), but the
		// cart-line write never landed.
		await h.cartStore.claimMutation({ key, cartId, kind: "add" });
		const reserved = await h.inventory.reserve("SKU-1", 2, key);
		if (!reserved.ok) throw new Error("seed reserve must succeed");
		const deadline = new Date(h.clock.now().getTime() + DEFAULT_HOLD_TTL_MS).toISOString();
		h.cartStore.seedDanglingHold(reserved.reservationId, "SKU-1", deadline);
		expect(await h.onHand("SKU-1")).toBe(3);

		// The sweep reaps the dangling hold; its stock returns to the shelf.
		h.advance(DEFAULT_HOLD_TTL_MS + 60 * 1000);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);

		// The ORIGINAL key is finally replayed (offline retry). reserve replays
		// `released` as ok (Phase-0 semantics), but the attach guard refuses to
		// resurrect a visible line over stock the shopper no longer holds.
		const late = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, key);
		expect(late).toEqual({ ok: false, reason: "HOLD_EXPIRED" });
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
		expect(await h.onHand("SKU-1")).toBe(5); // stock unchanged
	});

	test("a remove that crashed after release is healed on replay: line removed, stock returned exactly once", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";
		expect(await h.onHand("SKU-1")).toBe(3);

		// Crash simulation: the remove's `release` landed (stock returned,
		// reservation `released`) but the line delete never ran.
		await h.inventory.release(reservationId);
		expect(await h.onHand("SKU-1")).toBe(5);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);

		// The replay finds the line with a `released` reservation and COMPLETES
		// the removal — never a spurious LINE_CHECKED_OUT, never a second return.
		const replay = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k2"));
		expect(replay).toEqual({ ok: true });
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
		expect(await h.onHand("SKU-1")).toBe(5); // returned exactly once
	});
});
