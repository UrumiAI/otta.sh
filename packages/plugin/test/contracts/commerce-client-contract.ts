/**
 * `commerceClientContract` — the transport-agnostic client contract (work order
 * 02, INC-A7 / D6 / D7 tier T5).
 *
 * WHAT THIS IS. The behavioural spec of the commerce client surface, lifted out
 * of the HTTP client's own test files so it can be run against a SECOND
 * transport. Every case here is shaped as *arrange backend state* → *call a
 * client method* → *assert the returned value or the typed rejection*. Nothing
 * in this file knows how the call travels: no URLs, no headers, no status codes,
 * no request recording. Those assertions are real and they are kept — they live
 * in the HTTP tier's own file, which is the transport's file and dies with the
 * transport.
 *
 * WHY IT EXISTS. The HTTP client's test body *is* the spec (D6, "Why keep a flag
 * at all"). INC-B10a/b/c build an in-process client and must prove it
 * behaviourally identical before INC-D3b deletes the HTTP one. A spec that only
 * one transport can execute cannot do that. So the spec moves here and the
 * implementation-specific residue stays behind.
 *
 * THREE SLICES, one per consuming increment:
 *   - `storefrontCommerceClientContract`       → INC-B10a (`CommerceClient`)
 *   - `adminOrdersProductsClientContract`      → INC-B10b (orders + products)
 *   - `adminRulesReportingClientContract`      → INC-B10c (rules + reporting)
 *
 * ASYNC REJECTIONS ONLY — a RULE FOR CASES YET TO COME, not a property of the
 * cases below. Every failure the lifted cases assert is a typed RESULT VALUE
 * (`{ ok: false, reason }`), so the contract as it stands contains no rejection
 * assertion at all: the only two cases that asserted a thrown error asserted an
 * HTTP status with it and stayed with the transport. When INC-B10a/b/c add the
 * gap cases that do assert failure by rejection, they must assert an awaited
 * rejection and never a synchronous `throw`, so an async in-process method and
 * the HTTP client behave alike under the same case.
 *
 * MONEY. Every amount in this file is an integer in minor units with an
 * explicit ISO-4217 currency, as the port requires.
 */

import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { AdminOrdersClient } from "../../src/admin/admin-orders-client.js";
import type { AdminProductsClient } from "../../src/admin/admin-products-client.js";
import type { AdminRulesClient } from "../../src/admin/admin-rules-client.js";
import type { ReportingSettingsClient } from "../../src/admin/reporting-client.js";
import type { CommerceClient, CommerceMoney } from "../../src/product-commerce/commerce-client.js";

// ── The tier interface ────────────────────────────────────────────────────
//
// A "tier" is one transport plus the means to seed state behind it. The four
// admin surfaces are named by `Pick<…>` of the classes that implement them
// TODAY purely to borrow their method signatures — this file never constructs
// one, and at INC-D3b the `Pick` targets swap to the in-process classes while
// every case below stays put.

/** The admin orders surface the contract exercises. Empty until INC-B10b. */
export type OrdersClientSurface = Pick<AdminOrdersClient, "listOrders">;
/** The admin products surface the contract exercises. Empty until INC-B10b. */
export type ProductsClientSurface = Pick<AdminProductsClient, "listProducts">;
/** The rules surface the contract exercises (shipping, tax, coupons). */
export type RulesClientSurface = Pick<
	AdminRulesClient,
	| "createZone"
	| "updateZone"
	| "deleteZone"
	| "createMethod"
	| "deleteMethod"
	| "createRate"
	| "updateRate"
	| "deleteRate"
	| "createTaxClass"
	| "createTaxRate"
	| "listTaxRates"
	| "updateTaxRate"
	| "deleteTaxRate"
	| "createCoupon"
	| "updateCoupon"
	| "getCoupon"
	| "deleteCoupon"
	| "listCoupons"
>;
/** The reporting + settings surface. Empty until INC-B10c. */
export type ReportingClientSurface = Pick<ReportingSettingsClient, "getRevenue">;

export interface AdminClientSurfaces {
	orders: OrdersClientSurface;
	products: ProductsClientSurface;
	rules: RulesClientSurface;
	reporting: ReportingClientSurface;
}

/** One `product_commerce` row — the only backend state the lifted cases seed
 *  other than carts. Derived from what the eight source files actually arrange:
 *  a sku, an optional price, an optional snapshot title, an optional initial
 *  on-hand count. Nothing else is seeded anywhere in them. */
