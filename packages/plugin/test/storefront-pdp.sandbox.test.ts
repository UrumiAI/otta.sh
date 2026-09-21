import {
	cents,
	currency,
	idempotencyKey,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/**
 * Phase 2 §7 step 9 — PDP wiring, as a PLUGIN-OWNED PUBLIC ROUTE per
 * ADR-0003 (the platform spike showed `page:fragments` is trusted-only, so
 * fragment injection is unavailable to this sandboxed plugin; the theme's
 * thin Astro page invokes this route and renders the returned view model +
 * JSON-LD). Exercised under the REAL workerd sandbox against route-input CMS
 * content (the "fake CMS content read": per ADR-0003 the tier-① CMS query runs
 * outside the plugin and its result arrives on the route input).
 *
 * WHAT INC-D3a CHANGED HERE. The commercial half of the join used to arrive over
 * `ctx.http` from a commerce service, and this suite's fixtures were a stub
 * server's batch replies. There is no service and no such call any more: the
 * route reads `product_commerce` in-process through the adapters over
 * `ctx.storage`, so the fixtures below are REAL ROWS, written through the real
 * store into the real (SQLite-backed) document store the isolate bridges to.
 * Assertions that were about the WIRE — the batch url, its request body, its
 * call count — described a transport that no longer exists and are gone; what
 * they were protecting (one lookup per render, absence is not an error) is
 * proven by `storefront-plp.sandbox.test.ts`'s batching case and by the
 * no-commerce-record case below.
 *
 * IDS ARE NAMESPACED (`pdp-…`) because the document store is process-scoped and
 * shared across boots — the same discipline every storage-backed sandbox suite
 * follows.
 */

const CONTENT = {
	id: "pdp-prod-1",
	title: "Bamboo Water Bottle",
	slug: "bamboo-water-bottle",
	description: "A reusable bottle.",
	images: ["https://cdn.example.com/bottle.jpg"],
	url: "https://shop.example.com/products/bamboo-water-bottle",
};

/** Any ISO instant works as the publish watermark: it is only ever compared
 *  against a LATER lifecycle event, and these fixtures have none. */
const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

let sandboxHandle: SandboxHandle;
/** A SECOND boot with no document store at all — see the RENDER_FAILED case. */
let storagelessHandle: SandboxHandle;
let storage: StorageAccess;

interface SeedProduct {
	readonly id: string;
	readonly sku: string;
	readonly amount: number;
	readonly currency: string;
	readonly onHand: number;
	/** New rows are born behind the publish gate, so a purchasable fixture must
	 *  be activated — exactly as `content:afterPublish` does in a deploy. */
	readonly active?: boolean;
}

/**
 * One commerce row, written the way the sync hook writes it: `upsert` for the
 * commercial fields, `seedOnHand` for the stock the store joins in, and
 * `activate` for the publish gate. Nothing is inserted behind the store's back —
 * a hand-built document would not carry the revision a guarded write compares.
 */
async function seedProduct(product: SeedProduct): Promise<void> {
	const commerce = new EmdashProductCommerceStore({ storage, clock: systemClock });
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	await commerce.upsert(
		{
			productId: toProductId(product.id),
			sku: toSku(product.sku),
			price: { amount: cents(product.amount), currency: currency(product.currency) },
			title: "Bamboo Water Bottle",
		},
		idempotencyKey(`seed-${product.id}`),
	);
	await inventory.seedOnHand(toSku(product.sku), product.onHand);
	if (product.active !== false) {
		await commerce.activate(
			toProductId(product.id),
			idempotencyKey(`pub-${product.id}`),
			PUBLISHED_AT,
		);
	}
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	[sandboxHandle, storagelessHandle] = await Promise.all([
		// NO allowed hosts: in-process commerce reaches the network for nothing, so
		// an empty allowlist is both the honest production shape and a guard — any
		// stray `ctx.http` call would throw rather than quietly succeed.
		loadPluginInSandbox({ allowedHosts: [], storage: true }),
		loadPluginInSandbox({ allowedHosts: [] }),
	]);
}, 120_000);

afterAll(async () => {
	await sandboxHandle?.close();
	await storagelessHandle?.close();
});

