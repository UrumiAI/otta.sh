/**
 * The cart sweep against CHECKED-OUT carts.
 *
 * `checkout` flips `state` and leaves the denormalized `holdExpiresAt` behind, so
 * before this suite every checked-out cart in history stayed a `listExpired`
 * candidate forever: each tick re-listed every one of its lines, and `expireHold`
 * spent its reads per line only to find the hold `adopted` (or long settled) and
 * return false. The sweep's cost grew with lifetime order lines, and on a
 * per-invocation query budget it starves every cron leg that runs after it.
 *
 * The first case is that regression. The others pin what the fix must NOT give up,
 * because a checked-out cart can still legitimately own a `held` hold the cart
 * sweep is the ONLY reaper of — the inventory aggregate has no TTL of its own:
 *
 * - a line that raced the checkout: the add's `guardActiveCart` read `active`, the
 *   line landed after the order snapshotted the cart, and the order therefore
 *   never adopted it;
 * - an add that claimed, reserved and crashed before its line write.
 *
 * Neither may be orphaned, and neither may cost an adopted sibling its stock.
 *
 * Two more pin the edges of "owes nothing": an add that was DECIDED out of stock
 * leaves its claim incomplete forever yet can never mint a hold, so it must not
 * keep a cart listed; and a narrowing that cannot land (contention) must cost
 * only its own cart the optimization, never the rest of the tick its reaping.
 */
import {
	addLine,
	createCart,
	currency,
	expireHolds,
	idempotencyKey,
	orderId,
	sku,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	CARTS_COLLECTION,
	type CartDoc,
	collectionOf,
	normalizeInventoryDoc,
} from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { delegatingCollection, withCollection } from "./helpers/fault-injection.js";

const USD = currency("USD");
const MINUTE_MS = 60 * 1000;
/** The domain default hold TTL. */
const TTL_MS = 15 * MINUTE_MS;

/** `listExpired` exactly as `expireHolds` calls it, at the harness clock. */
async function listed(h: CartHarness): Promise<string[]> {
	const now = h.clock.now();
	const cutoff = new Date(now.getTime() - TTL_MS).toISOString();
	const found = await h.store.listExpired(now.toISOString(), cutoff);
	return found.map((hold) => hold.reservationId);
}

async function holdState(h: CartHarness, key: string): Promise<string | undefined> {
	const doc = await h.inventoryDocs.get("SKU-1");
	if (doc === null) throw new Error("missing inventory document");
	return normalizeInventoryDoc(doc).holds[key]?.state;
}

/** Adopt `reservationIds` for an order, as `finalizeOrder` does before its flip. */
async function adopt(h: CartHarness, reservationIds: string[]): Promise<void> {
	const adopted = await h.inventory.adoptMany({
		reservationIds,
		orderId: "order-1",
		holdExpiresAt: new Date(h.clock.now().getTime() + 30 * MINUTE_MS).toISOString(),
		now: h.clock.now().toISOString(),
	});
	expect(adopted.lost).toEqual([]);
}

