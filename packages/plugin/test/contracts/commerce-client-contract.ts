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
 * ASYNC REJECTIONS ONLY. Most failures here are typed RESULT VALUES
 * (`{ ok: false, reason }`) and are asserted as values. Where the port declares no
 * typed result — a malformed input — the failure is asserted as an AWAITED
 * REJECTION and never as a synchronous `throw`, so an implementation that refuses
 * before it does any work and one that cannot refuse before a round trip behave
 * alike under the same case. No case anywhere in this file asserts a status code,
 * in either direction; see `expectRejectedInput` for the one asymmetry that
 * follows from that and how it is handled.
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

/**
 * One minted customer session — the ONLY credential any identity-bearing method
 * takes. `customerId` is what the tier's session store resolved the bearer to; a
 * tier that cannot see it omits it, so a case may assert on it only when it is
 * defined.
 */
export interface ArrangedSession {
	readonly bearer: string;
	readonly customerId?: string;
}

/** One GUEST order — an order under an email that has not been proven yet, which
 *  is the real state an order is in before its buyer logs in and claims it. Every
 *  optional field has a default, so a case names only what it asserts on. */
export interface ArrangedOrder {
	orderId: string;
	/** The email the order was placed under. Logging in as it claims the order. */
	buyerRef: string;
	sku?: string;
	productId?: string;
	title?: string;
	unitPrice?: CommerceMoney;
	quantity?: number;
}

/** One shipping zone, one flat-rate method in it, and optionally the rate. A spec
 *  with NO rate is how a case arranges the rate-missing refusal: the method
 *  resolves and its rate does not. */
export interface ArrangedShippingMethod {
	zoneId: string;
	methodId: string;
	rate?: CommerceMoney;
}

/**
 * One fixed-amount coupon, in the shape the quote path validates. Every refusal
 * the quote can return is arranged by a field here, and NONE of them by waiting:
 * the window bounds are absolute instants far outside any tier's clock, and
 * exhaustion is `maxUses: 0` (uses start at zero, and zero uses of zero permitted
 * is already exhausted). A tier's clock therefore never enters these cases.
 */
export interface ArrangedCoupon {
	id: string;
	code: string;
	/** The discount, in integer minor units with its own currency — which is what
	 *  the currency-mismatch refusal compares against the cart's. */
	amount: CommerceMoney;
	minSubtotalCents?: number | null;
	maxUses?: number | null;
	startsAt?: string | null;
	expiresAt?: string | null;
}

export interface CommerceClientTierArrange {
	/** Seed (or re-seed) one commerce row; resolves to its productId. */
	product(spec: ArrangedProduct): Promise<string>;
	/** Seed an empty cart; resolves to its cartId. */
	cart(currency?: string): Promise<string>;
	/**
	 * Mint a real session for `email`, through whatever login this transport
	 * genuinely has — never by writing a session row behind the port's back. That
	 * is the point of the hook: the identity cases below are worth nothing if the
	 * bearer they hold was not issued the way a shopper's is.
	 */
	session(email: string): Promise<ArrangedSession>;
	/** Seed one guest order; resolves to its orderId. */
	order(spec: ArrangedOrder): Promise<string>;
	/** Seed one address belonging to `session`'s customer. */
	address(session: ArrangedSession, spec: { name: string }): Promise<void>;
	/** Seed a shipping zone + method (+ rate, when the spec carries one). */
	shippingMethod(spec: ArrangedShippingMethod): Promise<void>;
	/** Seed one coupon. */
	coupon(spec: ArrangedCoupon): Promise<void>;
}

/**
 * OPTIONAL. A tier that can move its own clock forward implements this, and the
 * cases whose subject is an elapsed deadline run on it; a tier without one SKIPS
 * those cases, with the reason in the case name rather than in a comment nobody
 * reads from a test report.
 *
 * It is optional because a shared, long-lived backend cannot honour it: winding
 * one clock forward expires every OTHER case's holds too, and a tier whose
 * `reset()` is a documented no-op has no way to put that back.
 */
export interface CommerceClientTierClock {
	advance(ms: number): Promise<void>;
}

/**
 * OPTIONAL. Whether this tier composes a payment gateway at all, i.e. whether a
 * checkout can SUCCEED on it. Absent ⇒ it cannot, and the cases whose subject is a
 * minted order skip with the reason in the case name.
 *
 * This is a phase gap rather than a defect, and it is asymmetric in the useful
 * direction: the transport being replaced carries the gateways today and the
 * replacement gets them when the payment adapters move, at which point the flag
 * appears and these cases start running with no edit here.
 */
export interface CommerceClientTierPayments {
	/** The method whose gateway this tier composes. */
	readonly method: "stripe" | "x402";
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
	/** OPTIONAL: see {@link CommerceClientTierClock}. Absent ⇒ the cases whose
	 *  subject is an elapsed deadline skip, saying so in their own names. */
	readonly clock?: CommerceClientTierClock;
	/** OPTIONAL: see {@link CommerceClientTierPayments}. Absent ⇒ the cases whose
	 *  subject is a minted order skip, saying so in their own names. */
	readonly payments?: CommerceClientTierPayments;
	arrange: CommerceClientTierArrange;
}

