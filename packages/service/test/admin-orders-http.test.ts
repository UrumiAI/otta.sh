import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin Orders console (view-only): wire ⇄ port fidelity for GET /admin/orders
// (list, keyset cursor round-trip preserving the filter) and GET
// /admin/orders/:id (detail + allowedTransitions + 404), against a LIVE server
// backed by Postgres. Guards: no token ⇒ 401, no configured token ⇒ 503.
// Cursor fail-closed (MOD-1): a garbage/tampered cursor ⇒ 400; a decoded
// out-of-range limit is clamped, not honored.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

/** Encode an opaque cursor the way the route does (base64url of the JSON) so a
 *  test can craft a tampered/out-of-range token. */
function b64url(payload: unknown): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe.skipIf(PG === undefined)("admin Orders console HTTP contract", () => {
	let server: TestServer;
	let token: string;

	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	function get(path: string, opts: { token?: string } = { token }): Promise<Response> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers["X-Internal-Token"] = opts.token;
		return fetch(`${server.baseUrl}/admin${path}`, { headers });
	}

	async function seed(): Promise<void> {
		// Three paid USD orders across three days + a cancelled distractor inside the
		// same window (to prove filters survive paging).
		await server.seedOrder({
			id: "ord-1",
			state: "paid",
			currency: "USD",
			buyerRef: "Alice@Example.com",
			paymentMethod: "stripe",
			customerId: "cust-a",
			createdAt: "2026-07-10T01:00:00.000Z",
			totalCents: 1000,
		});
		await server.seedOrder({
			id: "ord-2",
			state: "paid",
			currency: "USD",
			buyerRef: "bob@example.com",
			createdAt: "2026-07-11T01:00:00.000Z",
			totalCents: 2000,
		});
		await server.seedOrder({
			id: "ord-3",
			state: "paid",
			currency: "USD",
			buyerRef: "carol@example.com",
			createdAt: "2026-07-12T01:00:00.000Z",
			totalCents: 3000,
		});
		await server.seedOrder({
			id: "ord-cancel",
			state: "cancelled",
			currency: "USD",
			buyerRef: "dave@example.com",
			createdAt: "2026-07-11T12:00:00.000Z",
			totalCents: 9999,
			reconciliationFlag: "manual review",
		});
	}

	test("GET /admin/orders lists newest-first with the summary projection (integer cents)", async () => {
		await seed();
		const body = await json(await get("/orders"));
		expect(body.ok).toBe(true);
		const orders = body.orders as Array<Record<string, unknown>>;
		// Newest-first across all four.
		expect(orders.map((o) => o.id)).toEqual(["ord-3", "ord-cancel", "ord-2", "ord-1"]);
		const first = orders[0]!;
		expect(first).toMatchObject({
			id: "ord-3",
			state: "paid",
			currency: "USD",
			buyerRef: "carol@example.com",
			totalCents: 3000,
			reconciliationFlag: false,
			createdAt: "2026-07-12T01:00:00.000Z",
		});
		// The reconciliation badge is a boolean on the distractor.
		const cancel = orders.find((o) => o.id === "ord-cancel")!;
		expect(cancel.reconciliationFlag).toBe(true);
		expect(cancel.state).toBe("cancelled");
		expect(body.nextCursor).toBeNull();
	});

	test("state + date-window + search filters compose ([from,to) half-open)", async () => {
		await seed();
		// Half-open: to = 2026-07-12T01:00:00Z EXCLUDES ord-3 (created exactly at to).
		const body = await json(
			await get("/orders?states=paid&from=2026-07-10T00:00:00.000Z&to=2026-07-12T01:00:00.000Z"),
		);
		const orders = body.orders as Array<Record<string, unknown>>;
		expect(orders.map((o) => o.id)).toEqual(["ord-2", "ord-1"]); // ord-3 excluded, cancel excluded

		// Search by exact order id.
		const byId = (await json(await get("/orders?search=ord-2"))).orders as Array<
			Record<string, unknown>
		>;
		expect(byId.map((o) => o.id)).toEqual(["ord-2"]);

		// Search by buyer_ref, case-insensitive.
		const byRef = (await json(await get("/orders?search=ALICE@example.com"))).orders as Array<
			Record<string, unknown>
		>;
		expect(byRef.map((o) => o.id)).toEqual(["ord-1"]);
	});

	test("keyset cursor round-trips and preserves the filter across pages (no overlap/gap)", async () => {
		await seed();
		const page1 = await json(await get("/orders?states=paid&limit=2"));
		const p1 = page1.orders as Array<Record<string, unknown>>;
		expect(p1.map((o) => o.id)).toEqual(["ord-3", "ord-2"]); // newest paid first, cancel excluded
		expect(typeof page1.nextCursor).toBe("string");

		const page2 = await json(
			await get(`/orders?cursor=${encodeURIComponent(page1.nextCursor as string)}`),
		);
		const p2 = page2.orders as Array<Record<string, unknown>>;
		// The filter (states=paid) SURVIVES the cursor: the cancelled distractor is
		// never surfaced, and the remainder is exactly ord-1.
		expect(p2.map((o) => o.id)).toEqual(["ord-1"]);
		expect(page2.nextCursor).toBeNull();
		// Union is the full paid set newest-first, no dup.
		expect([...p1, ...p2].map((o) => o.id)).toEqual(["ord-3", "ord-2", "ord-1"]);
	});

	test("GET /admin/orders/:id returns the full order + createdAt/customerId + allowedTransitions", async () => {
		await seed();
		const body = await json(await get("/orders/ord-1"));
		expect(body.ok).toBe(true);
		const order = body.order as Record<string, unknown>;
		expect(order.id).toBe("ord-1");
		expect(order.createdAt).toBe("2026-07-10T01:00:00.000Z");
		expect(order.customerId).toBe("cust-a");
		// allowedTransitions is the domain state machine for `paid`.
		expect(body.allowedTransitions).toEqual(["processing", "completed", "cancelled", "refunded"]);
	});

	test("GET /admin/orders/:id 404s for an unknown order", async () => {
		const res = await get("/orders/does-not-exist");
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("ORDER_NOT_FOUND");
	});

	test("guard: no token ⇒ 401 on both list and detail", async () => {
		expect((await get("/orders", {})).status).toBe(401);
		expect((await get("/orders/ord-1", {})).status).toBe(401);
	});

	test("guard: a server with no configured internal token ⇒ 503 (disabled, not open)", async () => {
		const disabled = await startTestServer({ internalToken: null });
		try {
			const res = await fetch(`${disabled.baseUrl}/admin/orders`);
			expect(res.status).toBe(503);
		} finally {
			await disabled.stop();
		}
	});

	test("MOD-1: a garbage/tampered cursor fails closed with 400 (never 500)", async () => {
		// Non-base64 garbage.
		expect((await get("/orders?cursor=%21%21%21not-base64%21%21%21")).status).toBe(400);
		// Well-formed base64url but not JSON.
		const notJson = Buffer.from("this is not json", "utf8").toString("base64url");
		expect((await get(`/orders?cursor=${notJson}`)).status).toBe(400);
		// Structurally valid but the embedded filter is invalid (unknown state) —
		// re-validated through zod ⇒ 400.
		const badFilter = b64url({
			pos: { createdAt: "2026-07-12T01:00:00.000Z", id: "ord-3" },
			filter: { states: ["bogus-state"] },
			limit: 25,
		});
		expect((await get(`/orders?cursor=${badFilter}`)).status).toBe(400);
		// A cursor whose pos.createdAt is not a valid ISO datetime ⇒ 400.
		const badCreatedAt = b64url({
			pos: { createdAt: "not-a-timestamp", id: "ord-3" },
			filter: {},
			limit: 25,
		});
		expect((await get(`/orders?cursor=${badCreatedAt}`)).status).toBe(400);
	});

	test("MOD-1: a decoded out-of-range limit is clamped, not honored (no 400/500)", async () => {
		await seed();
		// A hand-crafted cursor positioned before everything, with an absurd limit.
		const cursor = b64url({
			pos: { createdAt: "2999-01-01T00:00:00.000Z", id: "zzzz" },
			filter: {},
			limit: 999_999,
		});
		const res = await get(`/orders?cursor=${cursor}`);
		expect(res.status).toBe(200); // clamped to the max, request still succeeds
		const orders = (await json(res)).orders as Array<Record<string, unknown>>;
		expect(orders.map((o) => o.id)).toEqual(["ord-3", "ord-cancel", "ord-2", "ord-1"]);
	});
});
