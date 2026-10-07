/**
 * A checkout that dies AFTER its order is durable is finished by the same-key
 * replay — over real storage, with the failure being the store's own typed
 * `StorageContentionError` (a hot-SKU compare-and-set that exhausted its budget),
 * not a stand-in.
 *
 * The order document lands before adoption and before the cart flip, so a throw
 * from either leaves a `pending` order whose holds are still cart-`held` — on the
 * cart's deadline, reapable by the cart sweep — behind a still-`active` cart. The
 * client's retry under the same key must re-run both steps (idempotent for the
 * same order) before it is handed a payment intent, or it pays for units the cart
 * sweep can return to the shelf.
 */
import { createOrderFromCart, idempotencyKey, type Order } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { CARTS_COLLECTION, INVENTORY_COLLECTION, isStorageContentionError } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { alwaysLosingCollection, withCollection } from "./helpers/fault-injection.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const KEY = idempotencyKey("k-replay-heal");

function cmd(cartId: string) {
	return {
		cartId,
		idempotencyKey: KEY,
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe" as const,
	};
}

function reservationIdsOf(order: Order): string[] {
	return order.lines.map((line) => {
		if (line.reservationId === null) {
			throw new Error(`order ${order.id} line ${line.sku} was expected to hold a reservation`);
		}
		return line.reservationId;
	});
}

/** Await a call that MUST fail with the store's typed contention error. */
async function expectContention(call: Promise<unknown>): Promise<void> {
	const failure = await call.then(
		(value) => value,
		(err: unknown) => err,
	);
	expect(isStorageContentionError(failure), String(failure)).toBe(true);
}

describeEachDialect("checkout replay finishes an interrupted checkout", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);

	async function seeded(): Promise<{ clean: OrderHarness; cartId: string }> {
		const clean = makeOrderHarness(bound.storage);
		await clean.seedPhysical({
			productId: "pa",
			sku: "SKU-A",
			priceCents: 500,
			title: "A",
			onHand: 5,
		});
		await clean.seedPhysical({
			productId: "pb",
			sku: "SKU-B",
			priceCents: 700,
			title: "B",
			onHand: 5,
		});
		const cartId = await clean.cartWith([
			{ sku: "SKU-A", productId: "pa", qty: 1, kind: "physical" },
			{ sku: "SKU-B", productId: "pb", qty: 2, kind: "physical" },
		]);
		return { clean, cartId };
	}

	/** A twin whose writes to `collection` always lose their compare-and-set. */
	function contendedTwin(clean: OrderHarness, collection: string): OrderHarness {
		const raw = bound.storage[collection];
		if (raw === undefined) throw new Error(`the ${collection} collection is not declared`);
		const storage = withCollection(bound.storage, collection, alwaysLosingCollection(raw));
		return makeOrderHarness(bound.storage, {
			share: clean.shared,
			maxCasAttempts: 3,
			...(collection === INVENTORY_COLLECTION
				? { storageForInventory: storage }
				: { storageForCart: storage }),
		});
	}

	test("adopt throws contention after the order is durable → same-key replay leaves every hold adopted and the cart checked out", async () => {
		const { clean, cartId } = await seeded();
		const contended = contendedTwin(clean, INVENTORY_COLLECTION);
		await expectContention(createOrderFromCart(contended.createDeps, cmd(cartId)));

		// The seam, read off storage: a durable pending order, holds still held,
		// the cart still active.
		const stranded = await clean.store.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the contended checkout must leave a durable order");
		expect(stranded.state).toBe("pending");
		const ids = reservationIdsOf(stranded);
		expect(await Promise.all(ids.map((id) => clean.reservationState(id)))).toEqual([
			"held",
			"held",
		]);
		expect((await clean.cartStore.get(cartId))?.state).toBe("active");

		const replay = await createOrderFromCart(clean.createDeps, cmd(cartId));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.id).toBe(stranded.id);

		expect(await Promise.all(ids.map((id) => clean.reservationState(id)))).toEqual([
			"adopted",
			"adopted",
		]);
		const cartRow = await clean.cartStore.get(cartId);
		expect({ state: cartRow?.state, orderId: cartRow?.orderId }).toEqual({
			state: "checked_out",
			orderId: stranded.id,
		});
		expect(await clean.onHand("SKU-A")).toBe(4);
		expect(await clean.onHand("SKU-B")).toBe(3);

		// The cart sweep past the cart hold's deadline can no longer reap them.
		clean.advance(16 * 60 * 1000);
		expect(await clean.sweepHeldHolds()).toBe(0);
		expect(await clean.onHand("SKU-A")).toBe(4);
		expect(await clean.onHand("SKU-B")).toBe(3);
	});

	test("cart checkout throws contention after adoption → same-key replay flips the cart and stamps the order", async () => {
		const { clean, cartId } = await seeded();
		const contended = contendedTwin(clean, CARTS_COLLECTION);
		await expectContention(createOrderFromCart(contended.createDeps, cmd(cartId)));

		const stranded = await clean.store.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the contended checkout must leave a durable order");
		expect((await clean.cartStore.get(cartId))?.state).toBe("active");

		const replay = await createOrderFromCart(clean.createDeps, cmd(cartId));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.order.id).toBe(stranded.id);
		const cartRow = await clean.cartStore.get(cartId);
		expect({ state: cartRow?.state, orderId: cartRow?.orderId }).toEqual({
			state: "checked_out",
			orderId: stranded.id,
		});
		expect(
			await Promise.all(reservationIdsOf(stranded).map((id) => clean.reservationState(id))),
		).toEqual(["adopted", "adopted"]);
	});

	test("a replay whose stranded hold was reaped is RESERVATION_LOST and expires the order at once — its adopted sibling released over real storage; the next replay answers the expired order", async () => {
		const { clean, cartId } = await seeded();
		const contended = contendedTwin(clean, INVENTORY_COLLECTION);
		await expectContention(createOrderFromCart(contended.createDeps, cmd(cartId)));
		const stranded = await clean.store.getByIdempotencyKey(KEY);
		if (stranded === null) throw new Error("the contended checkout must leave a durable order");
		const [first, second] = reservationIdsOf(stranded);
		if (first === undefined || second === undefined) throw new Error("two holds expected");
		// The cart sweep (or a line removal) reaps one hold while the order sits un-adopted.
		await clean.inventory.release(first);

		expect(await createOrderFromCart(clean.createDeps, cmd(cartId))).toEqual({
			ok: false,
			reason: "RESERVATION_LOST",
		});
		expect((await clean.store.getById(stranded.id))?.state).toBe("expired");
		expect(await clean.reservationState(second)).toBe("released");
		expect(await clean.onHand("SKU-A")).toBe(5);
		expect(await clean.onHand("SKU-B")).toBe(5);
		expect((await clean.cartStore.get(cartId))?.state).toBe("active");

		const again = await createOrderFromCart(clean.createDeps, cmd(cartId));
		expect(again.ok, JSON.stringify(again)).toBe(true);
		if (!again.ok) return;
		expect(again.order.state).toBe("expired");
		expect(again.intent.clientAction).toEqual({ kind: "none" });
	});
});
