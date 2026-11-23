/** Refunds made in Stripe are recorded on the order (re-read, never summed from events). */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { callRoute, deliver, linesFor, makeShop, nProducts, orderKey, WHSEC } from "./fixtures.js";

const enc = new TextEncoder();
async function signed(type: string, object: Record<string, unknown>) {
	const text = JSON.stringify({
		id: `evt_r${Math.random().toString(16).slice(2)}`,
		type,
		data: { object },
	});
	const t = Math.floor(Date.now() / 1000);
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(WHSEC),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${t}.${text}`)))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return { body: enc.encode(text), sig: `t=${t},v1=${sig}` };
}

/** A paid order, and a fake Stripe refunds list the test controls. */
async function paidShop() {
	const s = await makeShop(nProducts(1, 5));
	await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
	const cs = s.stripe.only();
	s.stripe.complete(cs.id);
	await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
	const o = await s.order(orderKey(1));
	const refunds: Array<{ id: string; amount: number; status: string; currency: string }> = [];
	let reads = 0;
	s.http.on("GET", "https://api.stripe.com/v1/refunds", () => {
		reads++;
		return { json: { object: "list", data: refunds, has_more: false } };
	});
	// Payments that are not Core's have no order_id metadata.
	s.http.on("GET", "https://api.stripe.com/v1/payment_intents/", (q) => ({
		json: { id: q.url.split("/").pop(), metadata: {} },
	}));
	return { s, o, pi: o.paymentIntentId!, refunds, reads: () => reads };
}
const refundEvent = (pi: string, type = "refund.created") =>
	signed(type, {
		object: "refund",
		id: "re_1",
		payment_intent: pi,
		amount: 1,
		status: "succeeded",
	});

describe("refunds made in Stripe", () => {
	it("a partial then a full refund are recorded; status and stock are unchanged", async () => {
		const { s, o, pi, refunds } = await paidShop();
		refunds.push({ id: "re_a", amount: 300, status: "succeeded", currency: "usd" });
		expect((await deliver(s.ctx, await refundEvent(pi))).json).toMatchObject({
			received: true,
			outcome: "recorded",
		});
		expect((await s.order(orderKey(1))).refundedAmount).toBe(300);
		refunds.push({ id: "re_b", amount: o.total - 300, status: "pending", currency: "usd" });
		await deliver(
			s.ctx,
			await signed("charge.refunded", {
				object: "charge",
				id: "ch_1",
				payment_intent: pi,
				amount_refunded: o.total,
			}),
		);
		const after = await s.order(orderKey(1));
		expect([after.status, after.refundedAmount]).toEqual(["paid", o.total]);
		expect((await s.stock("p1")).onHand).toBe(4);
		const pub = await callRoute(s.ctx, "order", { id: orderKey(1), key: o.orderKey });
		expect(pub.order.refundedAmount).toBe(o.total);
	});
	it("duplicates are no-ops, and a stale read (missing a newer refund) never drops it", async () => {
		const { s, pi, refunds } = await paidShop();
		refunds.push({ id: "re_a", amount: 300, status: "succeeded", currency: "usd" });
		const ev = await refundEvent(pi);
		await deliver(s.ctx, ev);
		expect((await deliver(s.ctx, ev)).json).toMatchObject({ outcome: "noop" });
		// A stale view (an older read landing after a newer write), on any event type.
		refunds.length = 0;
		await deliver(s.ctx, await refundEvent(pi, "refund.updated"));
		expect((await s.order(orderKey(1))).refundedAmount).toBe(300);
	});
	it("a refund that fails lowers the total", async () => {
		const { s, pi, refunds } = await paidShop();
		refunds.push({ id: "re_a", amount: 300, status: "pending", currency: "usd" });
		await deliver(s.ctx, await refundEvent(pi));
		refunds[0]!.status = "failed";
		await deliver(s.ctx, await refundEvent(pi, "refund.failed"));
		expect((await s.order(orderKey(1))).refundedAmount).toBe(0);
	});
	it("a failed refund and a new one, read out of order, total the new one", async () => {
		const { s, pi, refunds } = await paidShop();
		refunds.push({ id: "re_1", amount: 200, status: "pending", currency: "usd" });
		await deliver(s.ctx, await refundEvent(pi));
		// Y's read: R1 failed, R2 succeeded. X's read (older): R1 failed only.
		refunds[0]!.status = "failed";
		refunds.push({ id: "re_2", amount: 500, status: "succeeded", currency: "usd" });
		await deliver(s.ctx, await refundEvent(pi, "refund.created"));
		refunds.pop();
		await deliver(s.ctx, await refundEvent(pi, "refund.updated"));
		expect((await s.order(orderKey(1))).refundedAmount).toBe(500);
		// A failed refund stays failed even if a stale read still says pending.
		refunds[0]!.status = "pending";
		await deliver(s.ctx, await refundEvent(pi, "refund.updated"));
		expect((await s.order(orderKey(1))).refundedAmount).toBe(500);
	});
	it("a refund that beats the payment's webhook is retried (503), then recorded", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.complete(cs.id);
		const pi = `pi_${cs.id}`;
		s.http.on("GET", "https://api.stripe.com/v1/payment_intents/", {
			json: { id: pi, metadata: { order_id: orderKey(1) } },
		});
		s.http.on("GET", "https://api.stripe.com/v1/refunds", {
			json: {
				object: "list",
				data: [{ id: "re_1", amount: 300, status: "succeeded", currency: "usd" }],
				has_more: false,
			},
		});
		expect((await deliver(s.ctx, await refundEvent(pi))).status).toBe(503);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect((await deliver(s.ctx, await refundEvent(pi))).json).toMatchObject({
			outcome: "recorded",
		});
		expect((await s.order(orderKey(1))).refundedAmount).toBe(300);
	});
	it("more than 100 refunds: what was read is merged and the order is flagged", async () => {
		const { s, pi } = await paidShop();
		s.http.on("GET", "https://api.stripe.com/v1/refunds", {
			json: {
				object: "list",
				data: [{ id: "re_1", amount: 100, status: "succeeded", currency: "usd" }],
				has_more: true,
			},
		});
		await deliver(s.ctx, await refundEvent(pi));
		const o = await s.order(orderKey(1));
		expect([o.refundedAmount, o.attention]).toEqual([100, "REFUNDS_TRUNCATED"]);
	});
	it("a refund of a payment that is not a Core order is ignored (200)", async () => {
		const { s, reads } = await paidShop();
		const r = await deliver(s.ctx, await refundEvent("pi_somebody_else"));
		expect([r.status, r.json.outcome]).toEqual([200, "unknown_order"]);
		expect(reads()).toBe(0);
	});
	it("Stripe down while re-reading: 500 so Stripe retries", async () => {
		const { s, pi } = await paidShop();
		s.http.on("GET", "https://api.stripe.com/v1/refunds", {
			status: 503,
			json: { error: { message: "down" } },
		});
		expect((await deliver(s.ctx, await refundEvent(pi))).status).toBe(500);
		expect((await s.order(orderKey(1))).refundedAmount).toBeNull();
	});
	it("an unrelated event type is ignored", async () => {
		const { s } = await paidShop();
		const r = await deliver(
			s.ctx,
			await signed("customer.created", { object: "customer", id: "cus_1" }),
		);
		expect(r.status).toBe(200);
	});
});
