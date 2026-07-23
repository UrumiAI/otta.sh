import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin Coupons console (view-only, admin-UX Increment 3): wire ⇄ port
// fidelity for GET /admin/coupons (list, keyset cursor round-trip preserving
// the filter), against a LIVE server backed by Postgres. Guards: no token ⇒
// 401, no configured token ⇒ 503. Cursor fail-closed (MOD-1): a garbage/
// tampered cursor ⇒ 400; a decoded out-of-range limit is clamped, not
// honored. Mirrors admin-products-http.test.ts's shape.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

/** Encode an opaque cursor the way the route does (base64url of the JSON) so a
 *  test can craft a tampered/out-of-range token. */
function b64url(payload: unknown): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe.skipIf(PG === undefined)("admin Coupons console HTTP contract", () => {
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
		// Three coupons across three creation times, plus a redeemed one so the
		// usesCount indicator is exercised.
		await server.seedCouponRow({
			id: "cpn-1",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
			maxUses: 10,
			usesCount: 0,
			createdAt: "2026-07-10T01:00:00.000Z",
		});
		await server.seedCouponRow({
			id: "cpn-2",
			code: "TEN-OFF",
			type: "percentage",
			rateBps: 1000,
			capCents: 2000,
			// Validity window: the list wire MUST carry it (PR #74 review) — the
			// console renders the expiry column straight off the summary row.
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: "2026-08-01T00:00:00.000Z",
			maxUses: 5,
			usesCount: 2,
			createdAt: "2026-07-11T01:00:00.000Z",
		});
		await server.seedCouponRow({
			id: "cpn-3",
			code: "WELCOME",
			type: "fixed_amount",
			amountCents: 1000,
			currency: "USD",
			createdAt: "2026-07-12T01:00:00.000Z",
		});
	}

	test("GET /admin/coupons lists newest-first with the summary projection (integer cents, usesCount as the redeemed indicator)", async () => {
		await seed();
		const body = await json(await get("/coupons"));
		expect(body.ok).toBe(true);
		const coupons = body.coupons as Array<Record<string, unknown>>;
		expect(coupons.map((c) => c.id)).toEqual(["cpn-3", "cpn-2", "cpn-1"]);
		const redeemed = coupons.find((c) => c.id === "cpn-2")!;
		expect(redeemed).toMatchObject({
			id: "cpn-2",
			code: "TEN-OFF",
			type: "percentage",
			rateBps: 1000,
			capCents: 2000,
			// The validity window is ON the list wire (PR #74 review) — dropping
			// it would force the console into a per-row detail fetch.
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: "2026-08-01T00:00:00.000Z",
			maxUses: 5,
			usesCount: 2,
			createdAt: "2026-07-11T01:00:00.000Z",
		});
		const unredeemed = coupons.find((c) => c.id === "cpn-1")!;
		expect(unredeemed.usesCount).toBe(0);
		// A coupon with no window carries EXPLICIT nulls — present unconditionally
		// on the wire, never "sometimes absent".
		expect(unredeemed.startsAt).toBeNull();
		expect(unredeemed.expiresAt).toBeNull();
		expect(body.nextCursor).toBeNull();
	});

	test("search matches an EXACT code, case-insensitively (never a substring)", async () => {
		await seed();
		const exact = await json(await get("/coupons?search=save5"));
		expect((exact.coupons as Array<Record<string, unknown>>).map((c) => c.id)).toEqual(["cpn-1"]);

		const partial = await json(await get("/coupons?search=save"));
		expect(partial.coupons as Array<Record<string, unknown>>).toEqual([]);
	});

	test("keyset cursor round-trips and preserves the filter across pages (no overlap/gap)", async () => {
		await seed();
		const page1 = await json(await get("/coupons?limit=2"));
		const p1 = page1.coupons as Array<Record<string, unknown>>;
		expect(p1.map((c) => c.id)).toEqual(["cpn-3", "cpn-2"]);
		expect(typeof page1.nextCursor).toBe("string");

		const page2 = await json(
			await get(`/coupons?cursor=${encodeURIComponent(page1.nextCursor as string)}`),
		);
		const p2 = page2.coupons as Array<Record<string, unknown>>;
		expect(p2.map((c) => c.id)).toEqual(["cpn-1"]);
		expect(page2.nextCursor).toBeNull();
		expect([...p1, ...p2].map((c) => c.id)).toEqual(["cpn-3", "cpn-2", "cpn-1"]);
	});

	test("guard: no token ⇒ 401", async () => {
		expect((await get("/coupons", {})).status).toBe(401);
	});

	test("guard: a server with no configured internal token ⇒ 503 (disabled, not open)", async () => {
		const disabled = await startTestServer({ internalToken: null });
		try {
			const res = await fetch(`${disabled.baseUrl}/admin/coupons`);
			expect(res.status).toBe(503);
		} finally {
			await disabled.stop();
		}
	});

	test("MOD-1: a garbage/tampered cursor fails closed with 400 (never 500)", async () => {
		expect((await get("/coupons?cursor=%21%21%21not-base64%21%21%21")).status).toBe(400);
		const notJson = Buffer.from("this is not json", "utf8").toString("base64url");
		expect((await get(`/coupons?cursor=${notJson}`)).status).toBe(400);
		// A cursor whose pos.createdAt is not a valid ISO datetime ⇒ 400.
		const badCreatedAt = b64url({
			pos: { createdAt: "not-a-timestamp", couponId: "cpn-3" },
			filter: {},
			limit: 25,
		});
		expect((await get(`/coupons?cursor=${badCreatedAt}`)).status).toBe(400);
	});

	test("MOD-1: a decoded out-of-range limit is clamped, not honored (no 400/500)", async () => {
		await seed();
		const cursor = b64url({
			pos: { createdAt: "2999-01-01T00:00:00.000Z", couponId: "zzzz" },
			filter: {},
			limit: 999_999,
		});
		const res = await get(`/coupons?cursor=${cursor}`);
		expect(res.status).toBe(200); // clamped to the max, request still succeeds
		const coupons = (await json(res)).coupons as Array<Record<string, unknown>>;
		expect(coupons.map((c) => c.id)).toEqual(["cpn-3", "cpn-2", "cpn-1"]);
	});
});
