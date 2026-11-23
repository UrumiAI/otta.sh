/** The sweep's capacity: large orders never stall expiry, and its cleanups run. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import plugin from "../src/plugin.js";
import { costA, LIMIT, sweep, UPKEEP_MIN } from "../src/sweep.js";
import { MAX_LINES, type OrderDoc } from "../src/model.js";
import { deliver, linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

const MIN = 60_000;

describe("expiry without a webhook", () => {
	it("an abandoned 8-line checkout is expired and its holds released", async () => {
		const s = await makeShop(nProducts(8, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		for (let k = 0; k < 4; k++) {
			s.resetCalls();
			await sweep(s.ctx, Date.now() + (45 + 5 * k) * MIN);
			expect(s.calls().total).toBeLessThanOrEqual(30);
		}
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock]).toEqual(["expired", "released"]);
		expect((await s.allStock()).every((d) => Object.keys(d.holds).length === 0)).toBe(true);
	});
	it("five 6-line orders ahead of a 1-line one: all are expired within a few runs", async () => {
		const s = await makeShop(nProducts(6, 50));
		for (let n = 1; n <= 5; n++) await placeOrder({ key: orderKey(n), lines: linesFor(6) }, s.ctx);
		await placeOrder({ key: orderKey(6), lines: linesFor(1) }, s.ctx);
		for (let k = 0; k < 10; k++) await sweep(s.ctx, Date.now() + (45 + 5 * k) * MIN);
		for (let n = 1; n <= 6; n++) expect((await s.order(orderKey(n))).status).toBe("expired");
		expect((await s.allStock()).every((d) => Object.keys(d.holds).length === 0)).toBe(true);
	});
});

describe("cleanups", () => {
	it("a decided order's lookup stamp is deleted", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		await s.ctx.kv.set(`chk:${orderKey(1)}`, Date.now());
		const cs = s.stripe.only();
		s.stripe.complete(cs.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect(`chk:${orderKey(1)}` in s.kv.dump()).toBe(false);
	});
	it("release counters from past windows are deleted by the sweep; the current one is kept", async () => {
		const s = await makeShop(nProducts(1, 5));
		const w = Math.floor(Date.now() / (10 * MIN));
		await s.ctx.kv.set(`rel:aaaa:${w - 2}`, 3);
		await s.ctx.kv.set(`rel:bbbb:${w}`, 1);
		await sweep(s.ctx);
		const kv = s.kv.dump();
		expect([`rel:aaaa:${w - 2}` in kv, `rel:bbbb:${w}` in kv]).toEqual([false, true]);
	});
});

describe("checkout/release per-buyer limit", () => {
	it("a buyer (public address) may release 3 checkouts per 10 minutes, then is refused", async () => {
		const s = await makeShop(nProducts(1, 50));
		const release = (key: string) =>
			(plugin.routes as Record<string, { handler: (r: unknown, c: unknown) => Promise<any> }>)[
				"checkout/release"
			]!.handler(
				{
					input: { key },
					request: { headers: { "x-otta-checkout": "1" } },
					requestMeta: { ip: "203.0.113.5" },
				},
				s.ctx,
			);
		// The route reads the ip from requestMeta on the route input.
		const results = [];
		for (let n = 1; n <= 4; n++) {
			await placeOrder({ key: orderKey(n), lines: linesFor(1) }, s.ctx);
			results.push((await release(orderKey(n))).ok);
		}
		expect(results).toEqual([true, true, true, false]);
	});
});

describe("a run busy with stock work", () => {
	it("still stamps its health, and every order is expired over a few runs", async () => {
		const s = await makeShop(nProducts(8, 500));
		for (let n = 1; n <= 12; n++)
			await placeOrder({ key: orderKey(n), lines: linesFor(n % 2 ? 8 : 1) }, s.ctx);
		let runs = 0;
		for (let k = 0; k < 40; k++, runs++) {
			const all = await Promise.all(Array.from({ length: 12 }, (_, i) => s.order(orderKey(i + 1))));
			if (all.every((o) => o.stock === "released")) break;
			await s.ctx.kv.delete("health:lastSweep");
			s.resetCalls();
			await sweep(s.ctx, Date.now() + (45 + 5 * k) * MIN);
			expect(s.calls().total).toBeLessThanOrEqual(30);
			expect(await s.ctx.kv.get("health:lastSweep")).toBeTruthy();
		}
		// 6 large and 6 small abandoned orders, no webhook: 16 runs measured.
		expect(runs).toBeLessThanOrEqual(24);
		for (let n = 1; n <= 12; n++) {
			const o = await s.order(orderKey(n));
			expect([o.status, o.stock]).toEqual(["expired", "released"]);
		}
	});
});

describe("part A's admission bound", () => {
	it("the largest order fits on its own while leaving upkeep (else it would never move)", () => {
		const items = Array.from({ length: MAX_LINES }, () => ({ trackStock: true }));
		const worst = costA({ items, stock: "reserving" } as unknown as OrderDoc);
		expect(2 + worst).toBeLessThanOrEqual(LIMIT - UPKEEP_MIN);
	});
});

describe("part A leaves upkeep", () => {
	it("releasing an 8-line and a 2-line order in one run still stamps the sweep's health", async () => {
		const s = await makeShop(nProducts(8, 50));
		await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		await placeOrder({ key: orderKey(2), lines: linesFor(2) }, s.ctx);
		await sweep(s.ctx, Date.now() + 45 * MIN); // B decides both: expired, releasing
		expect((await s.order(orderKey(1))).status).toBe("expired");
		expect((await s.order(orderKey(2))).status).toBe("expired");
		await s.ctx.kv.delete("health:lastSweep");
		s.resetCalls();
		await sweep(s.ctx, Date.now() + 50 * MIN); // A: 2 + 20 for the 8-line release
		expect(s.calls().total).toBeLessThanOrEqual(30);
		// Without the reserve, A would also admit the 2-line release (2 + 20 + 8 = 30):
		// no call left for B, prune or the stamp.
		expect(await s.ctx.kv.get("health:lastSweep")).toBeTruthy();
	});
});
