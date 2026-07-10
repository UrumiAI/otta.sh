import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * The client-side contract (plan §6 step 6 / DEVELOPMENT.md §3): the SAME
 * behavioral cases the domain/service suites already cover, run here
 * against `HttpCommerceClient` over a LIVE `@urumi/service` (Postgres-
 * backed) — proving the wire format has not drifted from the port.
 */
describe.skipIf(PG === undefined)("HttpCommerceClient [live @urumi/service, Postgres]", () => {
	let service: LiveService;
	let client: HttpCommerceClient;

	beforeAll(async () => {
		service = await startLiveService();
		client = new HttpCommerceClient({ fetch: globalThis.fetch, baseUrl: service.baseUrl });
	});
	afterAll(async () => {
		await service.stop();
	});

	test("upsertProductCommerce creates a row and sends Idempotency-Key as a header", async () => {
		const row = await client.upsertProductCommerce(
			"prod-c1",
			{ sku: "SKU-C1", price: { amount: 1500, currency: "USD" }, productKind: "physical" },
			"k1",
		);
		expect(row).toMatchObject({
			productId: "prod-c1",
			sku: "SKU-C1",
			price: { amount: 1500, currency: "USD" },
			active: false,
			deletedAt: null,
		});
	});

	test("replay with the same Idempotency-Key is a no-op returning the existing row unchanged", async () => {
		const first = await client.upsertProductCommerce(
			"prod-c2",
			{ sku: "SKU-C2", price: { amount: 100, currency: "USD" } },
			"k2",
		);
		const replay = await client.upsertProductCommerce(
			"prod-c2",
			{ sku: "SKU-C2-CHANGED", price: { amount: 999, currency: "USD" } },
			"k2",
		);
		expect(replay).toEqual(first);
	});

	test("getProductCommerce reads the row back; an unknown productId resolves to null (not a thrown error)", async () => {
		await client.upsertProductCommerce("prod-c3", { sku: "SKU-C3" }, "k3");
		const found = await client.getProductCommerce("prod-c3");
		expect(found).toMatchObject({ productId: "prod-c3", sku: "SKU-C3" });

		const missing = await client.getProductCommerce("does-not-exist");
		expect(missing).toBeNull();
	});

	test("softDeleteProductCommerce soft-deletes: retained, active=false, deletedAt set", async () => {
		await client.upsertProductCommerce("prod-c4", { sku: "SKU-C4" }, "k4");
		await client.softDeleteProductCommerce("prod-c4", "del-1");
		const row = await client.getProductCommerce("prod-c4");
		expect(row?.active).toBe(false);
		expect(row?.deletedAt).not.toBeNull();
		expect(row?.sku).toBe("SKU-C4"); // commercial data preserved, not wiped
	});

	test("a MISSING_PRODUCT_ID rejection (empty product id) surfaces as a structured CommerceClientError, not a silent create", async () => {
		// An empty productId collapses the URL to `/products//commerce`, which
		// Hono's router itself declines to match (404) before ever reaching the
		// MISSING_PRODUCT_ID domain guard — the service-level 400 case is
		// covered directly in packages/service/test/product-commerce-http.test.ts.
		// What THIS test proves is the transport contract: any non-2xx response
		// surfaces as a structured, catchable CommerceClientError, never a
		// silent success.
		await expect(client.upsertProductCommerce("", { sku: "SKU-X" }, "k5")).rejects.toMatchObject({
			name: "CommerceClientError",
		});
	});
});
