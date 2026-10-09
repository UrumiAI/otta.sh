/**
 * `replaceSpentCart` — the replacement for a cart that has become a FINISHED
 * order. The rule is the storefront's (cart-rotation.ts) enforced where it cannot
 * be skipped: the cart must be checked out, and the order it became must no longer
 * be `pending` — a pending order's payment may still happen, and its cart is how
 * the shopper resumes it. The key is derived here; no caller ever supplies one.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	replaceSpentCart,
	type CreateOrderInput,
} from "@otta-sh/domain";
import { CountingIdGen, InMemoryOrderStore } from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeFakeCartHarness, type FakeCartHarness } from "./fake-harness.js";

const USD = currency("USD");

let h: FakeCartHarness;
let orderStore: InMemoryOrderStore;

beforeEach(() => {
	h = makeFakeCartHarness();
	orderStore = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock: h.clock });
});

const deps = () => ({ ...h.deps, orderStore });

function orderFor(id: string, cartId: string): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId,
		currency: USD,
		idempotencyKey: idempotencyKey(`k-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [],
		totals: { subtotal: cents(0), total: cents(0), currency: USD },
	};
}

/** A cart checked out into an order, left in `state`. */
async function spent(
	tag: string,
	state: "pending" | "paid" | "expired",
	cartCurrency = USD,
): Promise<string> {
	const cartId = await h.cartStore.create(cartCurrency);
	const id = orderId(`ord-${tag}`);
	await orderStore.createFromCart(orderFor(`ord-${tag}`, cartId));
	if (state === "paid") await orderStore.markPaid(id);
	if (state === "expired") await orderStore.expire(id, "2099-01-01T00:00:00.000Z");
	await h.cartStore.checkout(cartId, id);
	return cartId;
}

describe("replaceSpentCart", () => {
	test("a PAID order's cart: one active replacement in its currency, however often (or concurrently) asked", async () => {
		const cartId = await spent("paid", "paid", currency("EUR"));
		const first = await replaceSpentCart(deps(), cartId);
		const again = await replaceSpentCart(deps(), cartId);
		expect(first.ok && again.ok).toBe(true);
		if (!first.ok || !again.ok) return;
		expect(again.cartId).toBe(first.cartId);
		expect(first.cartId).not.toBe(cartId);
		expect(await h.cartStore.get(first.cartId)).toMatchObject({ state: "active", currency: "EUR" });
		const racing = await Promise.all([
			replaceSpentCart(deps(), cartId),
			replaceSpentCart(deps(), cartId),
		]);
		expect(racing.map((r) => r.ok && r.cartId)).toEqual([first.cartId, first.cartId]);
	});

	test("an EXPIRED order's cart is spent too", async () => {
		const cartId = await spent("expired", "expired");
		expect((await replaceSpentCart(deps(), cartId)).ok).toBe(true);
	});

	test("a PENDING order's cart is refused ORDER_NOT_FINISHED — its payment may still happen", async () => {
		const cartId = await spent("pending", "pending");
		expect(await replaceSpentCart(deps(), cartId)).toEqual({
			ok: false,
			reason: "ORDER_NOT_FINISHED",
		});
	});

	test("a checked-out cart whose order cannot be found is refused ORDER_NOT_FINISHED — not knowing is not proof", async () => {
		const cartId = await h.cartStore.create(USD);
		await h.cartStore.checkout(cartId, orderId("ord-nowhere"));
		expect(await replaceSpentCart(deps(), cartId)).toEqual({
			ok: false,
			reason: "ORDER_NOT_FINISHED",
		});
	});

	test("an unknown cart is CART_NOT_FOUND; an active one CART_NOT_CHECKED_OUT", async () => {
		expect(await replaceSpentCart(deps(), "cart-never-minted")).toEqual({
			ok: false,
			reason: "CART_NOT_FOUND",
		});
		const active = await h.cartStore.create(USD);
		expect(await replaceSpentCart(deps(), active)).toEqual({
			ok: false,
			reason: "CART_NOT_CHECKED_OUT",
		});
	});

	// Store currency (Currency PR 2): the replacement's currency comes from an
	// optional resolver, called only once the spent cart has validated.
	test("a resolver's currency wins over the spent cart's; undefined keeps the spent cart's", async () => {
		const eurSpent = await spent("res-eur", "paid", currency("EUR"));
		const toGbp = await replaceSpentCart(deps(), eurSpent, async () => currency("GBP"));
		if (!toGbp.ok) throw new Error(toGbp.reason);
		expect((await h.cartStore.get(toGbp.cartId))?.currency).toBe("GBP");

		const usdSpent = await spent("res-none", "paid");
		const kept = await replaceSpentCart(deps(), usdSpent, async () => undefined);
		if (!kept.ok) throw new Error(kept.reason);
		expect((await h.cartStore.get(kept.cartId))?.currency).toBe("USD");
	});

	test("the resolver is never called for a refusal — a refusal stays typed even if it would throw", async () => {
		let calls = 0;
		const throwing = async (): Promise<never> => {
			calls += 1;
			throw new Error("settings unreadable");
		};
		expect(await replaceSpentCart(deps(), "no-such-cart", throwing)).toEqual({
			ok: false,
			reason: "CART_NOT_FOUND",
		});
		const active = await h.cartStore.create(USD);
		expect(await replaceSpentCart(deps(), active, throwing)).toEqual({
			ok: false,
			reason: "CART_NOT_CHECKED_OUT",
		});
		const pending = await spent("res-pending", "pending");
		expect(await replaceSpentCart(deps(), pending, throwing)).toEqual({
			ok: false,
			reason: "ORDER_NOT_FINISHED",
		});
		expect(calls).toBe(0);
	});

	test("racers converge on ONE replacement even when their resolvers answer different currencies", async () => {
		const cartId = await spent("res-race", "paid");
		const racing = await Promise.all([
			replaceSpentCart(deps(), cartId, async () => currency("EUR")),
			replaceSpentCart(deps(), cartId, async () => currency("JPY")),
			replaceSpentCart(deps(), cartId),
		]);
		const ids = racing.map((r) => (r.ok ? r.cartId : r.reason));
		expect(new Set(ids).size).toBe(1);
		// A later ask, whatever it resolves, gets that same cart.
		const later = await replaceSpentCart(deps(), cartId, async () => currency("GBP"));
		expect(later.ok && later.cartId).toBe(ids[0]);
	});
});
