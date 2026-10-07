import {
	createOrderFromCart,
	expireOrders,
	expireOrdersBatch,
	idempotencyKey,
	type Order,
} from "@otta-sh/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

// The order-expiry sweep runs inside a host hook with a hard timeout, so one call
// must be able to take a BOUNDED bite of the expirable backlog and report whether
// it finished. An unfinished bite is not a failure: every flip is guarded, so the
// next tick simply picks up the orders this one did not reach.
describe("bounded order expiry", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	async function pendingOrders(n: number): Promise<Order[]> {
		const orders: Order[] = [];
		for (let i = 1; i <= n; i++) {
			await h.seedPhysical({
				productId: `p${String(i)}`,
				sku: `SKU-${String(i)}`,
				priceCents: 1000,
				title: `Widget ${String(i)}`,
				onHand: 5,
			});
			const cartId = await h.cartWith([
				{ sku: `SKU-${String(i)}`, productId: `p${String(i)}`, qty: 1, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, {
				cartId,
				idempotencyKey: idempotencyKey(`k${String(i)}`),
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			});
			if (!res.ok) throw new Error(`seed order failed: ${res.reason}`);
			orders.push(res.order);
		}
		h.clock.advance(16 * 60 * 1000);
		return orders;
	}

	async function expiredCount(orders: readonly Order[]): Promise<number> {
		let n = 0;
		for (const order of orders) {
			if ((await h.orderStore.getById(order.id))?.state === "expired") n++;
		}
		return n;
	}

	test("a limit caps the orders attempted per call; the backlog drains over several calls", async () => {
		const orders = await pendingOrders(3);
		expect(await expireOrdersBatch(h.expireDeps, undefined, { limit: 2 })).toEqual({
			count: 2,
			drained: false,
		});
		expect(await expiredCount(orders)).toBe(2);
		expect(await expireOrdersBatch(h.expireDeps, undefined, { limit: 2 })).toEqual({
			count: 1,
			drained: true,
		});
		expect(await expiredCount(orders)).toBe(3);
		// Every adopted hold came back exactly once across the split.
		for (const i of [1, 2, 3]) expect(h.inventory.onHand(`SKU-${String(i)}`)).toBe(5);
	});

	test("shouldContinue is asked before every order, and a stop leaves the rest pending", async () => {
		const orders = await pendingOrders(3);
		let asked = 0;
		const result = await expireOrdersBatch(h.expireDeps, undefined, {
			shouldContinue: () => asked++ < 1,
		});
		expect(result).toEqual({ count: 1, drained: false });
		expect(await expiredCount(orders)).toBe(1);
	});

	test("expireOrders keeps its plain count, and an empty backlog is drained", async () => {
		await pendingOrders(2);
		expect(await expireOrders(h.expireDeps)).toBe(2);
		expect(await expireOrdersBatch(h.expireDeps)).toEqual({ count: 0, drained: true });
	});
	test("the LIST is bounded too: a limited call asks the store for one more than its limit", async () => {
		await pendingOrders(3);
		const listExpirable = vi.spyOn(h.orderStore, "listExpirable");
		expect(await expireOrdersBatch(h.expireDeps, undefined, { limit: 2 })).toEqual({
			count: 2,
			drained: false,
		});
		expect(listExpirable.mock.calls.map((call) => call[1])).toEqual([{ limit: 3 }]);
	});

	test("exactly `limit` due orders is drained, not reported as more-to-come", async () => {
		await pendingOrders(2);
		expect(await expireOrdersBatch(h.expireDeps, undefined, { limit: 2 })).toEqual({
			count: 2,
			drained: true,
		});
	});

	test("a non-positive or non-integer limit is refused loudly", async () => {
		const orders = await pendingOrders(1);
		for (const limit of [0, -3, Number.NaN, 2.5]) {
			await expect(expireOrdersBatch(h.expireDeps, undefined, { limit })).rejects.toThrow(
				RangeError,
			);
		}
		expect(await expiredCount(orders)).toBe(0);
	});
});
