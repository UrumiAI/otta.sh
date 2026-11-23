/** Pruning unpaid orders: orders that must be kept can never block it. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { updateOrder } from "../src/orders.js";
import { PRUNE_AFTER_DAYS, sweep } from "../src/sweep.js";
import { deliver, linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

const DAY = 86_400_000;

describe("prune", () => {
	it("25 kept orders older than a prunable one: the prunable one is still deleted", async () => {
		const s = await makeShop(nProducts(1, 100));
		const expire = async (n: number) => {
			await placeOrder({ key: orderKey(n), lines: linesFor(1) }, s.ctx);
			const cs = s.stripe.forOrder(orderKey(n))!;
			s.stripe.expire(cs.id);
			await deliver(s.ctx, await s.stripe.event("checkout.session.expired", cs.id));
		};
		for (let n = 1; n <= 25; n++) {
			await expire(n);
			// Kept forever: a note (as on an order released from review).
			await updateOrder(s.ctx, orderKey(n), (d) => ({ ...d, attention: "KEPT" }));
		}
		await expire(26);
		expect((await s.order(orderKey(26))).prunable).toBe(1);
		expect((await s.order(orderKey(1))).prunable).toBe(0);
		const r = await sweep(s.ctx, Date.now() + PRUNE_AFTER_DAYS * DAY + DAY);
		expect(r.pruned).toBe(1);
		expect(await s.raw("orders").get(orderKey(26))).toBeNull();
		expect(await s.raw("orders").get(orderKey(1))).not.toBeNull();
	});
	it("an order with a recorded payment is never prunable", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.complete(cs.id, { amount_total: 1 });
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		const { callRoute } = await import("./fixtures.js");
		await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" });
		const o = await s.order(orderKey(1));
		expect([o.status, o.prunable]).toEqual(["canceled", 0]);
	});
});
