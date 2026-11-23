/**
 * Regression tests for the money path (stock moves, cancels, budgets)
 * (findings 1-10). Each test failed before its fix.
 */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import type { OrderDoc } from "../src/model.js";
import { completeStock, orders } from "../src/orders.js";
import { applySession } from "../src/settle.js";
import { applyStock } from "../src/stock.js";
import { sweep } from "../src/sweep.js";
import {
	callRoute,
	deliver,
	linesFor,
	makeShop,
	nProducts,
	orderKey,
	publish,
} from "./fixtures.js";

const MIN = 60_000;

describe("the expiry sweep cannot be blocked by unreachable sessions", () => {
	it("moves unreachable sessions to review and still expires the next order", async () => {
		const s = await makeShop(nProducts(1, 10));
		for (let i = 1; i <= 3; i++)
			expect((await placeOrder({ key: orderKey(i), lines: linesFor(1) }, s.ctx)).ok).toBe(true);
		const cs3 = s.stripe.forOrder(orderKey(3))!.id;
		s.stripe.expire(cs3);
		// The merchant switched Stripe accounts: sessions 1 and 2 are now unknown (404).
		for (const i of [1, 2]) s.stripe.sessions.delete(s.stripe.forOrder(orderKey(i))!.id);
		for (let k = 0; k < 3; k++) await sweep(s.ctx, Date.now() + 60 * MIN + k);
		const o3 = await s.order(orderKey(3));
		expect([o3.status, o3.stock]).toEqual(["expired", "released"]);
		for (const i of [1, 2]) {
			const o = await s.order(orderKey(i));
			expect(o.status).toBe("review");
			expect(o.attention).toMatch(/^SESSION_UNREACHABLE/);
		}
	});
});

async function reviewOrder() {
	const s = await makeShop(nProducts(1, 3));
	await placeOrder({ key: orderKey(1), lines: linesFor(1, 2) }, s.ctx);
	const cs = s.stripe.only();
	s.stripe.complete(cs.id, { amount_total: 1 }); // wrong amount
	expect(
		(await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id))).status,
	).toBe(200);
	expect((await s.order(orderKey(1))).status).toBe("review");
	return s;
}

describe("orders held for review can be resolved", () => {
	it("lists review orders", async () => {
		const s = await reviewOrder();
		const r = await callRoute(s.ctx, "orders/list", { status: "review" });
		expect(r.ok).toBe(true);
		expect(r.orders.map((o: { id: string }) => o.id)).toEqual([orderKey(1)]);
	});
	it("release: canceled, hold returned", async () => {
		const s = await reviewOrder();
		const r = await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" });
		expect(r.ok).toBe(true);
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock, o.stockPending]).toEqual(["canceled", "released", 0]);
		const st = await s.stock("p1");
		expect([st.onHand, st.holds]).toEqual([3, {}]);
	});
	it("accept: paid, stock committed once", async () => {
		const s = await reviewOrder();
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "accept" })).ok,
		).toBe(true);
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "accept" })).ok,
		).toBe(true);
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock]).toEqual(["paid", "committed"]);
		const st = await s.stock("p1");
		expect([st.onHand, st.holds]).toEqual([1, {}]);
	});
	it("refuses to resolve an order that is not in review", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const r = await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" });
		expect(r.ok).toBe(false);
	});
});

describe("a replayed commit never sells twice, however old", () => {
	it("survives eviction of every op record on the product", async () => {
		const s = await makeShop(nProducts(1, 300));
		const A = orderKey(1);
		expect((await applyStock(s.ctx, "p1", { kind: "reserve", orderId: A, qty: 1 })).ok).toBe(true);
		expect((await applyStock(s.ctx, "p1", { kind: "commit", orderId: A, qty: 1 })).ok).toBe(true);
		for (let i = 0; i < 260; i++) {
			const B = orderKey(1000 + i);
			await applyStock(s.ctx, "p1", { kind: "reserve", orderId: B, qty: 1 });
			await applyStock(s.ctx, "p1", { kind: "release", orderId: B });
		}
		const before = (await s.stock("p1")).onHand;
		await applyStock(s.ctx, "p1", { kind: "commit", orderId: A, qty: 1 });
		expect((await s.stock("p1")).onHand).toBe(before);
	});
});

describe("product sync cannot reset sold stock after a crash", () => {
	it("a crash between the stock write and the product write, then a title edit", async () => {
		const s = await makeShop([{ id: "p1", price: 10, stock: 5 }]);
		s.failAt(5); // settings, product get, stock read, stock CAS, PRODUCT PUT <- dies here
		await publish(s.ctx, { id: "p1", price: 10, stock: 10 });
		s.failAt(null);
		expect((await s.stock("p1")).onHand).toBe(10);
		// 3 units sell.
		await applyStock(s.ctx, "p1", { kind: "reserve", orderId: orderKey(7), qty: 3 });
		await applyStock(s.ctx, "p1", { kind: "commit", orderId: orderKey(7), qty: 3 });
		// The editor fixes a typo; the stock field still says 10.
		await publish(s.ctx, { id: "p1", price: 10, stock: 10, title: "Fixed title" });
		expect((await s.stock("p1")).onHand).toBe(7);
	});
	it("a real change of the stock field still applies", async () => {
		const s = await makeShop([{ id: "p1", price: 10, stock: 5 }]);
		await publish(s.ctx, { id: "p1", price: 10, stock: 12 });
		expect((await s.stock("p1")).onHand).toBe(12);
	});
});