export interface ArrangedProduct {
	productId: string;
	sku: string;
	price?: CommerceMoney;
	title?: string;
	onHand?: number;
	idempotencyKey: string;
}

export interface CommerceClientTierArrange {
	/** Seed (or re-seed) one commerce row; resolves to its productId. */
	product(spec: ArrangedProduct): Promise<string>;
	/** Seed an empty cart; resolves to its cartId. */
	cart(currency?: string): Promise<string>;
}

export interface CommerceClientTier {
	/** Names the tier in every `describe` this contract registers. */
	readonly name: string;
	/** Stand the backend up. Called once per slice, in `beforeAll`. */
	setup(): Promise<void>;
	/** Tear it down. The caller wires this to its own `afterAll`. */
	teardown(): Promise<void>;
	/** Per-case state reset, called in `beforeEach`. A tier whose cases are
	 *  already disjoint by id may implement this as a documented no-op. */
	reset(): Promise<void>;
	makeClient(): Promise<CommerceClient>;
	/** OPTIONAL: a tier that binds only the storefront surface omits it. The
	 *  storefront slice never asks for it; the two admin slices fail loudly
	 *  rather than skipping silently (`assertAdminClients`). */
	makeAdminClients?(): Promise<AdminClientSurfaces>;
	arrange: CommerceClientTierArrange;
}

/** Fails at collection time, so a tier wired to an admin slice without admin
 *  clients is a loud error and never a quietly empty run. */
function assertAdminClients(
	tier: CommerceClientTier,
): NonNullable<CommerceClientTier["makeAdminClients"]> {
	if (tier.makeAdminClients === undefined) {
		throw new Error(
			`commerceClientContract: tier "${tier.name}" provides no admin clients, so it cannot run an admin slice`,
		);
	}
	return tier.makeAdminClients.bind(tier);
}

// WHICH SEEDING PATH. A case whose SUBJECT is a write method calls that method
// directly — `upsertProductCommerce`, `createCart` and `addCartLine` are under
// test in their own cases and must not be hidden behind `arrange`. A case that
// merely NEEDS a product or a cart to exist uses `tier.arrange.*`, so a tier
// with a cheaper way to seed state can take it.
//
// ORDERING AND `reset()`. Every case below addresses disjoint product ids, skus,
// cart ids, rule ids and idempotency keys, which is the only reason a tier may
// implement `reset()` as a no-op. No case may depend on state another case left
// behind. The first real `reset()` lands with the in-process tier at INC-B10a.
//
// NO CLOCK / ID / HOLD-EXPIRY HOOKS. The eight source files control time only
// by passing explicit `contentUpdatedAt` / `expectedUpdatedAt` watermark
// ARGUMENTS, and control identity only by passing explicit idempotency keys —
// both of which are inputs to the port and travel with the cases below. None of
// them expires a hold, advances a clock, or asserts a generated id, so the tier
// interface declares no lever for any of that. Add one when a case needs it.

// ── Slice 1: the storefront `CommerceClient` ──────────────────────────────

