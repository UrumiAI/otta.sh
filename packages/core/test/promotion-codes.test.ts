/** Stripe promotion codes (opt-in) and the amount check that goes with them. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import {
	callRoute,
	deliver,
	linesFor,
	makeShop,
	nProducts,
	orderKey,
	type Shop,
} from "./fixtures.js";

// One product at 10.00, flat shipping from makeShop's default.
async function promoShop(
	on = true,
): Promise<Shop & { total: number; subtotal: number; shipping: number }> {
	const s = await makeShop(nProducts(1, 5));
	s.kv.seedSettings({ allowPromotionCodes: on });
	expect((await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).ok).toBe(true);
	const o = await s.order(orderKey(1));
	return Object.assign(s, { total: o.total, subtotal: o.subtotal, shipping: o.shipping });
}
async function pay(s: Shop, over: Record<string, unknown>) {
	const cs = s.stripe.only();
	s.stripe.complete(cs.id, over);
	return deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
}
const details = (discount: number, shipping: number, tax = 0) => ({
	amount_discount: discount,
	amount_shipping: shipping,
	amount_tax: tax,
});

describe("promotion codes", () => {
	it("on: the session is created with allow_promotion_codes", async () => {
		const s = await promoShop(true);
		const body = s.http.requests.find((r) => r.method === "POST")!.body;
		expect(new URLSearchParams(body).get("allow_promotion_codes")).toBe("true");
	});
	it("off (default): not sent, and a discounted payment is a mismatch (review)", async () => {
		const s = await promoShop(false);
		expect(
			new URLSearchParams(s.http.requests.find((r) => r.method === "POST")!.body).has(
				"allow_promotion_codes",
			),
		).toBe(false);
		await pay(s, {
			amount_subtotal: s.subtotal,
			amount_total: s.total - 300,
			total_details: details(300, s.shipping),
		});
		expect((await s.order(orderKey(1))).status).toBe("review");
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
	});
	it("on: a valid discount settles, and the discount and amount paid are recorded", async () => {
		const s = await promoShop(true);
		await pay(s, {
			amount_subtotal: s.subtotal,
			amount_total: s.total - 300,
			total_details: details(300, s.shipping),
		});
		const o = await s.order(orderKey(1));
		expect([o.status, o.discount, o.amountPaid]).toEqual(["paid", 300, s.total - 300]);
		expect((await s.stock("p1")).onHand).toBe(4);
		const pub = await callRoute(s.ctx, "order", { id: orderKey(1), key: o.orderKey });
		expect(pub.order).toMatchObject({ status: "paid", discount: 300, amountPaid: s.total - 300 });
	});
	it("on: the subtotal Stripe charged must be ours", async () => {
		const s = await promoShop(true);
		await pay(s, {
			amount_subtotal: s.subtotal - 1,
			amount_total: s.total - 301,
			total_details: details(300, s.shipping),
		});
		expect((await s.order(orderKey(1))).status).toBe("review");
	});
	it("on: the arithmetic must hold", async () => {
		const s = await promoShop(true);
		await pay(s, {
			amount_subtotal: s.subtotal,
			amount_total: s.total - 100,
			total_details: details(300, s.shipping),
		});
		expect((await s.order(orderKey(1))).status).toBe("review");
	});
	it("on: tax or a different shipping amount is a mismatch", async () => {
		const a = await promoShop(true);
		await pay(a, {
			amount_subtotal: a.subtotal,
			amount_total: a.total + 50,
			total_details: details(0, a.shipping, 50),
		});
		expect((await a.order(orderKey(1))).status).toBe("review");
		const b = await promoShop(true);
		await pay(b, {
			amount_subtotal: b.subtotal,
			amount_total: b.subtotal,
			total_details: details(0, 0),
		});
		if (b.shipping !== 0) expect((await b.order(orderKey(1))).status).toBe("review");
	});
	it("on: a fully discounted session (no_payment_required, total 0) settles as paid", async () => {
		const s = await promoShop(true);
		await pay(s, {
			payment_status: "no_payment_required",
			payment_intent: null,
			amount_subtotal: s.subtotal,
			amount_total: 0,
			total_details: details(s.total, s.shipping),
		});
		const o = await s.order(orderKey(1));
		expect([o.status, o.amountPaid, o.discount]).toEqual(["paid", 0, s.total]);
		expect((await s.stock("p1")).onHand).toBe(4);
	});
	it("off: a no_payment_required session never settles an order", async () => {
		const s = await promoShop(false);
		await pay(s, { payment_status: "no_payment_required", payment_intent: null, amount_total: 0 });
		expect((await s.order(orderKey(1))).status).toBe("pending");
	});
	it("a fully discounted payment released from review is never reopened by a redelivery", async () => {
		const s = await promoShop(true);
		const bad = {
			payment_status: "no_payment_required",
			payment_intent: null,
			amount_subtotal: s.subtotal,
			amount_total: 0,
			total_details: details(s.total - 1, s.shipping),
		};
		const r1 = await pay(s, bad);
		expect(r1.status).toBe(200);
		expect((await s.order(orderKey(1))).status).toBe("review");
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" })).ok,
		).toBe(true);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		expect((await s.order(orderKey(1))).status).toBe("canceled");
		expect((await s.stock("p1")).onHand).toBe(5);
	});
	it("the order keeps the rules it was created with when the setting changes", async () => {
		const s = await promoShop(true);
		s.kv.seedSettings({ allowPromotionCodes: false });
		await pay(s, {
			amount_subtotal: s.subtotal,
			amount_total: s.total - 300,
			total_details: details(300, s.shipping),
		});
		expect((await s.order(orderKey(1))).status).toBe("paid");
	});
});

describe("real Stripe shapes from a test-mode run", () => {
	it("a 100%-off session reported as paid with total 0 and no PaymentIntent settles as paid", async () => {
		const s = await promoShop(true);
		await pay(s, {
			payment_status: "paid",
			payment_intent: null,
			amount_subtotal: s.subtotal,
			amount_total: 0,
			total_details: details(s.total, s.shipping),
		});
		const o = await s.order(orderKey(1));
		expect([o.status, o.amountPaid, o.discount, o.paymentIntentId]).toEqual([
			"paid",
			0,
			s.total,
			null,
		]);
		expect((await s.stock("p1")).onHand).toBe(4);
	});
	it("a paid session at total 0 on an order WITHOUT promo codes is a mismatch", async () => {
		const s = await promoShop(false);
		await pay(s, { payment_status: "paid", payment_intent: null, amount_total: 0 });
		expect((await s.order(orderKey(1))).status).toBe("review");
	});
	it("a real 20% coupon shape (shipping not discounted) settles with the discount recorded", async () => {
		const s = await promoShop(true);
		const disc = Math.round(s.subtotal * 0.2);
		await pay(s, {
			amount_subtotal: s.subtotal,
			amount_total: s.total - disc,
			total_details: details(disc, s.shipping),
		});
		expect(await s.order(orderKey(1))).toMatchObject({
			status: "paid",
			discount: disc,
			amountPaid: s.total - disc,
		});
	});
});
