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

/** The admin orders surface the contract exercises — the class's WHOLE public
 *  surface, named method by method, for the same reason products is: INC-B10b-ii
 *  folds all twelve in-process, and a surface that listed fewer would let one be
 *  forgotten silently. */
export type OrdersClientSurface = Pick<
	AdminOrdersClient,
	| "listOrders"
	| "getOrder"
	| "transitionOrder"
	| "resolveReconciliation"
	| "recordFulfillment"
	| "cancelOrder"
	| "getCustomerContext"
	| "getTimeline"
	| "getRefunds"
	| "refundOrder"
	| "listNotes"
	| "addNote"
>;
/** The admin products surface the contract exercises — the class's WHOLE public
 *  surface, named method by method, because INC-B10b-i folds all six in-process
 *  and a surface that listed fewer would let one be forgotten silently. */
export type ProductsClientSurface = Pick<
	AdminProductsClient,
	"updateProduct" | "restock" | "removeStock" | "listProducts" | "getProduct" | "getTaxClasses"
>;
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

/**
 * What a tier's admin composition hands back.
 *
 * EVERY SURFACE EXCEPT `products` IS OPTIONAL, and that is a statement about the
 * world rather than a convenience: rules and reporting arrive in-process with
 * INC-B10c, so the in-process tier genuinely has neither yet.
 *
 * `orders` IS FOLDED IN NOW (INC-B10b-ii) and is still typed optional, which is
 * deliberate: it is read through `requireSurface` — the `rules` idiom — so a tier
 * that binds the slice without an orders surface fails LOUDLY at bind time,
 * naming itself and the surface, rather than being unable to express the gap at
 * all. `products` is the one non-optional member because the slice reads it in
 * its own `beforeAll` before any case runs.
 *
 * THE ALTERNATIVE WAS A STUB — an empty `listOrders`, an empty `listCoupons`, a
 * zeroed `getRevenue` — and a stub would make those slices PASS against an
 * implementation that does nothing. A green suite asserting the absence of
 * behaviour is worse than a missing one, because it is indistinguishable from
 * evidence. An absent surface makes its slice fail loudly instead
 * (`requireSurface`), so the gap shows up in a test report and closes by wiring,
 * never by softening a case.
 */
export interface AdminClientSurfaces {
	orders?: OrdersClientSurface;
	products: ProductsClientSurface;
	rules?: RulesClientSurface;
	reporting?: ReportingClientSurface;
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
 * takes. `customerId` is what the tier's session store resolved the bearer to.
 *
 * It is typed optional because a bearer that resolves to nothing is a real outcome
 * the hook must be able to report, but the isolation case REQUIRES it and asserts
 * it present: a tier that minted a session whose bearer it cannot resolve has not
 * minted a session, and failing there is better than silently skipping the
 * cross-customer comparison that follows.
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
	/** Seed one tax-class registry entry. Seeded through the port on both tiers —
	 *  the admin rules client that would otherwise create one is a surface the
	 *  products slice must not depend on. */
	taxClass(spec: { id: string; name: string }): Promise<void>;
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

/** One admin surface, or a loud failure naming the tier and the surface it does
 *  not have. The counterpart to `AdminClientSurfaces`' optional members: a slice
 *  bound to a tier that lacks its surface FAILS rather than running against a
 *  stub that would agree with anything. */
function requireSurface<K extends keyof AdminClientSurfaces>(
	tier: CommerceClientTier,
	surfaces: AdminClientSurfaces,
	key: K,
): NonNullable<AdminClientSurfaces[K]> {
	const surface = surfaces[key];
	if (surface === undefined) {
		throw new Error(
			`commerceClientContract: tier "${tier.name}" provides no admin ${key} surface, so it cannot run the slice that exercises it`,
		);
	}
	return surface as NonNullable<AdminClientSurfaces[K]>;
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
			// Two different customers, not merely two different tokens — which is the half a
			// filter-based implementation can fake and a derivation-based one cannot. Both
			// ids are asserted PRESENT first, so a tier that stopped resolving them fails
			// here instead of quietly skipping the comparison that follows.
			expect(mine.customerId, "the tier must resolve the bearer it minted").toBeDefined();
			expect(theirs.customerId, "the tier must resolve the bearer it minted").toBeDefined();
			expect(mine.customerId).not.toBe(theirs.customerId);

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
			// A SPACE rather than an empty string, deliberately: an empty key makes the
			// other transport build a path with an empty segment, which misses its route
			// entirely — so an empty-key case would be asserting a route miss on one tier
			// and the bound on the other. The empty-string arm is asserted where the
			// refusal is structural, on the tier that checks the bound before any call.
			await expectRejectedInput(
				client.deactivateProductVariant("prod-bnd-vk", " ", "bnd-vk-3", watermark),
				"variantKey",
			);
			// NOTHING WAS DECLARED: a refused key must not leave a row behind under some
			// trimmed or coerced name, which is the failure a rejection alone would hide.
			expect(await client.listProductVariants("prod-bnd-vk")).toEqual([]);
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
			// Neither write landed. A blank title that was refused and then written anyway
			// would be worse than one accepted openly: the row would claim a name it does
			// not have, and the refusal would say it could not happen.
			expect(await client.getProductCommerce("prod-bnd-title")).toBeNull();
			expect(await client.listProductVariants("prod-bnd-title")).toEqual([]);
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
			const overCap = Array.from({ length: 101 }, (_, i) => `prod-bnd-batch-${String(i)}`);
			await expectRejectedInput(client.getCommerceBatch(overCap), "productIds");
			// REFUSED, not trimmed to the cap and answered: a truncated read looks like a
			// complete one to its caller, so the assertion is that no items came back at
			// all rather than merely that something was raised.
			let items: unknown = "the call resolved";
			await client.getCommerceBatch(overCap).then(
				(value) => {
					items = value;
				},
				() => {
					items = undefined;
				},
			);
			expect(items).toBeUndefined();
			// And the cap is the ONLY reason: the same ids one under the cap read cleanly,
			// so the refusal is about the request's size and not about the ids in it.
			expect(await client.getCommerceBatch(overCap.slice(0, 100))).toEqual([]);
		});
	});
}

// ── Slice 2: admin orders + products (INC-B10b) ───────────────────────────

