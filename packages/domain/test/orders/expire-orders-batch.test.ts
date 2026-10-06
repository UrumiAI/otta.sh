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

	// Review round 2, A R2-A1: one order whose release throws (a legacy hold the
	// store cannot address, say) must neither end the batch nor strand the holds of
	// the orders after it. Each order is its own unit; its failure is logged.
	test("a release that throws for one order: that order stays expired, the rest of the batch still runs", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = await pendingOrders(3);
		const release = vi.spyOn(h.inventory, "releaseAdoptedMany");
		release.mockRejectedValueOnce(new Error("storage refused"));
		const result = await expireOrdersBatch(h.expireDeps);
		// The flip is durable, so the failed order still counts as expired.
		expect(result).toEqual({ count: 3, drained: true });
		expect(await expiredCount(orders)).toBe(3);
		expect(release).toHaveBeenCalledTimes(3);
		// The orders after the failing one had their holds returned.
		expect(h.inventory.onHand("SKU-2")).toBe(5);
		expect(h.inventory.onHand("SKU-3")).toBe(5);
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toMatch(/releasing the holds of expired order/);
		error.mockRestore();
	});

	test("a flip that throws for one order: it stays pending for the next run, the rest still expire", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = await pendingOrders(3);
		const flip = vi.spyOn(h.orderStore, "expireWithOrder");
		flip.mockRejectedValueOnce(new Error("storage down"));
		const result = await expireOrdersBatch(h.expireDeps);
		expect(result).toEqual({ count: 2, drained: true });
		expect(await expiredCount(orders)).toBe(2);
		expect((await h.orderStore.getById(orders[0]?.id ?? ("" as never)))?.state).toBe("pending");
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toMatch(/expiring order/);
		error.mockRestore();
		// The next run picks it up.
		expect(await expireOrdersBatch(h.expireDeps)).toEqual({ count: 1, drained: true });
		expect(h.inventory.onHand("SKU-1")).toBe(5);
	});
});
