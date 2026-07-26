import { signStripeWebhook } from "@urumi/payments-stripe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	STRIPE_WEBHOOK_SECRET,
	startTestServer,
	type TestServer,
} from "./helpers/start-test-server.js";

// Issue #33 (ADR-0011): GET /entitlements/check is no longer an unauthenticated
// existence oracle over email. Presence-based precedence, exercised at the wire
// level against a LIVE Postgres-backed server:
//   1. buyerRef present anywhere  ⇒ X-Internal-Token required (else 401; 503 if
//      the token is unconfigured — never silently open)
//   2. else orderId present       ⇒ open bearer capability (unguessable order id)
//   3. else valid session Bearer  ⇒ session scope (email derived server-side)
//   4. else                       ⇒ 401
// Postgres-required (the grant flow runs through the real Stripe webhook).

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("entitlements/check auth HTTP contract", () => {
	let server: TestServer;
	beforeEach(async () => {
		server = await startTestServer();
	});
	afterEach(async () => {
		await server.stop();
	});

	function internalHeader(): Record<string, string> {
		return server.internalToken === undefined ? {} : { "X-Internal-Token": server.internalToken };
	}

	function lastLoginToken(): { challengeId: string; token: string } {
		const sends = server.emailSender.sends.filter((s) => s.template === "customer-login-link");
		const last = sends[sends.length - 1]!;
		return { challengeId: last.data["challengeId"] as string, token: last.data["token"] as string };
	}

	/** Full magic-link login over the wire → the bearer session token. */
	async function login(email: string): Promise<string> {
		const reqRes = await fetch(`${server.baseUrl}/auth/login/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email }),
		});
		expect(reqRes.status).toBe(200);
		const { challengeId, token } = lastLoginToken();
		const verifyRes = await fetch(`${server.baseUrl}/auth/login/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId, token }),
		});
		expect(verifyRes.status).toBe(200);
		return (await json(verifyRes))["sessionToken"] as string;
	}

	/** Seed a digital product, check out under `buyerRef`, and pay it through the
	 *  REAL Stripe webhook so the entitlement is granted by the production path. */
	async function payDigitalOrder(input: {
		sku: string;
		productId: string;
		buyerRef: string;
	}): Promise<string> {
		await server.seedProduct({
			productId: input.productId,
			sku: input.sku,
			priceCents: 900,
			title: "Digital Widget",
			kind: "digital",
		});
		const cart = await json(
			await fetch(`${server.baseUrl}/carts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currency: "USD" }),
			}),
		);
		const cartId = cart["cartId"] as string;
		await fetch(`${server.baseUrl}/carts/${cartId}/lines`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `add-${cartId}` },
			body: JSON.stringify({ sku: input.sku, qty: 1, productId: input.productId }),
		});
		const coRes = await fetch(`${server.baseUrl}/checkout/orders`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": `co-${cartId}` },
			body: JSON.stringify({ cartId, paymentMethod: "stripe", buyerRef: input.buyerRef }),
		});
		expect(coRes.status).toBe(201);
		const order = (await json(coRes))["order"] as Record<string, unknown>;
		const orderId = order["id"] as string;
		const totalCents = (order["totals"] as Record<string, number>)["totalCents"]!;
		const signed = signStripeWebhook(
			{
				eventId: `evt_${orderId}`,
				type: "payment_intent.succeeded",
				paymentIntentId: `pi_${orderId}`,
				orderId,
				amountCents: totalCents,
				currency: "usd",
			},
			STRIPE_WEBHOOK_SECRET,
		);
		const hookRes = await fetch(`${server.baseUrl}/webhooks/stripe`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signatureHeader },
			body: signed.body,
		});
		expect(hookRes.status).toBe(200);
		return orderId;
	}

	function check(
		query: Record<string, string>,
		headers: Record<string, string> = {},
	): Promise<Response> {
		const qs = new URLSearchParams(query).toString();
		return fetch(`${server.baseUrl}/entitlements/check?${qs}`, { headers });
	}

	// ── Precedence / oracle-closure ──────────────────────────────────────────

	test("1. buyerRef scope, no credentials → 401 (oracle closed, no `active`)", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "buyer@example.com" });
		const res = await check({ buyerRef: "buyer@example.com", sku: "DIG-1" });
		expect(res.status).toBe(401);
		const body = await json(res);
		expect(body).toEqual({ ok: false, error: "unauthorized" });
		expect(body).not.toHaveProperty("active");
	});

	test("2. buyerRef scope, wrong X-Internal-Token → 401", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "buyer@example.com" });
		const res = await check(
			{ buyerRef: "buyer@example.com", sku: "DIG-1" },
			{ "X-Internal-Token": "not-the-token" },
		);
		expect(res.status).toBe(401);
	});

	test("3. buyerRef scope, valid X-Internal-Token → correct boolean", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "buyer@example.com" });
		const owned = await check({ buyerRef: "buyer@example.com", sku: "DIG-1" }, internalHeader());
		expect(owned.status).toBe(200);
		expect((await json(owned))["active"]).toBe(true);
		const other = await check({ buyerRef: "buyer@example.com", sku: "OTHER" }, internalHeader());
		expect(other.status).toBe(200);
		expect((await json(other))["active"]).toBe(false);
	});

	test("4. buyerRef scope on a server with internalToken DISABLED → 503 (never silently open)", async () => {
		const disabled = await startTestServer({ internalToken: null });
		try {
			const res = await fetch(
				`${disabled.baseUrl}/entitlements/check?buyerRef=buyer@example.com&sku=DIG-1`,
			);
			expect(res.status).toBe(503);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body).not.toHaveProperty("active");
		} finally {
			await disabled.stop();
		}
	});

	test("5. buyerRef + valid session, no operator token → 401 (a session never unlocks arbitrary-email checks)", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "buyer@example.com" });
		const session = await login("buyer@example.com");
		const res = await check(
			{ buyerRef: "buyer@example.com", sku: "DIG-1" },
			{ Authorization: `Bearer ${session}` },
		);
		expect(res.status).toBe(401);
	});

	test("6. orderId + buyerRef, no token → 401 (presence-based: closes 'does order X belong to email Y')", async () => {
		const orderId = await payDigitalOrder({
			sku: "DIG-1",
			productId: "d1",
			buyerRef: "buyer@example.com",
		});
		const res = await check({ orderId, buyerRef: "buyer@example.com", sku: "DIG-1" });
		expect(res.status).toBe(401);
	});

	test("7. orderId + buyerRef + valid X-Internal-Token → ANDed boolean", async () => {
		const orderId = await payDigitalOrder({
			sku: "DIG-1",
			productId: "d1",
			buyerRef: "buyer@example.com",
		});
		const match = await check(
			{ orderId, buyerRef: "buyer@example.com", sku: "DIG-1" },
			internalHeader(),
		);
		expect((await json(match))["active"]).toBe(true);
		const mismatch = await check(
			{ orderId, buyerRef: "someone-else@example.com", sku: "DIG-1" },
			internalHeader(),
		);
		expect((await json(mismatch))["active"]).toBe(false);
	});

	test("8. orderId + valid Bearer of an UNRELATED customer → orderId capability (Bearer ignored, active:true)", async () => {
		const orderId = await payDigitalOrder({
			sku: "DIG-1",
			productId: "d1",
			buyerRef: "buyer@example.com",
		});
		const strangerSession = await login("stranger@example.com");
		const res = await check(
			{ orderId, sku: "DIG-1" },
			{ Authorization: `Bearer ${strangerSession}` },
		);
		expect(res.status).toBe(200);
		expect((await json(res))["active"]).toBe(true);
	});

	test("9. sku-only + valid X-Internal-Token, no Bearer → 401 (the token gates buyerRef, it is not a scope)", async () => {
		const res = await check({ sku: "DIG-1" }, internalHeader());
		expect(res.status).toBe(401);
	});

	test("10. sku missing → 400 (schema)", async () => {
		const res = await check({ buyerRef: "buyer@example.com" }, internalHeader());
		expect(res.status).toBe(400);
	});

	test("11. no scope, no credentials → 401", async () => {
		const res = await check({ sku: "DIG-1" });
		expect(res.status).toBe(401);
	});

	// ── Session scope ────────────────────────────────────────────────────────

	test("12. session scope: owned sku active:true, unowned sku active:false", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "buyer@example.com" });
		const session = await login("buyer@example.com");
		const owned = await check({ sku: "DIG-1" }, { Authorization: `Bearer ${session}` });
		expect(owned.status).toBe(200);
		expect((await json(owned))["active"]).toBe(true);
		const unowned = await check({ sku: "NOPE" }, { Authorization: `Bearer ${session}` });
		expect((await json(unowned))["active"]).toBe(false);
	});

	test("13. session scope: a different customer's session → active:false (no cross-buyer leak)", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "buyer@example.com" });
		const stranger = await login("stranger@example.com");
		const res = await check({ sku: "DIG-1" }, { Authorization: `Bearer ${stranger}` });
		expect(res.status).toBe(200);
		expect((await json(res))["active"]).toBe(false);
	});

	test("14. session scope: garbage bearer token → 401", async () => {
		const res = await check({ sku: "DIG-1" }, { Authorization: "Bearer not-a-real-token" });
		expect(res.status).toBe(401);
	});

	test("15. session scope: a revoked session (logout, then replay) → 401", async () => {
		const session = await login("buyer@example.com");
		await fetch(`${server.baseUrl}/auth/logout`, {
			method: "POST",
			headers: { Authorization: `Bearer ${session}` },
		});
		const res = await check({ sku: "DIG-1" }, { Authorization: `Bearer ${session}` });
		expect(res.status).toBe(401);
	});

	test("16. session scope: an expired session → 401", async () => {
		const session = await login("buyer@example.com");
		server.advance(31 * 24 * 60 * 60 * 1000); // past the 30-day session TTL
		const res = await check({ sku: "DIG-1" }, { Authorization: `Bearer ${session}` });
		expect(res.status).toBe(401);
	});

	test("17. case-insensitive end-to-end: mixed-case checkout ref, lower-cased login email → active:true", async () => {
		await payDigitalOrder({ sku: "DIG-1", productId: "d1", buyerRef: "Buyer@Example.COM" });
		const session = await login("buyer@example.com");
		const res = await check({ sku: "DIG-1" }, { Authorization: `Bearer ${session}` });
		expect(res.status).toBe(200);
		expect((await json(res))["active"]).toBe(true);
	});
});
