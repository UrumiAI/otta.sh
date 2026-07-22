import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin customer-context HTTP contract (admin-UX Increment 1): wire ⇄ use-case
// fidelity for GET /admin/orders/:id/customer-context against a LIVE server
// backed by Postgres, with the account minted through the REAL magic-link flow
// (request → verify), so linking semantics (`linkGuestOrders`) are the genuine
// article, not a seeded approximation. Guards: internal-token (401 without),
// unknown order (404). The headline case is the lazy-linking regression: a
// linked order and a later, not-yet-relinked order of the SAME person must
// answer with the SAME identity and the SAME counts.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("admin customer-context HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	function lastLoginToken(): { challengeId: string; token: string } {
		const sends = server.emailSender.sends.filter((s) => s.template === "customer-login-link");
		const last = sends[sends.length - 1]!;
		return { challengeId: last.data["challengeId"] as string, token: last.data["token"] as string };
	}

	/** Full magic-link login over the wire → the bearer session token. Also
	 *  links any guest orders with a matching buyer_ref (the real mechanism). */
	async function login(email: string): Promise<string> {
		const reqRes = await fetch(`${server.baseUrl}/auth/login/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email }),
		});
		expect(reqRes.status).toBe(200);
		const { challengeId, token: magicToken } = lastLoginToken();
		const verifyRes = await fetch(`${server.baseUrl}/auth/login/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId, token: magicToken }),
		});
		expect(verifyRes.status).toBe(200);
		return (await json(verifyRes))["sessionToken"] as string;
	}

	function getContext(orderId: string, opts: { token?: string } = { token }): Promise<Response> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers["X-Internal-Token"] = opts.token;
		return fetch(`${server.baseUrl}/admin/orders/${orderId}/customer-context`, { headers });
	}

	test("lazy-linking regression: a claimed and a later unclaimed order answer with the SAME account and counts", async () => {
		// Guest checkout (mixed case), then bob logs in → the order gets linked.
		await server.seedOrder({
			id: "ord-a",
			state: "paid",
			currency: "USD",
			buyerRef: "Bob@Example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
			totalCents: 1500,
		});
		const sessionToken = await login("bob@example.com");
		// A saved address on the profile (through the real /me surface).
		const addrRes = await fetch(`${server.baseUrl}/me/addresses`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${sessionToken}`,
			},
			body: JSON.stringify({
				kind: "shipping",
				name: "Bob",
				line1: "1 Main St",
				city: "Springfield",
				postalCode: "12345",
				country: "US",
				isDefault: true,
			}),
		});
		expect(addrRes.status).toBe(201);
		// A NEW order after that login — born unlinked (the common path).
		await server.seedOrder({
			id: "ord-b",
			state: "paid",
			currency: "USD",
			buyerRef: "bob@example.com",
			createdAt: "2026-07-10T00:00:02.000Z",
			totalCents: 2500,
		});

		const fromA = await json(await getContext("ord-a"));
		const fromB = await json(await getContext("ord-b"));
		expect(fromA.ok).toBe(true);
		expect(fromB.ok).toBe(true);
		const ctxA = fromA.context as Record<string, unknown>;
		const ctxB = fromB.context as Record<string, unknown>;
		const idA = ctxA.identity as Record<string, unknown>;
		const idB = ctxB.identity as Record<string, unknown>;

		// Same resolved account either way; linkage tells the true story.
		expect(idA.email).toBe("bob@example.com");
		expect(idB.email).toBe("bob@example.com");
		expect(idA.customerId).toBe(idB.customerId);
		expect(idA.linkage).toBe("claimed");
		expect(idB.linkage).toBe("unclaimed");
		expect(idA.emailVerifiedAt).not.toBeNull(); // the login proved the inbox

		// Union counts agree; each order's "recent" is the OTHER order.
		expect(ctxA.orderCount).toBe(2);
		expect(ctxB.orderCount).toBe(2);
		expect((ctxA.recentOrders as Array<{ id: string }>).map((o) => o.id)).toEqual(["ord-b"]);
		expect((ctxB.recentOrders as Array<{ id: string }>).map((o) => o.id)).toEqual(["ord-a"]);

		// The profile address book + token-free session history surface on BOTH.
		for (const ctx of [ctxA, ctxB]) {
			const addresses = ctx.addresses as Array<Record<string, unknown>>;
			expect(addresses.map((a) => a.line1)).toEqual(["1 Main St"]);
			const sessions = ctx.sessions as Array<Record<string, unknown>>;
			expect(sessions.length).toBeGreaterThanOrEqual(1);
			for (const s of sessions) {
				expect(Object.keys(s).toSorted()).toEqual(["createdAt", "expiresAt", "id", "revokedAt"]);
			}
		}
	});

	test("a guest order with no account answers linkage:guest with empty addresses/sessions", async () => {
		await server.seedOrder({
			id: "ord-guest",
			state: "paid",
			currency: "USD",
			buyerRef: "carol@example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
			totalCents: 900,
		});
		const body = await json(await getContext("ord-guest"));
		expect(body.ok).toBe(true);
		const ctx = body.context as Record<string, unknown>;
		expect(ctx.identity).toEqual({
			customerId: null,
			buyerRef: "carol@example.com",
			email: null,
			displayName: null,
			emailVerifiedAt: null,
			linkage: "guest",
		});
		expect(ctx.addresses).toEqual([]);
		expect(ctx.sessions).toEqual([]);
		expect(ctx.orderCount).toBe(1);
		expect(ctx.recentOrders).toEqual([]);
	});

	test("unknown order → 404 ORDER_NOT_FOUND", async () => {
		const res = await getContext("does-not-exist");
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no internal token ⇒ 401 (the read is admin-only — it carries PII)", async () => {
		await server.seedOrder({
			id: "ord-guarded",
			state: "paid",
			currency: "USD",
			buyerRef: "bob@example.com",
			createdAt: "2026-07-10T00:00:01.000Z",
			totalCents: 100,
		});
		expect((await getContext("ord-guarded", {})).status).toBe(401);
	});
});
