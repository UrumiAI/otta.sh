import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type RecordedRequest,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * Phase 2 §7 step 10 — PLP wiring (plugin-owned public route per ADR-0003),
 * including the headline N+1 proof: one page render ⇒ exactly ONE
 * commerce-batch HTTP call, and ZERO calls to any inventory-only endpoint
 * (the §6 intra-service inStock-join invariant seen from the client side).
 *
 * All three PLP entry points — all-products, taxonomy-filtered, and
 * search-result — share this ONE render path (§5): they differ only in
 * which tier-① CMS query produced the page of content (run outside the
 * plugin, per ADR-0003), which arrives on the route input.
 */

interface StubItem {
	amount: number;
	currency: string;
	sku: string;
	inStock: boolean;
}

let stubServer: StubCommerceServer;
let sandboxHandle: SandboxHandle;

function contentItem(id: string): Record<string, unknown> {
	return {
		id,
		title: `Product ${id}`,
		slug: `product-${id}`,
		description: `Description of ${id}`,
	};
}

function respondFromCatalog(known: Record<string, StubItem>): void {
	stubServer.respondWith("POST", (req: RecordedRequest) => {
		const productIds = (req.body as { productIds?: string[] }).productIds ?? [];
		const items = productIds
			.filter((id) => id in known)
			.map((id) => {
				const item = known[id]!;
				return {
					productId: id,
					sku: item.sku,
					price: { amount: item.amount, currency: item.currency },
					inStock: item.inStock,
				};
			});
		return { status: 200, body: { items } };
	});
}

beforeAll(async () => {
	stubServer = await startStubCommerceServer();
	sandboxHandle = await loadPluginInSandbox({
		allowedHosts: [stubServer.host],
		commerceServiceBaseUrl: stubServer.baseUrl,
	});
}, 60_000);

afterAll(async () => {
	await sandboxHandle?.close();
	await stubServer?.close();
});

beforeEach(() => {
	stubServer.requests.length = 0;
});

