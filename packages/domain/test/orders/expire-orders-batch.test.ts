import {
	createOrderFromCart,
	expireOrders,
	expireOrdersBatch,
	idempotencyKey,
	UnitBackoff,
	type Order,
} from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
	afterEach(() => {
		vi.restoreAllMocks();
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

	test("orders whose flip always fails cannot starve the orders behind them: they back off (review round 3, B I4)", async () => {
		// Reviewer B's repro (S8): with a bite of 2 and two poisoned orders at the head
		// of the list, every run spent its bite on them and the third order's stock
		// stayed held forever. With a back-off, a failed order waits its turn and the
		// list reads past it.
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = await pendingOrders(3);
		const real = h.orderStore.expireWithOrder.bind(h.orderStore);
		const poisoned = new Set([orders[0]?.id, orders[1]?.id]);
		const flip = vi.spyOn(h.orderStore, "expireWithOrder").mockImplementation(async (id, now) => {
			if (poisoned.has(id)) throw new Error("poisoned order");
			return real(id, now);
		});
		const list = vi.spyOn(h.orderStore, "listExpirable");
		const backoff = new UnitBackoff();
		const runs = [];
		for (let i = 0; i < 3; i++) {
			runs.push(await expireOrdersBatch(h.expireDeps, undefined, { limit: 2, backoff }));
		}
		expect(runs[0]).toEqual({ count: 0, drained: false });
		expect(runs[1]).toEqual({ count: 1, drained: true });
		expect((await h.orderStore.getById(orders[2]?.id ?? ("" as never)))?.state).toBe("expired");
		expect(h.inventory.onHand("SKU-3")).toBe(5);
		// Each run is ONE list call; it reads past the waiting orders instead of
		// spending a query per skipped one.
		expect(list).toHaveBeenCalledTimes(3);
		expect(list.mock.calls[1]?.[1]).toMatchObject({ limit: 2 + 1 + 2 });
		// The poisoned orders were tried once each, then waited.
		expect(flip.mock.calls.filter(([id]) => poisoned.has(id))).toHaveLength(2);

		// Once the back-off has passed they are tried again, and expire if healed.
		poisoned.clear();
		h.clock.advance(UnitBackoff.DEFAULT_BASE_MS);
		expect(await expireOrdersBatch(h.expireDeps, undefined, { limit: 2, backoff })).toEqual({
			count: 2,
			drained: true,
		});
		expect(await expiredCount(orders)).toBe(3);
		expect(backoff.size).toBe(0);
		error.mockRestore();
	});

	/**
	 * Ticks (one a minute) until the one good order behind `failing` orders whose
	 * flip throws every time is expired, or `null` if it is not within `ticks`. The
	 * back-off's cap is sized as the plugin's expiry leg sizes it: the rows its one
	 * 100-row look can read past, `100 - (limit + 1)`.
	 */
	async function ticksToReachGoodOrder(
		failing: number,
		limit: number,
		cap: number,
		ticks: number,
	): Promise<number | null> {
		const orders = await pendingOrders(failing + 1);
		const good = orders[failing]?.id;
		const real = h.orderStore.expireWithOrder.bind(h.orderStore);
		vi.spyOn(h.orderStore, "expireWithOrder").mockImplementation(async (id, now) => {
			if (id !== good) throw new Error("poisoned order");
			return real(id, now);
		});
		const backoff = new UnitBackoff();
		backoff.setMaxEntries(cap);
		for (let tick = 1; tick <= ticks; tick++) {
			await expireOrdersBatch(h.expireDeps, undefined, { limit, backoff });
			if ((await h.orderStore.getById(good ?? ("" as never)))?.state === "expired") return tick;
			h.clock.advance(60_000);
		}
		return null;
	}

	test("33 always-failing orders at a bite of 1 no longer starve the order behind them (polish P-3)", async () => {
		// Reviewer's simulation: with the old fixed cap of 32, the 33rd failing order
		// evicted a waiting one every tick, so a failing order held the bite forever.
		// Sized to the look's page (98 at a bite of 1), the good order is reached.
		// Measured: tick 119 (each failing order is retried at most once an hour).
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await ticksToReachGoodOrder(33, 1, 100 - (1 + 1), 600)).toBeLessThanOrEqual(130);
	}, 60_000);

	test("50 always-failing orders at the Paid bite of 18 no longer starve the order behind them (polish P-3)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		// Measured: tick 3 (sized cap 81; with the old cap of 32 it never was).
		expect(await ticksToReachGoodOrder(50, 18, 100 - (18 + 1), 600)).toBeLessThanOrEqual(10);
	}, 60_000);

	test("the documented bound: past about 60 × the bite always-failing orders, the rest still starve (polish P-3)", async () => {
		// Each failing order is retried at most once an hour; at one tick a minute a
		// bite of 1 has room for fewer than 60 such retries an hour. Pinned so the
		// docs' bound stays true; 59 is reached (tick 375 measured), 60 is not. If this
		// starts failing because the good order IS reached, raise the documented bound.
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await ticksToReachGoodOrder(60, 1, 100 - (1 + 1), 600)).toBeNull();
	}, 60_000);

	test("a pre-listed `due` set skips the orders still backing off", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = await pendingOrders(2);
		const ids = orders.map((o) => o.id);
		const backoff = new UnitBackoff();
		backoff.failed(ids[0] ?? ("" as never), h.clock.now().getTime());
		expect(
			await expireOrdersBatch(h.expireDeps, undefined, { limit: 1, due: ids, backoff }),
		).toEqual({ count: 1, drained: true });
		expect((await h.orderStore.getById(ids[0] ?? ("" as never)))?.state).toBe("pending");
		expect((await h.orderStore.getById(ids[1] ?? ("" as never)))?.state).toBe("expired");
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	test("an error that stops the whole batch (the sweep's query ceiling) is rethrown, not logged as one order's failure (review round 3, A I2)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = await pendingOrders(2);
		const ceiling = Object.assign(new Error("tick query ceiling reached"), {
			name: "SweepQueryCeilingError",
		});
		vi.spyOn(h.orderStore, "expireWithOrder").mockRejectedValueOnce(ceiling);
		const backoff = new UnitBackoff();
		await expect(
			expireOrdersBatch(h.expireDeps, undefined, {
				backoff,
				stopsBatch: (err) => err instanceof Error && err.name === "SweepQueryCeilingError",
			}),
		).rejects.toBe(ceiling);
		expect(error).not.toHaveBeenCalled();
		expect(backoff.size).toBe(0);
		expect(await expiredCount(orders)).toBe(0);

		// A stop raised by a release is rethrown too.
		// (The in-memory store leaves the release to the use-case: `holdsReleased: false`.)
		vi.spyOn(h.inventory, "releaseAdoptedMany").mockRejectedValueOnce(ceiling);
		await expect(
			expireOrdersBatch(h.expireDeps, undefined, {
				stopsBatch: (err) => err instanceof Error && err.name === "SweepQueryCeilingError",
			}),
		).rejects.toBe(ceiling);
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	test("a unit failure logs the error's name, code and a short message with quoted values removed (review round 3, B I5)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await pendingOrders(1);
		const leaky = Object.assign(
			new Error(
				`duplicate key value "victim.person@example.com" violates 'orders_pkey' for ${"x".repeat(400)}`,
			),
			{ name: "DatabaseError", code: "23505" },
		);
		vi.spyOn(h.orderStore, "expireWithOrder").mockRejectedValueOnce(leaky);
		await expireOrdersBatch(h.expireDeps);
		expect(error).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(error.mock.calls[0]);
		expect(logged).toMatch(/DatabaseError/);
		expect(logged).toMatch(/23505/);
		expect(logged).toMatch(/duplicate key value/);
		expect(logged).not.toMatch(/victim|example\.com|orders_pkey/);
		expect(logged).not.toMatch(/x{200}/);
		error.mockRestore();
	});

	test("a stop raised by the coupon release is rethrown too (review round 3 polish, P-2)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await pendingOrders(1);
		const ceiling = Object.assign(new Error("tick query ceiling reached"), {
			name: "SweepQueryCeilingError",
		});
		// The order carried a coupon, so its expiry releases the redemption.
		const real = h.orderStore.expireWithOrder.bind(h.orderStore);
		vi.spyOn(h.orderStore, "expireWithOrder").mockImplementation(async (id, now) => {
			const won = await real(id, now);
			if (won === null) return null;
			const totals = { ...won.order.totals, appliedCouponCode: "SAVE10" as never };
			return { ...won, order: { ...won.order, totals } };
		});
		const release = vi.spyOn(h.couponStore, "releaseByOrder").mockRejectedValueOnce(ceiling);
		await expect(
			expireOrdersBatch(h.expireDeps, undefined, {
				stopsBatch: (err) => err instanceof Error && err.name === "SweepQueryCeilingError",
			}),
		).rejects.toBe(ceiling);
		expect(release).toHaveBeenCalledTimes(1);
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	test("an email outside quotes is redacted from the log line (review round 3 polish, P-2)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await pendingOrders(1);
		vi.spyOn(h.orderStore, "expireWithOrder").mockRejectedValueOnce(
			new Error("insert failed for victim.person@example.com on orders"),
		);
		await expireOrdersBatch(h.expireDeps);
		const logged = JSON.stringify(error.mock.calls[0]);
		expect(logged).toMatch(/insert failed for <value> on orders/);
		expect(logged).not.toMatch(/victim|example\.com/);
		error.mockRestore();
	});

	test("an unclosed quote is redacted to the end of the message (review round 3 polish, P-1)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await pendingOrders(1);
		vi.spyOn(h.orderStore, "expireWithOrder").mockRejectedValueOnce(
			new Error('bad value "jane.doe-secret-without-closing-quote'),
		);
		await expireOrdersBatch(h.expireDeps);
		const logged = JSON.stringify(error.mock.calls[0]);
		expect(logged).toMatch(/bad value <value>/);
		expect(logged).not.toMatch(/jane|secret/);
		error.mockRestore();
	});

	test("a 100k-character message with no spaces is scrubbed in linear time, and redacted (review round 3 polish, P-1)", async () => {
		// The email pattern backtracked quadratically on a long run with no space, `@`
		// or `<>`, over the WHOLE message (100k characters took 13 s). The message is
		// now cut to about 1 KB first and the pattern's repeats are bounded.
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await pendingOrders(3);
		const messages = [
			"a".repeat(100_000),
			`${"a".repeat(300)}victim@example.com${"b".repeat(100_000)}`,
			`value "${"s".repeat(100_000)}`,
		];
		const flip = vi.spyOn(h.orderStore, "expireWithOrder");
		for (const message of messages) flip.mockRejectedValueOnce(new Error(message));
		const started = performance.now();
		await expireOrdersBatch(h.expireDeps);
		const elapsed = performance.now() - started;
		expect(elapsed, `${elapsed.toFixed(1)} ms`).toBeLessThan(50);
		expect(error).toHaveBeenCalledTimes(3);
		const logged = error.mock.calls.map((call) => JSON.stringify(call));
		for (const line of logged) expect(line.length).toBeLessThan(600);
		expect(logged[1]).not.toMatch(/victim|example\.com/);
		expect(logged[2]).toMatch(/value <value>/);
		expect(logged[2]).not.toMatch(/sss/);
		error.mockRestore();
	});
});
