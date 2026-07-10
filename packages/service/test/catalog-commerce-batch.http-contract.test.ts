import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COMMERCE_BATCH_ID_CAP } from "../src/routes/catalog.js";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

const PG = process.env.PG_CONNECTION_STRING;

interface JsonResponse {
	status: number;
	body: Record<string, unknown> | null;
}

/**
 * Phase 2 §7 step 3: live-server contract for `POST /catalog/commerce/batch`
 * — wire ⇄ port fidelity for `listCommerceByIds` (missing ids omitted, no
 * per-id error entries, money as integer + ISO-4217 string, `inStock` from
 * the service's own single intra-DB join) plus the id-cap 400 request-size
 * guard (a guard, not pagination — ADR-0002 rule 2).
 */
describe.skipIf(PG === undefined)("HTTP catalog commerce batch [live server, Postgres]", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await startTestServer();
	});
	afterAll(async () => {
		await server.stop();
	});

	async function putCommerce(id: string, body: unknown, key: string): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}/products/${id}/commerce`, {
			method: "PUT",
			headers: { "content-type": "application/json", "Idempotency-Key": key },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> | null };
	}

	async function batch(body: unknown): Promise<JsonResponse> {
		const res = await fetch(`${server.baseUrl}/catalog/commerce/batch`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> | null };
	}

	test("POST /catalog/commerce/batch returns items for known ids and omits unknown ids — no per-id error entries", async () => {
		await putCommerce(
			"prod-cb-1",
			{ sku: "SKU-CB1", price: { amount: 1999, currency: "USD" }, initialOnHand: 5 },
			"kcb1",
		);
		await putCommerce(
			"prod-cb-2",
			{ sku: "SKU-CB2", price: { amount: 500, currency: "EUR" } },
			"kcb2",
		);

		const res = await batch({ productIds: ["prod-cb-1", "prod-cb-2", "prod-cb-nope"] });

		expect(res.status).toBe(200);
		const items = res.body?.["items"] as Array<Record<string, unknown>>;
		expect(items).toHaveLength(2);
		const byId = new Map(items.map((i) => [i["productId"], i]));
		// Money on the wire: integer minor units + ISO-4217 string, never a float.
		expect(byId.get("prod-cb-1")).toEqual({
			productId: "prod-cb-1",
			sku: "SKU-CB1",
			price: { amount: 1999, currency: "USD" },
			inStock: true,
		});
		// No inventory row seeded for SKU-CB2 ⇒ coarsely out of stock, still listed.
		expect(byId.get("prod-cb-2")).toEqual({
			productId: "prod-cb-2",
			sku: "SKU-CB2",
			price: { amount: 500, currency: "EUR" },
			inStock: false,
		});
		// The unknown id is simply ABSENT — no error entry, no 404.
		expect(byId.has("prod-cb-nope")).toBe(false);
		expect(JSON.stringify(res.body)).not.toMatch(/error/i);
	});

	test("inStock arrives on the batch response itself (service-side join) — a drained sku flips to false", async () => {
		await putCommerce(
			"prod-cb-3",
			{ sku: "SKU-CB3", price: { amount: 100, currency: "USD" }, initialOnHand: 1 },
			"kcb3",
		);
		const before = await batch({ productIds: ["prod-cb-3"] });
		const beforeItems = (before.body?.["items"] ?? []) as Array<Record<string, unknown>>;
		expect(beforeItems[0]?.["inStock"]).toBe(true);

		await server.seed("SKU-CB3", 0);
		const after = await batch({ productIds: ["prod-cb-3"] });
		const afterItems = (after.body?.["items"] ?? []) as Array<Record<string, unknown>>;
		expect(afterItems[0]?.["inStock"]).toBe(false);
	});

	test("soft-deleted and not-yet-priced rows are omitted, not error entries", async () => {
		await putCommerce(
			"prod-cb-4",
			{ sku: "SKU-CB4", price: { amount: 100, currency: "USD" } },
			"kcb4",
		);
		await fetch(`${server.baseUrl}/products/prod-cb-4/commerce`, {
			method: "DELETE",
			headers: { "Idempotency-Key": "kcb4-del" },
		});
		// "Create, then price" not finished: a bare row with no sku/price yet.
		await putCommerce("prod-cb-5", {}, "kcb5");

		const res = await batch({ productIds: ["prod-cb-4", "prod-cb-5"] });
		expect(res.status).toBe(200);
		expect(res.body?.["items"]).toEqual([]);
	});

	test("a request over the id cap is rejected with 400 (request-size guard, not pagination)", async () => {
		const ids = Array.from({ length: COMMERCE_BATCH_ID_CAP + 1 }, (_, i) => `prod-cap-${i}`);
		const res = await batch({ productIds: ids });
		expect(res.status).toBe(400);

		// Exactly AT the cap is accepted.
		const atCap = await batch({ productIds: ids.slice(0, COMMERCE_BATCH_ID_CAP) });
		expect(atCap.status).toBe(200);
		expect(atCap.body?.["items"]).toEqual([]);
	});

	test("an empty id list is a valid request returning zero items", async () => {
		const res = await batch({ productIds: [] });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ items: [] });
	});

	test("a schema-invalid body (missing/ill-typed productIds) is a 400", async () => {
		for (const bad of [
			{},
			{ productIds: "prod-1" },
			{ productIds: [1, 2] },
			{ productIds: [""] },
		]) {
			const res = await batch(bad);
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
	});
});
