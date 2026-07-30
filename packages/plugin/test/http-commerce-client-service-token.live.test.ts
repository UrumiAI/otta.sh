import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CommerceClientError } from "../src/product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * B9 (ADR-0007) — the write-gate wire contract against a LIVE Postgres-backed
 * `@otta-sh/service` booted WITH `SERVICE_API_TOKEN` set. A client carrying the
 * matching `serviceToken` clears the gate on a write; a client WITHOUT it is
 * 401'd at the gate — proving the header the client sends (`X-Service-Token`)
 * is exactly the header the service enforces (no wire drift from the port).
 */
describe.skipIf(PG === undefined)(
	"HttpCommerceClient X-Service-Token [live service, Postgres]",
	() => {
		const TOKEN = "live-svc-token-7Kq";
		let service: LiveService;
		let authed: HttpCommerceClient;
		let unauthed: HttpCommerceClient;

		beforeAll(async () => {
			service = await startLiveService({ serviceToken: TOKEN });
			authed = new HttpCommerceClient({
				fetch: globalThis.fetch,
				baseUrl: service.baseUrl,
				serviceToken: TOKEN,
			});
			unauthed = new HttpCommerceClient({ fetch: globalThis.fetch, baseUrl: service.baseUrl });
		});
		afterAll(async () => {
			await service.stop();
		});

		test("a matching serviceToken clears the write gate (upsert PUT succeeds)", async () => {
			const row = await authed.upsertProductCommerce(
				"prod-svc-1",
				{ sku: "SKU-SVC-1", price: { amount: 1200, currency: "USD" } },
				"svc-k1",
			);
			expect(row).toMatchObject({ productId: "prod-svc-1", sku: "SKU-SVC-1" });
		});

		test("no serviceToken is 401'd at the gate on the same write", async () => {
			let caught: unknown;
			try {
				await unauthed.upsertProductCommerce("prod-svc-2", { sku: "SKU-SVC-2" }, "svc-k2");
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(CommerceClientError);
			expect((caught as CommerceClientError).status).toBe(401);
		});

		test("a GET read stays open through the gate (getProductCommerce needs no token)", async () => {
			// GET is gate-exempt: even the unauthed client reads the row the authed
			// write created above.
			const found = await unauthed.getProductCommerce("prod-svc-1");
			expect(found).toMatchObject({ productId: "prod-svc-1", sku: "SKU-SVC-1" });
		});
	},
);
