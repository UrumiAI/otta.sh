/** With no webhook configured, the sweep records payments. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { sweep } from "../src/sweep.js";
import { linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

describe("sweep: payments recorded without a webhook", () => {
	it("a paid session is recorded by the next sweep, once", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		const r = await sweep(s.ctx);
		expect(r.paid).toBe(1);
		// Decided now; the stock is committed by the next run's part A.
		expect((await s.order(orderKey(1))).status).toBe("paid");
		expect((await s.order(orderKey(1))).stock).toBe("committing");
		expect((await sweep(s.ctx)).paid).toBe(0);
		expect((await s.stock("p1")).onHand).toBe(4);
		await sweep(s.ctx);
		expect((await s.stock("p1")).onHand).toBe(4);
	});
	it("open sessions are left alone", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		await sweep(s.ctx);
		expect((await s.order(orderKey(1))).status).toBe("pending");
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
	});
	it("a wrong amount still goes to review, not paid", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id, { amount_total: 1 });
		await sweep(s.ctx);
		expect((await s.order(orderKey(1))).status).toBe("review");
	});
	it("many paid orders: each run stays within 30 calls and all are recorded over a few runs", async () => {
		const s = await makeShop(nProducts(3, 50));
		for (let n = 1; n <= 6; n++) await placeOrder({ key: orderKey(n), lines: linesFor(3) }, s.ctx);
		for (const cs of s.stripe.sessions.values()) s.stripe.complete(cs.id);
		let runs = 0;
		while (runs < 10) {
			s.resetCalls();
			await sweep(s.ctx);
			expect(s.calls().total).toBeLessThanOrEqual(30);
			runs++;
			const left = (await Promise.all([1, 2, 3, 4, 5, 6].map((n) => s.order(orderKey(n))))).filter(
				(o) => o.status !== "paid",
			);
			if (left.length === 0) break;
		}
		expect(runs).toBeLessThan(10);
		await sweep(s.ctx); // part A commits what the payment pass decided
		expect((await s.stock("p1")).onHand).toBe(44);
	});
});

describe("sweep: window, paging and foreign sessions", () => {
	it("a session created 35 minutes before it is paid, no webhook: recorded by the next sweep", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		// Created 35 minutes ago (as seen by the sweep), paid just now.
		s.stripe.complete(cs.id);
		const r = await sweep(s.ctx, Date.now() + 35 * 60_000);
		expect(r.paid).toBe(1);
		expect((await s.order(orderKey(1))).status).toBe("paid");
	});
	it("a foreign session carrying our order id but another session id is never touched", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const ours = s.stripe.only();
		s.stripe.sessions.set("cs_foreign", {
			...ours,
			id: "cs_foreign",
			status: "complete",
			payment_status: "paid",
			payment_intent: "pi_foreign",
			created: ours.created,
		});
		await sweep(s.ctx);
		const o = await s.order(orderKey(1));
		expect([o.status, o.attention]).toEqual(["pending", null]);
	});
	it("more than one page of complete sessions: ours on page 2 is still found, and the position resets after a full pass", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const ours = s.stripe.only();
		s.stripe.complete(ours.id);
		// 150 newer completed sessions of another product on the same account.
		for (let i = 0; i < 150; i++)
			s.stripe.sessions.set(`cs_other_${i}`, {
				...ours,
				id: `cs_other_${i}`,
				status: "complete",
				payment_status: "paid",
				metadata: { order_id: "other" },
				created: (ours.created ?? 0) + 1 + i,
			});
		const r = await sweep(s.ctx);
		expect(r.paid).toBe(1);
		expect((await s.order(orderKey(1))).status).toBe("paid");
		expect(s.kv.dump()["settings:_scanAfter"] ?? "").toBe("");
	});
	it("a pass cut short by the budget carries its position to the next run", async () => {
		const s = await makeShop(nProducts(8, 50));
		// Six 8-line paid orders: each settle costs 2*8+4 = 20, so one per run fits.
		for (let n = 1; n <= 3; n++) await placeOrder({ key: orderKey(n), lines: linesFor(8) }, s.ctx);
		for (const cs of s.stripe.sessions.values()) s.stripe.complete(cs.id);
		let runs = 0;
		for (; runs < 8; runs++) {
			s.resetCalls();
			await sweep(s.ctx);
			expect(s.calls().total).toBeLessThanOrEqual(30);
			const open = (await Promise.all([1, 2, 3].map((n) => s.order(orderKey(n))))).filter(
				(o) => o.status !== "paid",
			);
			if (open.length === 0) break;
		}
		expect(runs).toBeLessThan(8);
		// Part A commits what the payment pass decided, one 8-line order per run.
		for (let k = 0; k < 5; k++) await sweep(s.ctx);
		expect((await s.stock("p1")).onHand).toBe(47);
	});
});
