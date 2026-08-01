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
		// Every bucket carries BOTH figures, `refundedCents` alongside — never
		// netted into — `revenueCents` (INC-23). 07-10 USD shows a partial refund
		// on an order whose full 1000 still counts as revenue; 07-12 USD shows a
		// fully refunded order's 6666, money the revenue allow-list excludes and
		// which no endpoint reported at all before this.
		expect(body.buckets).toEqual([
			{
				bucketStart: "2026-07-10T00:00:00.000Z",
				currency: "EUR",
				revenueCents: 3000,
				refundedCents: 300,
			},
			{
				bucketStart: "2026-07-10T00:00:00.000Z",
				currency: "USD",
				revenueCents: 3000,
				refundedCents: 250,
			},
			{
				bucketStart: "2026-07-11T00:00:00.000Z",
				currency: "EUR",
				revenueCents: 2500,
				refundedCents: 0,
			},
			{
				bucketStart: "2026-07-11T00:00:00.000Z",
				currency: "USD",
				revenueCents: 5500,
				refundedCents: 0,
			},
			{
				bucketStart: "2026-07-12T00:00:00.000Z",
				currency: "EUR",
				revenueCents: 3500,
				refundedCents: 0,
			},
			{
				bucketStart: "2026-07-12T00:00:00.000Z",
				currency: "USD",
				revenueCents: 3000,
				refundedCents: 6666,
			},
		]);
	});

	test("GET /reports/revenue emits refundedCents as a KEY even at zero — absence is what means 'not reported'", async () => {
		const body = await json(await get(`/revenue?from=${FROM}&to=${TO}&interval=day`));
		const buckets = body.buckets as Array<Record<string, unknown>>;
		const zeroBucket = buckets.find(
			(b) => b.bucketStart === "2026-07-11T00:00:00.000Z" && b.currency === "EUR",
		);
		// `in`, not a truthiness/`?? 0` read: a client distinguishes "no refunds"
		// from "this service predates the field" by the key, never by the value.
		expect(zeroBucket !== undefined && "refundedCents" in zeroBucket).toBe(true);
		expect(zeroBucket?.refundedCents).toBe(0);
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

	test("GET /reports/low-stock carries the LIVE product title; null when unknown and NEVER the sku", async () => {
		// The shared fixture seeds inventory but no products, so titles start null.
		const before = await json(await get("/low-stock"));
		const rowsBefore = before.rows as Array<Record<string, unknown>>;
		for (const r of rowsBefore) {
			expect(Object.hasOwn(r, "title")).toBe(true);
			expect(r.title).toBeNull();
			// The one fallback that must never happen: the sku standing in as a name.
			expect(r.title).not.toBe(r.sku);
		}

		await server.seedProductRow({
			id: "p-live-a",
			sku: "SKU-A",
			title: "Alpha Widget",
			priceCents: 100,
			active: true,
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		// A product whose own title is null stays null — not the sku.
		await server.seedProductRow({
			id: "p-live-b",
			sku: "SKU-B",
			title: null,
			priceCents: 100,
			active: true,
			createdAt: "2026-07-10T00:00:00.000Z",
		});

		const after = await json(await get("/low-stock"));
		const rows = after.rows as Array<Record<string, unknown>>;
		const bySku = new Map(rows.map((r) => [r.sku, r]));
		expect(bySku.get("SKU-A")?.title).toBe("Alpha Widget");
		expect(bySku.get("SKU-B")?.title).toBeNull();
		expect(bySku.get("SKU-B")?.title).not.toBe("SKU-B");
	});

	test("GET /reports/low-stock: a soft-deleted product sharing a live sku neither duplicates the row nor titles it", async () => {
		// Legal state: sku uniqueness on product_commerce is a PARTIAL index over
		// live rows, so a tombstone may hold a sku a live row also holds. The join
		// must see only the live row.
		await server.seedProductRow({
			id: "p-dead-c",
			sku: "SKU-C",
			title: "Gamma Sprocket (old)",
			priceCents: 100,
			active: true,
			createdAt: "2026-07-09T00:00:00.000Z",
			deletedAt: "2026-07-09T12:00:00.000Z",
		});
		await server.seedProductRow({
			id: "p-live-c",
			sku: "SKU-C",
			title: "Gamma Sprocket",
			priceCents: 100,
			active: true,
			createdAt: "2026-07-10T00:00:00.000Z",
		});
		// SKU-E gets ONLY a tombstone: the low-stock row still lists (inventory is
		// the driving table) but a dead product cannot supply its title.
		await server.seedProductRow({
			id: "p-dead-e",
			sku: "SKU-E",
			title: "Epsilon Ghost",
			priceCents: 100,
			active: true,
			createdAt: "2026-07-09T00:00:00.000Z",
			deletedAt: "2026-07-09T12:00:00.000Z",
		});

		const rows = (await json(await get("/low-stock"))).rows as Array<Record<string, unknown>>;
		expect(rows.filter((r) => r.sku === "SKU-C")).toHaveLength(1);
		expect(rows.find((r) => r.sku === "SKU-C")?.title).toBe("Gamma Sprocket");
		expect(rows.filter((r) => r.sku === "SKU-E")).toHaveLength(1);
		expect(rows.find((r) => r.sku === "SKU-E")?.title).toBeNull();
		// And the page as a whole did not grow: still one row per low-stock sku.
		expect(rows.map((r) => r.sku)).toEqual(["SKU-A", "SKU-B", "SKU-C", "SKU-E"]);
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
