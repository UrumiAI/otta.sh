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

	// -- total: the exact size of the filtered set (INC-23) --------------------

	test("GET /admin/orders carries `total` — the whole FILTERED set, identical on every page", async () => {
		await seed();
		const page1 = await json(await get("/orders?states=paid&limit=2"));
		// 3 paid orders behind a 2-row page: the count is of the SET, not the page,
		// which is precisely what a keyset cursor cannot tell a console on its own.
		expect(page1.total).toBe(3);
		expect((page1.orders as unknown[]).length).toBe(2);
		const page2 = await json(
			await get(`/orders?cursor=${encodeURIComponent(page1.nextCursor as string)}`),
		);
		// Page 2 carries the SAME total — the filter rode the cursor, and so did
		// the predicate the count is taken under.
		expect(page2.total).toBe(3);
	});

	test("GET /admin/orders `total` counts under the SAME filter as the rows, and is 0 (present) when nothing matches", async () => {
		await seed();
		const unfiltered = await json(await get("/orders"));
		expect(unfiltered.total).toBe(4); // every seeded order, cancelled included
		const cancelled = await json(await get("/orders?states=cancelled"));
		expect(cancelled.total).toBe(1);
		const none = await json(await get("/orders?search=nobody@example.com"));
		expect(none.orders).toEqual([]);
		// Zero is REPORTED, not omitted: the key's presence is what tells a client
		// "this service counts", and its absence is what means "it cannot".
		expect(none.total).toBe(0);
		expect(Object.hasOwn(none, "total")).toBe(true);
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

	// -- a cursor that disagrees with the query's filters fails CLOSED ----------
	//
	// The token is authoritative for paging AND carries the filter it was minted
	// under, so a request that ALSO spells that filter out in the query string can
	// contradict it. Resolving the contradiction in the token's favour is silent
	// divergence: the address claims one predicate while the rows answer another,
	// and nothing in the response says so. PRESENT filter params must therefore
	// canonicalize to exactly the token's filter; ABSENT ones claim nothing (the
	// cursor-alone request every client sends today must keep working).
	//
	// The four quadrants are pinned below: cursor alone, cursor + agreeing params,
	// cursor + disagreeing params, params alone.

	test("quadrant: cursor + AGREEING filter params pages byte-identically to the cursor ALONE", async () => {
		await seed();
		const page1 = await json(await get("/orders?states=paid&limit=2"));
		const cursor = encodeURIComponent(page1.nextCursor as string);

		const aloneRes = await get(`/orders?cursor=${cursor}`);
		const alone = await aloneRes.text();
		const agreeRes = await get(`/orders?cursor=${cursor}&states=paid`);
		expect(aloneRes.status).toBe(200);
		expect(agreeRes.status).toBe(200);
		// BYTE-identical — same rows, same total, same nextCursor. The agreeing
		// params are redundant, not a second opinion.
		expect(await agreeRes.text()).toBe(alone);
		const parsed = JSON.parse(alone) as { orders: Array<{ id: string }>; total: number };
		expect(parsed.orders.map((o) => o.id)).toEqual(["ord-1"]);
		expect(parsed.total).toBe(3);
	});

	test("quadrant: cursor + DISAGREEING filter params ⇒ 400, never a silently divergent page", async () => {
		await seed();
		// An UNFILTERED first page mints an UNFILTERED token. Paging it with
		// `states=paid` beside it used to answer 200 with the unfiltered set —
		// four orders under an address that claims only the paid ones.
		const unfiltered = await json(await get("/orders?limit=1"));
		const unfilteredCursor = encodeURIComponent(unfiltered.nextCursor as string);
		const res = await get(`/orders?cursor=${unfilteredCursor}&states=paid`);
		expect(res.status).toBe(400);
		expect(await json(res)).toEqual({ error: "cursor filter mismatch" });

		// And the mirror: a FILTERED token under a different states value.
		const paid = await json(await get("/orders?states=paid&limit=1"));
		const paidCursor = encodeURIComponent(paid.nextCursor as string);
		expect((await get(`/orders?cursor=${paidCursor}&states=cancelled`)).status).toBe(400);
		// Every filter axis participates, not just `states`.
		expect((await get(`/orders?cursor=${paidCursor}&states=paid&search=ord-2`)).status).toBe(400);
		expect(
			(await get(`/orders?cursor=${paidCursor}&states=paid&from=2026-07-01T00:00:00.000Z`)).status,
		).toBe(400);
	});

	test("quadrant: filter params ALONE (no cursor) are untouched by the gate", async () => {
		await seed();
		const body = await json(await get("/orders?states=paid"));
		expect((body.orders as Array<Record<string, unknown>>).map((o) => o.id)).toEqual([
			"ord-3",
			"ord-2",
			"ord-1",
		]);
		expect(body.total).toBe(3);
	});

	test("a filter axis the query OMITS is still a disagreement when the token carries it", async () => {
		await seed();
		// The token carries states + a window; the address claims only the states.
		// A subset is not agreement — the rows are narrower than the address says.
		const page1 = await json(
			await get("/orders?states=paid&from=2026-07-10T00:00:00.000Z&limit=2"),
		);
		const cursor = encodeURIComponent(page1.nextCursor as string);
		expect((await get(`/orders?cursor=${cursor}&states=paid`)).status).toBe(400);
		// Spelling BOTH axes out agrees, and pages.
		expect(
			(await get(`/orders?cursor=${cursor}&states=paid&from=2026-07-10T00:00:00.000Z`)).status,
		).toBe(200);
	});

	test("canonicalization: state ORDER, duplicates and datetime SPELLING are not disagreements", async () => {
		await seed();
		const page1 = await json(await get("/orders?states=paid,cancelled&limit=2"));
		const cursor = encodeURIComponent(page1.nextCursor as string);
		const alone = await (await get(`/orders?cursor=${cursor}`)).text();
		// Same SET of states, written in the other order — and with a duplicate.
		expect(await (await get(`/orders?cursor=${cursor}&states=cancelled,paid`)).text()).toBe(alone);
		expect(await (await get(`/orders?cursor=${cursor}&states=paid,paid,cancelled`)).text()).toBe(
			alone,
		);

		// A window bound is an INSTANT, not a string: the same moment spelled with
		// and without the fractional part is the same filter.
		const windowed = await json(
			await get("/orders?states=paid&from=2026-07-10T00:00:00.000Z&limit=2"),
		);
		const windowedCursor = encodeURIComponent(windowed.nextCursor as string);
		const windowedAlone = await (await get(`/orders?cursor=${windowedCursor}`)).text();
		expect(
			await (
				await get(`/orders?cursor=${windowedCursor}&states=paid&from=2026-07-10T00:00:00Z`)
			).text(),
		).toBe(windowedAlone);
	});

	test("a `limit` that disagrees with the token's embedded limit ⇒ 400; an agreeing one pages", async () => {
		await seed();
		const page1 = await json(await get("/orders?states=paid&limit=2"));
		const cursor = encodeURIComponent(page1.nextCursor as string);
		const alone = await (await get(`/orders?cursor=${cursor}`)).text();

		// The shape live clients send today: cursor + the same page limit.
		const agree = await get(`/orders?cursor=${cursor}&limit=2`);
		expect(agree.status).toBe(200);
		expect(await agree.text()).toBe(alone);

		const disagree = await get(`/orders?cursor=${cursor}&limit=5`);
		expect(disagree.status).toBe(400);
		expect(await json(disagree)).toEqual({ error: "cursor filter mismatch" });
	});
});