export function storefrontCommerceClientContract(tier: CommerceClientTier): void {
	describe(`commerceClientContract — storefront [${tier.name}]`, () => {
		let client: CommerceClient;

		beforeAll(async () => {
			await tier.setup();
			client = await tier.makeClient();
		});
		beforeEach(async () => {
			await tier.reset();
		});

		// ── product_commerce ──────────────────────────────────────────────

		test("upsertProductCommerce creates the commerce row from exactly the fields it was given", async () => {
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

		test("getCommerceBatch returns only the known items, each carrying inStock", async () => {
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

		// ── Variants: the client-side contract ────────────────────────────
		// The two disjoint write bodies and the refusal normalization: the
		// caller is handed `reason` for every documented refusal, like every
		// other typed failure the port returns.

		const VWM = "2026-08-08T00:00:00.000Z";

		async function parentProduct(id: string, skuValue: string): Promise<void> {
			await tier.arrange.product({
				productId: id,
				sku: skuValue,
				price: { amount: 1000, currency: "USD" },
				title: id,
				idempotencyKey: `vparent-${id}`,
			});
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

		test("deactivate orphans the row without deleting it — gone from the public read, brought back intact by a re-declare", async () => {
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
			// The public read carries live sizes only, so a discontinued one — and its
			// last price — simply is not there.
			expect(await client.listProductVariants("prod-cv3")).toEqual([]);

			// Retained, not deleted: the CMS declaring the key again brings back the
			// same row with its sku and price intact, which is only possible because
			// the tombstone kept them.
			const back = await client.upsertProductVariant(
				"prod-cv3",
				"large",
				{ title: "Large", contentUpdatedAt: "2026-08-10T00:00:00.000Z" },
				"cv3-resurrect",
			);
			expect(back).toMatchObject({
				sku: "SKU-CV3-L",
				price: { amount: 4200, currency: "USD" },
				orphanedAt: null,
			});
			const listed = await client.listProductVariants("prod-cv3");
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ variantKey: "large", sku: "SKU-CV3-L" });

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
		// ── end variants ──────────────────────────────────────────────────

		// ── cart ──────────────────────────────────────────────────────────

		/** Seed a `product_commerce` row keyed by its CMS content id (the productId
		 *  join key), optionally priced. Returns the productId so a cart add can
		 *  thread it, exactly as the storefront now does (issue #80). */
		async function seedProduct(opts: {
			sku: string;
			onHand: number;
			price?: CommerceMoney;
		}): Promise<string> {
			return tier.arrange.product({
				productId: `prod-for-${opts.sku}`,
				sku: opts.sku,
				...(opts.price !== undefined ? { price: opts.price } : {}),
				onHand: opts.onHand,
				idempotencyKey: `seed-${opts.sku}`,
			});
		}

		test("createCart mints a cartId with no ok-envelope (a bare success shape)", async () => {
			const { cartId } = await client.createCart();
			expect(typeof cartId).toBe("string");
			expect(cartId.length).toBeGreaterThan(0);
		});

		test("createCart accepts an explicit currency, defaulting server-side otherwise", async () => {
			const { cartId } = await client.createCart("EUR");
			const result = await client.getCart(cartId);
			expect(result).toMatchObject({
				ok: true,
				// `orderId: null` (#132): a fresh cart names no order.
				cart: { currency: "EUR", state: "active", orderId: null, lines: [] },
			});
		});

		test("getCart on an unknown cartId returns the typed CART_NOT_FOUND token, not a thrown error", async () => {
			const result = await client.getCart("does-not-exist");
			expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
		});

		// ── issue #80: the storefront now threads productId end-to-end ─────
		test("addCartLine threads productId; the persisted line carries it (non-null) and the cart read reflects it", async () => {
			const productId = await seedProduct({
				sku: "SKU-PID-1",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart();

			const added = await client.addCartLine(cartId, "SKU-PID-1", productId, 2, "pid-add-1");
			expect(added.ok).toBe(true);
			if (!added.ok) throw new Error("unreachable");
			expect(added.line).toMatchObject({ sku: "SKU-PID-1", qty: 2, productId });
			expect(added.line.productId).not.toBeNull();

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({
				ok: true,
				cart: { lines: [{ sku: "SKU-PID-1", qty: 2, productId }] },
			});
		});

		test("a priced cart QUOTES computed totals: 2 × 1500 minor units is a 3000 subtotal and, nothing else selected, a 3000 total", async () => {
			const productId = await seedProduct({
				sku: "SKU-QUOTE-OK",
				onHand: 10,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart("USD");
			const added = await client.addCartLine(cartId, "SKU-QUOTE-OK", productId, 2, "quote-ok-1");
			if (!added.ok) throw new Error("unreachable");

			const quoted = await client.quoteCheckout({ cartId });
			expect(quoted.ok).toBe(true);
			if (!quoted.ok) throw new Error("unreachable");
			// Integer minor units all the way through — 2 × $15.00, no shipping,
			// tax or coupon selected, so subtotal IS the total. No float anywhere.
			expect(quoted.breakdown.subtotalCents).toBe(3000);
			expect(quoted.breakdown.totalCents).toBe(3000);
		});

		// The guarantee this test has always made is unchanged — threading a
		// productId must never make an unpriced row look purchasable — but the
		// service now makes it EARLIER. Since the add endpoint's SKU guard, an
		// unpriced sellable unit is refused at the Add button rather than accepted
		// and then refused at the quote, so the shopper is told while they can
		// still do something about it and no stock is held for a line that could
		// never have been bought.
		test("no false positive: an UNPRICED product (row exists, no price) is refused PRODUCT_NOT_PRICED at the ADD, with the productId threaded", async () => {
			const productId = await seedProduct({ sku: "SKU-UNPRICED", onHand: 5 }); // no price
			const cartId = await tier.arrange.cart("USD");
			const added = await client.addCartLine(cartId, "SKU-UNPRICED", productId, 1, "unpriced-1");
			expect(added).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });

			// Nothing persisted, nothing held, and the cart is still empty — so the
			// downstream quote cannot see a priced line either.
			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [] } });
			expect(await client.quoteCheckout({ cartId })).toEqual({
				ok: false,
				reason: "CART_EMPTY",
			});
		});

		test("a legacy add with NO productId (absent) is preserved as null and still quotes PRODUCT_NOT_PRICED", async () => {
			await seedProduct({
				sku: "SKU-LEGACY",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart("USD");
			const added = await client.addCartLine(cartId, "SKU-LEGACY", null, 1, "legacy-1");
			if (!added.ok) throw new Error("unreachable");
			expect(added.line.productId).toBeNull(); // absent ⇒ null round-trips

			// A line with no product reference cannot be priced.
			expect(await client.quoteCheckout({ cartId })).toEqual({
				ok: false,
				reason: "PRODUCT_NOT_PRICED",
			});
		});

		test("SECURITY (issue #80 review): a mismatched sku/productId pair (sku of product B, productId of product A) is rejected SKU_MISMATCH and never reaches checkout", async () => {
			const cheapId = await seedProduct({
				sku: "SKU-CHEAP",
				onHand: 10,
				price: { amount: 100, currency: "USD" },
			});
			await seedProduct({
				sku: "SKU-PRICEY",
				onHand: 10,
				price: { amount: 100000, currency: "USD" },
			});
			const cartId = await tier.arrange.cart("USD");

			// Attack: pair the cheap product's productId with the pricey product's sku.
			const added = await client.addCartLine(cartId, "SKU-PRICEY", cheapId, 1, "mismatch-1");
			expect(added).toEqual({ ok: false, reason: "SKU_MISMATCH" });

			// Nothing was persisted ⇒ the cart is empty ⇒ no priced checkout.
			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [] } });
			expect(await client.quoteCheckout({ cartId })).toEqual({
				ok: false,
				reason: "CART_EMPTY",
			});
		});

		test("currency mismatch: a product priced in EUR in a USD cart quotes CURRENCY_MISMATCH (not PRODUCT_NOT_PRICED)", async () => {
			const productId = await seedProduct({
				sku: "SKU-EUR",
				onHand: 5,
				price: { amount: 1500, currency: "EUR" },
			});
			const cartId = await tier.arrange.cart("USD");
			const added = await client.addCartLine(cartId, "SKU-EUR", productId, 1, "eur-1");
			if (!added.ok) throw new Error("unreachable");

			expect(await client.quoteCheckout({ cartId })).toEqual({
				ok: false,
				reason: "CURRENCY_MISMATCH",
			});
		});

		test("idempotency: replaying the add with the same key threads productId once and does NOT duplicate the line", async () => {
			const productId = await seedProduct({
				sku: "SKU-PID-IDEM",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart("USD");

			const first = await client.addCartLine(cartId, "SKU-PID-IDEM", productId, 2, "pid-replay-1");
			const replay = await client.addCartLine(cartId, "SKU-PID-IDEM", productId, 2, "pid-replay-1");
			expect(replay).toEqual(first);

			const read = await client.getCart(cartId);
			expect(read.ok).toBe(true);
			if (!read.ok) throw new Error("unreachable");
			expect(read.cart.lines).toHaveLength(1);
			expect(read.cart.lines[0]).toMatchObject({ productId, qty: 2 });
		});

		test("addCartLine beyond on_hand returns the typed OUT_OF_STOCK token as a normal (non-throwing) result", async () => {
			const productId = await seedProduct({
				sku: "SKU-CART-2",
				onHand: 1,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart();

			const result = await client.addCartLine(cartId, "SKU-CART-2", productId, 5, "add-key-2");
			expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		});

		test("adjustCartLine takes the TARGET qty, not a delta, and the line reflects it", async () => {
			const productId = await seedProduct({
				sku: "SKU-CART-4",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart();
			const added = await client.addCartLine(cartId, "SKU-CART-4", productId, 2, "add-key-4");
			if (!added.ok) throw new Error("unreachable");

			const adjusted = await client.adjustCartLine(cartId, added.line.lineId, 4, "adjust-key-4");
			expect(adjusted).toMatchObject({ ok: true, line: { qty: 4 } });
		});

		test("adjustCartLine increasing beyond available stock returns OUT_OF_STOCK, line unchanged", async () => {
			const productId = await seedProduct({
				sku: "SKU-CART-5",
				onHand: 3,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart();
			const added = await client.addCartLine(cartId, "SKU-CART-5", productId, 2, "add-key-5");
			if (!added.ok) throw new Error("unreachable");

			const adjusted = await client.adjustCartLine(cartId, added.line.lineId, 10, "adjust-key-5");
			expect(adjusted).toEqual({ ok: false, reason: "OUT_OF_STOCK" });

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [{ qty: 2 }] } });
		});

		test("removeCartLine releases the reservation and drops the line; the typed CartResult carries ok:true only", async () => {
			const productId = await seedProduct({
				sku: "SKU-CART-6",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const cartId = await tier.arrange.cart();
			const added = await client.addCartLine(cartId, "SKU-CART-6", productId, 2, "add-key-6");
			if (!added.ok) throw new Error("unreachable");

			const removed = await client.removeCartLine(cartId, added.line.lineId, "remove-key-6");
			expect(removed).toEqual({ ok: true });

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [] } });
		});

		test("a mutation against an unknown lineId returns the typed LINE_NOT_FOUND token (a 404 normalized, not thrown)", async () => {
			const cartId = await tier.arrange.cart();
			const result = await client.adjustCartLine(cartId, "does-not-exist", 1, "adjust-key-missing");
			expect(result).toEqual({ ok: false, reason: "LINE_NOT_FOUND" });
		});

		// The add endpoint's SKU guard. A size is a row of its own and resolves
		// against its product — and is REFUSED anyway, with the same typed token a
		// spoof gets, because order pricing still reads the snapshot price and
		// title from the product row and cannot reach a variant.
		//
		// THIS TEST FLIPS when order pricing resolves the sellable unit rather than
		// the product row: the first expectation becomes the accepted line the
		// comment below spells out. The orphaned half does not flip — a
		// discontinued size stays unaddable either way — so it is asserted here
		// against a distinct sku, keeping the two halves independent.
		test("a LIVE variant's sku is REFUSED at the add for now, and an ORPHANED one is refused permanently", async () => {
			const productId = await seedProduct({
				sku: "SKU-CART-VAR",
				onHand: 5,
				price: { amount: 2000, currency: "USD" },
			});
			// The size's units. A variant's first sku ADOPTS whatever inventory row
			// already stands under it (units and all), so stocking one means
			// creating that row and then freeing the sku: a soft-deleted product is
			// no longer a LIVE sellable unit, so its sku is available again while
			// its stock stays exactly where it is.
			const donor = await seedProduct({
				sku: "SKU-CART-VAR-L",
				onHand: 4,
				price: { amount: 2500, currency: "USD" },
			});
			await client.softDeleteProductCommerce(donor, "cartvar-free-sku");

			const declared = await client.upsertProductVariant(
				productId,
				"large",
				{ title: "Large", contentUpdatedAt: "2026-08-08T00:00:00.000Z" },
				"cartvar-declare",
			);
			const priced = await client.updateProductVariantFields(
				productId,
				"large",
				{ sku: "SKU-CART-VAR-L", price: { amount: 2500, currency: "USD" } },
				declared.updatedAt,
				"cartvar-price",
			);
			if (!priced.ok) throw new Error("unreachable");

			const cartId = await tier.arrange.cart("USD");
			const added = await client.addCartLine(cartId, "SKU-CART-VAR-L", productId, 1, "cartvar-add");
			expect(added).toEqual({ ok: false, reason: "SKU_MISMATCH" });
			// Nothing held: the size still has every unit it adopted.
			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [] } });
			// On the flip, this is the assertion:
			//   expect(added).toMatchObject({ ok: true, line: { sku: "SKU-CART-VAR-L", productId } });

			await client.deactivateProductVariant(
				productId,
				"large",
				"cartvar-drop",
				"2026-08-09T00:00:00.000Z",
			);
			const secondCart = await tier.arrange.cart("USD");
			const afterDrop = await client.addCartLine(
				secondCart,
				"SKU-CART-VAR-L",
				productId,
				1,
				"cartvar-add-2",
			);
			expect(afterDrop).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		});
	});
}

// ── Slice 2: admin orders + products (INC-B10b) ───────────────────────────

/**
 * INTENTIONALLY EMPTY, and that is the finding, not an oversight: no test file
 * in `packages/plugin/test/` ever exercised `AdminOrdersClient` (15 methods) or
 * `AdminProductsClient` (9). There was nothing to lift. INC-B10b writes these
 * cases first, against this tier interface, and they will then run on both
 * transports for free.
 *
 * Gaps to cover (the two classes' full public surfaces): orders —
 * `listOrders`, `getOrder`, `transitionOrder`, `resolveReconciliation`,
 * `recordFulfillment`, `cancelOrder`, `getCustomerContext`, `getTimeline`,
 * `getRefunds`, `refundOrder`, `listNotes`, `addNote`; products —
 * `updateProduct`, `restock`, `removeStock`, `listProducts`, `getProduct`,
 * `getTaxClasses`.
 */
export function adminOrdersProductsClientContract(tier: CommerceClientTier): void {
	// No cases yet — but the tier is still held to the slice's requirement, so
	// INC-B10b's first case does not discover a mis-wired tier.
	assertAdminClients(tier);
}

// ── Slice 3: admin rules + reporting (INC-B10c) ───────────────────────────

export function adminRulesReportingClientContract(tier: CommerceClientTier): void {
	describe(`commerceClientContract — admin rules + reporting [${tier.name}]`, () => {
		let client: RulesClientSurface;

		const makeAdminClients = assertAdminClients(tier);
		beforeAll(async () => {
			await tier.setup();
			client = (await makeAdminClients()).rules;
		});
		beforeEach(async () => {
			await tier.reset();
		});

		// REPORTING HAS NO CASES YET — nothing in the eight source files
		// exercised `ReportingSettingsClient`. INC-B10c writes them here, for
		// `getRevenue`, `getOrdersByStatus`, `getTopProducts`, `getLowStock`,
		// `getSettings` and `updateSettings`.

		test("shipping: create zone→method→rate, edit them, and enforce referential deletes", async () => {
			expect((await client.createZone({ id: "z1", name: "US" })).ok).toBe(true);
			expect(
				(await client.createMethod("z1", { id: "m1", name: "Flat", type: "flat_rate" })).ok,
			).toBe(true);
			expect((await client.createRate("m1", { currency: "USD", amountCents: 599 })).ok).toBe(true);

			// LWW zone edit round-trips (`regions` is a required full-replace field).
			const zoneEdit = await client.updateZone("z1", { name: "United States", regions: ["US"] });
			expect(zoneEdit.ok && zoneEdit.value.name).toBe("United States");

			// A zone with a method cannot be deleted.
			expect(await client.deleteZone("z1")).toEqual({ ok: false, reason: "in_use" });

			// CAS rate edit: correct expected wins; a stale expected returns the fresh row.
			const ok = await client.updateRate("m1", "USD", {
				amountCents: 699,
				minSubtotalCents: null,
				expectedAmountCents: 599,
			});
			expect(ok.ok && ok.value.amountCents).toBe(699);
			const stale = await client.updateRate("m1", "USD", {
				amountCents: 799,
				minSubtotalCents: null,
				expectedAmountCents: 599,
			});
			expect(stale.ok).toBe(false);
			if (!stale.ok && stale.reason === "stale") {
				expect(stale.current?.amountCents).toBe(699);
			} else {
				throw new Error("expected a stale result carrying the current row");
			}

			// Leaf rate delete is idempotent; then the chain deletes cleanly.
			expect(await client.deleteRate("m1", "USD")).toEqual({ ok: true });
			expect(await client.deleteRate("m1", "USD")).toEqual({ ok: false, reason: "not_found" });
			expect(await client.deleteMethod("m1")).toEqual({ ok: true });
			expect(await client.deleteZone("z1")).toEqual({ ok: true });
		});

		test("tax: create class+rate, CAS-edit, delete", async () => {
			// ARRANGEMENT, not an assertion: a zone of this case's OWN. It used to
			// name `z1` — the zone the shipping case above creates AND deletes — so
			// it read as a cross-case dependency. A tax rate carries its zone id
			// without a referential guarantee, so the borrowed id worked by
			// accident; this one makes the independence real. Unasserted on purpose,
			// so the case's assertions stay the tax-rate ones it always had.
			await client.createZone({ id: "z-tax", name: "Tax" });

			expect((await client.createTaxClass({ id: "standard", name: "Standard" })).ok).toBe(true);
			expect(
				(
					await client.createTaxRate({
						id: "t1",
						taxClassId: "standard",
						zoneId: "z-tax",
						rateBps: 725,
					})
				).ok,
			).toBe(true);

			const rates = await client.listTaxRates("z-tax");
			expect(rates.map((r) => r.id)).toContain("t1");

			const ok = await client.updateTaxRate("t1", {
				rateBps: 825,
				appliesToShipping: false,
				expectedRateBps: 725,
			});
			expect(ok.ok && ok.value.rateBps).toBe(825);
			const stale = await client.updateTaxRate("t1", {
				rateBps: 900,
				appliesToShipping: false,
				expectedRateBps: 725,
			});
			expect(stale.ok === false && stale.reason).toBe("stale");
			expect(
				await client.updateTaxRate("nope", {
					rateBps: 1,
					appliesToShipping: false,
					expectedRateBps: 0,
				}),
			).toEqual({
				ok: false,
				reason: "not_found",
			});

			expect(await client.deleteTaxRate("t1")).toEqual({ ok: true });
			expect(await client.deleteTaxRate("t1")).toEqual({ ok: false, reason: "not_found" });
		});

		test("coupons: create, LWW-edit, read, delete", async () => {
			expect(
				(
					await client.createCoupon({
						id: "cpn1",
						code: "SAVE5",
						type: "fixed_amount",
						amountCents: 500,
						currency: "USD",
						maxUses: 10,
					})
				).ok,
			).toBe(true);

			const edit = await client.updateCoupon("cpn1", { amountCents: 750, maxUses: 20 });
			expect(edit.ok && edit.value.amountCents).toBe(750);
			expect(edit.ok && edit.value.code).toBe("SAVE5"); // identity preserved

			const read = await client.getCoupon("SAVE5");
			expect(read?.amountCents).toBe(750);
			expect(await client.getCoupon("MISSING")).toBeNull();

			expect(await client.deleteCoupon("cpn1")).toEqual({ ok: true });
			expect(await client.deleteCoupon("cpn1")).toEqual({ ok: false, reason: "not_found" });
		});

		test("coupons: listCoupons enumerates newest-first, the search filter matches an EXACT code, and the cursor round-trips", async () => {
			expect(
				(
					await client.createCoupon({
						id: "list-1",
						code: "LIST-ALPHA",
						type: "fixed_amount",
						amountCents: 100,
						currency: "USD",
						// Validity window — the LIST read must carry it back (PR #74
						// review); pinned below.
						startsAt: "2026-07-01T00:00:00.000Z",
						expiresAt: "2026-08-01T00:00:00.000Z",
					})
				).ok,
			).toBe(true);
			expect(
				(
					await client.createCoupon({
						id: "list-2",
						code: "LIST-BETA",
						type: "fixed_amount",
						amountCents: 200,
						currency: "USD",
					})
				).ok,
			).toBe(true);

			const page1 = await client.listCoupons({}, { limit: 1 });
			expect(page1.coupons).toHaveLength(1);
			expect(typeof page1.nextCursor === "string" || page1.nextCursor === null).toBe(true);
			if (page1.nextCursor !== null) {
				const page2 = await client.listCoupons({}, { cursor: page1.nextCursor });
				expect([...page1.coupons, ...page2.coupons].map((c) => c.id).toSorted()).toEqual(
					["list-1", "list-2"].toSorted(),
				);
			}

			const bySearch = await client.listCoupons({ search: "list-alpha" });
			expect(bySearch.coupons.map((c) => c.id)).toEqual(["list-1"]);
			// The validity window rides the LIST read (PR #74 review): the console
			// renders expiry straight off the summary row — no per-row detail read.
			const windowed = bySearch.coupons[0]!;
			expect(windowed.startsAt).toBe("2026-07-01T00:00:00.000Z");
			expect(windowed.expiresAt).toBe("2026-08-01T00:00:00.000Z");
			// And a windowless coupon carries EXPLICIT nulls, never absent fields.
			const bare = await client.listCoupons({ search: "list-beta" });
			expect(bare.coupons[0]?.startsAt).toBeNull();
			expect(bare.coupons[0]?.expiresAt).toBeNull();
			const noMatch = await client.listCoupons({ search: "list-alph" }); // substring must NOT match
			expect(noMatch.coupons).toEqual([]);
		});
	});
}
