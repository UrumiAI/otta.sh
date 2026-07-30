import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Admin Products console (view-only, admin-UX Increment 2): wire ⇄ port
// fidelity for GET /admin/products (list, keyset cursor round-trip preserving
// the filter) and GET /admin/products/:id (detail + stock, 404), against a
// LIVE server backed by Postgres. Guards: no token ⇒ 401, no configured token
// ⇒ 503. Cursor fail-closed (MOD-1): a garbage/tampered cursor ⇒ 400; a
// decoded out-of-range limit is clamped, not honored. Mirrors
// admin-orders-http.test.ts's shape.

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

/** Encode an opaque cursor the way the route does (base64url of the JSON) so a
 *  test can craft a tampered/out-of-range token. */
function b64url(payload: unknown): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe.skipIf(PG === undefined)("admin Products console HTTP contract", () => {
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
		// Three live USD products across three creation times + an inactive
		// digital distractor inside the same window (to prove filters survive
		// paging), plus a soft-deleted row that must never surface.
		await server.seedProductRow({
			id: "prod-1",
			sku: "SKU-1",
			title: "Blue Widget",
			priceCents: 1000,
			currency: "USD",
			productKind: "physical",
			active: true,
			createdAt: "2026-07-10T01:00:00.000Z",
		});
		await server.seedProductRow({
			id: "prod-2",
			sku: "SKU-2",
			title: "Red Gadget",
			priceCents: 2000,
			currency: "USD",
			productKind: "physical",
			active: true,
			createdAt: "2026-07-11T01:00:00.000Z",
		});
		await server.seedProductRow({
			id: "prod-3",
			sku: "SKU-3",
			title: "Green Sprocket",
			priceCents: 3000,
			currency: "USD",
			productKind: "physical",
			active: true,
			createdAt: "2026-07-12T01:00:00.000Z",
		});
		await server.seedProductRow({
			id: "prod-ebook",
			sku: "SKU-EBOOK",
			title: "Findable Ebook",
			priceCents: 999,
			currency: "USD",
			productKind: "digital",
			active: false,
			createdAt: "2026-07-11T12:00:00.000Z",
		});
		await server.seedProductRow({
			id: "prod-deleted",
			sku: "SKU-DEL",
			title: "Deleted Product",
			priceCents: 100,
			currency: "USD",
			active: true,
			createdAt: "2026-07-13T00:00:00.000Z",
			deletedAt: "2026-07-13T01:00:00.000Z",
		});
	}

	test("GET /admin/products lists newest-first with the summary projection (integer cents), excluding soft-deleted rows", async () => {
		await seed();
		const body = await json(await get("/products"));
		expect(body.ok).toBe(true);
		const products = body.products as Array<Record<string, unknown>>;
		// Newest-first across the four LIVE rows; the soft-deleted one is absent.
		expect(products.map((p) => p.productId)).toEqual(["prod-3", "prod-ebook", "prod-2", "prod-1"]);
		const first = products[0]!;
		expect(first).toMatchObject({
			productId: "prod-3",
			sku: "SKU-3",
			title: "Green Sprocket",
			priceCents: 3000,
			currency: "USD",
			productKind: "physical",
			active: true,
			createdAt: "2026-07-12T01:00:00.000Z",
		});
		expect(products.some((p) => p.productId === "prod-deleted")).toBe(false);
		expect(body.nextCursor).toBeNull();
	});

	test("a CMS product that was never priced (no sku, no price) IS listed — PR 1b makes this row reachable", async () => {
		await seed();
		// Before "one home per field" this row could not exist: the CMS sync
		// refused to mint a row without a sku, so a product created in the CMS and
		// not yet priced was INVISIBLE in Pricing & inventory and there was no way
		// to price it from the console. Now every CMS product has a row, and it
		// must show up here — unpriced, waiting for a SKU and a price.
		await server.seedProductRow({
			id: "prod-unpriced",
			sku: null,
			title: "Freshly Created",
			priceCents: null,
			active: true,
			createdAt: "2026-07-14T00:00:00.000Z",
		});

		const body = await json(await get("/products"));
		const products = body.products as Array<Record<string, unknown>>;
		const row = products.find((p) => p.productId === "prod-unpriced");
		expect(row).toBeDefined();
		expect(row).toMatchObject({
			productId: "prod-unpriced",
			sku: null,
			title: "Freshly Created",
			priceCents: null,
			active: true,
		});
		// It is listed in the ADMIN console but is not sellable: the catalog read
		// (`listCommerceByIds`) filters commerce-incomplete rows, which is what
		// the admin's "active (not priced)" status label reports.
		const detail = await json(await get("/products/prod-unpriced"));
		expect(detail.ok).toBe(true);
		expect(detail.product).toMatchObject({ sku: null, priceCents: null, active: true });
	});

	test("active + productKind + search filters compose", async () => {
		await seed();
		const activeOnly = await json(await get("/products?active=true"));
		const activeIds = (activeOnly.products as Array<Record<string, unknown>>).map(
			(p) => p.productId,
		);
		expect(activeIds.toSorted()).toEqual(["prod-1", "prod-2", "prod-3"]);

		const digitalOnly = await json(await get("/products?productKind=digital"));
		expect(
			(digitalOnly.products as Array<Record<string, unknown>>).map((p) => p.productId),
		).toEqual(["prod-ebook"]);

		// Search by exact sku, case-insensitive.
		const bySku = (await json(await get("/products?search=sku-2"))).products as Array<
			Record<string, unknown>
		>;
		expect(bySku.map((p) => p.productId)).toEqual(["prod-2"]);

		// Search by a title substring, case-insensitive.
		const byTitle = (await json(await get("/products?search=WIDGET"))).products as Array<
			Record<string, unknown>
		>;
		expect(byTitle.map((p) => p.productId)).toEqual(["prod-1"]);

		// Composed: active + digital + search.
		const composed = await json(
			await get("/products?active=false&productKind=digital&search=ebook"),
		);
		expect((composed.products as Array<Record<string, unknown>>).map((p) => p.productId)).toEqual([
			"prod-ebook",
		]);
	});

	test("keyset cursor round-trips and preserves the filter across pages (no overlap/gap)", async () => {
		await seed();
		const page1 = await json(await get("/products?productKind=physical&limit=2"));
		const p1 = page1.products as Array<Record<string, unknown>>;
		expect(p1.map((p) => p.productId)).toEqual(["prod-3", "prod-2"]); // newest physical first
		expect(typeof page1.nextCursor).toBe("string");

		const page2 = await json(
			await get(`/products?cursor=${encodeURIComponent(page1.nextCursor as string)}`),
		);
		const p2 = page2.products as Array<Record<string, unknown>>;
		// The filter (productKind=physical) SURVIVES the cursor: the digital
		// distractor is never surfaced, and the remainder is exactly prod-1.
		expect(p2.map((p) => p.productId)).toEqual(["prod-1"]);
		expect(page2.nextCursor).toBeNull();
		expect([...p1, ...p2].map((p) => p.productId)).toEqual(["prod-3", "prod-2", "prod-1"]);
	});

	test("GET /admin/products/:id returns the full detail incl. stock", async () => {
		await seed();
		await server.seed("SKU-1", 42);
		const body = await json(await get("/products/prod-1"));
		expect(body.ok).toBe(true);
		const product = body.product as Record<string, unknown>;
		expect(product).toMatchObject({
			productId: "prod-1",
			sku: "SKU-1",
			title: "Blue Widget",
			priceCents: 1000,
			currency: "USD",
			productKind: "physical",
			active: true,
			onHand: 42,
		});
	});

	test("GET /admin/products/:id with no inventory row reports onHand:0 (never a throw)", async () => {
		await seed();
		const body = await json(await get("/products/prod-2"));
		expect(body.ok).toBe(true);
		expect((body.product as Record<string, unknown>).onHand).toBe(0);
	});

	test("GET /admin/products/:id 404s for an unknown product", async () => {
		const res = await get("/products/does-not-exist");
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("PRODUCT_NOT_FOUND");
	});

	test("GET /admin/products/:id returns the read-only tombstone (200 + deletedAt) for a soft-deleted product — never masquerades as 'never existed' (product lifecycle surfacing)", async () => {
		await seed();
		const res = await get("/products/prod-deleted");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.ok).toBe(true);
		const product = body.product as Record<string, unknown>;
		expect(product.productId).toBe("prod-deleted");
		expect(product.deletedAt).toBe("2026-07-13T01:00:00.000Z");
	});

	test("GET /admin/products excludes the archive by default; filter.deleted=true is the archive-only view, projecting deletedAt", async () => {
		await seed();
		const live = await json(await get("/products"));
		expect(
			(live.products as Array<Record<string, unknown>>).every((p) => p.deletedAt === null),
		).toBe(true);
		expect(
			(live.products as Array<Record<string, unknown>>).some((p) => p.productId === "prod-deleted"),
		).toBe(false);

		const archived = await json(await get("/products?deleted=true"));
		const archivedProducts = archived.products as Array<Record<string, unknown>>;
		expect(archivedProducts.map((p) => p.productId)).toEqual(["prod-deleted"]);
		expect(archivedProducts[0]?.deletedAt).toBe("2026-07-13T01:00:00.000Z");
	});

	test("a soft-deleted product remains blocked from the WRITE routes (edit / restock / remove-stock) — 404, never editable from the tombstone view", async () => {
		await seed();
		const patchRes = await fetch(`${server.baseUrl}/admin/products/prod-deleted`, {
			method: "PATCH",
			headers: { "X-Internal-Token": token, "Content-Type": "application/json" },
			body: JSON.stringify({ expectedUpdatedAt: "2026-07-13T00:00:00.000Z", title: "New title" }),
		});
		expect(patchRes.status).toBe(404);
		expect((await json(patchRes)).reason).toBe("PRODUCT_NOT_FOUND");

		const restockRes = await fetch(`${server.baseUrl}/admin/products/prod-deleted/restock`, {
			method: "POST",
			headers: {
				"X-Internal-Token": token,
				"Content-Type": "application/json",
				"Idempotency-Key": "restock-deleted-1",
			},
			body: JSON.stringify({ qty: 5 }),
		});
		expect(restockRes.status).toBe(404);
		expect((await json(restockRes)).reason).toBe("PRODUCT_NOT_FOUND");
	});

	test("guard: no token ⇒ 401 on both list and detail", async () => {
		expect((await get("/products", {})).status).toBe(401);
		expect((await get("/products/prod-1", {})).status).toBe(401);
	});

	test("guard: a server with no configured internal token ⇒ 503 (disabled, not open)", async () => {
		const disabled = await startTestServer({ internalToken: null });
		try {
			const res = await fetch(`${disabled.baseUrl}/admin/products`);
			expect(res.status).toBe(503);
		} finally {
			await disabled.stop();
		}
	});

	test("MOD-1: a garbage/tampered cursor fails closed with 400 (never 500)", async () => {
		expect((await get("/products?cursor=%21%21%21not-base64%21%21%21")).status).toBe(400);
		const notJson = Buffer.from("this is not json", "utf8").toString("base64url");
		expect((await get(`/products?cursor=${notJson}`)).status).toBe(400);
		// Structurally valid but the embedded filter is invalid (unknown kind) —
		// re-validated through zod ⇒ 400.
		const badFilter = b64url({
			pos: { createdAt: "2026-07-12T01:00:00.000Z", productId: "prod-3" },
			filter: { productKind: "bogus-kind" },
			limit: 25,
		});
		expect((await get(`/products?cursor=${badFilter}`)).status).toBe(400);
		// A cursor whose pos.createdAt is not a valid ISO datetime ⇒ 400.
		const badCreatedAt = b64url({
			pos: { createdAt: "not-a-timestamp", productId: "prod-3" },
			filter: {},
			limit: 25,
		});
		expect((await get(`/products?cursor=${badCreatedAt}`)).status).toBe(400);
	});

	test("MOD-1: a decoded out-of-range limit is clamped, not honored (no 400/500)", async () => {
		await seed();
		const cursor = b64url({
			pos: { createdAt: "2999-01-01T00:00:00.000Z", productId: "zzzz" },
			filter: {},
			limit: 999_999,
		});
		const res = await get(`/products?cursor=${cursor}`);
		expect(res.status).toBe(200); // clamped to the max, request still succeeds
		const products = (await json(res)).products as Array<Record<string, unknown>>;
		expect(products.map((p) => p.productId)).toEqual(["prod-3", "prod-ebook", "prod-2", "prod-1"]);
	});
});
