import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

const PG = process.env.PG_CONNECTION_STRING;

interface JsonResponse {
	status: number;
	body: Record<string, unknown> | null;
}

describe.skipIf(PG === undefined)("HTTP product-commerce contract [live server, Postgres]", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startTestServer();
	});
	afterAll(async () => {
		await server.stop();
	});

	async function put(
		id: string,
		body: unknown,
		headers: Record<string, string> = {},
	): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}/products/${id}/commerce`, {
			method: "PUT",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> | null };
	}

	function get(id: string): Promise<JsonResponse> {
		return fetch(`${server.baseUrl}/products/${id}/commerce`).then(async (res) => ({
			status: res.status,
			body: (await res.json()) as Record<string, unknown> | null,
		}));
	}

	function del(id: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
		return fetch(`${server.baseUrl}/products/${id}/commerce`, { method: "DELETE", headers }).then(
			async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }),
		);
	}

	test("PUT upserts a product_commerce row keyed by the CMS id (wire ⇄ port fidelity)", async () => {
		const res = await put(
			"prod-http-1",
			{
				sku: "SKU-H1",
				price: { amount: 1999, currency: "USD" },
				productKind: "physical",
			},
			{ "Idempotency-Key": "k1" },
		);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			productId: "prod-http-1",
			sku: "SKU-H1",
			price: { amount: 1999, currency: "USD" },
			productKind: "physical",
			active: false,
			deletedAt: null,
		});
	});

	test("replay with the same Idempotency-Key is a no-op returning the existing row unchanged", async () => {
		const first = await put(
			"prod-http-2",
			{ sku: "SKU-H2", price: { amount: 500, currency: "USD" } },
			{ "Idempotency-Key": "k2" },
		);
		const replay = await put(
			"prod-http-2",
			{ sku: "SKU-H2-CHANGED", price: { amount: 999999, currency: "USD" } },
			{ "Idempotency-Key": "k2" },
		);
		expect(replay.body).toEqual(first.body);
	});

	test("PUT on first creation with initialOnHand seeds inventory on_hand once", async () => {
		await put(
			"prod-http-3",
			{ sku: "SKU-H3", price: { amount: 100, currency: "USD" }, initialOnHand: 25 },
			{ "Idempotency-Key": "k3" },
		);
		expect(await server.onHand("SKU-H3")).toBe(25);

		// A later edit must not reseed even if it supplies a new figure.
		await put(
			"prod-http-3",
			{ price: { amount: 150, currency: "USD" }, initialOnHand: 999 },
			{ "Idempotency-Key": "k3b" },
		);
		expect(await server.onHand("SKU-H3")).toBe(25);
	});

	test("GET reads the row back; unknown product_id returns 200 with a null body (not purchasable, not a hard 404)", async () => {
		await put(
			"prod-http-4",
			{ sku: "SKU-H4", price: { amount: 250, currency: "USD" } },
			{ "Idempotency-Key": "k4" },
		);
		const found = await get("prod-http-4");
		expect(found.status).toBe(200);
		expect(found.body).toMatchObject({ productId: "prod-http-4", sku: "SKU-H4" });

		const missing = await get("does-not-exist");
		expect(missing.status).toBe(200);
		expect(missing.body).toBeNull();
	});

	test("DELETE soft-deletes: deletedAt set, active false, row retained (readable via GET)", async () => {
		await put(
			"prod-http-5",
			{ sku: "SKU-H5", price: { amount: 400, currency: "USD" } },
			{ "Idempotency-Key": "k5" },
		);
		const del1 = await del("prod-http-5", { "Idempotency-Key": "del-1" });
		expect(del1.status).toBe(200);
		expect(del1.body).toEqual({ ok: true });

		const read = await get("prod-http-5");
		expect(read.body).toMatchObject({ active: false, sku: "SKU-H5" });
		expect(read.body?.deletedAt).not.toBeNull();
	});

	test("PUT with a missing Idempotency-Key header returns 400", async () => {
		const res = await put("prod-http-6", { sku: "SKU-H6" });
		expect(res.status).toBe(400);
	});

	test("PUT with a schema-invalid body (bad currency) returns 400", async () => {
		const res = await put(
			"prod-http-7",
			{ price: { amount: 100, currency: "usd" } },
			{ "Idempotency-Key": "k7" },
		);
		expect(res.status).toBe(400);
	});

	test("DELETE with a missing Idempotency-Key header returns 400", async () => {
		const res = await del("prod-http-8");
		expect(res.status).toBe(400);
	});
});
