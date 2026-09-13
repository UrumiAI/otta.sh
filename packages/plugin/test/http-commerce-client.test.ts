import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * HTTP-WIRE RESIDUE. Every transport-agnostic case this file used to carry now
 * lives in `test/contracts/commerce-client-contract.ts` (INC-A7) and runs here
 * through `commerce-client-contract.http.test.ts`. What stays is what can only
 * be stated in wire terms: a non-2xx response surfacing as a structured,
 * catchable `CommerceClientError` carrying the HTTP status. Deleted with the
 * transport at INC-D3b.
 */
describe.skipIf(PG === undefined)("HttpCommerceClient [live @otta-sh/service, Postgres]", () => {
	let service: LiveService;
	let client: HttpCommerceClient;

	beforeAll(async () => {
		service = await startLiveService();
		client = new HttpCommerceClient({ fetch: globalThis.fetch, baseUrl: service.baseUrl });
	});
	afterAll(async () => {
		await service.stop();
	});

	test("getCommerceBatch over the service's id cap surfaces the 400 as a structured CommerceClientError", async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `prod-cap-${i}`);
		await expect(client.getCommerceBatch(ids)).rejects.toMatchObject({
			name: "CommerceClientError",
			status: 400,
		});
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
