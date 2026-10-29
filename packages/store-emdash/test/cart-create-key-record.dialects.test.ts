/**
 * Issue #39: a keyed create records its key ON the cart it minted.
 *
 * `cart_create_keys/{key}` maps a create key to its cart, and nothing maps a cart
 * back to its key: the collection is reached by id alone and declares no index.
 * The abandoned-cart prune (the plugin's `prune-carts` sweep leg) must delete a
 * cart's key record together with the cart, or a late replay of the key re-creates
 * the same cart id, empty. So the cart carries the key it was minted under
 * (`CartDoc.createKey`), written in the same create-if-absent as the cart itself,
 * and every later write keeps it.
 */
import {
	addLine,
	createCart,
	currency,
	idempotencyKey,
	orderId as brandOrderId,
	removeLine,
	sku,
} from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import {
	CART_CREATE_KEYS_COLLECTION,
	type CartCreateKeyDoc,
	collectionOf,
	normalizeCartDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { type CartHarness, makeCartHarness } from "./cart-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const USD = currency("USD");

describeEachDialect("a keyed create records its key on the cart (#39)", (ctx) => {
	const bound = ctx.useStorage(CART_LAYOUT);
	const make = (): CartHarness => makeCartHarness(bound.storage);

	test("the cart a keyed create mints carries the store key it was minted under", async () => {
		const h = make();
		const cartId = await h.store.create(USD, idempotencyKey("create:press-1"));
		const doc = await h.carts.get(cartId);
		expect(doc?.createKey).toBe("create:press-1");
	});

	test("an unkeyed create carries no key", async () => {
		const h = make();
		const cartId = await h.store.create(USD);
		const doc = await h.carts.get(cartId);
		expect(doc).not.toBeNull();
		expect(doc).not.toHaveProperty("createKey");
	});

	test("racing creates under one key converge on one cart, which carries the key", async () => {
		const h = make();
		const ids = await Promise.all(
			Array.from({ length: 5 }, () => h.store.create(USD, idempotencyKey("create:race"))),
		);
		expect(new Set(ids).size).toBe(1);
		const doc = await h.carts.get(ids[0]!);
		expect(doc?.createKey).toBe("create:race");
	});

	test("the use-case's namespaced key is what is recorded, and line writes keep it", async () => {
		const h = make();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD, idempotencyKey("press-2"));
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("add-1"));
		if (!add.ok) throw new Error("add must succeed");
		await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("remove-1"));
		const doc = await h.carts.get(cartId);
		if (doc === null) throw new Error("the cart must exist");
		expect(Object.keys(normalizeCartDoc(doc).lines)).toEqual([]);
		expect(doc.createKey).toBe("create:press-2");
	});

	test("a replay whose key record is pruned between its lost claim and its read claims again (#39)", async () => {
		// A first create named cart A under the key; the prune then deleted A and its
		// record. Simulated here at the worst moment: after this replay's create-if-absent
		// lost to A's record, before it read A's id back.
		const base = bound.storage;
		const keys = collectionOf<CartCreateKeyDoc>(base, CART_CREATE_KEYS_COLLECTION);
		await keys.compareAndSet("create:pruned", null, { cartId: "cart-a" });
		let reads = 0;
		const real = base[CART_CREATE_KEYS_COLLECTION]!;
		const racing = new Proxy(real, {
			get(target, prop, receiver) {
				if (prop !== "get") {
					const value: unknown = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return async (id: string) => {
					reads++;
					const current = await keys.getVersioned(id);
					if (reads === 1 && current !== null) await keys.compareAndDelete(id, current.revision);
					return target.get(id);
				};
			},
		}) satisfies StorageCollection;
		const storageForCart: StorageAccess = { ...base, [CART_CREATE_KEYS_COLLECTION]: racing };
		const h = makeCartHarness(base, { storageForCart });

		const cartId = await h.store.create(USD, idempotencyKey("create:pruned"));

		expect(cartId).not.toBe("cart-a");
		expect(reads).toBe(1);
		expect((await keys.get("create:pruned"))?.cartId).toBe(cartId);
		expect((await h.carts.get(cartId))?.createKey).toBe("create:pruned");
		// A further replay finds the new record.
		expect(await h.store.create(USD, idempotencyKey("create:pruned"))).toBe(cartId);
	});

	test("a replay that re-issues an active cart moves its updatedAt; a checked-out cart is left as it is", async () => {
		// The route hands the shopper a fresh cookie on every replay, and the prune
		// judges a cart by its last write, so the replay is that write (#39).
		const h = make();
		const active = await h.store.create(USD, idempotencyKey("create:touch"));
		const spent = await h.store.create(USD, idempotencyKey("create:spent"));
		await h.store.checkout(spent, brandOrderId("order-spent"));
		const spentBefore = (await h.carts.get(spent))?.updatedAt;
		h.clock.advance(20 * 24 * 60 * 60 * 1000);

		expect(await h.store.create(USD, idempotencyKey("create:touch"))).toBe(active);
		expect(await h.store.create(USD, idempotencyKey("create:spent"))).toBe(spent);

		expect((await h.carts.get(active))?.updatedAt).toBe(h.clock.now().toISOString());
		expect((await h.carts.get(spent))?.updatedAt).toBe(spentBefore);
	});
});