describe("cancel paths stay inside the 30-call budget", () => {
	it("8 lines, the last out of stock", async () => {
		const s = await makeShop([...nProducts(7, 5), { id: "p8", price: 10, stock: 0 }]);
		s.resetCalls();
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
		expect(s.calls().total).toBeLessThanOrEqual(30);
		for (let k = 0; k < 2; k++) await sweep(s.ctx, Date.now() + 5 * MIN + k);
		for (const st of await s.allStock()) expect(st.holds).toEqual({});
	});
	it("8 lines, Stripe refuses", async () => {
		const s = await makeShop(nProducts(8, 5));
		s.stripe.failNextCreate(400);
		s.resetCalls();
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		expect(r.ok).toBe(false);
		expect(s.calls().total).toBeLessThanOrEqual(30);
		for (let k = 0; k < 2; k++) await sweep(s.ctx, Date.now() + 5 * MIN + k);
		for (const st of await s.allStock()) expect(st.holds).toEqual({});
		expect((await s.order(orderKey(1))).status).toBe("canceled");
	});
	it("a sweep that cancels a stale 8-line order stays inside the budget", async () => {
		const s = await makeShop(nProducts(8, 5));
		s.stripe.failNextCreate(500);
		await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		s.stripe.failNextCreate(400);
		s.resetCalls();
		await sweep(s.ctx, Date.now() + 3 * MIN);
		expect(s.calls().total).toBeLessThanOrEqual(30);
		for (let k = 0; k < 3; k++) await sweep(s.ctx, Date.now() + 5 * MIN + k);
		for (const st of await s.allStock()) expect(st.holds).toEqual({});
	});
});

describe("a release tombstones the order on that product", () => {
	it("a stale reserve after a release does not leak a hold", async () => {
		const s = await makeShop(nProducts(1, 5));
		const A = orderKey(1);
		await applyStock(s.ctx, "p1", { kind: "release", orderId: A });
		await applyStock(s.ctx, "p1", { kind: "reserve", orderId: A, qty: 1 });
		expect((await s.stock("p1")).holds).toEqual({});
	});
});

describe("an order whose first Stripe call failed cannot hold stock for long", () => {
	it("sweep cancels a reserving order once its session window has passed", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.stripe.failNextCreate(500);
		expect((await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).ok).toBe(false);
		// Stripe keeps answering 500 for this idempotency key.
		for (let i = 0; i < 5; i++) s.stripe.failNextCreate(500);
		for (let k = 0; k < 3; k++) await sweep(s.ctx, Date.now() + 90 * MIN + k);
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock]).toEqual(["canceled", "released"]);
		expect((await s.stock("p1")).holds).toEqual({});
	});
});

describe("idempotency conflicts and settings changes do not cancel a live checkout", () => {
	it("409 idempotency_key_in_use is retryable, not a refusal", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.stripe.failNextCreate(409);
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "PAYMENT_UNAVAILABLE" });
		expect((await s.order(orderKey(1))).status).toBe("pending");
		expect((await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).ok).toBe(true);
	});
	it("a replay after the merchant edits the URLs sends identical Stripe params", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.stripe.failNextCreate(500);
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.kv.seedSettings({ successUrl: "/thanks", cancelUrl: "/shop", shippingCountries: "US,CA" });
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const [a, b] = s.stripe.creates;
		expect(b!.params.toString()).toBe(a!.params.toString());
	});
});

describe("a late payment of the wrong amount goes to review", () => {
	it("PAID_WHILE_EXPIRED with a mismatched amount settles nothing", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.expire(cs.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.expired", cs.id));
		const late = {
			...cs,
			status: "complete" as const,
			payment_status: "paid" as const,
			amount_total: 1,
		};
		s.stripe.sessions.set(cs.id, late);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		const o = await s.order(orderKey(1));
		expect(o.status).toBe("review");
		expect((await s.stock("p1")).onHand).toBe(5);
	});
	it("a late payment of the right amount is a sale, taken once", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.expire(cs.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.expired", cs.id));
		s.stripe.sessions.set(cs.id, { ...cs, status: "complete", payment_status: "paid" });
		const ev = await s.stripe.event("checkout.session.completed", cs.id);
		await deliver(s.ctx, ev);
		await deliver(s.ctx, ev);
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock]).toEqual(["paid", "committed"]);
		expect((await s.stock("p1")).onHand).toBe(4);
		// and replaying completion after every op record is evicted still takes it once
		const cur = await orders(s.ctx).getVersioned(orderKey(1));
		await completeStock(s.ctx, orderKey(1), {
			value: { ...(cur!.value as OrderDoc), stock: "committing" },
			revision: cur!.revision,
		});
		expect((await s.stock("p1")).onHand).toBe(4);
	});
});

describe("applySession input guard", () => {
	it("unknown order is reported, not thrown", async () => {
		const s = await makeShop(nProducts(1, 1));
		const r = await applySession(s.ctx, {
			id: "cs_x",
			url: null,
			status: "complete",
			paymentStatus: "paid",
			amountTotal: 1,
			amountSubtotal: null,
			amountDiscount: null,
			amountShipping: null,
			amountTax: null,
			currency: "USD",
			paymentIntentId: null,
			email: null,
			shippingAddress: null,
			orderId: orderKey(99),
			expiresAt: 1,
		});
		expect(r).toBe("unknown_order");
	});
});