describeEachDialect("cart sweep over checked-out carts", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);
	const make = (): CartHarness => makeCartHarness(bound.storage);

	test("REGRESSION: a checked-out cart whose holds the order adopted stops being a sweep candidate", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		await adopt(h, [add.line.reservationId ?? ""]);
		expect(await h.store.checkout(cartId, orderId("order-1"))).toBe(true);

		// Past the cart line's deadline. Nothing here is the cart's to reap — the
		// order owns the hold — so nothing may be listed, and the cart must drop
		// out of the candidate index rather than be re-read on every later tick.
		// This is also the shape every checked-out cart written BEFORE the fix is
		// in, so it proves existing data heals without a backfill.
		h.advance(TTL_MS + MINUTE_MS);
		expect(await listed(h)).toEqual([]);
		expect((await h.carts.get(cartId))?.holdExpiresAt).toBeNull();
		expect(await expireHolds(h.deps)).toBe(0);

		// And the order's hold is exactly where the order left it.
		expect(await holdState(h, "k1")).toBe("adopted");
		expect(await h.onHand("SKU-1")).toBe(3);
		const cart = await h.store.get(cartId);
		expect(cart?.state).toBe("checked_out");
		expect(cart?.lines).toHaveLength(1);
	});

	test("a line that raced the checkout keeps its hold reapable, and only that hold is reaped", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		await h.seedStock("SKU-2", 5);
		const cartId = await createCart(h.deps, USD);
		const a = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!a.ok) throw new Error("add must succeed");
		// B lands five minutes later and is NOT in the order's snapshot: the order
		// adopts A alone and then flips the cart, leaving B `held` on a terminal cart.
		h.advance(5 * MINUTE_MS);
		const b = await addLine(h.deps, cartId, sku("SKU-2"), null, 1, idempotencyKey("k2"));
		if (!b.ok) throw new Error("add must succeed");
		await adopt(h, [a.line.reservationId ?? ""]);
		expect(await h.store.checkout(cartId, orderId("order-1"))).toBe(true);

		// A's deadline has passed, B's has not: nothing is due, and the candidate
		// deadline narrows to the one hold that is still the cart's.
		h.advance(11 * MINUTE_MS);
		expect(await listed(h)).toEqual([]);
		expect((await h.carts.get(cartId))?.holdExpiresAt).toBe(b.line.expiresAt);

		// Past B's deadline: B — and only B — is reaped, exactly once.
		h.advance(5 * MINUTE_MS);
		expect(await listed(h)).toEqual([b.line.reservationId]);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-2")).toBe(5);
		expect(await h.onHand("SKU-1")).toBe(3);
		expect(await holdState(h, "k1")).toBe("adopted");

		// With B gone the cart owes nothing, and the next tick retires it.
		expect(await listed(h)).toEqual([]);
		expect((await h.carts.get(cartId))?.holdExpiresAt).toBeNull();
		expect(await expireHolds(h.deps)).toBe(0);
	});

	test("a crashed add on a checked-out cart is still reaped", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const a = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("k1"));
		if (!a.ok) throw new Error("add must succeed");
		// An add that claimed and reserved, then died before its line write.
		await h.deps.cartStore.claimMutation({ key: idempotencyKey("k2"), cartId, kind: "add" });
		const crashed = await h.deps.inventoryStore.reserve("SKU-1", 2, idempotencyKey("k2"));
		if (!crashed.ok) throw new Error("the crashed add's reserve must succeed");
		await adopt(h, [a.line.reservationId ?? ""]);
		expect(await h.store.checkout(cartId, orderId("order-1"))).toBe(true);
		expect(await h.onHand("SKU-1")).toBe(2);

		h.advance(TTL_MS + MINUTE_MS);
		expect(await listed(h)).toEqual([crashed.reservationId]);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(4); // the crashed 2 return; the adopted 1 does not
		expect(await holdState(h, "k1")).toBe("adopted");

		expect(await listed(h)).toEqual([]);
		expect((await h.carts.get(cartId))?.holdExpiresAt).toBeNull();
	});

	test("an add decided OUT_OF_STOCK does not keep a checked-out cart listed", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		await h.seedStock("SKU-2", 1);
		const cartId = await createCart(h.deps, USD);
		const a = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!a.ok) throw new Error("add must succeed");
		// The real OOS path: the claim is written, the reserve is DECIDED with no
		// reservation, and the domain leaves the claim incomplete for good.
		const oos = await addLine(h.deps, cartId, sku("SKU-2"), null, 3, idempotencyKey("k2"));
		expect(oos).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		await adopt(h, [a.line.reservationId ?? ""]);
		expect(await h.store.checkout(cartId, orderId("order-1"))).toBe(true);

		h.advance(TTL_MS + MINUTE_MS);
		expect(await listed(h)).toEqual([]);
		expect((await h.carts.get(cartId))?.holdExpiresAt).toBeNull();
		expect(await h.onHand("SKU-2")).toBe(1);
		expect(await holdState(h, "k1")).toBe("adopted");
	});

	test("a checked-out cart whose narrowing cannot land does not stop the tick reaping others", async () => {
		// Every write that would narrow a checked-out cart is refused, as sustained
		// contention would; writes to active carts go through untouched.
		const raw = collectionOf<CartDoc>(bound.storage, CARTS_COLLECTION);
		const refusing = delegatingCollection<CartDoc>(raw, {
			compareAndSet: async (id, revision, data) =>
				data.state === "checked_out" && data.orderId !== null && revision !== null
					? { applied: false }
					: raw.compareAndSet(id, revision, data),
		});
		const h = makeCartHarness(bound.storage, {
			maxCasAttempts: 2,
			storageForCart: withCollection(bound.storage, CARTS_COLLECTION, refusing),
		});
		await h.seedStock("SKU-1", 5);
		await h.seedStock("SKU-2", 5);
		const done = await createCart(h.deps, USD);
		const a = await addLine(h.deps, done, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!a.ok) throw new Error("add must succeed");
		await adopt(h, [a.line.reservationId ?? ""]);
		// The flip itself is a checked_out write with an order id, so it is made
		// on the raw collection, as `checkout` would have made it.
		const flip = await raw.getVersioned(done);
		if (flip === null) throw new Error("missing cart document");
		await raw.compareAndSet(done, flip.revision, {
			...flip.value,
			state: "checked_out",
			orderId: "order-1",
		});

		const live = await createCart(h.deps, USD);
		const b = await addLine(h.deps, live, sku("SKU-2"), null, 3, idempotencyKey("k2"));
		if (!b.ok) throw new Error("add must succeed");

		h.advance(TTL_MS + MINUTE_MS);
		// The active cart's lapsed hold is still found and reaped; the un-narrowed
		// checked-out cart falls back to being listed in full, which `expireHold`
		// refuses exactly as it did before narrowing existed.
		expect(await listed(h)).toContain(b.line.reservationId);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-2")).toBe(5);
		expect(await holdState(h, "k1")).toBe("adopted");
	});
});
