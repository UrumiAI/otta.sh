import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Phase 5 HTTP contract (§8 5.6): the new customer/auth/admin surface exercised
// against a LIVE server backed by Postgres. Proves own-orders isolation, the
// magic-link flow, address scoping, admin transitions, and the extended
// expire-orders email — all at the wire level. Postgres-required.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

function authed(token: string): { Authorization: string } {
	return { Authorization: `Bearer ${token}` };
}

describe.skipIf(PG === undefined)("customers + auth + admin HTTP contract", () => {
	let server: TestServer;
	beforeEach(async () => {
		server = await startTestServer();
	});
	afterEach(async () => {
		await server.stop();
	});

	function lastLoginToken(): { challengeId: string; token: string } {
		const sends = server.emailSender.sends.filter((s) => s.template === "customer-login-link");
		const last = sends[sends.length - 1]!;
		return { challengeId: last.data["challengeId"] as string, token: last.data["token"] as string };
	}

	/** Full magic-link login over the wire → returns the bearer session token. */
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

	/** Seed + check out a one-line physical order under `buyerRef`. */
	async function createGuestOrder(input: {
		email: string;
		sku: string;
		productId: string;
	}): Promise<string> {
		await server.seedProduct({
			productId: input.productId,
			sku: input.sku,
			priceCents: 1500,
			title: "Item",
			kind: "physical",
			onHand: 5,
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
			body: JSON.stringify({ cartId, paymentMethod: "stripe", buyerRef: input.email }),
		});
		expect(coRes.status).toBe(201);
		return ((await json(coRes))["order"] as Record<string, unknown>)["id"] as string;
	}

	test("a customer sees only their own orders; a foreign order id returns 404 (not 403)", async () => {
		const orderA = await createGuestOrder({
			email: "a@example.com",
			sku: "SKU-A",
			productId: "pa",
		});
		const orderB = await createGuestOrder({
			email: "b@example.com",
			sku: "SKU-B",
			productId: "pb",
		});
		const tokenA = await login("a@example.com");
		await login("b@example.com"); // links orderB to B

		const mine = await json(
			await fetch(`${server.baseUrl}/me/orders`, { headers: authed(tokenA) }),
		);
		const orders = mine["orders"] as Array<{ id: string }>;
		expect(orders.map((o) => o.id)).toEqual([orderA]);

		// B's order by id, as A → 404 NOT_FOUND (existence not leaked as 403).
		const foreign = await fetch(`${server.baseUrl}/me/orders/${orderB}`, {
			headers: authed(tokenA),
		});
		expect(foreign.status).toBe(404);
		// A's own order by id → 200.
		const own = await fetch(`${server.baseUrl}/me/orders/${orderA}`, { headers: authed(tokenA) });
		expect(own.status).toBe(200);
	});

	test("the /me surface rejects an unauthenticated request with 401", async () => {
		expect((await fetch(`${server.baseUrl}/me/orders`)).status).toBe(401);
		expect((await fetch(`${server.baseUrl}/me`)).status).toBe(401);
		expect((await fetch(`${server.baseUrl}/me/addresses`)).status).toBe(401);
	});

	test("POST /auth/login/request sends exactly one login email and returns a generic response", async () => {
		const res = await fetch(`${server.baseUrl}/auth/login/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "solo@example.com" }),
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body["ok"]).toBe(true);
		expect(String(body["message"])).toMatch(/if an account exists/i);
		expect(server.emailSender.countByTemplate("customer-login-link")).toBe(1);
	});

	test("rapid login requests for one email are rate-limited: no extra email/challenge, response indistinguishable (H1)", async () => {
		const bodies: string[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await fetch(`${server.baseUrl}/auth/login/request`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "bomb@example.com" }),
			});
			expect(res.status).toBe(200);
			bodies.push(await res.text());
		}
		// The throttled responses are byte-identical to the issued ones — the
		// limiter is not an oracle (§9 Risk 4).
		expect(new Set(bodies).size).toBe(1);
		// Only the capped number of emails ever went out (default cap: 3); a
		// different address is unaffected.
		expect(server.emailSender.countByTemplate("customer-login-link")).toBe(3);
		await fetch(`${server.baseUrl}/auth/login/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "someone-else@example.com" }),
		});
		expect(server.emailSender.countByTemplate("customer-login-link")).toBe(4);
	});

	test("the internal maintenance tick prunes consumed/expired login challenges (H1)", async () => {
		// A completed login leaves exactly one consumed challenge behind.
		await login("prune@example.com");
		const res = await fetch(`${server.baseUrl}/internal/dispatch-emails`, {
			method: "POST",
			headers: { "X-Internal-Token": server.internalToken! },
		});
		expect(res.status).toBe(200);
		expect((await json(res))["prunedChallenges"]).toBe(1);
		// Idempotent: a second tick finds nothing left to prune.
		const again = await fetch(`${server.baseUrl}/internal/dispatch-emails`, {
			method: "POST",
			headers: { "X-Internal-Token": server.internalToken! },
		});
		expect((await json(again))["prunedChallenges"]).toBe(0);
	});

	test("POST /auth/login/verify with a stale (consumed) challenge returns 401, not customer detail", async () => {
		await fetch(`${server.baseUrl}/auth/login/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "stale@example.com" }),
		});
		const { challengeId, token } = lastLoginToken();
		const first = await fetch(`${server.baseUrl}/auth/login/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId, token }),
		});
		expect(first.status).toBe(200);
		const replay = await fetch(`${server.baseUrl}/auth/login/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId, token }),
		});
		expect(replay.status).toBe(401);
		const body = await json(replay);
		expect(body["sessionToken"]).toBeUndefined();
		expect(body["reason"]).toBe("CONSUMED");
	});

	test("the address book is scoped to the authenticated customer", async () => {
		const tokenA = await login("addr-a@example.com");
		const tokenB = await login("addr-b@example.com");
		const created = await json(
			await fetch(`${server.baseUrl}/me/addresses`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authed(tokenA) },
				body: JSON.stringify({
					kind: "shipping",
					name: "A",
					line1: "1 A St",
					city: "Town",
					postalCode: "0001",
					country: "US",
				}),
			}),
		);
		const addressId = (created["address"] as { id: string }).id;

		// B never sees A's address.
		const bList = await json(
			await fetch(`${server.baseUrl}/me/addresses`, { headers: authed(tokenB) }),
		);
		expect(bList["addresses"]).toEqual([]);
		// B cannot delete A's address (scoped → 404).
		const bDelete = await fetch(`${server.baseUrl}/me/addresses/${addressId}`, {
			method: "DELETE",
			headers: authed(tokenB),
		});
		expect(bDelete.status).toBe(404);
		// A sees exactly their own.
		const aList = await json(
			await fetch(`${server.baseUrl}/me/addresses`, { headers: authed(tokenA) }),
		);
		expect((aList["addresses"] as unknown[]).length).toBe(1);
	});

	test("admin transition paid→processing succeeds and enqueues exactly one processing email; an illegal transition is 409", async () => {
		const orderId = await createGuestOrder({
			email: "adm@example.com",
			sku: "SKU-ADM",
			productId: "padm",
		});
		// Move it to paid via the admin endpoint first (pending → paid is legal).
		const toPaid = await fetch(`${server.baseUrl}/admin/orders/${orderId}/transition`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": server.internalToken! },
			body: JSON.stringify({ toState: "paid" }),
		});
		expect(toPaid.status).toBe(200);
		const toProcessing = await fetch(`${server.baseUrl}/admin/orders/${orderId}/transition`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": server.internalToken! },
			body: JSON.stringify({ toState: "processing" }),
		});
		expect(toProcessing.status).toBe(200);

		// Illegal from processing (paid→pending equivalent): processing → paid.
		const illegal = await fetch(`${server.baseUrl}/admin/orders/${orderId}/transition`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Internal-Token": server.internalToken! },
			body: JSON.stringify({ toState: "paid" }),
		});
		expect(illegal.status).toBe(409);

		// Unauthorized without the internal token → 401.
		const noAuth = await fetch(`${server.baseUrl}/admin/orders/${orderId}/transition`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ toState: "shipped" }),
		});
		expect(noAuth.status).toBe(401);

		// Dispatch and assert exactly one processing email (confirmation also queued).
		const dispatch = await fetch(`${server.baseUrl}/internal/dispatch-emails`, {
			method: "POST",
			headers: { "X-Internal-Token": server.internalToken! },
		});
		expect(dispatch.status).toBe(200);
		expect(server.emailSender.countByTemplate("order-processing", orderId)).toBe(1);
		expect(server.emailSender.countByTemplate("order-confirmation", orderId)).toBe(1);
	});

	test("the expire-orders sweep transitions pending→expired, releases the reservation once, and enqueues exactly one order-expired email", async () => {
		const orderId = await createGuestOrder({
			email: "exp@example.com",
			sku: "SKU-EXP",
			productId: "pexp",
		});
		expect(await server.onHand("SKU-EXP")).toBe(4); // 5 seeded − 1 reserved at checkout

		server.advance(31 * 60 * 1000); // past the checkout hold TTL
		const expireRes = await fetch(`${server.baseUrl}/internal/expire-orders`, {
			method: "POST",
			headers: { "X-Internal-Token": server.internalToken! },
		});
		expect(expireRes.status).toBe(200);
		expect((await json(expireRes))["expired"]).toBe(1);

		// Reservation released exactly once (Phase-4 behavior unchanged).
		expect(await server.onHand("SKU-EXP")).toBe(5);
		const order = await json(await fetch(`${server.baseUrl}/orders/${orderId}`));
		expect((order["order"] as Record<string, unknown>)["state"]).toBe("expired");

		// Exactly one order-expired email after dispatch.
		await fetch(`${server.baseUrl}/internal/dispatch-emails`, {
			method: "POST",
			headers: { "X-Internal-Token": server.internalToken! },
		});
		expect(server.emailSender.countByTemplate("order-expired", orderId)).toBe(1);
	});
});
