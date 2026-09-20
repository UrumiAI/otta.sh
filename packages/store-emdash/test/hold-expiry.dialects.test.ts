/**
 * Hold expiry against the document adapter. `@otta-sh/store-postgres` is gone;
 * this is the dialect coverage now, re-pointed at `EmdashCartStore`.
 *
 * The four cases are the specification of ADR-0019 §7.7: an expired hold is
 * released and its stock returns, a lazy read racing the sweep returns stock
 * EXACTLY once, a hold whose TTL was reset between listing and release is not
 * reaped, and a raw non-cart hold older than the TTL is never the cart sweep's to
 * reap. Reservation state is read where the document model keeps it — the terminal
 * state in `reservation_index`, which outlives the pruned hold.
 */
import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	idempotencyKey,
	sku,
	updateLine,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	normalizeInventoryDoc,
	RESERVATION_INDEX_COLLECTION,
	type ReservationIndexDoc,
} from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const USD = currency("USD");
const PAST_TTL_MS = 16 * 60 * 1000;

/** The live hold's own state in the aggregate, or undefined if it is gone. */
async function liveHoldState(
	h: CartHarness,
	stockKeeping: string,
	reserveKey: string,
): Promise<string | undefined> {
	const doc = await h.inventoryDocs.get(stockKeeping);
	if (doc === null) throw new Error(`no inventory document for ${stockKeeping}`);
	return normalizeInventoryDoc(doc).holds[reserveKey]?.state;
}

describeEachDialect("hold expiry", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);
	const make = (): CartHarness => makeCartHarness(bound.storage);
	const reservations = (): ReturnType<typeof collectionOf<ReservationIndexDoc>> =>
		collectionOf<ReservationIndexDoc>(bound.storage, RESERVATION_INDEX_COLLECTION);

	test("an expired hold is released, its stock returns, and the reservation is 'released'", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";
		expect(await h.onHand("SKU-1")).toBe(3);

		h.advance(PAST_TTL_MS);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);

		expect((await reservations().get(reservationId))?.terminalState).toBe("released");
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
	});

	test("a lazy read racing the sweep returns stock exactly once", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");

		h.advance(PAST_TTL_MS);
		const lazy = await getCart(h.deps, cartId); // lazy-on-read reclaims
		const swept = await expireHolds(h.deps); // sweep sees nothing left
		expect(lazy?.lines).toHaveLength(0);
		expect(swept).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(5); // returned once, not 7
	});

	test("expiry re-checks the deadline: a hold TTL-reset between listing and release is not reaped", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";

		// Script the sweep's list→release window by hand: list at a `now` where the
		// hold looks expired…
		h.advance(PAST_TTL_MS);
		const staleNow = h.clock.now().toISOString();
		const listed = await h.deps.cartStore.listExpired(staleNow, staleNow);
		expect(listed).toEqual([{ reservationId }]);

		// …then an active shopper's mutation resets the hold before the release
		// lands. The deadline is re-checked in the same write that takes the
		// once-only token: nothing is flipped, nothing is reaped, no stock moved.
		const up = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k2"));
		if (!up.ok) throw new Error("adjust must succeed");
		const won = await h.deps.cartStore.expireHold(reservationId, staleNow, staleNow);
		expect(won).toBe(false);
		expect(await h.onHand("SKU-1")).toBe(2); // 5 − 3: the hold is intact
		// Asserted POSITIVELY, as the SQL version's `state === "held"` was: an absent
		// terminal state alone would also be satisfied by a hold that vanished.
		expect(await liveHoldState(h, "SKU-1", "k1")).toBe("held");
		expect((await reservations().get(reservationId))?.terminalState).toBeUndefined();
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
	});

	test("a raw non-cart hold older than the TTL is not reaped by the cart sweep", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		// A direct reserve: held, never stamped with a deadline, and — decisively —
		// with no cart claim, so no locator names a cart for it. An admin/API hold
		// awaiting explicit commit/release must be left alone forever.
		const raw = await h.deps.inventoryStore.reserve("SKU-1", 2, idempotencyKey("raw-1"));
		if (!raw.ok) throw new Error("raw reserve must succeed");
		expect(await h.onHand("SKU-1")).toBe(3);

		h.advance(PAST_TTL_MS * 10);
		expect(await expireHolds(h.deps)).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(3); // still held
		expect(await liveHoldState(h, "SKU-1", "raw-1")).toBe("held");
		expect((await reservations().get(raw.reservationId))?.terminalState).toBeUndefined();
	});
});