async function renderList(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	const outcome = await sandboxHandle.invokeRoute("storefront/list", input);
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

describe("storefront PLP route (workerd sandbox)", () => {
	test("rendering a PLP page of 25 products issues exactly ONE commerce batch HTTP call", async () => {
		const ids = Array.from({ length: 25 }, (_, i) => `prod-${i}`);
		respondFromCatalog(
			Object.fromEntries(
				ids.map((id, i) => [
					id,
					{ amount: 100 + i, currency: "USD", sku: `SKU-${id}`, inStock: true },
				]),
			),
		);

		const result = await renderList({
			items: ids.map(contentItem),
			locale: "en-US",
		});

		expect(result["ok"]).toBe(true);
		expect(result["items"]).toHaveLength(25);

		// THE N+1 proof (§1 case 4): one page, one HTTP call — not 25.
		expect(stubServer.requests).toHaveLength(1);
		expect(stubServer.requests[0]?.url).toBe("/catalog/commerce/batch");
		const batchBody = stubServer.requests[0]?.body as { productIds: string[] } | undefined;
		expect(batchBody?.productIds).toEqual(ids);
	});

	test("invariant guard: a PLP render issues ZERO calls to any inventory-only endpoint — inStock arrives on the single batch response", async () => {
		const ids = ["prod-a", "prod-b"];
		respondFromCatalog({
			"prod-a": { amount: 100, currency: "USD", sku: "SKU-A", inStock: true },
			"prod-b": { amount: 200, currency: "USD", sku: "SKU-B", inStock: false },
		});

		const result = await renderList({ items: ids.map(contentItem), locale: "en-US" });

		// The §6 intra-service-join invariant, client side: the TOTAL call
		// count for the page stays at the one batch call — no /inventory/*,
		// no second round trip of any kind.
		expect(stubServer.requests).toHaveLength(1);
		expect(stubServer.requests[0]?.url).toBe("/catalog/commerce/batch");
		expect(stubServer.requests.filter((r) => r.url.includes("inventory"))).toHaveLength(0);

		// And the stock signal is demonstrably on the batch payload.
		const items = result["items"] as Array<Record<string, unknown>>;
		expect(items.find((i) => i["id"] === "prod-a")?.["availability"]).toBe("in_stock");
		expect(items.find((i) => i["id"] === "prod-b")?.["availability"]).toBe("out_of_stock");
	});

	test("a taxonomy-filtered PLP narrows the CMS content set BEFORE the single batch commerce call (batch carries only the narrowed ids)", async () => {
		// The tier-① taxonomy query (category=bottles) already narrowed the
		// catalog to two ids — the plugin must scope its one batch call to
		// exactly that page, never expanding back to the full catalog.
		respondFromCatalog({
			"prod-bottle-1": { amount: 100, currency: "USD", sku: "SKU-B1", inStock: true },
			"prod-bottle-2": { amount: 200, currency: "USD", sku: "SKU-B2", inStock: true },
		});

		const result = await renderList({
			items: [contentItem("prod-bottle-1"), contentItem("prod-bottle-2")],
			query: { kind: "taxonomy", taxonomy: "category", term: "bottles" },
			locale: "en-US",
		});

		expect(result["ok"]).toBe(true);
		expect(result["query"]).toEqual({ kind: "taxonomy", taxonomy: "category", term: "bottles" });
		expect(stubServer.requests).toHaveLength(1);
		const taxonomyBody = stubServer.requests[0]?.body as { productIds: string[] } | undefined;
		expect(taxonomyBody?.productIds).toEqual(["prod-bottle-1", "prod-bottle-2"]);
	});

	test("a search-result PLP (FTS) narrows the CMS content set BEFORE the single batch commerce call", async () => {
		respondFromCatalog({
			"prod-hit-1": { amount: 100, currency: "USD", sku: "SKU-H1", inStock: true },
		});

		const result = await renderList({
			items: [contentItem("prod-hit-1")],
			query: { kind: "search", query: "bamboo" },
			locale: "en-US",
		});

		expect(result["ok"]).toBe(true);
		expect(result["query"]).toEqual({ kind: "search", query: "bamboo" });
		expect(stubServer.requests).toHaveLength(1);
		const searchBody = stubServer.requests[0]?.body as { productIds: string[] } | undefined;
		expect(searchBody?.productIds).toEqual(["prod-hit-1"]);
	});

	test("a non-purchasable product still appears in the listing, flagged, without a price slot (shown, not filtered)", async () => {
		respondFromCatalog({
			"prod-priced": { amount: 1999, currency: "USD", sku: "SKU-P", inStock: true },
			// prod-unpriced is absent from the stub catalog — the batch omits it.
		});

		const result = await renderList({
			items: [contentItem("prod-priced"), contentItem("prod-unpriced")],
			locale: "en-US",
		});

		const items = result["items"] as Array<Record<string, unknown>>;
		expect(items).toHaveLength(2);

		const priced = items.find((i) => i["id"] === "prod-priced");
		expect(priced).toMatchObject({
			purchasable: true,
			price: { amount: 1999, currency: "USD", formatted: "$19.99" },
			availability: "in_stock",
		});

		const unpriced = items.find((i) => i["id"] === "prod-unpriced");
		expect(unpriced).toMatchObject({
			title: "Product prod-unpriced",
			purchasable: false,
			price: null,
			availability: null,
		});
	});

	test("duplicate ids within a page collapse in the single batch call", async () => {
		respondFromCatalog({
			"prod-dup": { amount: 100, currency: "USD", sku: "SKU-D", inStock: true },
		});

		const result = await renderList({
			items: [contentItem("prod-dup"), contentItem("prod-dup")],
		});

		expect(result["ok"]).toBe(true);
		expect(stubServer.requests).toHaveLength(1);
		const dupBody = stubServer.requests[0]?.body as { productIds: string[] } | undefined;
		expect(dupBody?.productIds).toEqual(["prod-dup"]);
	});

	test("a page over the PLP size cap is a structured rejection BEFORE any commerce call (cap keeps one page = one batch)", async () => {
		respondFromCatalog({});
		const tooMany = Array.from({ length: 49 }, (_, i) => contentItem(`prod-${i}`));

		const result = await renderList({ items: tooMany });

		expect(result).toEqual({ ok: false, error: "PAGE_TOO_LARGE", max: 48 });
		expect(stubServer.requests).toHaveLength(0);
	});

	test("malformed items are a structured rejection before any commerce call", async () => {
		respondFromCatalog({});

		const result = await renderList({ items: [{ title: "no id" }] });

		expect(result).toEqual({ ok: false, error: "INVALID_ITEMS" });
		expect(stubServer.requests).toHaveLength(0);
	});
});