/**
 * NO CASE HERE WAS LIFTED, and that is the finding rather than an oversight: no
 * test file in `packages/plugin/test/` ever exercised `AdminOrdersClient` or
 * `AdminProductsClient`. There was nothing to move, so the cases below are
 * written against the tier interface from the start and run on both transports
 * for free.
 *
 * PRODUCTS IS COVERED (INC-B10b-i) — all six methods: `listProducts`,
 * `getProduct`, `updateProduct`, `restock`, `removeStock`, `getTaxClasses`.
 *
 * ORDERS IS COVERED TOO (INC-B10b-ii) — all twelve: `listOrders`, `getOrder`,
 * `transitionOrder`, `resolveReconciliation`, `recordFulfillment`,
 * `cancelOrder`, `getCustomerContext`, `getTimeline`, `getRefunds`,
 * `refundOrder`, `listNotes`, `addNote`. The orders surface is read through
 * `requireSurface`, so a tier that binds this slice without one fails by name
 * rather than by running its half of the cases against nothing.
 *
 * WHAT THE ORDERS CASES CANNOT ARRANGE, recorded for the same reason the
 * products gaps are: `arrange.order` seeds a PENDING guest order with one
 * digital line, no captured payment, no shipping-address snapshot and no
 * reconciliation flag — which is the state every order is born in. So a CAPTURED
 * payment (and with it a non-zero refund ceiling), a flagged reconciliation, and
 * a `processing` order that can legally be fulfilled are all out of reach from
 * here. Each is therefore asserted in the direction this surface CAN reach — the
 * refusal — and the refusals are the load-bearing half anyway: `NOT_FULFILLABLE`,
 * `NOT_IN_RECONCILIATION`, and a refund that moves no money.
 *
 * SEARCH IS ASSERTED AT ITS FLOOR, NEVER AT A TIER'S CEILING (ADR-0019 §6). The
 * shared case pins the three matches every dialect owes — an order-id PREFIX, a
 * folded buyer-ref PREFIX, an EXACT folded line sku — and asserts NO negative on
 * a wider one. A SQL adapter's unanchored buyer-ref SUBSTRING is a sanctioned
 * superset, not a divergence to fix and not a behaviour the document store owes;
 * each tier pins its own side of it in its own file, where the difference is
 * visible as a difference.
 *
 * THE ONE REFUSAL THE TIERS SPELL DIFFERENTLY is a refund against an order that
 * captured nothing. Both refuse with a 409 and both leave the ledger empty —
 * that much is shared — but the REASON differs because the composition does: a
 * tier with gateways composed is refused by the ceiling
 * (`REFUND_EXCEEDS_CAPTURED`), and a tier with none is refused for want of a
 * gateway (`REFUND_GATEWAY_UNAVAILABLE`, until INC-C1/C3 moves the payment
 * adapters in-process). Rather than soften the shared case into accepting
 * either, the shared case asserts what both owe and a GATED PAIR — keyed off the
 * existing `payments` hook, each naming its gate in its own name — pins the
 * reason on each side. The pair collapses into one case the day gateways are
 * composed on both tiers.
 *
 * WHAT THE SHARED ARRANGE SURFACE CANNOT REACH, recorded so it is not mistaken
 * for a decision: `arrange.product` goes through `upsertProductCommerce`, which
 * holds the invariant "a product with a sku has an inventory row" by seeding one
 * at `0`. So a product with NO sku, a sku with NO inventory row, and therefore
 * the `onHand: null` ("unknown") reading, the `no_sku` refusal and the
 * `no_inventory_row` refusal are all unreachable from here. The `null`/`0`
 * distinction is still asserted in the direction this surface can reach — a
 * seeded zero stays `0` and never becomes `null` — and the unreachable half is
 * held by the in-process client's own unit coverage.
 *
 * TWO STATES THE ADMIN SURFACE READS AND CANNOT WRITE are arranged through the
 * tier's STOREFRONT client instead, because they have exactly one writer each: a
 * soft-deleted row (`softDeleteProductCommerce`) and a sku under a live cart hold
 * (`addCartLine`). Both are load-bearing — `deletedAt` is what the console draws
 * the archived badge from and what the stock-movement tombstone guard turns on,
 * and `sku_held_stock` is a rename refusal with its own copy and its own
 * `liveHolds` operand — so neither may be left to a hand-written stub on one
 * tier.
 *
 * THE ONE `getTaxClasses` READING NOT ASSERTED HERE is the empty registry, and
 * deliberately: the registry is STORE-WIDE and one tier's `reset()` is a
 * documented no-op, so "no classes exist" is a claim no case in a shared file can
 * make without depending on every other case's ordering — the exact coupling this
 * contract's disjoint-ids rule exists to forbid. The branch that reads an empty
 * registry is the console's `readTaxClasses` backstop, and it is pinned where it
 * lives, in `products-console-route.sandbox.test.ts`.
 */
