/**
 * The reserve ↔ cart-line crash window against the document adapter — the
 * store-postgres suite of the same name, re-pointed at `EmdashCartStore`.
 *
 * The one substantive improvement over the SQL version: it no longer HAND-SEEDS
 * the crashed state. `seedCrashedHold` there inserted a `cart_mutations` row, a
 * `held` reservation and a decremented `inventory` row by raw statement, which is
 * an assumption about what a crash leaves behind. Here the crash is PRODUCED — the
 * real `claimMutation` runs, the real `reserve` runs, and `upsertLine` simply never
 * does — so the state the replay heals is the state the store really leaves.
 *
 * The fourth case keeps its raw-ish shape for the same reason it had it: it
 * simulates a remove whose `release` landed and whose line delete did not by
 * calling the real `release` and skipping the real `removeLine`.
 */
import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	idempotencyKey,
	removeLine,
	sku,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	RESERVATION_INDEX_COLLECTION,
	type ReservationIndexDoc,
} from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const USD = currency("USD");
/** The domain default hold TTL; the ages below are relative to it. */
const TTL_MS = 15 * 60 * 1000;

/**
 * The real state after an add-to-cart that claimed its mutation key, reserved,
 * and died before the cart-line write: the claim is in the cart's ledger,
 * incomplete; the hold is live and unstamped; the units are gone. `ageMs` backs
 * the clock up first, so the claim can be older than the TTL.
 */
async function crashAfterReserve(
	h: CartHarness,
	cartId: string,
	stockKeeping: string,
	qty: number,
	key: string,
	ageMs = 0,
): Promise<string> {
	h.advance(-ageMs);
	await h.deps.cartStore.claimMutation({ key: idempotencyKey(key), cartId, kind: "add" });
	const reserved = await h.deps.inventoryStore.reserve(stockKeeping, qty, idempotencyKey(key));
	h.advance(ageMs);
	if (!reserved.ok) throw new Error("the crashed add's reserve must succeed");
	return reserved.reservationId;
}

describeEachDialect("reserve ↔ cart-line crash window", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);
	const make = (): CartHarness => makeCartHarness(bound.storage);
	const reservations = (): ReturnType<typeof collectionOf<ReservationIndexDoc>> =>
		collectionOf<ReservationIndexDoc>(bound.storage, RESERVATION_INDEX_COLLECTION);

	test("a replayed add heals the missing line without a second decrement", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const reservationId = await crashAfterReserve(h, cartId, "SKU-1", 2, "k1");
		expect(await h.onHand("SKU-1")).toBe(3);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);

		const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.line.reservationId).toBe(reservationId);
		expect(await h.onHand("SKU-1")).toBe(3); // still exactly one decrement
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
	});

	test("an unreplayed dangling hold is reclaimed by the sweep once its TTL passes", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		// Claimed longer ago than the TTL, so the crashed-claim arm reaps it.
		const reservationId = await crashAfterReserve(
			h,
			cartId,
			"SKU-1",
			2,
			"k1",
			TTL_MS + 5 * 60 * 1000,
		);
		expect(await h.onHand("SKU-1")).toBe(3);

		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);
		expect((await reservations().get(reservationId))?.terminalState).toBe("released");
		// The claim is retired, not completed — the mutation never happened — so a
		// second sweep finds nothing and the stock cannot come back twice.
		expect(await expireHolds(h.deps)).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(5);
	});

	test("a late add replay after the sweep reaped its crashed hold does not resurrect a line (HOLD_EXPIRED)", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const reservationId = await crashAfterReserve(
			h,
			cartId,
			"SKU-1",
			2,
			"k1",
			TTL_MS + 5 * 60 * 1000,
		);

		// The sweep reaps the dangling hold and returns its stock.
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);

		// The ORIGINAL key finally replays: reserve resolves the released hold as ok
		// (replay-by-recorded-outcome), but the `held`-scoped attach precondition
		// fails — no visible line over dead stock, a typed failure instead.
		const late = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		expect(late).toEqual({ ok: false, reason: "HOLD_EXPIRED" });
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
		expect(await h.onHand("SKU-1")).toBe(5); // stock unchanged
		expect((await reservations().get(reservationId))?.terminalState).toBe("released");
	});

	test("a remove that crashed after release is healed on replay: line removed, stock returned exactly once", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";
		expect(await h.onHand("SKU-1")).toBe(3);

		// Crash simulation: the remove's `release` landed (stock returned, the hold
		// pruned, the reservation `released`) but the line delete never ran.
		await h.deps.inventoryStore.release(reservationId);
		expect(await h.onHand("SKU-1")).toBe(5);
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);

		// The replay finds the line with a `released` reservation and COMPLETES the
		// removal — never a spurious LINE_CHECKED_OUT, never a second return.
		const replay = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k2"));
		expect(replay).toEqual({ ok: true });
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
		expect(await h.onHand("SKU-1")).toBe(5); // returned exactly once
	});
});
