import { describe, expect, it } from "vitest";
import type { PluginContext } from "emdash/plugin";
import {
	createCheckoutSession,
	expireSession,
	retrieveSession,
	verifyWebhook,
	type CheckoutSessionInput,
} from "../src/stripe.js";

const KEY = "sk_test_SECRETKEY123";
const WHSEC = "whsec_test";
const enc = new TextEncoder();

async function sign(secret: string, t: number, body: string): Promise<string> {
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const s = await crypto.subtle.sign("HMAC", k, enc.encode(`${t}.${body}`));
	return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const session = (over: Record<string, unknown> = {}) => ({
	id: "cs_1",
	object: "checkout.session",
	url: "https://checkout.stripe.com/c/pay/cs_1",
	status: "complete",
	payment_status: "paid",
	amount_total: 2500,
	amount_subtotal: 2000,
	total_details: { amount_discount: 0, amount_shipping: 500, amount_tax: 0 },
	currency: "eur",
	payment_intent: "pi_1",
	customer_details: { email: "a@b.co" },
	collected_information: { shipping_details: { name: "A", address: { country: "DE" } } },
	metadata: { order_id: "ord_1" },
	expires_at: 1700000000,
	...over,
});
const event = (type: string, obj: unknown = session()) =>
	JSON.stringify({ id: "evt_1", type, data: { object: obj } });

type Call = {
	url: string;
	init: { method?: string; headers?: Record<string, string>; body?: string };
};
function fakeCtx(respond: () => unknown) {
	const calls: Call[] = [];
	const ctx = {
		http: {
			fetch: async (url: string, init: Call["init"]) => {
				calls.push({ url, init });
				const r = respond();
				if (r instanceof Error) throw r;
				return r;
			},
		},
	} as unknown as PluginContext;
	return { ctx, calls };
}
const reply = (status: number, body: unknown) => ({
	status,
	ok: status >= 200 && status < 300,
	headers: {},
	text: async () => JSON.stringify(body),
	json: async () => body,
});

describe("verifyWebhook", () => {
	const now = 1_700_000_000;
	const body = event("checkout.session.completed");
	const raw = enc.encode(body);

	it("accepts a valid signature and maps the session", async () => {
		const sig = `t=${now},v1=${await sign(WHSEC, now, body)}`;
		const r = await verifyWebhook(WHSEC, raw, sig, now);
		expect(r).toEqual({
			ok: true,
			event: {
				id: "evt_1",
				type: "checkout.session.completed",
				session: {
					id: "cs_1",
					url: "https://checkout.stripe.com/c/pay/cs_1",
					status: "complete",
					paymentStatus: "paid",
					amountTotal: 2500,
					amountSubtotal: 2000,
					amountDiscount: 0,
					amountShipping: 500,
					amountTax: 0,
					currency: "EUR",
					paymentIntentId: "pi_1",
					email: "a@b.co",
					shippingAddress: { name: "A", address: { country: "DE" } },
					orderId: "ord_1",
					expiresAt: 1700000000,
					storeTag: null,
					created: null,
					paymentMethodTypes: null,
				},
			},
		});
	});
	it("rejects wrong secret, tampered body, stale timestamp", async () => {
		const bad = `t=${now},v1=${await sign("other", now, body)}`;
		expect(await verifyWebhook(WHSEC, raw, bad, now)).toEqual({
			ok: false,
			reason: "INVALID_SIGNATURE",
		});
		const good = `t=${now},v1=${await sign(WHSEC, now, body)}`;
		expect(await verifyWebhook(WHSEC, enc.encode(body + " "), good, now)).toMatchObject({
			reason: "INVALID_SIGNATURE",
		});
		expect(await verifyWebhook(WHSEC, raw, good, now + 301)).toMatchObject({
			reason: "INVALID_SIGNATURE",
		});
		expect(await verifyWebhook(WHSEC, raw, good, now + 300)).toMatchObject({ ok: true });
	});
	it("accepts when any of several v1 candidates matches", async () => {
		const good = await sign(WHSEC, now, body);
		const sig = `t=${now},v1=${"0".repeat(64)},v1=zz,v1=${good}`;
		expect(await verifyWebhook(WHSEC, raw, sig, now)).toMatchObject({ ok: true });
	});
	it("rejects malformed headers", async () => {
		for (const h of [undefined, "", "garbage", `v1=abcd`, `t=${now}`, `t=abc,v1=00`]) {
			expect(await verifyWebhook(WHSEC, raw, h, now)).toEqual({
				ok: false,
				reason: "INVALID_SIGNATURE",
			});
		}
	});
	const signed = async (b: string) =>
		verifyWebhook(WHSEC, enc.encode(b), `t=${now},v1=${await sign(WHSEC, now, b)}`, now);
	it("maps all four event types, ignores others", async () => {
		for (const t of [
			"checkout.session.completed",
			"checkout.session.expired",
			"checkout.session.async_payment_succeeded",
			"checkout.session.async_payment_failed",
		]) {
			expect(await signed(event(t))).toMatchObject({ ok: true, event: { type: t } });
		}
		expect(await signed(event("payment_intent.succeeded"))).toEqual({
			ok: false,
			reason: "IGNORED",
		});
	});
	it("falls back to legacy shipping_details and expanded payment_intent", async () => {
		const o = session({
			collected_information: undefined,
			shipping_details: { name: "L" },
			payment_intent: { id: "pi_x" },
		});
		const r = await signed(event("checkout.session.completed", o));
		expect(r).toMatchObject({
			ok: true,
			event: { session: { shippingAddress: { name: "L" }, paymentIntentId: "pi_x" } },
		});
	});
	it("MALFORMED without an id or type; a signed event whose object Core cannot read is IGNORED (200, no retries)", async () => {
		expect(await signed("not json")).toEqual({ ok: false, reason: "MALFORMED" });
		expect(
			await signed(event("checkout.session.completed", { object: "payment_intent", id: "x" })),
		).toEqual({ ok: false, reason: "IGNORED" });
		expect(await signed(event("checkout.session.completed", session({ status: "weird" })))).toEqual(
			{ ok: false, reason: "IGNORED" },
		);
		expect(await signed(JSON.stringify({ type: "checkout.session.completed" }))).toEqual({
			ok: false,
			reason: "MALFORMED",
		});
	});
});

describe("createCheckoutSession", () => {
	const input: CheckoutSessionInput = {
		orderId: "ord_1",
		currency: "EUR",
		lines: [
			{ name: "Tee & co", unitAmount: 1500, qty: 2 },
			{ name: "Mug", unitAmount: 0, qty: 1 },
		],
		shipping: 500,
		successUrl: "https://s.test/ok?o=1",
		cancelUrl: "https://s.test/no",
		expiresAt: 1700001800,
		email: "a@b.co",
		shippingCountries: ["DE", "FR"],
		allowPromotionCodes: false,
		storeTag: "st0123456789abcd",
	};
	it("sends exactly one correctly encoded request", async () => {
		const { ctx, calls } = fakeCtx(() =>
			reply(200, session({ status: "open", payment_status: "unpaid" })),
		);
		const r = await createCheckoutSession(ctx, KEY, input);
		expect(r).toMatchObject({ ok: true, value: { id: "cs_1", status: "open" } });
		expect(calls).toHaveLength(1);
		const c = calls[0]!;
		expect(c.url).toBe("https://api.stripe.com/v1/checkout/sessions");
		expect(c.init.method).toBe("POST");
		expect(c.init.headers).toMatchObject({
			Authorization: `Bearer ${KEY}`,
			"Idempotency-Key": "otta-core-st0123456789abcd-ord_1",
			"Content-Type": "application/x-www-form-urlencoded",
		});
		expect(c.init.headers!["Stripe-Version"]).toMatch(/^\d{4}-\d\d-\d\d\./);
		const p = [...new URLSearchParams(c.init.body)];
		expect(p).toEqual([
			["mode", "payment"],
			["allowed_payment_method_types[0]", "card"],
			["adaptive_pricing[enabled]", "false"],
			["line_items[0][quantity]", "2"],
			["line_items[0][price_data][currency]", "eur"],
			["line_items[0][price_data][unit_amount]", "1500"],
			["line_items[0][price_data][product_data][name]", "Tee & co"],
			["line_items[1][quantity]", "1"],
			["line_items[1][price_data][currency]", "eur"],
			["line_items[1][price_data][unit_amount]", "0"],
			["line_items[1][price_data][product_data][name]", "Mug"],
			["client_reference_id", "ord_1"],
			["metadata[order_id]", "ord_1"],
			["metadata[otta_store]", "st0123456789abcd"],
			["payment_intent_data[metadata][order_id]", "ord_1"],
			["payment_intent_data[metadata][otta_store]", "st0123456789abcd"],
			["success_url", "https://s.test/ok?o=1"],
			["cancel_url", "https://s.test/no"],
			["expires_at", "1700001800"],
			["customer_email", "a@b.co"],
			["shipping_address_collection[allowed_countries][0]", "DE"],
			["shipping_address_collection[allowed_countries][1]", "FR"],
			["shipping_options[0][shipping_rate_data][type]", "fixed_amount"],
			["shipping_options[0][shipping_rate_data][display_name]", "Shipping"],
			["shipping_options[0][shipping_rate_data][fixed_amount][amount]", "500"],
			["shipping_options[0][shipping_rate_data][fixed_amount][currency]", "eur"],
		]);
	});
	it("omits optional params", async () => {
		const { ctx, calls } = fakeCtx(() => reply(200, session()));
		await createCheckoutSession(ctx, KEY, {
			...input,
			shipping: 0,
			email: null,
			shippingCountries: [],
		});
		const keys = [...new URLSearchParams(calls[0]!.init.body)].map(([k]) => k).join(" ");
		expect(keys).not.toMatch(/customer_email|shipping_/);
	});
	it("rejects invalid amounts without fetching", async () => {
		const { ctx, calls } = fakeCtx(() => reply(200, session()));
		for (const bad of [
			{ ...input, shipping: -1 },
			{ ...input, lines: [{ name: "x", unitAmount: 1.5, qty: 1 }] },
			{ ...input, lines: [{ name: "x", unitAmount: 1, qty: 0 }] },
			{ ...input, lines: [] },
		]) {
			expect(await createCheckoutSession(ctx, KEY, bad)).toMatchObject({
				ok: false,
				code: "STRIPE_REFUSED",
			});
		}
		expect(calls).toHaveLength(0);
	});
});

describe("retrieve / expire and error classification", () => {
	it("retrieve GETs, expire POSTs, ids are url-encoded", async () => {
		const { ctx, calls } = fakeCtx(() => reply(200, session()));
		await retrieveSession(ctx, KEY, "cs_1/../x");
		await expireSession(ctx, KEY, "cs_1");
		expect(calls[0]).toMatchObject({
			url: "https://api.stripe.com/v1/checkout/sessions/cs_1%2F..%2Fx",
			init: { method: "GET" },
		});
		expect(calls[1]).toMatchObject({
			url: "https://api.stripe.com/v1/checkout/sessions/cs_1/expire",
			init: { method: "POST" },
		});
	});
	it.each([
		[500, "STRIPE_UNAVAILABLE"],
		[503, "STRIPE_UNAVAILABLE"],
		[429, "STRIPE_UNAVAILABLE"],
		[400, "STRIPE_REFUSED"],
		[401, "STRIPE_REFUSED"],
	])("status %i -> %s", async (status, code) => {
		const { ctx } = fakeCtx(() => reply(status, { error: { message: `bad ${KEY} thing` } }));
		const r = await expireSession(ctx, KEY, "cs_1");
		expect(r).toMatchObject({ ok: false, code, status });
		expect(JSON.stringify(r)).not.toContain("SECRETKEY123");
		if (code === "STRIPE_REFUSED") expect((r as { message: string }).message).toBe("bad *** thing");
	});
	it("uses Stripe's error.message on 4xx", async () => {
		const { ctx } = fakeCtx(() =>
			reply(400, { error: { message: "Only open sessions can be expired" } }),
		);
		expect(await expireSession(ctx, KEY, "cs_1")).toMatchObject({
			message: "Only open sessions can be expired",
		});
	});
	it("network throw -> UNAVAILABLE without key", async () => {
		const { ctx } = fakeCtx(() => new Error(`connect failed for ${KEY}`));
		const r = await retrieveSession(ctx, KEY, "cs_1");
		expect(r).toMatchObject({ ok: false, code: "STRIPE_UNAVAILABLE" });
		expect(JSON.stringify(r)).not.toContain("SECRETKEY123");
	});
	it("2xx with garbage body -> UNAVAILABLE", async () => {
		const { ctx } = fakeCtx(() => reply(200, { hello: 1 }));
		expect(await retrieveSession(ctx, KEY, "cs_1")).toMatchObject({
			ok: false,
			code: "STRIPE_UNAVAILABLE",
		});
	});
});