export function adminOrdersProductsClientContract(tier: CommerceClientTier): void {
	describe(`commerceClientContract — admin orders + products [${tier.name}]`, () => {
		let client: ProductsClientSurface;
		/** The orders half of the slice, taken through `requireSurface` so a tier
		 *  that has no orders surface fails by name here rather than running the
		 *  twelve methods' cases against a stub that would agree with anything. */
		let orders: OrdersClientSurface;
		/** THE STOREFRONT CLIENT, for the two states the admin surface can read but
		 *  cannot produce: a soft-deleted row (`softDeleteProductCommerce`) and a sku
		 *  under a live cart hold (`addCartLine`). Both are admin-facing outcomes
		 *  reached only through a shopper-facing write, and both tiers have it. */
		let storefront: CommerceClient;

		const makeAdminClients = assertAdminClients(tier);
		beforeAll(async () => {
			await tier.setup();
			const surfaces = await makeAdminClients();
			client = surfaces.products;
			orders = requireSurface(tier, surfaces, "orders");
			storefront = await tier.makeClient();
		});
		beforeEach(async () => {
			await tier.reset();
		});

		/** Seed one product and hand back the watermark an edit has to present.
		 *  Read through `getProduct` rather than taken from the seed, because the
		 *  watermark a console holds is the one the READ gave it. */
		async function seed(spec: {
			productId: string;
			sku: string;
			price?: CommerceMoney;
			title?: string;
			onHand?: number;
		}): Promise<string> {
			await tier.arrange.product({ ...spec, idempotencyKey: `seed-${spec.productId}` });
			const read = await client.getProduct(spec.productId);
			if (read === null) throw new Error(`arrange: ${spec.productId} did not read back`);
			return read.updatedAt;
		}

		// ══ ORDERS ════════════════════════════════════════════════════════
		//
		// Every order below is seeded through `tier.arrange.order`, which mints the
		// one order state a shared seeder can honestly mint: a PENDING guest order
		// with a single digital line, priced in USD, holding far past any tier's
		// clock. Ids and buyer refs are disjoint per case, like everywhere else in
		// this file, because one tier's `reset()` is a documented no-op.

		// ── listOrders ────────────────────────────────────────────────────

		test("a listed order carries EVERY summary field, and `total` counts the filtered set", async () => {
			await tier.arrange.order({ orderId: "adm-o-shape-1", buyerRef: "shape@example.test" });
			await tier.arrange.order({ orderId: "adm-o-shape-2", buyerRef: "shape@example.test" });

			// An id PREFIX that only the first order answers to (ADR-0019 §6 floor).
			const page = await orders.listOrders({ search: "adm-o-shape-1" });
			// THE EXACT COUNT OF THE FILTERED SET, not of the page — the caption a
			// console prints. An absent total is a different claim entirely and is
			// never spelled `0`.
			expect(page.total).toBe(1);
			expect(page.nextCursor).toBeNull();
			// `toEqual` against a written-out object: it fails on a MISSING key as
			// loudly as on a wrong value, which is the only way a narrowed projection
			// is caught here.
			expect(page.orders).toEqual([
				{
					id: "adm-o-shape-1",
					state: "pending",
					currency: "USD",
					buyerRef: "shape@example.test",
					customerId: null,
					paymentMethod: "stripe",
					createdAt: expect.any(String) as unknown as string,
					totalCents: 1500,
					// The list carries the BADGE, never the free-text detail (which the
					// order detail carries as a nullable string).
					reconciliationFlag: false,
				},
			]);
			// AN ORDINARY PAGE CARRIES NO `cursorRejected` KEY AT ALL. The flag means
			// "you asked for a page you did not get"; present-and-false would be a
			// claim about a question nobody asked.
			expect("cursorRejected" in page).toBe(false);
		});

		test("paging walks the filtered set by cursor, repeats no row, and keeps the same total", async () => {
			for (const n of [1, 2, 3]) {
				await tier.arrange.order({ orderId: `adm-o-page-${n}`, buyerRef: "page@example.test" });
			}
			const filter = { search: "adm-o-page-" };

			const first = await orders.listOrders(filter, { limit: 2 });
			expect(first.total).toBe(3);
			expect(first.orders).toHaveLength(2);
			expect(first.nextCursor).not.toBeNull();

			// THE FILTER TRAVELS BESIDE THE CURSOR and agrees with it, which is the
			// ordinary paging request both transports make.
			const second = await orders.listOrders(filter, {
				cursor: first.nextCursor ?? "",
				limit: 2,
			});
			expect(second.total).toBe(3);
			expect(second.orders).toHaveLength(1);
			expect(second.nextCursor).toBeNull();
			expect("cursorRejected" in second).toBe(false);

			const walked = [...first.orders, ...second.orders].map((o) => o.id);
			expect(new Set(walked).size).toBe(3);
			expect([...walked].toSorted()).toEqual(["adm-o-page-1", "adm-o-page-2", "adm-o-page-3"]);
		});

		test("a cursor presented beside a DIFFERENT filter is refused, and the answer is page one, flagged", async () => {
			for (const n of [1, 2]) {
				await tier.arrange.order({ orderId: `adm-o-rej-${n}`, buyerRef: "rej@example.test" });
			}
			const first = await orders.listOrders({ search: "adm-o-rej-" }, { limit: 1 });
			expect(first.nextCursor).not.toBeNull();

			// The same token, now beside a filter that names an axis it never carried.
			// Honouring it would answer one predicate while the request claims another,
			// with nothing in the reply admitting the substitution — so it fails closed
			// and the prescribed recovery (page one, same parameters, once) runs.
			const rejected = await orders.listOrders(
				{ search: "adm-o-rej-", states: ["pending"] },
				{ cursor: first.nextCursor ?? "", limit: 1 },
			);
			expect(rejected.cursorRejected).toBe(true);
			expect(rejected.orders.map((o) => o.id)).toEqual(first.orders.map((o) => o.id));

			// An undecodable token is the same refusal by a different route.
			const garbage = await orders.listOrders({ search: "adm-o-rej-" }, { cursor: "not-a-token" });
			expect(garbage.cursorRejected).toBe(true);
			expect(garbage.orders).toHaveLength(2);
		});

		test("a filter value the port does not know is REFUSED rather than quietly ignored", async () => {
			await expectRejectedInput(orders.listOrders({ states: ["not-a-state"] }), "states");
			await expectRejectedInput(orders.listOrders({ from: "yesterday" }), "from");
			await expectRejectedInput(orders.listOrders({}, { limit: 0 }), "limit");
		});

		test("search matches the ADR-0019 §6 FLOOR: an id prefix, a buyer-ref prefix, an exact line sku", async () => {
			await tier.arrange.order({
				orderId: "adm-o-find-42",
				buyerRef: "Findme@example.test",
				sku: "ZZ-FIND-SKU",
			});

			// All three folded on both sides — the operator types what they remember,
			// in whatever case they remember it.
			for (const term of ["adm-o-find-", "ADM-O-FIND-42", "findme@", "Findme@example.test"]) {
				const hit = await orders.listOrders({ search: term });
				expect(
					hit.orders.map((o) => o.id),
					`search ${term}`,
				).toContain("adm-o-find-42");
			}
			// The sku half is an EXACT match on a purchase-time line, not a prefix.
			const bySku = await orders.listOrders({ search: "zz-find-sku" });
			expect(bySku.orders.map((o) => o.id)).toContain("adm-o-find-42");
			// NO NEGATIVE IS ASSERTED on a wider match: a SQL dialect's unanchored
			// buyer-ref substring is a sanctioned superset of this floor, and each tier
			// pins its own side of that in its own file.
		});

		test("the states filter and the half-open window select, and the count follows them", async () => {
			await tier.arrange.order({ orderId: "adm-o-filt-1", buyerRef: "filt@example.test" });
			expect((await orders.listOrders({ search: "adm-o-filt-", states: ["pending"] })).total).toBe(
				1,
			);
			// A state the order is not in selects nothing — and `total` agrees, rather
			// than counting a set the page does not describe.
			const none = await orders.listOrders({ search: "adm-o-filt-", states: ["refunded"] });
			expect(none.orders).toEqual([]);
			expect(none.total).toBe(0);
			// The window is half-open `[from, to)`, and a window that closed before the
			// order was created excludes it.
			const past = await orders.listOrders({
				search: "adm-o-filt-",
				from: "2000-01-01T00:00:00.000Z",
				to: "2001-01-01T00:00:00.000Z",
			});
			expect(past.orders).toEqual([]);
			expect(past.total).toBe(0);
		});

		// ── getOrder ──────────────────────────────────────────────────────

		test("the order detail leaf carries EVERY field, with the transitions taken from the state machine", async () => {
			await tier.arrange.order({
				orderId: "adm-o-detail",
				buyerRef: "detail@example.test",
				sku: "ADM-O-DETAIL",
				title: "Detail",
				unitPrice: { amount: 2500, currency: "USD" },
				quantity: 2,
			});

			const read = await orders.getOrder("adm-o-detail");
			expect(read).toEqual({
				order: {
					id: "adm-o-detail",
					state: "pending",
					currency: "USD",
					paymentMethod: "stripe",
					buyerRef: "detail@example.test",
					customerId: null,
					holdExpiresAt: "2099-01-01T00:00:00.000Z",
					createdAt: expect.any(String) as unknown as string,
					reconciliationFlag: null,
					reconciliationResolution: null,
					fulfillment: null,
					cancellation: null,
					// ADR-0009: the immutable checkout SNAPSHOT, null for this digital
					// order — and never the customer's mutable profile book, which lives
					// on the customer-context panel.
					shippingAddress: null,
					totals: {
						currency: "USD",
						subtotalCents: 5000,
						discountCents: 0,
						shippingCents: 0,
						taxCents: 0,
						totalCents: 5000,
						appliedCouponCode: null,
						shippingZoneId: null,
					},
					// The line is the PURCHASE-TIME snapshot: price and title frozen.
					lines: [
						{
							sku: "ADM-O-DETAIL",
							title: "Detail",
							unitPriceCents: 2500,
							currency: "USD",
							quantity: 2,
							fulfillmentKind: "digital",
						},
					],
				},
				// DERIVED, never re-listed: exactly the domain state machine's row for
				// `pending`.
				allowedTransitions: ["paid", "failed", "expired", "cancelled"],
			});

			// An id that never existed is a "not found" state, not an error banner.
			expect(await orders.getOrder("adm-o-missing")).toBeNull();
		});

		// ── transitionOrder ───────────────────────────────────────────────

		test("a legal transition moves the order, its replay is a no-op, and an illegal one conflicts", async () => {
			await tier.arrange.order({ orderId: "adm-o-trans", buyerRef: "trans@example.test" });

			expect(
				await orders.transitionOrder("adm-o-trans", "paid", { idempotencyKey: "adm-o-trans-1" }),
			).toEqual({ ok: true, transitioned: true });
			// THE REPLAY, under the same key: already there, so nothing moved — and the
			// surface says so rather than reporting a second transition.
			expect(
				await orders.transitionOrder("adm-o-trans", "paid", { idempotencyKey: "adm-o-trans-1" }),
			).toEqual({ ok: true, transitioned: false });

			// `paid → pending` is not a row in the machine.
			expect(
				await orders.transitionOrder("adm-o-trans", "pending", { idempotencyKey: "adm-o-trans-2" }),
			).toEqual({ ok: false, status: 409 });
			expect(
				await orders.transitionOrder("adm-o-missing", "paid", { idempotencyKey: "adm-o-trans-3" }),
			).toEqual({ ok: false, status: 404 });
			// A state that is not a state at all is refused as a typed result, never a
			// throw — this surface renders a banner, it does not unwind into the host.
			expect(
				await orders.transitionOrder("adm-o-trans", "nonsense", {
					idempotencyKey: "adm-o-trans-4",
				}),
			).toEqual({ ok: false, status: 400 });

			const read = await orders.getOrder("adm-o-trans");
			expect(read?.order.state).toBe("paid");
			expect(read?.allowedTransitions).toEqual([
				"processing",
				"completed",
				"cancelled",
				"refunded",
			]);
		});

		// ── resolveReconciliation ─────────────────────────────────────────

		test("resolving a reconciliation flag that was never raised conflicts rather than clearing blind", async () => {
			await tier.arrange.order({ orderId: "adm-o-rec", buyerRef: "rec@example.test" });
			const disposition = {
				expectedFlag: "short capture",
				outcome: "written_off",
				reason: "reviewed against the provider",
				resolvedBy: "ops@example.test",
			};

			// NOT_IN_RECONCILIATION — the compare-and-clear found nothing to clear. A
			// 409 like an illegal transition, with the typed reason forwarded so the
			// console can pick its GENERIC copy.
			expect(
				await orders.resolveReconciliation("adm-o-rec", disposition, {
					idempotencyKey: "adm-o-rec-1",
				}),
			).toEqual({ ok: false, status: 409, reason: "NOT_IN_RECONCILIATION" });
			expect(
				await orders.resolveReconciliation("adm-o-missing", disposition, {
					idempotencyKey: "adm-o-rec-2",
				}),
			).toEqual({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });
			// An outcome outside the taxonomy is refused at the boundary, as a result.
			expect(
				await orders.resolveReconciliation(
					"adm-o-rec",
					{ ...disposition, outcome: "shrugged" },
					{ idempotencyKey: "adm-o-rec-3" },
				),
			).toMatchObject({ ok: false, status: 400 });
			// Nothing was recorded on the order by any of it.
			expect((await orders.getOrder("adm-o-rec"))?.order.reconciliationResolution).toBeNull();
		});

		// ── recordFulfillment ─────────────────────────────────────────────

		test("fulfillment cannot be recorded against an order that is not processing", async () => {
			await tier.arrange.order({ orderId: "adm-o-ful", buyerRef: "ful@example.test" });
			const shipment = {
				carrier: "UPS",
				trackingNumber: "1Z-ADM-O-FUL",
				trackingUrl: "https://tracking.example.test/1Z-ADM-O-FUL",
				recordedBy: "ops@example.test",
			};

			// Recording fulfillment IS shipping the order (`processing → shipped`), so a
			// pending one is NOT_FULFILLABLE — a 409, never a silently recorded envelope
			// on an order that never shipped.
			expect(
				await orders.recordFulfillment("adm-o-ful", shipment, { idempotencyKey: "adm-o-ful-1" }),
			).toEqual({ ok: false, status: 409, reason: "NOT_FULFILLABLE" });
			expect(
				await orders.recordFulfillment("adm-o-missing", shipment, {
					idempotencyKey: "adm-o-ful-2",
				}),
			).toEqual({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });
			// A tracking "URL" that is not one is refused as a typed result.
			expect(
				await orders.recordFulfillment(
					"adm-o-ful",
					{ ...shipment, trackingUrl: "ask the driver" },
					{ idempotencyKey: "adm-o-ful-3" },
				),
			).toMatchObject({ ok: false, status: 400 });
			expect((await orders.getOrder("adm-o-ful"))?.order.fulfillment).toBeNull();
		});

		// ── cancelOrder ───────────────────────────────────────────────────

		test("cancelling records the reason envelope AND drives the state flip, and cancelling again is a no-op", async () => {
			await tier.arrange.order({ orderId: "adm-o-cancel", buyerRef: "cancel@example.test" });
			const cancellation = {
				reason: "customer_request",
				detail: "changed their mind",
				cancelledBy: "ops@example.test",
			};

			expect(
				await orders.cancelOrder("adm-o-cancel", cancellation, {
					idempotencyKey: "adm-o-cancel-1",
				}),
			).toEqual({ ok: true, cancelled: true });

			const read = await orders.getOrder("adm-o-cancel");
			expect(read?.order.state).toBe("cancelled");
			expect(read?.order.cancellation).toEqual({
				reason: "customer_request",
				detail: "changed their mind",
				cancelledBy: "ops@example.test",
				cancelledAt: expect.any(String) as unknown as string,
			});
			// `cancelled` is terminal: the console renders no transition buttons.
			expect(read?.allowedTransitions).toEqual([]);

			// A SECOND cancel under a FRESH key is the benign no-op, not a failure: the
			// order is already cancelled with a reason on file.
			expect(
				await orders.cancelOrder("adm-o-cancel", cancellation, {
					idempotencyKey: "adm-o-cancel-2",
				}),
			).toEqual({ ok: true, cancelled: false });

			expect(
				await orders.cancelOrder("adm-o-missing", cancellation, {
					idempotencyKey: "adm-o-cancel-3",
				}),
			).toEqual({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });
			// A reason outside the taxonomy is refused at the boundary.
			expect(
				await orders.cancelOrder(
					"adm-o-cancel",
					{ ...cancellation, reason: "because" },
					{ idempotencyKey: "adm-o-cancel-4" },
				),
			).toMatchObject({ ok: false, status: 400 });
		});

		// ── getCustomerContext ────────────────────────────────────────────

		test("the customer-context panel reads a GUEST order honestly: no account, no book, no sessions", async () => {
			await tier.arrange.order({ orderId: "adm-o-ctx-1", buyerRef: "ctx@example.test" });
			await tier.arrange.order({ orderId: "adm-o-ctx-2", buyerRef: "ctx@example.test" });

			const context = await orders.getCustomerContext("adm-o-ctx-1");
			expect(context?.identity).toEqual({
				customerId: null,
				buyerRef: "ctx@example.test",
				email: null,
				displayName: null,
				emailVerifiedAt: null,
				// No account exists for this email yet — a login would claim both orders.
				linkage: "guest",
			});
			expect(context?.addresses).toEqual([]);
			// TOKEN-FREE, always: no session was ever minted for this buyer, and this
			// surface would not carry a token or a hash if one had been.
			expect(context?.sessions).toEqual([]);
			// The aggregates run on the UNION customer key, so they are the same from
			// either of this person's orders — and `recentOrders` excludes the one being
			// viewed.
			expect(context?.orderCount).toBe(2);
			expect(context?.recentOrders.map((o) => o.id)).toEqual(["adm-o-ctx-2"]);

			expect(await orders.getCustomerContext("adm-o-missing")).toBeNull();
		});

		// ── getTimeline + notes ───────────────────────────────────────────

		test("the timeline starts at `created`, says its state history is unaudited, and then merges both", async () => {
			await tier.arrange.order({ orderId: "adm-o-tl", buyerRef: "tl@example.test" });

			expect(await orders.getTimeline("adm-o-tl")).toEqual({
				orderId: "adm-o-tl",
				// A fresh order has transitioned zero times, so there is no audited
				// state-change history to speak of — said out loud rather than implied by
				// an empty list.
				stateChangesAudited: false,
				entries: [{ kind: "created", at: expect.any(String) as unknown as string }],
			});

			expect(
				await orders.addNote(
					"adm-o-tl",
					{ author: "ops@example.test", body: "called the buyer" },
					{ idempotencyKey: "adm-o-tl-note" },
				),
			).toMatchObject({ ok: true, appended: true });
			expect(
				await orders.transitionOrder("adm-o-tl", "paid", { idempotencyKey: "adm-o-tl-paid" }),
			).toEqual({ ok: true, transitioned: true });

			const after = await orders.getTimeline("adm-o-tl");
			expect(after?.stateChangesAudited).toBe(true);
			expect(after?.entries.map((e) => e.kind)).toEqual(
				expect.arrayContaining(["created", "note", "state_change"]),
			);
			expect(after?.entries.find((e) => e.kind === "note")).toMatchObject({
				author: "ops@example.test",
				body: "called the buyer",
			});
			expect(after?.entries.find((e) => e.kind === "state_change")).toMatchObject({
				fromState: "pending",
				toState: "paid",
			});

			expect(await orders.getTimeline("adm-o-missing")).toBeNull();
		});

		test("notes are append-only, dedupe on their key, and must hang off a real order", async () => {
			await tier.arrange.order({ orderId: "adm-o-note", buyerRef: "note@example.test" });
			expect(await orders.listNotes("adm-o-note")).toEqual([]);

			const first = await orders.addNote(
				"adm-o-note",
				{ author: "ops@example.test", body: "first" },
				{ idempotencyKey: "adm-o-note-1" },
			);
			if (!first.ok) throw new Error("the first note was refused");
			expect(first.appended).toBe(true);
			expect(first.note).toEqual({
				id: expect.any(String) as unknown as string,
				orderId: "adm-o-note",
				author: "ops@example.test",
				body: "first",
				createdAt: expect.any(String) as unknown as string,
			});

			// THE REPLAY hands back the stored note rather than appending a second one —
			// a double-submit must not double the record.
			const replay = await orders.addNote(
				"adm-o-note",
				{ author: "ops@example.test", body: "first" },
				{ idempotencyKey: "adm-o-note-1" },
			);
			expect(replay).toMatchObject({ ok: true, appended: false });
			expect(await orders.listNotes("adm-o-note")).toHaveLength(1);

			expect(
				await orders.addNote(
					"adm-o-missing",
					{ author: "ops@example.test", body: "orphan" },
					{ idempotencyKey: "adm-o-note-2" },
				),
			).toEqual({ ok: false, status: 404 });
			// A blank body is refused: an empty annotation is not an annotation.
			expect(
				await orders.addNote(
					"adm-o-note",
					{ author: "ops@example.test", body: "   " },
					{ idempotencyKey: "adm-o-note-3" },
				),
			).toEqual({ ok: false, status: 400 });
			expect(await orders.listNotes("adm-o-note")).toHaveLength(1);
			// An order with no notes — including one that does not exist — is an empty
			// list, never a failure.
			expect(await orders.listNotes("adm-o-missing")).toEqual([]);
		});

		// ── getRefunds + refundOrder (ADR-0008) ───────────────────────────

		test("the refunds summary is zeroed and HONEST on an order that captured nothing", async () => {
			await tier.arrange.order({ orderId: "adm-o-ref", buyerRef: "ref@example.test" });

			// The ceiling is `min(Σ captured, frozen total)` and nothing was captured,
			// so it is zero even though the order's frozen total is not — the watermark
			// the refund action reads must never be the total by default.
			expect(await orders.getRefunds("adm-o-ref")).toEqual({
				refunds: [],
				currency: "USD",
				capturedTotalCents: 0,
				refundedTotalCents: 0,
				ceilingCents: 0,
				remainingCents: 0,
				paymentMethod: "stripe",
				// The gateway's HONEST capability: false ⇒ the panel offers "record a
				// manual refund", never a provider button that silently no-ops. Both
				// tiers answer false today, for different reasons (no gateway composed /
				// a Stripe gateway with no secret), and neither softens it.
				refundable: false,
			});

			expect(await orders.getRefunds("adm-o-missing")).toBeNull();
		});

		test("a refund carries a REQUIRED idempotency key and cannot name an order that does not exist", async () => {
			await tier.arrange.order({ orderId: "adm-o-refx", buyerRef: "refx@example.test" });
			const refund = { amountCents: 500, currency: "USD", refundedBy: "ops@example.test" };

			// A refund is ADDITIVE, so there is no safe content-derived fallback key:
			// two deliberate refunds must not collapse into one.
			expect(await orders.refundOrder("adm-o-refx", refund, { idempotencyKey: "" })).toEqual({
				ok: false,
				status: 400,
				reason: "MISSING_IDEMPOTENCY_KEY",
			});
			expect(
				await orders.refundOrder("adm-o-missing", refund, { idempotencyKey: "adm-o-refx-1" }),
			).toEqual({ ok: false, status: 404, reason: "ORDER_NOT_FOUND" });
			// Money is an integer minor amount; zero is not a refund.
			expect(
				await orders.refundOrder(
					"adm-o-refx",
					{ ...refund, amountCents: 0 },
					{ idempotencyKey: "adm-o-refx-2" },
				),
			).toMatchObject({ ok: false, status: 400 });
			expect((await orders.getRefunds("adm-o-refx"))?.refunds).toEqual([]);
		});

		test("a refund against an order that captured nothing is refused, and the ledger stays empty", async () => {
			await tier.arrange.order({ orderId: "adm-o-ref409", buyerRef: "ref409@example.test" });

			const res = await orders.refundOrder(
				"adm-o-ref409",
				{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
				{ idempotencyKey: "adm-o-ref409-1" },
			);
			// A CONFLICT on both tiers — the request is well-formed and the order is
			// real; what is missing is the money. The two tiers name a different reason
			// for it, and the gated pair below pins each; what they OWE alike is the
			// status and an untouched ledger.
			expect(res).toMatchObject({ ok: false, status: 409 });
			expect(await orders.getRefunds("adm-o-ref409")).toMatchObject({
				refunds: [],
				refundedTotalCents: 0,
				remainingCents: 0,
			});
		});

		test.skipIf(tier.payments === undefined)(
			"(gateways composed) that refusal names the CEILING: nothing was captured to refund against",
			async () => {
				await tier.arrange.order({ orderId: "adm-o-refc", buyerRef: "refc@example.test" });
				expect(
					await orders.refundOrder(
						"adm-o-refc",
						{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
						{ idempotencyKey: "adm-o-refc-1" },
					),
				).toEqual({ ok: false, status: 409, reason: "REFUND_EXCEEDS_CAPTURED" });
			},
		);

		test.skipIf(tier.payments !== undefined)(
			"(no gateways yet — INC-C1/C3) that refusal names the missing GATEWAY, not the ceiling",
			async () => {
				await tier.arrange.order({ orderId: "adm-o-refg", buyerRef: "refg@example.test" });
				expect(
					await orders.refundOrder(
						"adm-o-refg",
						{ amountCents: 500, currency: "USD", refundedBy: "ops@example.test" },
						{ idempotencyKey: "adm-o-refg-1" },
					),
				).toEqual({ ok: false, status: 409, reason: "REFUND_GATEWAY_UNAVAILABLE" });
			},
		);

		// ── listProducts + getProduct ─────────────────────────────────────

		test("a listed row and the detail leaf carry EVERY field, with on-hand never folded", async () => {
			await seed({
				productId: "adm-p-shape",
				sku: "ADM-SHAPE",
				title: "Shape",
				price: { amount: 2599, currency: "USD" },
				onHand: 7,
			});
			// A SECOND product with no stock figure of its own — which seeds a row at
			// zero, so this is the `0` half of the pair `onHand` must keep apart.
			await seed({ productId: "adm-p-zero", sku: "ADM-ZERO", title: "Zero" });

			const page = await client.listProducts({ search: "ADM-SHAPE" });
			expect(page.total).toBe(1);
			expect(page.nextCursor).toBeNull();
			// `toEqual` against a written-out object, deliberately: it fails on a
			// MISSING key as loudly as on a wrong value, which is the only way a
			// narrowed projection is caught here — the console's own types are
			// structural mirrors and would not notice.
			expect(page.products[0]).toEqual({
				productId: "adm-p-shape",
				sku: "ADM-SHAPE",
				title: "Shape",
				priceCents: 2599,
				currency: "USD",
				productKind: expect.any(String) as unknown as string,
				active: expect.any(Boolean) as unknown as boolean,
				onHand: 7,
				deletedAt: null,
				createdAt: expect.any(String) as unknown as string,
			});

			const detail = await client.getProduct("adm-p-shape");
			expect(detail).toEqual({
				productId: "adm-p-shape",
				sku: "ADM-SHAPE",
				title: "Shape",
				priceCents: 2599,
				currency: "USD",
				taxClass: null,
				compareAtCents: null,
				compareAtCurrency: null,
				unitCostCents: null,
				unitCostCurrency: null,
				inventoryPolicy: expect.any(String) as unknown as string,
				weightGrams: null,
				lengthMm: null,
				widthMm: null,
				heightMm: null,
				productKind: expect.any(String) as unknown as string,
				active: expect.any(Boolean) as unknown as boolean,
				deletedAt: null,
				onHand: 7,
				createdAt: expect.any(String) as unknown as string,
				updatedAt: expect.any(String) as unknown as string,
			});

			// A KNOWN ZERO IS A ZERO. `null` here would say "unknown" about a sku that
			// has an inventory row, which is the fold this field exists to prevent.
			const zero = await client.getProduct("adm-p-zero");
			expect(zero?.onHand).toBe(0);
		});

		test("getProduct: an id that never existed is null, not an error", async () => {
			expect(await client.getProduct("adm-p-missing")).toBeNull();
		});

		test("a soft-deleted product reads back as a tombstone, lists only under deleted, and takes no stock movement", async () => {
			await seed({
				productId: "adm-del-1",
				sku: "ADM-DEL-1",
				title: "adm-del-fixture",
				onHand: 9,
			});
			// Soft-deleted through the STOREFRONT surface, the only writer of this
			// state — the admin surface can read a tombstone and never mint one.
			await storefront.softDeleteProductCommerce("adm-del-1", "adm-del-1-delete");

			// A TOMBSTONE IS A READ, NOT A 404. `deletedAt` is the field the console
			// renders the archived badge from, so a tier that folded it to `null` — or
			// answered `null` for the whole row — would take the badge with it.
			const detail = await client.getProduct("adm-del-1");
			expect(detail).not.toBeNull();
			expect(detail?.deletedAt).not.toBeNull();
			expect(detail?.active).toBe(false);
			expect(detail?.sku).toBe("ADM-DEL-1"); // commercial data preserved, not wiped

			// THE TOMBSTONE AXIS IS EITHER/OR. The default page is the live catalog
			// and excludes it; `deleted: true` is the archive view and is the only
			// place it appears.
			const live = await client.listProducts({ search: "adm-del-fixture" });
			expect(live.products.map((p) => p.productId)).toEqual([]);
			const archived = await client.listProducts({ search: "adm-del-fixture", deleted: true });
			expect(archived.products.map((p) => p.productId)).toEqual(["adm-del-1"]);
			expect(archived.products[0]?.deletedAt).not.toBeNull();

			// AND A DELETED ROW TAKES NO MOVEMENT, either way. The sku still exists and
			// its inventory row still holds nine units, so nothing but an explicit
			// tombstone check stands between an operator and a restock against a
			// product that is not for sale. `not_found` rather than a typed refusal of
			// its own: to this surface an archived product is not there.
			expect(await client.restock("adm-del-1", 1, "adm-del-1-restock")).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(await client.removeStock("adm-del-1", 1, "adm-del-1-remove")).toEqual({
				ok: false,
				reason: "not_found",
			});
			// The refusals moved nothing.
			const after = await client.listProducts({ search: "adm-del-fixture", deleted: true });
			expect(after.products[0]).toMatchObject({ onHand: 9 });
		});

		test("search matches a sku exactly and a title by substring, case-insensitively", async () => {
			await seed({ productId: "adm-s-1", sku: "ADM-SEARCH-ALPHA", title: "Winter Parka" });
			await seed({ productId: "adm-s-2", sku: "ADM-SEARCH-BETA", title: "Summer Hat" });

			// THE SKU ARM IS EXACT, and lower-cased on the way in to prove the match
			// is case-insensitive rather than literal.
			const bySku = await client.listProducts({ search: "adm-search-alpha" });
			expect(bySku.products.map((p) => p.productId)).toEqual(["adm-s-1"]);

			// THE TITLE ARM IS A SUBSTRING — an interior fragment, not a prefix, so a
			// tier that could only match prefixes would fail here rather than pass by
			// accident. Both adapters implement the same predicate; there is no
			// prefix/substring divergence on this surface.
			const byTitle = await client.listProducts({ search: "arka" });
			expect(byTitle.products.map((p) => p.productId)).toEqual(["adm-s-1"]);

			// A partial sku is NOT a sku match, and matches no title either.
			expect((await client.listProducts({ search: "adm-search" })).products).toEqual([]);
		});

		test("lowStockThreshold keeps only the rows at or under it, and counts only those", async () => {
			await seed({ productId: "adm-l-low", sku: "ADM-LOW", title: "adm-low-fixture", onHand: 1 });
			await seed({ productId: "adm-l-ok", sku: "ADM-OK", title: "adm-low-fixture", onHand: 50 });

			const page = await client.listProducts({ search: "adm-low-fixture", lowStockThreshold: 5 });
			expect(page.products.map((p) => p.productId)).toEqual(["adm-l-low"]);
			// The count describes the SAME predicate as the page — a total that
			// counted the unfiltered catalog would caption one row as two.
			expect(page.total).toBe(1);
		});

		test("paging walks the whole filtered set once, and the last page names no cursor", async () => {
			for (const n of [1, 2, 3]) {
				await seed({
					productId: `adm-pg-${String(n)}`,
					sku: `ADM-PG-${String(n)}`,
					title: "adm-pg",
				});
			}

			const seen: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 5; page++) {
				const result: ProductsListResultShape = await client.listProducts(
					{ search: "adm-pg" },
					{ limit: 2, ...(cursor === null ? {} : { cursor }) },
				);
				expect(result.cursorRejected).toBeUndefined();
				expect(result.total).toBe(3);
				seen.push(...result.products.map((p) => p.productId));
				cursor = result.nextCursor;
				if (cursor === null) break;
			}
			expect(cursor).toBeNull();
			// EVERY ROW ONCE: sorted because the page order is the store's, and what
			// is under test here is that paging neither repeats nor drops a row.
			expect(seen.toSorted()).toEqual(["adm-pg-1", "adm-pg-2", "adm-pg-3"]);
		});

		test("an undecodable cursor yields page one, flagged — never an error and never a silent reset", async () => {
			await seed({ productId: "adm-c-1", sku: "ADM-C-1", title: "adm-cursor" });

			const result = await client.listProducts(
				{ search: "adm-cursor" },
				{ cursor: "not-a-real-cursor" },
			);
			// THE FLAG IS THE POINT. The rows come back so a console that wants a page
			// has one, and the flag is what lets it say the page is not the one asked
			// for. A tier that returned the rows without the flag would look identical
			// to a successful page.
			expect(result.cursorRejected).toBe(true);
			expect(result.products.map((p) => p.productId)).toEqual(["adm-c-1"]);
		});

		test("a cursor whose filter disagrees with the request is refused, and the REQUEST's filter wins the retry", async () => {
			await seed({ productId: "adm-d-1", sku: "ADM-D-1", title: "adm-dis-one" });
			await seed({ productId: "adm-d-2", sku: "ADM-D-2", title: "adm-dis-two" });

			// A cursor minted under one predicate…
			const first = await client.listProducts({ search: "adm-dis" }, { limit: 1 });
			expect(first.nextCursor).not.toBeNull();
			const cursor = first.nextCursor;
			if (cursor === null) throw new Error("arrange: the first page named no cursor");

			// …presented beside a DIFFERENT one. Honouring the token would answer with
			// rows from the old predicate under the new caption, which is the failure
			// this fail-closed check exists to prevent.
			const mismatched = await client.listProducts({ search: "adm-dis-two" }, { limit: 1, cursor });
			expect(mismatched.cursorRejected).toBe(true);
			expect(mismatched.products.map((p) => p.productId)).toEqual(["adm-d-2"]);
			expect(mismatched.total).toBe(1);
		});

		test("listProducts rejects a page size outside the port's bounds", async () => {
			await expectRejectedInput(client.listProducts({}, { limit: 0 }), "limit");
			await expectRejectedInput(client.listProducts({}, { limit: 1000 }), "limit");
		});

		// ── updateProduct ─────────────────────────────────────────────────

		test("an edit applies on the watermark it was loaded with, and reports the row's own", async () => {
			const watermark = await seed({
				productId: "adm-e-ok",
				sku: "ADM-E-OK",
				price: { amount: 1000, currency: "USD" },
			});

			const applied = await client.updateProduct(
				"adm-e-ok",
				{
					expectedUpdatedAt: watermark,
					price: { amount: 1250, currency: "USD" },
					compareAtPrice: { amount: 1800, currency: "USD" },
					unitCost: { amount: 400, currency: "USD" },
					weightGrams: 250,
				},
				"adm-e-ok-1",
			);
			expect(applied.ok).toBe(true);

			const read = await client.getProduct("adm-e-ok");
			// THE WATERMARK COMES BACK, and it is the row's own — the value the next
			// read reports — so a console can hold it and edit again without a reload.
			// Whether it MOVED is deliberately not asserted: the tiers stamp `updatedAt`
			// from different clocks (one frozen for the whole suite), so "it advanced"
			// is a property of the harness rather than of the port.
			expect(applied.ok && applied.updatedAt).toBe(read?.updatedAt);
			expect(read).toMatchObject({
				priceCents: 1250,
				currency: "USD",
				compareAtCents: 1800,
				compareAtCurrency: "USD",
				unitCostCents: 400,
				unitCostCurrency: "USD",
				weightGrams: 250,
			});
		});

		test("a stale watermark is refused and hands back the current one", async () => {
			const watermark = await seed({
				productId: "adm-e-stale",
				sku: "ADM-E-STALE",
				price: { amount: 1000, currency: "USD" },
			});
			// A WATERMARK FROM BEFORE THE ROW EXISTED, which is what an admin who
			// loaded the form long ago is holding. Stated as a literal rather than
			// produced by editing twice, because the two tiers stamp `updatedAt` from
			// different clocks — one frozen for the whole suite — so "edit, then reuse
			// the old watermark" is only stale on a tier whose clock moves.
			const stale = await client.updateProduct(
				"adm-e-stale",
				{ expectedUpdatedAt: "2020-01-01T00:00:00.000Z", weightGrams: 20 },
				"adm-e-stale-1",
			);
			expect(stale).toMatchObject({ ok: false, reason: "stale" });
			// The CURRENT watermark travels with the refusal, so the console can offer
			// a reload that actually succeeds rather than a second guess.
			expect(stale.ok === false && stale.reason === "stale" && stale.currentUpdatedAt).toBe(
				watermark,
			);
			// And nothing was applied.
			expect((await client.getProduct("adm-e-stale"))?.weightGrams).toBeNull();
		});

		test("editing a product that does not exist is not_found, not an error", async () => {
			const result = await client.updateProduct(
				"adm-e-missing",
				{ expectedUpdatedAt: "2026-01-01T00:00:00.000Z", weightGrams: 1 },
				"adm-e-missing-1",
			);
			expect(result).toEqual({ ok: false, reason: "not_found" });
		});

		test("a price in another currency is refused as a currency mismatch, naming the one in force", async () => {
			const watermark = await seed({
				productId: "adm-e-cur",
				sku: "ADM-E-CUR",
				price: { amount: 1000, currency: "USD" },
			});
			const result = await client.updateProduct(
				"adm-e-cur",
				{ expectedUpdatedAt: watermark, price: { amount: 900, currency: "EUR" } },
				"adm-e-cur-1",
			);
			expect(result).toEqual({ ok: false, reason: "currency_mismatch", currency: "USD" });
			// The refusal changed nothing — a half-applied currency switch is the
			// outcome this refusal exists to prevent.
			expect(await client.getProduct("adm-e-cur")).toMatchObject({
				priceCents: 1000,
				currency: "USD",
			});
		});

		test("renaming a sku onto one another live product holds is refused, naming it", async () => {
			const watermark = await seed({ productId: "adm-e-sku-a", sku: "ADM-E-SKU-A" });
			await seed({ productId: "adm-e-sku-b", sku: "ADM-E-SKU-B" });

			const result = await client.updateProduct(
				"adm-e-sku-a",
				{ expectedUpdatedAt: watermark, sku: "ADM-E-SKU-B" },
				"adm-e-sku-1",
			);
			expect(result).toMatchObject({ ok: false });
			// EITHER refusal is correct and both are honest: the target sku belongs to
			// a live product AND has its own inventory row, and which guard fires first
			// is the store's business rather than the port's. What the contract pins is
			// that the rename is refused whole and names the sku involved.
			expect(result.ok === false && result.reason).toMatch(/^sku_(taken|stock_conflict)$/);
			expect(await client.getProduct("adm-e-sku-a")).toMatchObject({ sku: "ADM-E-SKU-A" });
		});

		test("renaming a sku a live cart hold is against is refused, carrying the hold count", async () => {
			const watermark = await seed({
				productId: "adm-e-held",
				sku: "ADM-E-HELD",
				title: "Held",
				price: { amount: 1500, currency: "USD" },
				onHand: 10,
			});
			// THE HOLD IS A REAL RESERVATION, taken through the storefront's own add —
			// the only writer of one. A seeded row would prove nothing about the state
			// the refusal is actually guarding.
			const cartId = await tier.arrange.cart();
			const added = await storefront.addCartLine(
				cartId,
				"ADM-E-HELD",
				"adm-e-held",
				2,
				"adm-e-held-add",
			);
			expect(added.ok).toBe(true);

			const result = await client.updateProduct(
				"adm-e-held",
				{ expectedUpdatedAt: watermark, sku: "ADM-E-HELD-NEW" },
				"adm-e-held-1",
			);
			// ITS OWN MEMBER, not `sku_taken`: the target sku is free and the operator
			// is being asked to WAIT rather than to pick another name, which is a
			// different sentence and a different next action.
			expect(result).toMatchObject({ ok: false, reason: "sku_held_stock", sku: "ADM-E-HELD" });
			// THE COUNT IS A POSITIVE INTEGER OR `null`, never `0`. It is the operand
			// the copy is composed from — "held by 1 cart" — and a `0` beside a
			// refusal caused by holds reads as "no holds", so a non-integer is
			// normalised to "some, number unknown" instead. One live hold here.
			expect(result.ok === false && result.reason === "sku_held_stock" && result.liveHolds).toBe(1);
			// Refused whole: the sku did not move, and neither did the stock.
			const after = await client.getProduct("adm-e-held");
			expect(after).toMatchObject({ sku: "ADM-E-HELD" });
			expect(after?.onHand).toBe(8);
		});

		test("a malformed edit field is refused as a typed result, never a throw", async () => {
			const watermark = await seed({ productId: "adm-e-bad", sku: "ADM-E-BAD" });

			// An empty sku and a negative dimension: both outside the edit body's
			// declared bounds. `field` is NOT asserted — one transport refuses at a
			// schema that names no field, so pinning it would fail a tier over the
			// shape of its refusal rather than over the refusal.
			for (const [n, body] of [
				{ expectedUpdatedAt: watermark, sku: "" },
				{ expectedUpdatedAt: watermark, weightGrams: -1 },
			].entries()) {
				const result = await client.updateProduct("adm-e-bad", body, `adm-e-bad-${String(n)}`);
				expect(result).toMatchObject({ ok: false, reason: "invalid" });
			}
			// A refusal at the boundary wrote nothing.
			expect(await client.getProduct("adm-e-bad")).toMatchObject({
				sku: "ADM-E-BAD",
				weightGrams: null,
			});
		});

		// ── restock / removeStock ─────────────────────────────────────────

		test("a restock adds units and reports the new count", async () => {
			await seed({ productId: "adm-r-ok", sku: "ADM-R-OK", onHand: 4 });

			expect(await client.restock("adm-r-ok", 6, "adm-r-ok-1")).toEqual({ ok: true, onHand: 10 });
			// The count the movement reported is the count the read agrees with.
			expect((await client.getProduct("adm-r-ok"))?.onHand).toBe(10);
		});

		test("a restock replays under the same key instead of adding twice", async () => {
			await seed({ productId: "adm-r-replay", sku: "ADM-R-REPLAY", onHand: 0 });

			// ADDITIVE AND THEREFORE NOT IDEMPOTENT BY NATURE: only the key makes the
			// second call a replay, which is why the key is required on this surface.
			expect(await client.restock("adm-r-replay", 5, "adm-r-replay-1")).toEqual({
				ok: true,
				onHand: 5,
			});
			expect(await client.restock("adm-r-replay", 5, "adm-r-replay-1")).toEqual({
				ok: true,
				onHand: 5,
			});
			expect((await client.getProduct("adm-r-replay"))?.onHand).toBe(5);
		});

		test("a removal takes units off, and one larger than the stock is refused with the count", async () => {
			await seed({ productId: "adm-rm", sku: "ADM-RM", onHand: 3 });

			expect(await client.removeStock("adm-rm", 1, "adm-rm-1")).toEqual({ ok: true, onHand: 2 });
			// THE GUARDED FLOOR: the refusal carries the current count, so the operator
			// is told what is actually there rather than only that they asked for too
			// much — and stock never goes negative.
			expect(await client.removeStock("adm-rm", 99, "adm-rm-2")).toEqual({
				ok: false,
				reason: "insufficient_stock",
				onHand: 2,
			});
			expect((await client.getProduct("adm-rm"))?.onHand).toBe(2);
		});

		test("a stock movement against a product that does not exist is not_found", async () => {
			expect(await client.restock("adm-sm-missing", 1, "adm-sm-missing-1")).toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(await client.removeStock("adm-sm-missing", 1, "adm-sm-missing-2")).toEqual({
				ok: false,
				reason: "not_found",
			});
		});

		test("a malformed quantity or a missing key is refused as a typed result", async () => {
			await seed({ productId: "adm-sm-bad", sku: "ADM-SM-BAD", onHand: 5 });

			for (const qty of [0, -1, 1.5]) {
				expect(await client.restock("adm-sm-bad", qty, "adm-sm-bad-q")).toMatchObject({
					ok: false,
					reason: "invalid",
				});
			}
			// AN EMPTY KEY IS REFUSED rather than defaulted: a movement this surface
			// cannot dedupe is one a double-submit would apply twice.
			expect(await client.restock("adm-sm-bad", 1, "")).toMatchObject({
				ok: false,
				reason: "invalid",
			});
			expect(await client.removeStock("adm-sm-bad", 0, "adm-sm-bad-r")).toMatchObject({
				ok: false,
				reason: "invalid",
			});
			// Nothing moved.
			expect((await client.getProduct("adm-sm-bad"))?.onHand).toBe(5);
		});

		// ── getTaxClasses ─────────────────────────────────────────────────

		test("the tax-class registry comes back whole, id and name", async () => {
			await tier.arrange.taxClass({ id: "adm-tc-standard", name: "Standard" });
			await tier.arrange.taxClass({ id: "adm-tc-reduced", name: "Reduced" });

			const classes = await client.getTaxClasses();
			// A CONTAINS rather than an equality: the registry is store-wide and a tier
			// whose `reset()` is a documented no-op carries other slices' classes too.
			// What is under test is that the entries arrive unfiltered and unprojected.
			expect(classes).toEqual(
				expect.arrayContaining([
					{ id: "adm-tc-standard", name: "Standard" },
					{ id: "adm-tc-reduced", name: "Reduced" },
				]),
			);
		});
	});
}

/** The list result's shape, borrowed from the client the surface is `Pick`ed
 *  from — the paging loop above needs to name it to annotate its accumulator. */
type ProductsListResultShape = Awaited<ReturnType<ProductsClientSurface["listProducts"]>>;

// ── Slice 3: admin rules + reporting (INC-B10c) ───────────────────────────

export function adminRulesReportingClientContract(tier: CommerceClientTier): void {
	describe(`commerceClientContract — admin rules + reporting [${tier.name}]`, () => {
		let client: RulesClientSurface;

		const makeAdminClients = assertAdminClients(tier);
		beforeAll(async () => {
			await tier.setup();
			client = requireSurface(tier, await makeAdminClients(), "rules");
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