/**
 * A refused input, asserted the ONE way both transports can honour.
 *
 * AWAITED, ALWAYS. The rejection must arrive from the returned promise and never
 * from a synchronous `throw`, so an in-process method that checks its inputs
 * immediately and a client that cannot refuse anything before its round trip
 * behave alike under one case.
 *
 * THE CODE WHERE THERE IS ONE, AND NEVER A STATUS. One transport refuses at its
 * own boundary with a structural `INVALID_INPUT` naming the field; the other
 * refuses at a wire, and its client error carries that wire's status and body and
 * no code at all. Asserting the code unconditionally would fail a tier over the
 * SHAPE of its error rather than over its behaviour, and asserting the status
 * would smuggle the wire back into the one contract that exists to be free of it.
 * So: both must reject, and a tier that does name a code must name the right one.
 */
async function expectRejectedInput(call: Promise<unknown>, field: string): Promise<void> {
	let raised: unknown;
	let resolved = false;
	await call.then(
		() => {
			resolved = true;
		},
		(err: unknown) => {
			raised = err;
		},
	);
	if (resolved) throw new Error(`expected a rejection for ${field}; the call resolved instead`);
	expect(raised, `${field}: rejected with an error`).toBeInstanceOf(Error);
	const code = (raised as { code?: unknown }).code;
	if (code !== undefined) {
		expect(code, `${field}: structural code`).toBe("INVALID_INPUT");
		expect((raised as { field?: unknown }).field, `${field}: the field it names`).toBe(field);
	}
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
// TIME. The lifted cases control it only by passing explicit `contentUpdatedAt` /
// `expectedUpdatedAt` watermark ARGUMENTS, which are inputs to the port and
// travel with the cases. Exactly ONE case needs more than that — the elapsed
// hold — and it takes it through the OPTIONAL `clock` hook rather than by
// sleeping, so a tier that cannot move its clock skips that one case and runs
// every other. No case asserts a generated id.
//
// TWO OPTIONAL HOOKS, AND WHY OPTIONAL IS NOT A LOOPHOLE. `clock` and `payments`
// gate one case each, in OPPOSITE directions — one tier has the gateways and not
// the movable clock, the other has the movable clock and not the gateways — so
// neither gate is a tier quietly excusing itself from the shared spec. A gated
// case states its gate in its own NAME, so a test report says which tier skipped
// what and why without anyone reading this file. Every other case runs on every
// tier, unchanged: the moment a tier is allowed to narrow, reorder or soften one,
// the equivalence this contract exists to prove is gone.

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

		// ── the gap cases ─────────────────────────────────────────────────
		//
		// Everything above was LIFTED from the HTTP client's own suites, so it
		// was already proven on one transport before it was shared. Everything
		// below was proven on ONE transport only — or on neither — and is moved
		// here so both run it. That is the whole of the equivalence proof: a
		// surface that only one implementation's suite ever touched is a surface
		// where the two may already disagree and nobody would know.
		//
		// TWO CASES ARE GATED, in opposite directions, and each names its reason
		// in its own title so a test report says why rather than a comment:
		//  - the elapsed-deadline case needs `tier.clock`, which a shared,
		//    long-lived backend cannot offer;
		//  - the minted-order case needs `tier.payments`, which the transport
		//    that has not yet received the payment adapters cannot offer.
		// Neither is a weakened case. Each runs in full where it can run at all,
		// and starts running on the other tier the day that tier grows the hook.

		// ── identity: the session is the only credential ───────────────────
		//
		// No method on this port takes a customer id, so the isolation below is
		// STRUCTURAL rather than a filter someone could forget to apply. Each
		// case uses its own email: `reset()` is a documented no-op on a tier whose
		// backend is expensive to rebuild, so a shared address would let one
		// case's claimed order show up in another's list.

		test("a login mints a session that resolves, and logout invalidates it", async () => {
			const { bearer } = await tier.arrange.session("id-logout@example.test");
			expect(await client.listMyOrders(bearer)).toEqual({ ok: true, orders: [] });

			await client.logout(bearer);
			// Every `my` method, because one of them remembering a revoked session is
			// the whole failure mode worth testing.
			expect(await client.listMyOrders(bearer)).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
			expect(await client.listMyAddresses(bearer)).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
			expect(await client.getMyOrder(bearer, "id-logout-any-order")).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
		});

		test("an unknown bearer is UNAUTHENTICATED on every method that takes one", async () => {
			const forged = "not-a-session-token";
			expect(await client.listMyOrders(forged)).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
			expect(await client.listMyAddresses(forged)).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
			expect(await client.getMyOrder(forged, "id-forged-any-order")).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
			// The session arm of the delivery check too: an unusable bearer is not a
			// downgrade to "no scope", it is unauthenticated.
			expect(await client.checkEntitlement({}, "SKU-ID-FORGED", { sessionToken: forged })).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
		});

		test("with no credential at all, the delivery check is CLOSED rather than open", async () => {
			expect(await client.checkEntitlement({}, "SKU-ID-NONE")).toEqual({
				ok: false,
				reason: "UNAUTHENTICATED",
			});
		});

		test("the order-id scope is an OPEN capability and IGNORES any bearer that came along", async () => {
			// The order id IS the credential and there is no email in the question, so
			// there is nothing to probe: an unknown id answers "not active", never a
			// refusal and never an existence signal.
			expect(await client.checkEntitlement({ orderId: "id-cap-unknown" }, "SKU-ID-CAP")).toEqual({
				ok: true,
				active: false,
			});
			// A bearer alongside it changes NOTHING — the scope is chosen by what the
			// request contains, not by whichever credential looks best, which is what
			// keeps a "does order X belong to email Y" oracle out of this surface. An
			// UNUSABLE bearer proves it: were the session consulted at all, this would
			// have to be unauthenticated instead.
			expect(
				await client.checkEntitlement({ orderId: "id-cap-unknown" }, "SKU-ID-CAP", {
					sessionToken: "not-a-session-token",
				}),
			).toEqual({ ok: true, active: false });
			// And with a VALID one, the answer is still the order-id scope's.
			const { bearer } = await tier.arrange.session("id-capability@example.test");
			expect(
				await client.checkEntitlement({ orderId: "id-cap-unknown" }, "SKU-ID-CAP", {
					sessionToken: bearer,
				}),
			).toEqual({ ok: true, active: false });
		});

		test("the session arm derives the buyer's email server-side — the port carries NO field for one", async () => {
			const { bearer } = await tier.arrange.session("id-derived@example.test");
			// It answers, and it answers about THIS session's own customer: nothing in
			// the call named an email or a customer id, because nothing in the call
			// could. That the scope cannot express one is a property of the TYPE rather
			// than of any value, so it is asserted by the compiler at the bottom of this
			// file — a runtime `Object.keys` on a literal written here would assert only
			// that this file wrote it.
			expect(await client.checkEntitlement({}, "SKU-ID-DERIVED", { sessionToken: bearer })).toEqual(
				{ ok: true, active: false },
			);
		});

		test("two sessions see only their own data — the isolation is derived, not filtered", async () => {
			const mine = await tier.arrange.session("id-mine@example.test");
			const theirs = await tier.arrange.session("id-theirs@example.test");
			expect(mine.bearer).not.toBe(theirs.bearer);
			// Where the tier can see which customer a bearer resolved to, the two must be
			// different customers and not merely different tokens.
			if (mine.customerId !== undefined && theirs.customerId !== undefined) {
				expect(mine.customerId).not.toBe(theirs.customerId);
			}

			// Addresses are the cheapest per-customer state there is, and they exercise
			// the same derivation every `my` read uses.
			await tier.arrange.address(mine, { name: "Mine" });

			const minesView = await client.listMyAddresses(mine.bearer);
			expect(minesView.ok && minesView.addresses.map((address) => address.name)).toEqual(["Mine"]);
			// The other session shares the whole backend and sees none of it.
			expect(await client.listMyAddresses(theirs.bearer)).toEqual({ ok: true, addresses: [] });
		});

		test("the owner sees their claimed order; a FOREIGN one is NOT_FOUND, indistinguishable from an id nobody minted", async () => {
			// The order exists as a GUEST order under the owner's address first, because
			// that is the state every order is in before its buyer proves the inbox.
			const orderId = await tier.arrange.order({
				orderId: "id-owned-order-1",
				buyerRef: "id-owner@example.test",
			});
			// Logging in proves the inbox and CLAIMS it — the real path to ownership.
			const mine = await tier.arrange.session("id-owner@example.test");
			const theirs = await tier.arrange.session("id-stranger@example.test");

			const ownerView = await client.getMyOrder(mine.bearer, orderId);
			expect(ownerView.ok && ownerView.order.id).toBe(orderId);
			const ownerList = await client.listMyOrders(mine.bearer);
			expect(ownerList.ok && ownerList.orders.map((order) => order.id)).toEqual([orderId]);

			// The other session: the order genuinely exists and genuinely is not theirs.
			expect(await client.getMyOrder(theirs.bearer, orderId)).toEqual({
				ok: false,
				reason: "NOT_FOUND",
			});
			// An id nobody ever minted answers IDENTICALLY, which is the entire point —
			// the two must be indistinguishable to a caller probing ids.
			expect(await client.getMyOrder(theirs.bearer, "id-never-existed")).toEqual({
				ok: false,
				reason: "NOT_FOUND",
			});
			// And their own list stays empty: no cross-customer leak by another route.
			expect(await client.listMyOrders(theirs.bearer)).toEqual({ ok: true, orders: [] });
		});

		// ── the publish gate and its watermark ─────────────────────────────

		test("activate/deactivate are watermark-ordered: a newer watermark wins and an older one is a stale no-op", async () => {
			const productId = await tier.arrange.product({
				productId: "prod-wmgate",
				sku: "SKU-WMGATE",
				price: { amount: 1000, currency: "USD" },
				idempotencyKey: "wmgate-seed",
			});
			async function active(): Promise<boolean | undefined> {
				return (await client.getProductCommerce(productId))?.active;
			}

			await client.activateProductCommerce(productId, "wmgate-act", "2026-08-01T00:00:00.000Z");
			expect(await active()).toBe(true);

			// An OLDER watermark is a no-op rather than an error: the sync fires and
			// forgets, and out-of-order delivery is normal rather than exceptional.
			await client.deactivateProductCommerce(
				productId,
				"wmgate-stale-deact",
				"2026-07-01T00:00:00.000Z",
			);
			expect(await active()).toBe(true);

			// A NEWER one wins.
			await client.deactivateProductCommerce(productId, "wmgate-deact", "2026-08-02T00:00:00.000Z");
			expect(await active()).toBe(false);

			// And an older activate cannot bring it back, which is the direction that
			// matters: a late-arriving publish must not republish a withdrawn product.
			await client.activateProductCommerce(
				productId,
				"wmgate-stale-act",
				"2026-07-15T00:00:00.000Z",
			);
			expect(await active()).toBe(false);
		});

		// ── quote: shipping selection and the coupon refusals ──────────────

		/** A cart holding 2 × $15.00 of one product — a 3000-minor-unit subtotal
		 *  every quote case below reasons against. */
		async function pricedCart(tag: string, cartCurrency = "USD"): Promise<string> {
			const productId = await tier.arrange.product({
				productId: `prod-q-${tag}`,
				sku: `SKU-Q-${tag.toUpperCase()}`,
				price: { amount: 1500, currency: "USD" },
				onHand: 10,
				idempotencyKey: `q-seed-${tag}`,
			});
			const cartId = await tier.arrange.cart(cartCurrency);
			const added = await client.addCartLine(
				cartId,
				`SKU-Q-${tag.toUpperCase()}`,
				productId,
				2,
				`q-add-${tag}`,
			);
			if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
			return cartId;
		}

		test("a quote with a shipping zone and method selected adds the method's rate to the total", async () => {
			await tier.arrange.shippingMethod({
				zoneId: "zone-q-ship",
				methodId: "method-q-ship",
				rate: { amount: 599, currency: "USD" },
			});
			const cartId = await pricedCart("ship");

			const quoted = await client.quoteCheckout({
				cartId,
				shippingZoneId: "zone-q-ship",
				shippingMethodId: "method-q-ship",
			});
			expect(quoted.ok).toBe(true);
			if (!quoted.ok) throw new Error("unreachable");
			// Integer minor units end to end: 3000 + 599, no tax rate seeded so no tax,
			// no coupon so no discount. No float anywhere in the sum.
			expect(quoted.breakdown).toMatchObject({
				currency: "USD",
				subtotalCents: 3000,
				shippingCents: 599,
				discountCents: 0,
				taxCents: 0,
				totalCents: 3599,
				appliedCouponCode: null,
			});
		});

		test("a shipping method nobody declared refuses SHIPPING_METHOD_NOT_FOUND", async () => {
			const cartId = await pricedCart("nomethod");
			expect(
				await client.quoteCheckout({ cartId, shippingMethodId: "method-q-never-declared" }),
			).toEqual({ ok: false, reason: "SHIPPING_METHOD_NOT_FOUND" });
		});

		test("a declared method with no rate in the cart's currency refuses SHIPPING_RATE_NOT_FOUND", async () => {
			// The method resolves and its rate does not, which is the only way to reach
			// this refusal and a real merchant state: a method added and never priced.
			await tier.arrange.shippingMethod({ zoneId: "zone-q-norate", methodId: "method-q-norate" });
			const cartId = await pricedCart("norate");
			expect(
				await client.quoteCheckout({
					cartId,
					shippingZoneId: "zone-q-norate",
					shippingMethodId: "method-q-norate",
				}),
			).toEqual({ ok: false, reason: "SHIPPING_RATE_NOT_FOUND" });
		});

		// EVERY quote-time coupon refusal the port declares, one case each, each with
		// a coupon seeded into exactly the state that produces it. `COUPON_EXHAUSTED`
		// is seeded as a cap of zero rather than by redeeming anything: uses start at
		// zero, and zero uses of zero permitted is already exhausted — so the case
		// needs no second checkout and no clock.
		//
		// `COUPON_MAX_PER_CUSTOMER` is deliberately ABSENT and that is not an omission:
		// it is a CHECKOUT-only refusal. The quote path validates and never redeems, so
		// a per-customer cap cannot surface from it; the port says as much by leaving it
		// out of the quote's reason union and carrying it in the checkout's.

		test("a valid coupon discounts the total — the positive control the refusals below are measured against", async () => {
			await tier.arrange.coupon({
				id: "cpn-q-ok",
				code: "Q-OK-500",
				amount: { amount: 500, currency: "USD" },
			});
			const cartId = await pricedCart("cpnok");
			const quoted = await client.quoteCheckout({ cartId, couponCode: "Q-OK-500" });
			expect(quoted.ok).toBe(true);
			if (!quoted.ok) throw new Error("unreachable");
			expect(quoted.breakdown).toMatchObject({
				subtotalCents: 3000,
				discountCents: 500,
				totalCents: 2500,
				appliedCouponCode: "Q-OK-500",
			});
		});

		test("a coupon code nobody seeded refuses COUPON_NOT_FOUND", async () => {
			const cartId = await pricedCart("cpnmissing");
			expect(await client.quoteCheckout({ cartId, couponCode: "Q-NEVER-SEEDED" })).toEqual({
				ok: false,
				reason: "COUPON_NOT_FOUND",
			});
		});

		test("a coupon outside its validity window refuses COUPON_NOT_ACTIVE, in both directions", async () => {
			// Absolute instants far either side of any tier's clock, so the case turns on
			// the window and never on what time it is where it runs.
			await tier.arrange.coupon({
				id: "cpn-q-early",
				code: "Q-NOT-YET",
				amount: { amount: 500, currency: "USD" },
				startsAt: "2999-01-01T00:00:00.000Z",
			});
			await tier.arrange.coupon({
				id: "cpn-q-late",
				code: "Q-EXPIRED",
				amount: { amount: 500, currency: "USD" },
				expiresAt: "2000-01-01T00:00:00.000Z",
			});
			const cartId = await pricedCart("cpnwindow");

			expect(await client.quoteCheckout({ cartId, couponCode: "Q-NOT-YET" })).toEqual({
				ok: false,
				reason: "COUPON_NOT_ACTIVE",
			});
			expect(await client.quoteCheckout({ cartId, couponCode: "Q-EXPIRED" })).toEqual({
				ok: false,
				reason: "COUPON_NOT_ACTIVE",
			});
		});

		test("a coupon whose minimum the cart does not reach refuses COUPON_MIN_SUBTOTAL", async () => {
			await tier.arrange.coupon({
				id: "cpn-q-min",
				code: "Q-MIN-5000",
				amount: { amount: 500, currency: "USD" },
				minSubtotalCents: 5000, // the cart subtotals 3000
			});
			const cartId = await pricedCart("cpnmin");
			expect(await client.quoteCheckout({ cartId, couponCode: "Q-MIN-5000" })).toEqual({
				ok: false,
				reason: "COUPON_MIN_SUBTOTAL",
			});
		});

		test("a coupon with no uses left refuses COUPON_EXHAUSTED", async () => {
			await tier.arrange.coupon({
				id: "cpn-q-used",
				code: "Q-EXHAUSTED",
				amount: { amount: 500, currency: "USD" },
				maxUses: 0,
			});
			const cartId = await pricedCart("cpnused");
			expect(await client.quoteCheckout({ cartId, couponCode: "Q-EXHAUSTED" })).toEqual({
				ok: false,
				reason: "COUPON_EXHAUSTED",
			});
		});

		test("a coupon denominated in another currency refuses COUPON_CURRENCY_MISMATCH", async () => {
			await tier.arrange.coupon({
				id: "cpn-q-eur",
				code: "Q-EUR-500",
				amount: { amount: 500, currency: "EUR" },
			});
			const cartId = await pricedCart("cpneur"); // a USD cart
			expect(await client.quoteCheckout({ cartId, couponCode: "Q-EUR-500" })).toEqual({
				ok: false,
				reason: "COUPON_CURRENCY_MISMATCH",
			});
		});

		// ── the public order read ──────────────────────────────────────────

		test("getPublicOrder returns the guest whitelist and omits every private field; an unknown id is ORDER_NOT_FOUND", async () => {
			const orderId = await tier.arrange.order({
				orderId: "order-public-1",
				buyerRef: "public-order@example.test",
				sku: "SKU-PUBLIC-1",
				productId: "prod-public-1",
				title: "Public One",
				unitPrice: { amount: 2500, currency: "USD" },
				quantity: 2,
			});

			const read = await client.getPublicOrder(orderId);
			expect(read.ok).toBe(true);
			if (!read.ok) throw new Error("unreachable");
			expect(read.order).toMatchObject({
				id: orderId,
				currency: "USD",
				totals: { currency: "USD", subtotalCents: 5000, totalCents: 5000 },
				lines: [
					{
						sku: "SKU-PUBLIC-1",
						title: "Public One",
						unitPriceCents: 2500,
						currency: "USD",
						quantity: 2,
					},
				],
			});
			// A WHITELIST, so the private fields are ABSENT rather than nulled: a caller
			// must not be able to tell "redacted" from "never there" and probe the shape.
			for (const field of ["buyerRef", "customerId", "shippingAddress"]) {
				expect(read.order, `${field} must not reach a guest`).not.toHaveProperty(field);
			}

			expect(await client.getPublicOrder("order-public-never-minted")).toEqual({
				ok: false,
				reason: "ORDER_NOT_FOUND",
			});
		});

		// ── checkout: the replay, where a checkout can succeed at all ──────

		test.skipIf(tier.payments === undefined)(
			"checkout replays on its idempotency key: the same order, no second order, and stock consumed exactly once (SKIPPED where the tier composes no payment gateway)",
			async () => {
				const paymentMethod = tier.payments?.method ?? "stripe";
				// THE TITLE IS LOAD-BEARING, not decoration: order pricing snapshots the
				// price AND the title onto the line at purchase time, so a row nobody has
				// titled cannot be ordered at all — it is refused PRODUCT_NOT_PRICED, the
				// same token an unpriced row gets. Every case that mints an order therefore
				// arranges a titled product, and it says so here because the refusal names
				// the price and points at the title.
				const productId = await tier.arrange.product({
					productId: "prod-co-replay",
					sku: "SKU-CO-REPLAY",
					title: "Replay Product",
					price: { amount: 2500, currency: "USD" },
					onHand: 3,
					idempotencyKey: "co-replay-seed",
				});
				const cartId = await tier.arrange.cart("USD");
				const added = await client.addCartLine(
					cartId,
					"SKU-CO-REPLAY",
					productId,
					2,
					"co-replay-add",
				);
				if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);

				const first = await client.createOrder(
					{ cartId, paymentMethod, buyerRef: "co-replay@example.test" },
					"co-replay-key",
				);
				if (!first.ok) throw new Error(`checkout failed: ${first.reason}`);

				// THE SAME KEY: the same order, not a second one beside it.
				const replay = await client.createOrder(
					{ cartId, paymentMethod, buyerRef: "co-replay@example.test" },
					"co-replay-key",
				);
				if (!replay.ok) throw new Error(`replay failed: ${replay.reason}`);
				expect(replay.order.id).toBe(first.order.id);
				expect(replay.order.totals.totalCents).toBe(first.order.totals.totalCents);

				// A DISTINCT key against the same cart is refused, which is what proves the
				// replay above was honoured as a replay and not as a second checkout that
				// happened to look alike.
				const second = await client.createOrder(
					{ cartId, paymentMethod, buyerRef: "co-replay@example.test" },
					"co-replay-other-key",
				);
				expect(second).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });

				// And stock moved ONCE: three units existed, two were bought, so exactly one
				// is addable and two are not. A double-consumed hold fails the first half.
				const probe = await tier.arrange.cart("USD");
				expect(
					await client.addCartLine(probe, "SKU-CO-REPLAY", productId, 2, "co-replay-probe-2"),
				).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
				const one = await client.addCartLine(
					probe,
					"SKU-CO-REPLAY",
					productId,
					1,
					"co-replay-probe-1",
				);
				expect(one.ok).toBe(true);
			},
		);

		test.skipIf(tier.clock === undefined)(
			"once a cart's hold lapses the cart holds nothing, cannot be quoted, and its units are free again (SKIPPED where the tier cannot move its own clock)",
			async () => {
				const clock = tier.clock;
				if (clock === undefined) throw new Error("unreachable");
				const productId = await tier.arrange.product({
					productId: "prod-co-expired",
					sku: "SKU-CO-EXPIRED",
					price: { amount: 2500, currency: "USD" },
					onHand: 3,
					idempotencyKey: "co-expired-seed",
				});
				const cartId = await tier.arrange.cart("USD");
				const added = await client.addCartLine(
					cartId,
					"SKU-CO-EXPIRED",
					productId,
					2,
					"co-expired-add",
				);
				if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
				expect(added.line.reservationId).not.toBeNull();
				// It quotes NOW, so everything asserted after the wind-forward is about the
				// deadline and nothing else about the cart.
				expect((await client.quoteCheckout({ cartId })).ok).toBe(true);

				// Past the hold window. NOTHING SWEEPS: the expiry is lazy and belongs to the
				// cart read, which is the behaviour worth pinning — a lapsed hold must stop
				// being spendable the moment it lapses, not whenever a sweeper next runs.
				await clock.advance(31 * 60 * 1000);

				// The line is GONE rather than shown without its hold, which is the honest
				// projection: a line whose stock is no longer held is not a line a shopper can
				// buy, and showing it with a null reservation would invite exactly that.
				const read = await client.getCart(cartId);
				expect(read).toMatchObject({ ok: true, cart: { state: "active", lines: [] } });
				// So there is nothing left to check out: an empty cart cannot be quoted, and a
				// cart that cannot be quoted cannot be bought.
				expect(await client.quoteCheckout({ cartId })).toEqual({
					ok: false,
					reason: "CART_EMPTY",
				});
				// And the old line id resolves to nothing, so a stale page cannot adjust it
				// back into existence.
				expect(await client.adjustCartLine(cartId, added.line.lineId, 1, "co-expired-adj")).toEqual(
					{ ok: false, reason: "LINE_NOT_FOUND" },
				);

				// The units were RELEASED, not merely hidden: all three are addable again.
				// Without this, a hold that lapsed without releasing its stock would pass
				// every assertion above while quietly making the product unsellable.
				const fresh = await tier.arrange.cart("USD");
				const reclaimed = await client.addCartLine(
					fresh,
					"SKU-CO-EXPIRED",
					productId,
					3,
					"co-expired-reclaim",
				);
				expect(reclaimed.ok).toBe(true);
			},
		);

		// BOTH HOOKS, so it runs on NEITHER tier today — and it is written anyway,
		// because the gap it names is real and otherwise invisible. Checkout resolves
		// its gateway BEFORE it reads the cart, so on a tier with no gateway every
		// cart-level checkout refusal is unreachable, and on a tier with a gateway there
		// is no way to reach the deadline. The refusal a lapsed hold must produce at the
		// checkout itself is therefore unasserted on both transports right now; this is
		// where it gets asserted the moment either tier grows the hook it lacks.
		test.skipIf(tier.clock === undefined || tier.payments === undefined)(
			"a checkout against a lapsed hold is refused RESERVATION_LOST (SKIPPED until one tier has both a movable clock and a payment gateway)",
			async () => {
				const clock = tier.clock;
				const paymentMethod = tier.payments?.method;
				if (clock === undefined || paymentMethod === undefined) throw new Error("unreachable");
				const productId = await tier.arrange.product({
					productId: "prod-co-lost",
					sku: "SKU-CO-LOST",
					price: { amount: 2500, currency: "USD" },
					onHand: 3,
					idempotencyKey: "co-lost-seed",
				});
				const cartId = await tier.arrange.cart("USD");
				const added = await client.addCartLine(cartId, "SKU-CO-LOST", productId, 2, "co-lost-add");
				if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);

				// Past the window, and WITHOUT reading the cart first: the checkout must
				// re-check the deadline itself rather than trusting that some earlier read
				// already swept the hold away.
				await clock.advance(31 * 60 * 1000);

				expect(
					await client.createOrder(
						{ cartId, paymentMethod, buyerRef: "co-lost@example.test" },
						"co-lost-key",
					),
				).toEqual({ ok: false, reason: "RESERVATION_LOST" });
			},
		);

		// ── the input bounds, on both transports ───────────────────────────
		//
		// These were proven on the in-process transport alone, where they were
		// written as the restoration of what the wire used to refuse. That is
		// exactly the claim that needs the OTHER transport to be worth anything:
		// "the refusal survived removing the wire" is only demonstrated by
		// running the same input through both and seeing both refuse.
		//
		// WHAT IS ASSERTED, AND THE ONE ASYMMETRY. Both transports REJECT — an
		// awaited rejection, never a synchronous throw and never a resolved value.
		// Only one of them carries a structural code with it: the in-process
		// refusal names `INVALID_INPUT` and the field, while the other transport's
		// client error carries the wire's status and body and no code at all. So
		// the shared assertion is the rejection plus the code WHERE THERE IS ONE,
		// and never a status — asserting a status here would put the wire back
		// into the contract that exists to be free of it.

		test("a garbage watermark is refused on the product upsert, and nothing is written", async () => {
			await expectRejectedInput(
				client.upsertProductCommerce(
					"prod-bnd-wm",
					{ sku: "SKU-BND-WM", price: { amount: 100, currency: "USD" }, contentUpdatedAt: "ZZZZ" },
					"bnd-wm-1",
				),
				"contentUpdatedAt",
			);
			// Refused BEFORE anything was written, so there is nothing to have wedged.
			// The stored watermark is compared as raw text, so ONE high-sorting garbage
			// value accepted once would make every later legitimate sync a stale no-op
			// forever, and the ordinary write path preserves it rather than healing it.
			expect(await client.getProductCommerce("prod-bnd-wm")).toBeNull();
		});

		test("a garbage watermark is refused on every lifecycle and variant transition that carries one", async () => {
			const productId = await tier.arrange.product({
				productId: "prod-bnd-wm2",
				sku: "SKU-BND-WM2",
				price: { amount: 100, currency: "USD" },
				idempotencyKey: "bnd-wm2-seed",
			});
			await expectRejectedInput(
				client.activateProductCommerce(productId, "bnd-wm2-act", "2026-09-14"),
				"contentUpdatedAt",
			);
			await expectRejectedInput(
				client.deactivateProductCommerce(productId, "bnd-wm2-deact", "not-a-date"),
				"contentUpdatedAt",
			);
			await expectRejectedInput(
				client.upsertProductVariant(
					productId,
					"large",
					{ contentUpdatedAt: "9999" },
					"bnd-wm2-decl",
				),
				"contentUpdatedAt",
			);
			await expectRejectedInput(
				client.deactivateProductVariant(productId, "large", "bnd-wm2-drop", "2026-09-14T00:00:00Z"),
				"contentUpdatedAt",
			);
			await expectRejectedInput(
				client.updateProductVariantFields(
					productId,
					"large",
					{ price: { amount: 100, currency: "USD" } },
					"whenever",
					"bnd-wm2-edit",
				),
				"expectedUpdatedAt",
			);
			// The publish gate is still closed and still honest — no transition landed.
			expect((await client.getProductCommerce(productId))?.active).toBe(false);
		});

		test("a whitespace-only variant key is refused on all three variant writers", async () => {
			const watermark = "2026-09-14T00:00:00.000Z";
			await expectRejectedInput(
				client.upsertProductVariant(
					"prod-bnd-vk",
					"   ",
					{ contentUpdatedAt: watermark },
					"bnd-vk-1",
				),
				"variantKey",
			);
			await expectRejectedInput(
				client.updateProductVariantFields(
					"prod-bnd-vk",
					"\t",
					{ price: { amount: 100, currency: "USD" } },
					watermark,
					"bnd-vk-2",
				),
				"variantKey",
			);
			await expectRejectedInput(
				client.deactivateProductVariant("prod-bnd-vk", "", "bnd-vk-3", watermark),
				"variantKey",
			);
		});

		test("an empty title is refused — the field is omitted to preserve, nulled to clear, never blanked", async () => {
			await expectRejectedInput(
				client.upsertProductCommerce(
					"prod-bnd-title",
					{ sku: "SKU-BND-TITLE", title: "" },
					"bnd-t-1",
				),
				"title",
			);
			await expectRejectedInput(
				client.upsertProductVariant(
					"prod-bnd-title",
					"large",
					{ title: "", contentUpdatedAt: "2026-09-14T00:00:00.000Z" },
					"bnd-t-2",
				),
				"title",
			);
		});

		test("a zero variant price is refused, and the row stays UNPRICED rather than priced at zero", async () => {
			const productId = await tier.arrange.product({
				productId: "prod-bnd-zero",
				sku: "SKU-BND-ZERO",
				price: { amount: 1000, currency: "USD" },
				idempotencyKey: "bnd-zero-seed",
			});
			const declared = await client.upsertProductVariant(
				productId,
				"large",
				{ title: "Large", contentUpdatedAt: "2026-09-14T00:00:00.000Z" },
				"bnd-zero-declare",
			);
			// An absent price is expressed by OMITTING the field, so a zero is a mistake
			// rather than a clearing — and rendering "nobody has priced this" as free is
			// the failure this refusal exists to prevent.
			await expectRejectedInput(
				client.updateProductVariantFields(
					productId,
					"large",
					{ price: { amount: 0, currency: "USD" } },
					declared.updatedAt,
					"bnd-zero-edit",
				),
				"price.amount",
			);
			expect((await client.listProductVariants(productId))[0]?.price).toBeNull();
		});

		test("a batch read over the cap is refused as a whole, never silently truncated", async () => {
			await expectRejectedInput(
				client.getCommerceBatch(
					Array.from({ length: 101 }, (_, i) => `prod-bnd-batch-${String(i)}`),
				),
				"productIds",
			);
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

// ── the delivery check's scope, asserted by the COMPILER ──────────────────
//
// TRANSPORT-AGNOSTIC because it is a property of the PORT rather than of either
// implementation, which is why it belongs here and not beside one of them.
//
// The scope must stay exactly `{ orderId?: string }`. The operator-only raw-email
// scope is not "refused" by this port, it is UNREPRESENTABLE — and the only honest
// way to assert that is to ask the compiler, because a test cannot call a
// signature that does not exist. Both directions are pinned: the one key must
// typecheck, and no other key may.

type EntitlementScope = Parameters<CommerceClient["checkEntitlement"]>[0];

/** Exhaustiveness: a scope with only `orderId` is a COMPLETE `EntitlementScope`,
 *  so no other key is required, and this assignment is what proves it. */
const completeScope: Required<EntitlementScope> = { orderId: "order-1" };
void completeScope;

// The raw-email scope: the field the other surface had and this port must never
// grow.
// @ts-expect-error — `buyerRef` is not part of the scope this port accepts.
const withBuyerRef: EntitlementScope = { orderId: "order-1", buyerRef: "someone@example.test" };
void withBuyerRef;

// And nothing else either: an unknown key is a type error rather than a silently
// ignored field, which is what keeps a future "just pass the customer id" from
// compiling.
// @ts-expect-error — the scope carries no customer identity of any kind.
const withCustomerId: EntitlementScope = { orderId: "order-1", customerId: "cus_1" };
void withCustomerId;
