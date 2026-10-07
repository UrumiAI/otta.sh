/**
 * Racing first adds and the line's `productId`, with the interleaving FORCED
 * (issue #373).
 *
 * The contract's `Promise.all` case states the rule but cannot promise the
 * interleaving: on SQLite the two calls run one after the other, and on Postgres
 * they collide only when the scheduler happens to line them up. This file pins
 * the one ordering that exercises the compare-and-set retry:
 *
 *   1. the null-productId write reads the cart (no line yet), stamps its hold,
 *      and reaches its `compareAndSet` — where it is PARKED;
 *   2. the productId write runs to completion, so the null write's revision is
 *      now stale;
 *   3. the null write is released, LOSES its `compareAndSet`, re-reads, and
 *      retries against the line the productId write left.
 *
 * The park is on the WRITE, not on the read, on purpose: `parkRead` performs the
 * read on release, so parking the read until the peer has landed would hand the
 * null write a FRESH revision and no retry would ever happen. Parking the write
 * keeps the stale read the race is about.
 *
 * The retry is asserted, not assumed: `onCasAttempts` must report two attempts
 * for the null write's `upsertLine`. Without that check, a run where the park
 * never fired would pass while proving nothing.
 */
import { createCart, currency, DEFAULT_HOLD_TTL_MS, idempotencyKey } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { CARTS_COLLECTION, collectionOf, type CartDoc, type StorageAccess } from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { isUpdateWrite, onId, parkCall, withCollection } from "./helpers/fault-injection.js";

const USD = currency("USD");

/** A first add's two setup steps, in the use-case's order: claim, then reserve. */
async function claimAndReserve(h: CartHarness, cartId: string, name: string, key: string) {
	const k = idempotencyKey(key);
	await h.deps.cartStore.claimMutation({ key: k, cartId, kind: "add" });
	const reserved = await h.deps.inventoryStore.reserve(name, 1, k);
	if (!reserved.ok) throw new Error("the seed reserve must succeed");
	return { key: k, reservationId: reserved.reservationId };
}

describeEachDialect("cart productId under racing first adds", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);

	test("a null-productId write that loses the compare-and-set keeps the winner's productId on its retry", async () => {
		// Armed only once both setups are done, so the claims' own read-modify-writes
		// on this cart pass straight through; once armed, the FIRST cart update is
		// the null write's upsert, and only that one is parked.
		let armed = false;
		let cartId = "";
		const raw = collectionOf<CartDoc>(bound.storage, CARTS_COLLECTION);
		const parked = parkCall(raw, (call) => armed && onId(cartId, isUpdateWrite)(call));
		const storageForCart: StorageAccess = withCollection(
			bound.storage,
			CARTS_COLLECTION,
			parked.collection,
		);
		const upsertAttempts: number[] = [];
		const h = makeCartHarness(bound.storage, {
			storageForCart,
			onCasAttempts: (operation, attempts) => {
				if (operation === "upsertLine") upsertAttempts.push(attempts);
			},
		});

		await h.seedStock("SKU-RACE", 10);
		cartId = await createCart(h.deps, USD);
		const bare = await claimAndReserve(h, cartId, "SKU-RACE", "race-bare");
		const priced = await claimAndReserve(h, cartId, "SKU-RACE", "race-priced");
		const expiresAt = new Date(h.clock.now().getTime() + DEFAULT_HOLD_TTL_MS).toISOString();

		armed = true;
		const bareWrite = h.deps.cartStore.upsertLine({
			cartId,
			sku: "SKU-RACE",
			productId: null,
			qty: 1,
			reservationId: bare.reservationId,
			expiresAt,
			key: bare.key,
		});
		await parked.arrived;
		expect(parked.parked()).toBe(1);

		// The winner lands while the null write holds its stale revision.
		const won = await h.deps.cartStore.upsertLine({
			cartId,
			sku: "SKU-RACE",
			productId: "prod-1",
			qty: 1,
			reservationId: priced.reservationId,
			expiresAt,
			key: priced.key,
		});
		expect(won.productId).toBe("prod-1");

		parked.release();
		const lost = await bareWrite;

		// The winner took one attempt; the null write lost once and retried.
		expect(upsertAttempts).toEqual([1, 2]);
		expect(lost.productId).toBe("prod-1");
		const cart = await h.deps.cartStore.get(cartId);
		expect(cart?.lines).toHaveLength(1);
		expect(cart?.lines[0]?.productId).toBe("prod-1");
	});
});
