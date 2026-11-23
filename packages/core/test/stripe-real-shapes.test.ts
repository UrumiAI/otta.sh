/**
 * Real Stripe behaviour found in the test-mode run (run 7), pinned so the fake
 * can never drift from it again:
 *  - Since API 2026-09-30 Checkout refuses payment_method_types; Core sends
 *    allowed_payment_method_types, which FILTERS silently, so Core checks what
 *    Stripe will actually offer and never hands the buyer anything but card.
 *  - A 100%-off session is reported as paid, amount_total 0, no PaymentIntent.
 */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { applySession } from "../src/settle.js";
import { readHealth } from "../src/health.js";
import { callRoute, deliver, linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

/** The create parameters Stripe accepts at the pinned version, as Core uses them. */
const ALLOWED_CREATE_PARAMS = new Set([
	"mode",
	"allowed_payment_method_types",
	"adaptive_pricing",
	"line_items",
	"client_reference_id",
	"metadata",
	"payment_intent_data",
	"success_url",
	"cancel_url",
	"expires_at",
	"customer_email",
	"shipping_address_collection",
	"shipping_options",
	"allow_promotion_codes",
]);

describe("Checkout create parameters", () => {
	it("only parameters Stripe accepts at the pinned version are sent (payment_method_types is retired)", async () => {
		const s = await makeShop(nProducts(1, 5), { shipping: 500 });
		s.kv.seedSettings({ allowPromotionCodes: true, shippingCountries: "US" });
		await placeOrder({ key: orderKey(1), lines: linesFor(1), email: "a@b.co" }, s.ctx);
		const body = s.http.requests.find((r) => r.method === "POST")!.body;
		const roots = [...new URLSearchParams(body).keys()].map((k) => k.split("[")[0]!);
		expect(roots.filter((k) => !ALLOWED_CREATE_PARAMS.has(k))).toEqual([]);
		expect(roots).not.toContain("payment_method_types");
	});
});

describe("Stripe offers something other than card only", () => {
	for (const [name, types] of [
		["card plus klarna", ["card", "klarna"]],
		["nothing", []],
	] as const) {
		it(`${name}: the URL is never handed out, the session is expired, the stock released, the merchant told`, async () => {
			const s = await makeShop(nProducts(1, 5));
			const real = s.http;
			// Stripe's response to the create, filtered differently.
			const expired: string[] = [];
			real.on("POST", "https://api.stripe.com/v1/checkout/sessions", (req) => {
				const id = "cs_mixed";
				if (req.url.endsWith("/expire")) {
					expired.push(id);
					return { json: { ...(s.stripe.sessions.get(id) as object), status: "expired" } };
				}
				const sess = {
					id,
					object: "checkout.session",
					url: "https://checkout.stripe.test/x",
					status: "open",
					payment_status: "unpaid",
					amount_total: 1000,
					currency: "usd",
					payment_intent: null,
					metadata: { order_id: new URLSearchParams(req.body).get("metadata[order_id]") },
					expires_at: 1,
					payment_method_types: [...types],
				};
				s.stripe.sessions.set(id, sess as never);
				return { json: sess };
			});
			const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
			expect(r).toMatchObject({ ok: false, code: "CARD_NOT_OFFERED" });
			expect(JSON.stringify(r)).not.toContain("checkout.stripe.test");
			expect(expired).toEqual(["cs_mixed"]);
			expect((await s.stock("p1")).holds).toEqual({});
			expect((await s.order(orderKey(1))).status).toBe("canceled");
			expect((await readHealth(s.ctx)).cardProblem).not.toBeNull();
		});
	}
	it("expire not confirmed: the holds stay (S-b) and the buyer gets no URL", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.http.on("POST", "https://api.stripe.com/v1/checkout/sessions", (req) => {
			if (req.url.endsWith("/expire")) return { status: 503, json: { error: { message: "down" } } };
			const sess = {
				id: "cs_m",
				object: "checkout.session",
				url: "https://checkout.stripe.test/m",
				status: "open",
				payment_status: "unpaid",
				amount_total: 1000,
				currency: "usd",
				payment_intent: null,
				metadata: { order_id: new URLSearchParams(req.body).get("metadata[order_id]") },
				expires_at: 1,
				payment_method_types: ["card", "klarna"],
			};
			return { json: sess };
		});
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "CARD_NOT_OFFERED" });
		expect(JSON.stringify(r)).not.toContain("checkout.stripe.test");
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
		expect((await s.order(orderKey(1))).checkoutUrl).toBeNull();
	});
	it("a create refused because no payment method is eligible: canceled, merchant told (fake only; not run on real Stripe)", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.http.on("POST", "https://api.stripe.com/v1/checkout/sessions", {
			status: 400,
			json: {
				error: {
					type: "invalid_request_error",
					message: "No valid payment method types for this Checkout Session.",
				},
			},
		});
		expect(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).toMatchObject({
			ok: false,
			code: "CARD_NOT_OFFERED",
		});
		expect((await s.stock("p1")).holds).toEqual({});
		expect((await readHealth(s.ctx)).cardProblem).not.toBeNull();
	});
});

