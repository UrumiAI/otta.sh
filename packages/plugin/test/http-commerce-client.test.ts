import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * The client-side contract (plan §6 step 6 / DEVELOPMENT.md §3): the SAME
 * behavioral cases the domain/service suites already cover, run here
 * against `HttpCommerceClient` over a LIVE `@otta-sh/service` (Postgres-
 * backed) — proving the wire format has not drifted from the port.
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

	// ── Phase 2: catalog batch read (plan §6 step 4 — wire ⇄ port fidelity) ──

	test("getCommerceBatch posts productIds and returns only known items, inStock included from the service's single join", async () => {
		await client.upsertProductCommerce(
			"prod-cb1",
			{ sku: "SKU-CB1", price: { amount: 1999, currency: "USD" }, initialOnHand: 3 },
			"kcb1",
		);
		await client.upsertProductCommerce(
			"prod-cb2",
			{ sku: "SKU-CB2", price: { amount: 500, currency: "EUR" } },
			"kcb2",
		);

		const items = await client.getCommerceBatch(["prod-cb1", "prod-cb2", "prod-cb-unknown"]);

		expect(items).toHaveLength(2);
		const byId = new Map(items.map((item) => [item.productId, item]));
		expect(byId.get("prod-cb1")).toEqual({
			productId: "prod-cb1",
			sku: "SKU-CB1",
			price: { amount: 1999, currency: "USD" },
			inStock: true,
			active: false, // unpublished until the deferred afterPublish wiring lands
		});
		expect(byId.get("prod-cb2")).toEqual({
			productId: "prod-cb2",
			sku: "SKU-CB2",
			price: { amount: 500, currency: "EUR" },
			inStock: false, // never seeded — coarse out-of-stock, still listed
			active: false,
		});
		// The unknown id is OMITTED — absence, not an error entry.
		expect(byId.has("prod-cb-unknown")).toBe(false);
	});

	test("getCommerceBatch over the service's id cap surfaces the 400 as a structured CommerceClientError", async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `prod-cap-${i}`);
		await expect(client.getCommerceBatch(ids)).rejects.toMatchObject({
			name: "CommerceClientError",
			status: 400,
		});
	});

	// ── end Phase 2 catalog batch read ────────────────────────────────────

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
	// ── Variants: the client-side contract ────────────────────────────────
	// The same cases the service suite runs, driven through `HttpCommerceClient`
	// against a live service — so the client's URLs, its two disjoint write
	// bodies and its refusal normalization cannot drift from the routes. The
	// service answers a variant refusal on `error`; the client hands the caller
	// `reason`, like every other typed failure it returns, and these tests are
	// where that translation is pinned.

	const VWM = "2026-08-08T00:00:00.000Z";

	async function parentProduct(id: string, skuValue: string): Promise<void> {
		await client.upsertProductCommerce(
			id,
			{ sku: skuValue, price: { amount: 1000, currency: "USD" }, title: id },
			`vparent-${id}`,
		);
	}

	test("declare → price → list: the two writers each write only their own half", async () => {
		await parentProduct("prod-cv1", "SKU-CV1");
		const declared = await client.upsertProductVariant(
			"prod-cv1",
			"large",
			{ title: "Large", contentUpdatedAt: VWM },
			"cv1-declare",
		);
		expect(declared).toMatchObject({
			productId: "prod-cv1",
			variantKey: "large",
			title: "Large",
			sku: null,
			price: null, // absent is absent — never 0
			orphanedAt: null,
		});

		const priced = await client.updateProductVariantFields(
			"prod-cv1",
			"large",
			{ sku: "SKU-CV1-L", price: { amount: 2599, currency: "USD" } },
			declared.updatedAt,
			"cv1-price",
		);
		expect(priced).toMatchObject({
			ok: true,
			variant: {
				sku: "SKU-CV1-L",
				price: { amount: 2599, currency: "USD" },
				title: "Large", // the commerce edit cannot touch the name
			},
		});

		const listed = await client.listProductVariants("prod-cv1");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ variantKey: "large", sku: "SKU-CV1-L", inStock: false });
	});

	test("listProductVariants on a product with no variants is an empty array, never a throw", async () => {
		expect(await client.listProductVariants("prod-cv-none")).toEqual([]);
	});

	test("every documented edit refusal arrives as a typed VALUE on `reason`, never a thrown error", async () => {
		await parentProduct("prod-cv2", "SKU-CV2");
		await parentProduct("prod-cv2-other", "SKU-CV2-TAKEN");
		const declared = await client.upsertProductVariant(
			"prod-cv2",
			"large",
			{ title: "Large", contentUpdatedAt: VWM },
			"cv2-declare",
		);

		// Unknown key.
		expect(
			await client.updateProductVariantFields(
				"prod-cv2",
				"never-declared",
				{ price: { amount: 100, currency: "USD" } },
				declared.updatedAt,
				"cv2-unknown",
			),
		).toEqual({ ok: false, reason: "VARIANT_NOT_FOUND" });

		// Lost update — the fresh watermark travels with the refusal.
		expect(
			await client.updateProductVariantFields(
				"prod-cv2",
				"large",
				{ price: { amount: 100, currency: "USD" } },
				"2020-01-01T00:00:00.000Z",
				"cv2-stale",
			),
		).toEqual({ ok: false, reason: "STALE_EDIT", currentUpdatedAt: declared.updatedAt });

		// A currency the product cannot honour.
		expect(
			await client.updateProductVariantFields(
				"prod-cv2",
				"large",
				{ price: { amount: 100, currency: "EUR" } },
				declared.updatedAt,
				"cv2-currency",
			),
		).toMatchObject({ ok: false, reason: "CURRENCY_MISMATCH" });

		// A sku another live sellable unit holds.
		expect(
			await client.updateProductVariantFields(
				"prod-cv2",
				"large",
				{ sku: "SKU-CV2-TAKEN", price: { amount: 100, currency: "USD" } },
				declared.updatedAt,
				"cv2-taken",
			),
		).toEqual({ ok: false, reason: "SKU_TAKEN", sku: "SKU-CV2-TAKEN" });
	});

	test("deactivate orphans the row without deleting it, and the orphan is LISTED with its tombstone", async () => {
		await parentProduct("prod-cv3", "SKU-CV3");
		const declared = await client.upsertProductVariant(
			"prod-cv3",
			"large",
			{ title: "Large", contentUpdatedAt: VWM },
			"cv3-declare",
		);
		const priced = await client.updateProductVariantFields(
			"prod-cv3",
			"large",
			{ sku: "SKU-CV3-L", price: { amount: 4200, currency: "USD" } },
			declared.updatedAt,
			"cv3-price",
		);
		if (!priced.ok) throw new Error("unreachable");

		await client.deactivateProductVariant(
			"prod-cv3",
			"large",
			"cv3-drop",
			"2026-08-09T00:00:00.000Z",
		);
		const listed = await client.listProductVariants("prod-cv3");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.orphanedAt).toEqual(expect.any(String));
		// Retained in full: sku and price survive the tombstone.
		expect(listed[0]).toMatchObject({
			sku: "SKU-CV3-L",
			price: { amount: 4200, currency: "USD" },
		});

		// An unknown key is a no-op, not an error — the sync fires and forgets.
		await expect(
			client.deactivateProductVariant(
				"prod-cv3",
				"never-declared",
				"cv3-drop-unknown",
				"2026-08-09T00:00:00.000Z",
			),
		).resolves.toBeUndefined();
	});

	test("a variant key carrying URL-significant characters addresses its own row", async () => {
		await parentProduct("prod-cv4", "SKU-CV4");
		const key = "size/extra large";
		const declared = await client.upsertProductVariant(
			"prod-cv4",
			key,
			{ title: "Extra Large", contentUpdatedAt: VWM },
			"cv4-declare",
		);
		expect(declared.variantKey).toBe(key);
		const listed = await client.listProductVariants("prod-cv4");
		expect(listed.map((row) => row.variantKey)).toEqual([key]);
	});
	// ── end variants ──────────────────────────────────────────────────────
});
