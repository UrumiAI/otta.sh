/** The buyer's checkout/release route: sweep part B's path, early, and nothing else. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import plugin from "../src/plugin.js";
import { linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

const release = (
	s: { ctx: unknown },
	key: string,
	headers: Record<string, string> = { "x-otta-checkout": "1" },
) =>
	(plugin.routes as Record<string, { handler: (r: unknown, c: unknown) => Promise<any> }>)[
		"checkout/release"
	]!.handler({ input: { key }, request: { headers } }, s.ctx);

describe("checkout/release", () => {
	it("an open session is expired through Stripe and its holds come back", async () => {
		const s = await makeShop(nProducts(1, 2));
		await placeOrder({ key: orderKey(1), lines: linesFor(1, 2) }, s.ctx);
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 2 });
		expect(await release(s, orderKey(1))).toEqual({ ok: true, released: true });
		expect((await s.stock("p1")).holds).toEqual({});
		expect(s.stripe.only().status).toBe("expired");
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock]).toEqual(["expired", "released"]);
		// The buyer's changed cart can now take the stock.
		expect((await placeOrder({ key: orderKey(2), lines: linesFor(1, 2) }, s.ctx)).ok).toBe(true);
	});
	it("paid meanwhile: the expire is refused, nothing is released, the payment settles", async () => {
		const s = await makeShop(nProducts(1, 2));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		expect(await release(s, orderKey(1))).toMatchObject({ ok: false, code: "NOT_RELEASABLE" });
		const o = await s.order(orderKey(1));
		expect(o.status).toBe("paid");
		expect((await s.stock("p1")).onHand).toBe(1);
	});
	it("a paid order is never touched", async () => {
		const s = await makeShop(nProducts(1, 2));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		const { deliver } = await import("./fixtures.js");
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		const before = s.http.requests.length;
		expect(await release(s, orderKey(1))).toMatchObject({ code: "NOT_RELEASABLE" });
		expect(s.http.requests.length).toBe(before);
		expect((await s.order(orderKey(1))).status).toBe("paid");
	});
	it("an order still being created (reserving, no session) is never released", async () => {
		const s = await makeShop(nProducts(1, 2));
		s.stripe.failNextCreate(503);
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect((await s.order(orderKey(1))).stock).toBe("reserving");
		expect(await release(s, orderKey(1))).toMatchObject({ code: "NOT_RELEASABLE" });
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
	});
	it("an unknown id costs one call and answers the same as a refused one", async () => {
		const s = await makeShop(nProducts(1, 2));
		s.resetCalls();
		expect(await release(s, orderKey(9))).toMatchObject({ ok: false, code: "NOT_RELEASABLE" });
		expect(s.calls().total).toBe(1);
		expect(await release(s, "not-an-id")).toMatchObject({ ok: false, code: "NOT_RELEASABLE" });
	});
	it("needs the storefront header; throttled per order", async () => {
		const s = await makeShop(nProducts(1, 2));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(await release(s, orderKey(1), {})).toMatchObject({ code: "BAD_REQUEST" });
		await s.ctx.kv.set(`chk:${orderKey(1)}`, Date.now());
		expect(await release(s, orderKey(1))).toMatchObject({ code: "NOT_RELEASABLE" });
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
	});
	it("at 8 tracked lines it stays within 30 calls", async () => {
		const s = await makeShop(nProducts(8, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		s.resetCalls();
		expect(await release(s, orderKey(1))).toEqual({ ok: true, released: true });
		expect(s.calls().total).toBeLessThanOrEqual(30);
	});
	it("settings refuse {ORDER_ID} in the cancel URL", async () => {
		const s = await makeShop(nProducts(1, 2));
		s.kv.seedSettings({ cancelUrl: "/cart?o={ORDER_ID}" });
		expect(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).toMatchObject({
			code: "NOT_CONFIGURED",
		});
	});
});
