import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type RecordedRequest,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * Phase 2 §7 step 9 — PDP wiring, as a PLUGIN-OWNED PUBLIC ROUTE per
 * ADR-0003 (the platform spike showed `page:fragments` is trusted-only, so
 * fragment injection is unavailable to this sandboxed plugin; the theme's
 * thin Astro page invokes this route and renders the returned view model +
 * JSON-LD). Exercised under the REAL workerd sandbox against a stub
 * commerce service and route-input CMS content (the "fake CMS content
 * read": per ADR-0003 the tier-① CMS query runs outside the plugin and its
 * result arrives on the route input).
 */

const CONTENT = {
	id: "prod-1",
	title: "Bamboo Water Bottle",
	slug: "bamboo-water-bottle",
	description: "A reusable bottle.",
	images: ["https://cdn.example.com/bottle.jpg"],
	url: "https://shop.example.com/products/bamboo-water-bottle",
};

let stubServer: StubCommerceServer;
let sandboxHandle: SandboxHandle;

/** Answer the batch endpoint from a per-test map of known commerce items. */
function respondFromCatalog(
	known: Record<
		string,
		{ amount: number; currency: string; sku: string; inStock: boolean; active?: boolean }
	>,
): void {
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
					// Tests default to published (active) so purchasable paths
					// are exercisable; the deferred afterPublish wiring is what
					// will make this true in production.
					active: item.active ?? true,
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

describe("storefront PDP route (workerd sandbox)", () => {
	test("rendering the PDP for a product with a commerce record joins content+commerce and emits Product+Offer JSON-LD", async () => {
		respondFromCatalog({
			"prod-1": { amount: 1999, currency: "USD", sku: "SKU-1", inStock: true },
		});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "en-US",
		});

		expect(outcome).toHaveProperty("result");
		const result = (outcome as { result: Record<string, unknown> }).result;
		expect(result["ok"]).toBe(true);

		// The join: CMS fields AND commercial fields, one view model (§1 case 1).
		const product = result["product"] as Record<string, unknown>;
		expect(product).toMatchObject({
			id: "prod-1",
			title: "Bamboo Water Bottle",
			slug: "bamboo-water-bottle",
			description: "A reusable bottle.",
			purchasable: true,
			sku: "SKU-1",
			price: { amount: 1999, currency: "USD", formatted: "$19.99" },
			availability: "in_stock",
		});

		// JSON-LD: Product + nested Offer (§1 case 3).
		const jsonLd = result["jsonLd"] as Record<string, unknown>;
		expect(jsonLd).toMatchObject({
			"@context": "https://schema.org",
			"@type": "Product",
			name: "Bamboo Water Bottle",
			offers: {
				"@type": "Offer",
				price: "19.99",
				priceCurrency: "USD",
				availability: "https://schema.org/InStock",
			},
		});

		// Sourced from the commerce service over ctx.http, via the batch shape.
		expect(stubServer.requests).toHaveLength(1);
		expect(stubServer.requests[0]?.url).toBe("/catalog/commerce/batch");
		expect(stubServer.requests[0]?.body).toEqual({ productIds: ["prod-1"] });
	});

	test("rendering the PDP for a product with no commerce record renders not-purchasable: no price, Product-only JSON-LD", async () => {
		respondFromCatalog({}); // the batch omits the id — absence, not an error

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: { ...CONTENT, id: "prod-unsynced" },
			locale: "en-US",
		});

		const result = (outcome as { result: Record<string, unknown> }).result;
		// Renders successfully — no throw, no 500, no silent omission (§1 case 2).
		expect(result["ok"]).toBe(true);

		const product = result["product"] as Record<string, unknown>;
		expect(product).toMatchObject({
			id: "prod-unsynced",
			title: "Bamboo Water Bottle",
			purchasable: false,
			sku: null,
			price: null,
			availability: null,
		});
		// The content still renders — hidden from purchase, not from the catalog.
		expect(product["description"]).toBe("A reusable bottle.");

		const jsonLd = result["jsonLd"] as Record<string, unknown>;
		expect(jsonLd["@type"]).toBe("Product");
		// Offer OMITTED, not nulled (§1 case 3).
		expect("offers" in jsonLd).toBe(false);
		expect(JSON.stringify(jsonLd)).not.toContain("Offer");
	});

	test("the P3-group-E seam is now FILLED: a purchasable product carries a Block Kit add-to-cart slot riding the purchasable flag", async () => {
		respondFromCatalog({
			"prod-1": { amount: 1999, currency: "USD", sku: "SKU-1", inStock: true },
		});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
		});
		const result = (outcome as { result: Record<string, unknown> }).result;
		const product = result["product"] as Record<string, unknown>;

		// Phase 3 fills the seam Phase 2 always rendered `null`: a purchasable
		// product now carries an add-to-cart affordance descriptor (§4.5). It
		// targets the plugin's public add-line route, carries the sku + a fresh
		// idempotency key, and is a Block Kit fragment (a qty stepper + button),
		// NOT React (DEVELOPMENT.md §5).
		const slots = product["slots"] as { addToCart: Record<string, unknown> | null };
		expect(slots.addToCart).not.toBeNull();
		const slot = slots.addToCart!;
		expect(slot["route"]).toBe("storefront/cart/lines/add");
		expect(slot["sku"]).toBe("SKU-1");
		// issue #80: the slot carries the CMS content id as productId — the join
		// key the add-to-cart path must thread so the line can be priced/quoted.
		expect(slot["productId"]).toBe("prod-1");
		expect(typeof slot["idempotencyKey"]).toBe("string");
		expect((slot["idempotencyKey"] as string).length).toBeGreaterThan(0);

		const elements = slot["elements"] as Array<Record<string, unknown>>;
		expect(elements.map((e) => e["type"])).toEqual(["number_input", "button"]);
		const button = elements[1]!;
		expect(button).toMatchObject({
			type: "button",
			// The button's value is echoed back verbatim on click (Block Kit) —
			// it forwards the payload the add-line route needs (plan §8 Risk 5).
			value: {
				route: "storefront/cart/lines/add",
				sku: "SKU-1",
				productId: "prod-1",
				idempotencyKey: slot["idempotencyKey"],
			},
		});
	});

	test("the add-to-cart slot is null for a NON-purchasable product (no sku to add) — it rides the purchasable flag", async () => {
		respondFromCatalog({}); // no commerce record ⇒ not purchasable

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: { ...CONTENT, id: "prod-unsynced" },
		});
		const result = (outcome as { result: Record<string, unknown> }).result;
		const product = result["product"] as Record<string, unknown>;
		expect(product["purchasable"]).toBe(false);
		expect(product["slots"]).toEqual({ addToCart: null });
	});

	test("out-of-stock is a coarse display state: price still renders, availability flips, JSON-LD says OutOfStock", async () => {
		respondFromCatalog({
			"prod-1": { amount: 1999, currency: "USD", sku: "SKU-1", inStock: false },
		});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "en-US",
		});
		const result = (outcome as { result: Record<string, unknown> }).result;
		const product = result["product"] as Record<string, unknown>;
		expect(product["purchasable"]).toBe(true);
		expect(product["availability"]).toBe("out_of_stock");
		expect((product["price"] as Record<string, unknown>)["formatted"]).toBe("$19.99");

		const jsonLd = result["jsonLd"] as Record<string, unknown>;
		expect((jsonLd["offers"] as Record<string, unknown>)["availability"]).toBe(
			"https://schema.org/OutOfStock",
		);
	});

	test("the price string localizes by the requested locale (Intl under workerd, not hand-built strings)", async () => {
		respondFromCatalog({
			"prod-1": { amount: 123456, currency: "EUR", sku: "SKU-1", inStock: true },
		});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "de-DE",
		});
		const result = (outcome as { result: Record<string, unknown> }).result;
		const product = result["product"] as Record<string, unknown>;
		const formatted = (product["price"] as Record<string, unknown>)["formatted"] as string;
		// ICU builds differ on WHICH space precedes the symbol (NBSP vs
		// narrow NBSP) — normalize the space, pin everything else exactly.
		expect(formatted.replace(/[\u00A0\u202F]/g, " ")).toBe("1.234,56 €");
	});

	test("a commerce-complete but INACTIVE (unpublished) product renders not-purchasable: no price, Product-only JSON-LD (§4.2's inactive arm)", async () => {
		respondFromCatalog({
			"prod-1": { amount: 1999, currency: "USD", sku: "SKU-1", inStock: true, active: false },
		});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "en-US",
		});
		const result = (outcome as { result: Record<string, unknown> }).result;
		expect(result["ok"]).toBe(true);

		// Behaves exactly like the no-commerce case: flagged, no price, no sku.
		const product = result["product"] as Record<string, unknown>;
		expect(product).toMatchObject({
			purchasable: false,
			sku: null,
			price: null,
			availability: null,
		});

		const jsonLd = result["jsonLd"] as Record<string, unknown>;
		expect(jsonLd["@type"]).toBe("Product");
		expect("offers" in jsonLd).toBe(false);
	});

	test("an unexpected render failure (malformed upstream amount) returns a structured, message-free RENDER_FAILED — no internal leak through the public envelope", async () => {
		// A float amount off the wire makes the branded cents() parse throw a
		// RangeError mid-render — exactly the class of internal error that
		// must NOT surface its message to an anonymous caller.
		stubServer.respondWith("POST", () => ({
			status: 200,
			body: {
				items: [
					{
						productId: "prod-1",
						sku: "SKU-1",
						price: { amount: 19.99, currency: "USD" },
						inStock: true,
						active: true,
					},
				],
			},
		}));

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "en-US",
		});

		expect(outcome).toEqual({ result: { ok: false, error: "RENDER_FAILED" } });
		// Nothing about the internal failure leaks through the envelope.
		const wire = JSON.stringify(outcome);
		expect(wire).not.toMatch(/RangeError|safe integer|cents\(/i);
	});

	test("invalid content (missing CMS id) is a structured rejection before any commerce call", async () => {
		respondFromCatalog({});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: { title: "No id" },
		});

		expect(outcome).toEqual({ result: { ok: false, error: "INVALID_CONTENT" } });
		expect(stubServer.requests).toHaveLength(0);
	});

	test("a garbage locale falls back safely instead of failing the render", async () => {
		respondFromCatalog({
			"prod-1": { amount: 1999, currency: "USD", sku: "SKU-1", inStock: true },
		});

		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "not a locale!!",
		});
		const result = (outcome as { result: Record<string, unknown> }).result;
		expect(result["ok"]).toBe(true);
		const product = result["product"] as Record<string, unknown>;
		expect((product["price"] as Record<string, unknown>)["formatted"]).toBeTruthy();
	});
});