const free = (o: { subtotal: number; shipping: number; total: number }, disc = o.total) => ({
	payment_status: "paid" as const,
	payment_intent: null,
	amount_subtotal: o.subtotal,
	amount_total: o.total - disc,
	total_details: { amount_discount: disc, amount_shipping: o.shipping, amount_tax: 0 },
});

async function shop(promo: boolean) {
	const s = await makeShop(nProducts(1, 5), { shipping: 0 });
	s.kv.seedSettings({ allowPromotionCodes: promo });
	await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
	return { s, o: await s.order(orderKey(1)), cs: s.stripe.only() };
}

describe("100%-off sessions (paid, total 0, no PaymentIntent)", () => {
	it("promo on: paid, stock committed once; a redelivery is a no-op", async () => {
		const { s, o, cs } = await shop(true);
		s.stripe.complete(cs.id, free(o));
		const ev = await s.stripe.event("checkout.session.completed", cs.id);
		await deliver(s.ctx, ev);
		expect((await s.order(orderKey(1))).status).toBe("paid");
		expect((await s.stock("p1")).onHand).toBe(4);
		expect((await deliver(s.ctx, ev)).json).toMatchObject({ outcome: "noop" });
		expect((await s.stock("p1")).onHand).toBe(4);
	});
	it("promo off: the same session is a mismatch (review)", async () => {
		const { s, o, cs } = await shop(false);
		s.stripe.complete(cs.id, free(o));
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect((await s.order(orderKey(1))).status).toBe("review");
	});
	it("paid at total 0 with a discount smaller than the total: review", async () => {
		const { s, o, cs } = await shop(true);
		s.stripe.complete(cs.id, { ...free(o, o.total - 1), amount_total: 0 });
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect((await s.order(orderKey(1))).status).toBe("review");
	});
	it("paid at total 0 arriving on an expired order: the late-payment path, no crash", async () => {
		const { s, o, cs } = await shop(true);
		s.stripe.expire(cs.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.expired", cs.id));
		expect((await s.order(orderKey(1))).status).toBe("expired");
		const sv = {
			id: cs.id,
			url: null,
			status: "complete" as const,
			paymentStatus: "paid" as const,
			amountTotal: 0,
			amountSubtotal: o.subtotal,
			amountDiscount: o.total,
			amountShipping: 0,
			amountTax: 0,
			currency: o.currency,
			paymentIntentId: null,
			email: null,
			shippingAddress: null,
			orderId: orderKey(1),
			expiresAt: 1,
			storeTag: o.store,
		};
		expect(await applySession(s.ctx, sv)).toBe("paid");
		const after = await s.order(orderKey(1));
		expect([after.status, after.attention, after.paymentIntentId]).toEqual([
			"paid",
			"PAID_WHILE_EXPIRED",
			null,
		]);
		expect((await callRoute(s.ctx, "orders/get", { id: orderKey(1) })).ok).toBe(true);
	});
});

describe("the orders page marks a free promo order", () => {
	it("Amount paid reads as a free order", async () => {
		const s = await makeShop(nProducts(1, 5), { shipping: 0 });
		s.kv.seedSettings({ allowPromotionCodes: true });
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const o = await s.order(orderKey(1));
		const cs = s.stripe.only();
		s.stripe.complete(cs.id, {
			payment_status: "paid",
			payment_intent: null,
			amount_subtotal: o.subtotal,
			amount_total: 0,
			total_details: { amount_discount: o.total, amount_shipping: 0, amount_tax: 0 },
		});
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		const { adminPage } = await import("../src/admin-page.js");
		const page = await adminPage(
			{ type: "block_action", action_id: "open", value: { id: orderKey(1) }, page: "/orders" },
			s.ctx,
		);
		expect(JSON.stringify(page)).toContain("free order (promotion code)");
	});
});
