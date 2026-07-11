import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Phase 7 §7 Step 5: wire ⇄ port fidelity for /reports/*, against a LIVE server
// backed by Postgres, seeded with the shared reporting fixture.

const PG = process.env.PG_CONNECTION_STRING;
const FROM = "2026-07-10T00:00:00.000Z";
const TO = "2026-07-12T23:59:59.999Z";

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("reports HTTP contract", () => {
	let server: TestServer;
	let token: string;
	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
		await server.seedReportingFixture();
	});
	afterEach(async () => {
		await server.stop();
	});

	function get(path: string): Promise<Response> {
		return fetch(`${server.baseUrl}/reports${path}`, { headers: { "X-Internal-Token": token } });
	}

	test("GET /reports/revenue returns per-day buckets grouped by currency, integer cents", async () => {
		const body = await json(await get(`/revenue?from=${FROM}&to=${TO}&interval=day`));
		expect(body.ok).toBe(true);
		expect(body.buckets).toEqual([
			{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "EUR", revenueCents: 3000 },
			{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "USD", revenueCents: 3000 },
			{ bucketStart: "2026-07-11T00:00:00.000Z", currency: "EUR", revenueCents: 2500 },
			{ bucketStart: "2026-07-11T00:00:00.000Z", currency: "USD", revenueCents: 5500 },
			{ bucketStart: "2026-07-12T00:00:00.000Z", currency: "EUR", revenueCents: 3500 },
			{ bucketStart: "2026-07-12T00:00:00.000Z", currency: "USD", revenueCents: 3000 },
		]);
	});

	test("GET /reports/orders-by-status counts every state including expired", async () => {
		const body = await json(await get(`/orders-by-status?from=${FROM}&to=${TO}`));
		expect(body.counts).toEqual([
			{ status: "cancelled", orderCount: 1 },
			{ status: "completed", orderCount: 1 },
			{ status: "delivered", orderCount: 1 },
			{ status: "expired", orderCount: 1 },
			{ status: "failed", orderCount: 1 },
			{ status: "paid", orderCount: 3 },
			{ status: "pending", orderCount: 1 },
			{ status: "processing", orderCount: 2 },
			{ status: "refunded", orderCount: 1 },
			{ status: "shipped", orderCount: 2 },
		]);
	});

	test("GET /reports/top-products respects metric and limit query params", async () => {
		const byRevenue = await json(
			await get(`/top-products?from=${FROM}&to=${TO}&metric=revenue&limit=2`),
		);
		expect((byRevenue.products as Array<Record<string, unknown>>).map((p) => p.productId)).toEqual([
			"p2",
			"p4",
		]);
		const byQty = await json(
			await get(`/top-products?from=${FROM}&to=${TO}&metric=quantity&limit=2`),
		);
		expect((byQty.products as Array<Record<string, unknown>>).map((p) => p.productId)).toEqual([
			"p1",
			"p3",
		]);
		// Snapshot title travels on the wire.
		expect((byQty.products as Array<Record<string, unknown>>)[0]?.titleSnapshot).toBe("Widget");
	});

	test("GET /reports/low-stock defaults the threshold from settings and honors an override", async () => {
		// Default settings.lowStockThreshold = 5.
		const dflt = await json(await get("/low-stock"));
		expect((dflt.rows as Array<Record<string, unknown>>).map((r) => r.sku)).toEqual([
			"SKU-A",
			"SKU-B",
			"SKU-C",
			"SKU-E",
		]);
		const override = await json(await get("/low-stock?threshold=0"));
		expect((override.rows as Array<Record<string, unknown>>).map((r) => r.sku)).toEqual(["SKU-A"]);
	});

	test("GET /reports/revenue with a from/to range over 400 days returns 400 with a structured validation error", async () => {
		const res = await get(`/revenue?from=2024-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`);
		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.ok).toBe(false);
		expect(body.error).toBe("range_too_wide");
		expect(body.maxDays).toBe(400);
	});

	test("GET /reports/orders-by-status and /top-products also reject a >400-day range", async () => {
		const wide = `from=2024-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`;
		expect((await get(`/orders-by-status?${wide}`)).status).toBe(400);
		expect((await get(`/top-products?${wide}`)).status).toBe(400);
	});

	test("GET /reports/revenue with a malformed date returns 400", async () => {
		const res = await get(`/revenue?from=not-a-date&to=${TO}`);
		expect(res.status).toBe(400);
	});

	test("SECURITY: /reports/* without the internal token is rejected (merchant data is not public)", async () => {
		// No token header — every report endpoint must refuse (401), not leak data.
		for (const path of [
			`/revenue?from=${FROM}&to=${TO}`,
			`/orders-by-status?from=${FROM}&to=${TO}`,
			`/top-products?from=${FROM}&to=${TO}`,
			"/low-stock",
		]) {
			const res = await fetch(`${server.baseUrl}/reports${path}`);
			expect(res.status).toBe(401);
		}
		// With the token, the same read succeeds.
		expect((await get(`/revenue?from=${FROM}&to=${TO}`)).status).toBe(200);
	});
});