async function renderProduct(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	const outcome = await sandboxHandle.invokeRoute("storefront/product", input);
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

describe("storefront PDP route (workerd sandbox)", () => {
	test("rendering the PDP for a product with a commerce record joins content+commerce and emits Product+Offer JSON-LD", async () => {
		await seedProduct({
			id: CONTENT.id,
			sku: "SKU-PDP-1",
			amount: 1999,
			currency: "USD",
			onHand: 5,
		});

		const result = await renderProduct({ content: CONTENT, locale: "en-US" });
		expect(result["ok"]).toBe(true);

		// The join: CMS fields AND commercial fields, one view model (§1 case 1).
		const product = result["product"] as Record<string, unknown>;
		expect(product).toMatchObject({
			id: CONTENT.id,
			title: "Bamboo Water Bottle",
			slug: "bamboo-water-bottle",
			description: "A reusable bottle.",
			purchasable: true,
			sku: "SKU-PDP-1",
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
	});

	test("rendering the PDP for a product with no commerce record renders not-purchasable: no price, Product-only JSON-LD", async () => {
		// Nothing seeded for this id — the in-process batch read simply omits it,
		// which is absence and not an error (§4.2), exactly as a batch response
		// omitting it used to be.
		const result = await renderProduct({
			content: { ...CONTENT, id: "pdp-prod-unsynced" },
			locale: "en-US",
		});
		// Renders successfully — no throw, no 500, no silent omission (§1 case 2).
		expect(result["ok"]).toBe(true);

		const product = result["product"] as Record<string, unknown>;
		expect(product).toMatchObject({
			id: "pdp-prod-unsynced",
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
		await seedProduct({
			id: "pdp-prod-slot",
			sku: "SKU-PDP-SLOT",
			amount: 1999,
			currency: "USD",
			onHand: 5,
		});

		const result = await renderProduct({ content: { ...CONTENT, id: "pdp-prod-slot" } });
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
		expect(slot["sku"]).toBe("SKU-PDP-SLOT");
		// issue #80: the slot carries the CMS content id as productId — the join
		// key the add-to-cart path must thread so the line can be priced/quoted.
		expect(slot["productId"]).toBe("pdp-prod-slot");
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
				sku: "SKU-PDP-SLOT",
				productId: "pdp-prod-slot",
				idempotencyKey: slot["idempotencyKey"],
			},
		});
	});

	test("the add-to-cart slot is null for a NON-purchasable product (no sku to add) — it rides the purchasable flag", async () => {
		const result = await renderProduct({ content: { ...CONTENT, id: "pdp-prod-unsynced" } });
		const product = result["product"] as Record<string, unknown>;
		expect(product["purchasable"]).toBe(false);
		expect(product["slots"]).toEqual({ addToCart: null });
	});

	test("out-of-stock is a coarse display state: price still renders, availability flips, JSON-LD says OutOfStock", async () => {
		// A real inventory row holding zero — `inStock` is the store's own join
		// over that row now, not a boolean a service put on the wire.
		await seedProduct({
			id: "pdp-prod-oos",
			sku: "SKU-PDP-OOS",
			amount: 1999,
			currency: "USD",
			onHand: 0,
		});

		const result = await renderProduct({
			content: { ...CONTENT, id: "pdp-prod-oos" },
			locale: "en-US",
		});
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
		await seedProduct({
			id: "pdp-prod-eur",
			sku: "SKU-PDP-EUR",
			amount: 123456,
			currency: "EUR",
			onHand: 5,
		});

		const result = await renderProduct({
			content: { ...CONTENT, id: "pdp-prod-eur" },
			locale: "de-DE",
		});
		const product = result["product"] as Record<string, unknown>;
		const formatted = (product["price"] as Record<string, unknown>)["formatted"] as string;
		// ICU builds differ on WHICH space precedes the symbol (NBSP vs
		// narrow NBSP) — normalize the space, pin everything else exactly.
		expect(formatted.replace(/[  ]/g, " ")).toBe("1.234,56 €");
	});

	test("a commerce-complete but INACTIVE (unpublished) product renders not-purchasable: no price, Product-only JSON-LD (§4.2's inactive arm)", async () => {
		// Seeded but never activated: a row is born behind the publish gate, so
		// this is the state a product sits in until `content:afterPublish` runs.
		await seedProduct({
			id: "pdp-prod-inactive",
			sku: "SKU-PDP-INACTIVE",
			amount: 1999,
			currency: "USD",
			onHand: 5,
			active: false,
		});

		const result = await renderProduct({
			content: { ...CONTENT, id: "pdp-prod-inactive" },
			locale: "en-US",
		});
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

	test("an unexpected render failure (no document store on the context) returns a structured, message-free RENDER_FAILED — no internal leak through the public envelope", async () => {
		// THE TRIGGER CHANGED, THE PROPERTY DID NOT. This case used to feed the
		// route a float `amount` off the commerce service's wire so the branded
		// `cents()` parse threw mid-render. There is no wire left to malform — the
		// price is read as branded money from a row that could only be written as
		// branded money — so the failure is provoked at the one seam a deployment
		// can genuinely get wrong instead: a plugin booted with NO document store,
		// where the in-process commerce composition throws
		// `MISSING_STORAGE_MESSAGE` at construction. That message names internals
		// (collections, the descriptor) and an anonymous caller must not see it.
		const outcome = await storagelessHandle.invokeRoute("storefront/product", {
			content: CONTENT,
			locale: "en-US",
		});

		expect(outcome).toEqual({ result: { ok: false, error: "RENDER_FAILED" } });
		// Nothing about the internal failure leaks through the envelope.
		const wire = JSON.stringify(outcome);
		expect(wire).not.toMatch(/storage|collections|descriptor/i);
	});

	test("invalid content (missing CMS id) is a structured rejection before any commerce read", async () => {
		const outcome = await sandboxHandle.invokeRoute("storefront/product", {
			content: { title: "No id" },
		});

		expect(outcome).toEqual({ result: { ok: false, error: "INVALID_CONTENT" } });
	});

	test("a garbage locale falls back safely instead of failing the render", async () => {
		await seedProduct({
			id: "pdp-prod-locale",
			sku: "SKU-PDP-LOCALE",
			amount: 1999,
			currency: "USD",
			onHand: 5,
		});

		const result = await renderProduct({
			content: { ...CONTENT, id: "pdp-prod-locale" },
			locale: "not a locale!!",
		});
		expect(result["ok"]).toBe(true);
		const product = result["product"] as Record<string, unknown>;
		expect((product["price"] as Record<string, unknown>)["formatted"]).toBeTruthy();
	});
});
