import { MAX_LOW_STOCK_THRESHOLD } from "@otta-sh/domain";
import { z } from "zod";

// Wire-level qty caps (service-hardening plan §4). Two different numbers,
// deliberately: `/inventory/reserve` is the raw inventory primitive (a
// machine caller, behind the write gate when configured) and is aligned with
// the admin `stockMovementBody` cap below; cart lines are the shopper-facing,
// anonymous-internet-caller surface and get a much tighter bound. Both are
// WIRE-ONLY (zod) — the domain enforces the positive-integer bound too
// (defense-in-depth; `domain/src/inventory/use-cases.ts`) — this caps the
// wire value and makes "how much may one request ask for" an explicit, tested
// part of the contract instead of an accident of IEEE-754 (today `qty: 1e9` /
// `Number.MAX_SAFE_INTEGER` is a "valid" request that only the store's
// arithmetic rejects).
//
// IMPORTANT — this is NOT a rate limit and does not fix junk-`failed`-
// reservation-row amplification: that is bound by request COUNT, not qty
// magnitude (10,000 requests at qty:9,999 each mint as many failed rows as
// one request at qty:1e9). See the follow-up issue for rate-limiting
// `POST /inventory/reserve` and `POST /carts/:id/lines`:
// https://github.com/UrumiAI/otta.sh/issues/91
export const CART_LINE_MAX_QTY = 10_000;
export const RESERVE_MAX_QTY = 1_000_000_000;

// Zod request bodies mirroring the inventory port 1:1 (§0.6). `Idempotency-Key`
// travels as a header, not in the body.
export const reserveBody = z.object({
	sku: z.string().min(1),
	qty: z.number().int().positive().max(RESERVE_MAX_QTY),
});

export const commitBody = z.object({
	reservationId: z.string().min(1),
});

export const releaseBody = z.object({
	reservationId: z.string().min(1),
});

// Cart bodies (§6). Money is intentionally absent — a cart line snapshots no
// price (that is an order invariant, Phase 4).
export const createCartBody = z.object({
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.optional(),
});

export const addLineBody = z.object({
	sku: z.string().min(1),
	qty: z.number().int().positive().max(CART_LINE_MAX_QTY),
	// Phase 4: the product this line references. Optional for backward-compat with
	// bare Phase-3 adds; REQUIRED to later check out (an order needs a priced
	// product). When present it is the subject of the route's SKU GUARD, not a
	// hint: the service resolves `sku` against THIS product's live sellable units
	// and refuses the add if it does not name one, and it reads the fulfillment
	// kind from the same row (server-authoritative) so a digital line reserves
	// nothing. See `routes/carts.ts` for why a bare add is deliberately left
	// unguarded — and why that is not the hole it looks like.
	productId: z.string().min(1).max(200).optional(),
});

export const patchLineBody = z.object({
	qty: z.number().int().positive().max(CART_LINE_MAX_QTY),
});

// Path-parameter sanity (N3): ids are opaque tokens — non-empty, bounded, and
// free of whitespace/control characters. Routing guarantees non-empty; the
// bound and charset keep garbage out of the store layer.
const idParam = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7e]+$/);

export const pathParams = z.object({ cartId: idParam });
export const linePathParams = z.object({ cartId: idParam, lineId: idParam });

// Phase 4 (§7). Checkout, order read, the x402 page-gate proof, and the
// entitlement check.
/**
 * ADR-0009: the optional shipping address a checkout submits. Required fields are
 * non-empty; `line2`/`region`/`email`/`phone` are optional. Bounds mirror the
 * domain's `ORDER_ADDRESS_MAX_LENGTHS` (the domain re-validates + trims — this is
 * the wire's first line of defense, the domain the authoritative guard). No
 * address→zone matching (ADR-0009 §5): `country` is a free string.
 */
export const shippingAddressBody = z.object({
	name: z.string().min(1).max(200),
	line1: z.string().min(1).max(200),
	line2: z.string().max(200).nullish(),
	city: z.string().min(1).max(120),
	region: z.string().max(120).nullish(),
	postalCode: z.string().min(1).max(32),
	country: z.string().min(1).max(100),
	email: z.string().max(320).nullish(),
	phone: z.string().max(64).nullish(),
});

export const checkoutBody = z.object({
	cartId: idParam,
	paymentMethod: z.enum(["stripe", "x402"]),
	// Email/session claim token — the pre-Phase-5 entitlement key (§6).
	buyerRef: z.string().min(1).max(320),
	// Phase 6: optional shipping selection + coupon (absent ⇒ zero shipping/tax).
	shippingZoneId: idParam.optional(),
	shippingMethodId: idParam.optional(),
	couponCode: z.string().min(1).max(200).optional(),
	// ADR-0009: optional ship-to snapshot captured at checkout (absent ⇒ none —
	// capture is optional this slice; required-for-physical is a later flip).
	shippingAddress: shippingAddressBody.optional(),
});

export const orderPathParams = z.object({ orderId: idParam });

// Phase 6 (§6): read-only totals preview — no coupon redemption, safe to repeat.
export const quoteBody = z.object({
	cartId: idParam,
	shippingZoneId: idParam.optional(),
	shippingMethodId: idParam.optional(),
	couponCode: z.string().min(1).max(200).optional(),
});

// Phase 6 admin CRUD bodies (mirror the store ports 1:1). Money = integer minor
// units; rates = integer basis points; never a float.
export const shippingZoneBody = z.object({
	id: idParam,
	name: z.string().min(1).max(200),
	regions: z.unknown().optional(),
});

export const shippingMethodBody = z.object({
	id: idParam,
	name: z.string().min(1).max(200),
	type: z.enum(["flat_rate", "free_shipping"]),
});

export const shippingRateBody = z.object({
	currency: z.string().regex(/^[A-Z]{3}$/),
	amountCents: z.number().int().nonnegative(),
	minSubtotalCents: z.number().int().nonnegative().nullable().optional(),
});

export const taxClassBody = z.object({
	id: idParam,
	name: z.string().min(1).max(200),
});

export const taxRateBody = z.object({
	id: idParam,
	taxClassId: idParam,
	zoneId: idParam,
	rateBps: z.number().int().min(0).max(100_000),
	appliesToShipping: z.boolean().optional(),
});

export const couponBody = z.object({
	id: idParam,
	code: z.string().min(1).max(200),
	type: z.enum(["fixed_amount", "percentage"]),
	amountCents: z.number().int().nonnegative().nullable().optional(),
	rateBps: z.number().int().min(0).max(100_000).nullable().optional(),
	capCents: z.number().int().nonnegative().nullable().optional(),
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.nullable()
		.optional(),
	minSubtotalCents: z.number().int().nonnegative().nullable().optional(),
	startsAt: z.string().min(1).max(64).nullable().optional(),
	expiresAt: z.string().min(1).max(64).nullable().optional(),
	maxUses: z.number().int().nonnegative().nullable().optional(),
	maxUsesPerCustomer: z.number().int().nonnegative().nullable().optional(),
});

export const zonePathParams = z.object({ zoneId: idParam });
export const methodPathParams = z.object({ methodId: idParam });
export const couponCodePathParams = z.object({ code: z.string().min(1).max(200) });

// Phase 6 admin UPDATE/DELETE bodies (admin-UX Increment 3 — the missing
// UPDATE/DELETE capability). Mirror the store ports 1:1; money = integer minor
// units, rates = integer basis points, never a float. Identity fields are the
// path param, never the body (a zone/method/rate/coupon id is immutable).

// Shipping zone edit — LWW, no CAS (structural, money-free); `id` is the path.
// `regions` is REQUIRED-PRESENT (PR #71 review, reviewer B finding 1): the
// port's `UpdateShippingZoneInput.regions` is a required full-replace field, so
// an OMITTED key must be a 400 — never a silent wipe-to-null. Pass an explicit
// `null` to clear. (`z.unknown()` alone treats an absent key as valid, hence
// the presence refine.)
export const shippingZoneUpdateBody = z
	.object({
		name: z.string().min(1).max(200),
		regions: z.unknown(),
	})
	.refine((o) => Object.hasOwn(o, "regions"), {
		message: "regions is required (pass null to clear)",
	});

// Shipping method edit — LWW; `zoneId` is immutable identity, never edited here.
export const shippingMethodUpdateBody = z.object({
	name: z.string().min(1).max(200),
	type: z.enum(["flat_rate", "free_shipping"]),
});

// Shipping rate edit — OPTIMISTIC CAS on the money-bearing `amountCents`:
// `expectedAmountCents` is the price the admin read; the store compare-and-sets
// on it (a concurrent edit surfaces as a 409 stale reload, never a silent
// clobber). `(methodId, currency)` is the rate's identity — both path params.
// `minSubtotalCents` is REQUIRED (nullable, not optional — PR #71 review,
// reviewer B finding 1): the port's `UpdateShippingRateInput.minSubtotalCents`
// is a required full-replace field, so an omitted key is a 400 — never a silent
// clear of the free-shipping threshold. Send `null` explicitly to clear it.
export const shippingRateUpdateBody = z.object({
	amountCents: z.number().int().nonnegative(),
	minSubtotalCents: z.number().int().nonnegative().nullable(),
	expectedAmountCents: z.number().int().nonnegative(),
});

// Tax rate edit — OPTIMISTIC CAS on the money-bearing `rateBps`
// (`expectedRateBps` = the rate the admin read). `(taxClassId, zoneId)` identity
// is immutable; the rate is addressed by its `id` path param.
// `appliesToShipping` is REQUIRED (PR #71 review, reviewer B finding 1): the
// port's `UpdateTaxRateInput.appliesToShipping` is a required full-replace
// field, so an omitted key is a 400 — never a silent flip of the shipping-tax
// behavior to false. (The CREATE body's optional-default-false is different:
// there is no prior value to clobber at creation.)
export const taxRateUpdateBody = z.object({
	rateBps: z.number().int().min(0).max(100_000),
	appliesToShipping: z.boolean(),
	expectedRateBps: z.number().int().min(0).max(100_000),
});

// Coupon edit — LWW (documented exception to "prefer CAS", see the port doc).
// `code`/`type`/`currency` are immutable identity/kind and are NOT editable; a
// full replacement of the economics/window (undefined ⇒ cleared to null, the
// LWW set-semantics). Addressed by `couponId` (the path param).
// DELIBERATELY all-optional (the one intentional omit-⇒-null partial, PR #71
// review): every field here is nullable in the port — "absent" and "null" both
// mean "this coupon axis is unset" (a fixed-amount coupon has no rateBps, no
// window ⇒ no window), so omit-⇒-clear IS the full-replace semantics, unlike
// the zone/rate bodies above where an omitted required field would silently
// destroy meaningful config.
export const couponUpdateBody = z.object({
	amountCents: z.number().int().nonnegative().nullable().optional(),
	rateBps: z.number().int().min(0).max(100_000).nullable().optional(),
	capCents: z.number().int().nonnegative().nullable().optional(),
	minSubtotalCents: z.number().int().nonnegative().nullable().optional(),
	startsAt: z.string().min(1).max(64).nullable().optional(),
	expiresAt: z.string().min(1).max(64).nullable().optional(),
	maxUses: z.number().int().nonnegative().nullable().optional(),
	maxUsesPerCustomer: z.number().int().nonnegative().nullable().optional(),
});

// Tax class rename — LWW, no CAS (structural, money-free; mirrors
// `shippingZoneUpdateBody`); `id` is the path. The class id is the referent
// rates/products point at, so a rename never orphans anything.
export const taxClassUpdateBody = z.object({
	name: z.string().min(1).max(200),
});

export const rateIdPathParams = z.object({ rateId: idParam });
export const taxClassPathParams = z.object({ classId: idParam });
export const couponIdPathParams = z.object({ couponId: idParam });
export const methodCurrencyPathParams = z.object({
	methodId: idParam,
	currency: z.string().regex(/^[A-Z]{3}$/),
});

// Admin Coupons console: view-only list query (admin-UX Increment 3). Mirrors
// `productsListQuery`'s shape: `limit` coerced + clamped to 1..100 (default
// 25), `cursor` the opaque base64url keyset token. `search` is the ONLY filter
// axis (coupons have no soft-delete/publish-gate/kind axis to mirror
// `deleted`/`active`/`productKind` — port doc) and matches `code` EXACTLY,
// case-insensitively (never a substring).
export const couponsListQuery = z.object({
	search: z.string().min(1).max(200).optional(),
	cursor: z.string().min(1).max(1000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

/** Validates the FILTER object carried inside a decoded opaque coupon-list
 *  cursor (MOD-1: re-validate the decoded filter through zod before trusting
 *  it) — mirrors `productListFilterSchema`. */
export const couponListFilterSchema = z.object({
	search: z.string().min(1).max(200).optional(),
});

export type CouponsListQuery = z.infer<typeof couponsListQuery>;
export type CouponListFilterParsed = z.infer<typeof couponListFilterSchema>;

// The x402 facilitator SettleResponse proof forwarded by the page layer (§6).
// Money on the wire is an integer minor unit + an ISO-4217 string (never a float).
export const x402ProofBody = z.object({
	orderId: idParam,
	transaction: z.string().min(1).max(200),
	network: z.string().min(1).max(64),
	payer: z.string().min(1).max(200),
	amount: z.number().int().nonnegative(),
	currency: z.string().regex(/^[A-Z]{3}$/),
	signature: z.string().min(1).max(4096),
});

// Scope selection (which of orderId / buyerRef / session applies) is resolved in
// the route, which — unlike a schema — can see the auth headers. `sku` is the
// only always-required field; the presence-based precedence + per-scope auth
// live in routes/entitlements.ts (see ADR-0011).
export const entitlementCheckQuery = z.object({
	orderId: z.string().min(1).max(200).optional(),
	buyerRef: z.string().min(1).max(320).optional(),
	sku: z.string().min(1).max(200),
});

export type ReserveBody = z.infer<typeof reserveBody>;
export type CommitBody = z.infer<typeof commitBody>;
export type ReleaseBody = z.infer<typeof releaseBody>;

// Product-commerce (Phase 1 §7). Money on the wire is an integer + an
// ISO-4217 string — never a float (DEVELOPMENT.md §4). Every commercial
// field is optional: "create then price" (plan §1 case 3) — a bare sync
// upsert may carry only the product_id.
//
// DELIBERATELY NOT `.strict()`, and it deliberately KEEPS `title` — the
// asymmetry with `editProductCommerceBody` below is intent, not an oversight
// somebody should tidy up. This is the CMS content sync's own channel and the
// ONE writer of `product_commerce.title` that ADR-0013 sanctions
// (`adr/0013-product-title-is-cms-owned.md`); it is also a
// forward-compatibility surface for integrators, so an unknown key here is
// tolerated rather than rejected.
export const upsertProductCommerceBody = z.object({
	sku: z.string().min(1).optional(),
	price: z
		.object({
			amount: z.number().int().nonnegative(),
			currency: z.string().regex(/^[A-Z]{3}$/),
		})
		.optional(),
	// Phase 4 §4: the title an order line snapshots at purchase time. THE SOLE
	// WRITE CHANNEL for `product_commerce.title` (ADR-0013) — the CMS content
	// sync posts it here on every save/publish. Absent from the admin PATCH
	// below, on purpose.
	title: z.string().min(1).max(500).nullable().optional(),
	taxClass: z.string().nullable().optional(),
	weightGrams: z.number().int().nullable().optional(),
	lengthMm: z.number().int().nullable().optional(),
	widthMm: z.number().int().nullable().optional(),
	heightMm: z.number().int().nullable().optional(),
	productKind: z.enum(["physical", "digital"]).optional(),
	// Initial stock (Phase 1 §8 Risk 4) — a create-if-absent seed; never a
	// restock path. OPERATIONALLY: it lands ONLY on the save that first carries
	// the product's sku. Since PR 1a a sku-bearing save ALWAYS seeds a row
	// (`initialOnHand ?? 0`), so by the time a later save supplies a figure the
	// row already exists and `ON CONFLICT (sku) DO NOTHING` discards it —
	// silently, and by design: the seed must never clobber a live or
	// already-decremented count. Send it with the first sku-bearing save; add
	// stock after that through `POST /admin/products/:id/restock`.
	initialOnHand: z.number().int().nonnegative().optional(),
	// Sync-ordering watermark (review S1): the CMS content's own updatedAt,
	// carried by content:afterSave syncs; a strictly-older value is a stale
	// no-op at the store. Panel saves omit it (last-writer-wins).
	// STRICT format (review F1): exactly `Date.toISOString()` output —
	// fixed-width UTC, so lexicographic comparison IS chronological. The
	// field feeds a raw text comparison in SQL; one garbage high-sorting
	// value (e.g. "ZZZZ") stored once would make every future legitimate
	// sync a stale no-op forever (panel saves preserve, never heal, the
	// watermark), so anything else is a 400 at the boundary.
	contentUpdatedAt: z
		.string()
		.regex(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			"contentUpdatedAt must be a Date.toISOString()-format UTC timestamp",
		)
		.optional(),
});

// Publish-gate lifecycle actions (the afterPublish→activate /
// afterUnpublish→deactivate follow-ups). `contentUpdatedAt` is the CMS
// content's own `updatedAt` at publish/unpublish time — the ORDERING WATERMARK
// the store gates on so a stale, out-of-order lifecycle POST is a no-op
// (activate/deactivate are opposing flips on the same `active` flag delivered
// by independent fire-and-forget hooks). REQUIRED and STRICT — exactly
// `Date.toISOString()` output (same rationale as `upsert`'s contentUpdatedAt,
// review F1: it feeds a raw lexicographic SQL comparison; a garbage
// high-sorting value would wedge the gate). EmDash's publish()/unpublish()
// always carry it, so it is never legitimately absent.
export const lifecycleProductCommerceBody = z.object({
	contentUpdatedAt: z
		.string()
		.regex(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			"contentUpdatedAt must be a Date.toISOString()-format UTC timestamp",
		),
});

export type LifecycleProductCommerceBody = z.infer<typeof lifecycleProductCommerceBody>;

// Standalone admin product EDIT (admin-UX Increment 2, slice 2). A SUBSET of
// `upsertProductCommerceBody` — the commerce-owned, merchant-editable fields
// only — plus the REQUIRED optimistic-concurrency watermark `expectedUpdatedAt`
// (the `updatedAt` the admin read on the detail; the store compare-and-sets on
// it, so a concurrent edit surfaces as a 409 stale reload rather than a silent
// clobber). Deliberately OMITS `active` (the CMS publish gate — edited by
// publishing the document, not here), `title` (CMS-owned; see `.strict()`
// below), `contentUpdatedAt` / `initialOnHand` (sync + create-time concerns),
// and `productId` (the path param). Money stays an integer minor-units +
// ISO-4217 pair; `price.amount` is `.positive()` here (a $0 edit is rejected —
// the domain's `price > 0` rule, mirrored so the boundary 400s before the
// use-case throws).
//
// `.strict()` IS DELIBERATE — DO NOT REMOVE IT AS NOISE. Zod's default object
// behaviour STRIPS an unknown key, so simply dropping `title` from this schema
// would make a stale client's rename vanish silently behind a 200 — the failure
// mode most likely to be misread as "it saved". Rejecting is the honest answer:
// title is CMS-owned and `upsertProductCommerceBody` above is its one channel
// (ADR-0013, `adr/0013-product-title-is-cms-owned.md`). Nothing fails when
// `.strict()` is deleted; things merely start passing silently — which is why
// the guard is pinned by a test that asserts the STORED title is unchanged, not
// just the status code (`packages/service/test/admin-product-edit-http.test.ts`).
// Known cost, accepted: an OLD plugin bundle that still sends `title` now 400s
// on EVERY edit, not only title edits. Moot for `sites/staging`, where the
// plugin and the site deploy from one build.
export const editProductCommerceBody = z
	.object({
		expectedUpdatedAt: z
			.string()
			.regex(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
				"expectedUpdatedAt must be a Date.toISOString()-format UTC timestamp",
			),
		sku: z.string().min(1).optional(),
		price: z
			.object({
				amount: z.number().int().positive(),
				currency: z.string().regex(/^[A-Z]{3}$/),
			})
			.optional(),
		taxClass: z.string().nullable().optional(),
		// Increment 2 slice 5: compare-at / cost are money (integer minor units +
		// ISO-4217), NON-NEGATIVE (unlike `price`, a $0 compare-at / cost is a
		// meaningful "cleared to zero"), nullable to CLEAR. Currency integrity (share
		// the product's price currency; no mixed-currency edit) is the domain +
		// store's atomic concern, not re-checked here.
		compareAtPrice: z
			.object({ amount: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
			.nullable()
			.optional(),
		unitCost: z
			.object({ amount: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
			.nullable()
			.optional(),
		weightGrams: z.number().int().nonnegative().nullable().optional(),
		lengthMm: z.number().int().nonnegative().nullable().optional(),
		widthMm: z.number().int().nonnegative().nullable().optional(),
		heightMm: z.number().int().nonnegative().nullable().optional(),
		productKind: z.enum(["physical", "digital"]).optional(),
		// Out-of-stock policy — `"deny"` is the ONLY accepted value this slice (the
		// wire enum is the boundary that keeps an `allow_backorder` from ever
		// reaching the no-oversell reserve path; widening it is a future slice + ADR).
		inventoryPolicy: z.enum(["deny"]).optional(),
	})
	.strict();

export type EditProductCommerceBody = z.infer<typeof editProductCommerceBody>;

// -- Variants: one wire body per WRITER, never one per row --------------------
//
// The two variant write bodies below are the wire half of ADR-0016's two-writer
// split (`adr/0016-variant-title-is-cms-owned.md`), and the split is the reason
// there are two of them rather than one merged body with optional fields: the
// CMS sync owns the variant's presence and its display name, the admin owns its
// sku and price, and NEITHER may reach the other's column. The port makes that
// uncrossable in TypeScript (`UpsertProductVariantInput` has no `sku`/`price`;
// `UpdateProductVariantFieldsInput` has no `title`); these schemas make it
// uncrossable over HTTP, which is the layer a stale client actually reaches.
//
// BOTH ARE `.strict()`, for `editProductCommerceBody`'s reason restated one
// level down: zod's default object behaviour STRIPS an unknown key, so a
// declare that sent `price`, or an edit that sent `title`, would come back 200
// with the field silently discarded — the failure mode most likely to be
// misread as "it saved". A 400 is the honest answer, and it names the field.

// The CMS-sync DECLARE (`PUT /products/:id/variants/:variantKey`). Carries the
// display-name cache and the ordering watermark, and NOTHING COMMERCIAL. The
// variant key is the identity and travels in the PATH, never here — there is no
// field that could re-key a row (ADR-0016: a re-key is unrepresentable, not
// merely discouraged).
export const upsertProductVariantBody = z
	.object({
		// `undefined` PRESERVES the stored cache; an explicit `null` CLEARS it (a
		// repeater row whose name sub-field is empty) — the same grain as
		// `upsertProductCommerceBody.title`, and the same single-writer rule.
		title: z.string().min(1).max(500).nullable().optional(),
		// The CMS content's own `updatedAt` — ONE watermark for both presence
		// transitions (declare and deactivate). STRICT `Date.toISOString()` format
		// for `upsertProductCommerceBody.contentUpdatedAt`'s reason: it feeds a raw
		// lexicographic comparison in SQL, so one garbage high-sorting value stored
		// once would wedge every later sync as a stale no-op.
		contentUpdatedAt: z
			.string()
			.regex(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
				"contentUpdatedAt must be a Date.toISOString()-format UTC timestamp",
			)
			.optional(),
	})
	.strict();

export type UpsertProductVariantBody = z.infer<typeof upsertProductVariantBody>;

// The guarded ADMIN edit (`PATCH /products/:id/variants/:variantKey`) — the
// exact mirror of `editProductCommerceBody`, one level down: the commerce-owned
// fields plus the REQUIRED compare-and-set watermark. Deliberately OMITS
// `title` (CMS-owned) and any field that could move `orphanedAt` (the presence
// axis is a transition, not a field). `price.amount` is `.positive()`, matching
// the domain's own `price > 0` rule so the boundary 400s before the use-case
// throws — an absent price is expressed by leaving the field unset, never by
// sending zero.
export const editProductVariantBody = z
	.object({
		expectedUpdatedAt: z
			.string()
			.regex(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
				"expectedUpdatedAt must be a Date.toISOString()-format UTC timestamp",
			),
		sku: z.string().min(1).optional(),
		price: z
			.object({
				amount: z.number().int().positive(),
				currency: z.string().regex(/^[A-Z]{3}$/),
			})
			.optional(),
	})
	.strict();

export type EditProductVariantBody = z.infer<typeof editProductVariantBody>;

// The ORPHAN transition (`POST /products/:id/variants/:variantKey/deactivate`).
// Same shape and same rationale as `lifecycleProductCommerceBody`: the ordering
// watermark is REQUIRED, because presence has two opposing transitions arriving
// as independent fire-and-forget POSTs and only the watermark orders them.
export const deactivateProductVariantBody = lifecycleProductCommerceBody;

// Admin Products console: merchant restock / stock removal (admin-UX Increment
// 2). `qty` is a positive integer count of whole units — NOT a money field, but
// held to the same integer discipline (no floats). The domain enforces the
// positive-integer bound too (defense-in-depth); this bounds the wire value and
// caps it well below the safe-integer ceiling.
export const stockMovementBody = z.object({
	qty: z.number().int().positive().max(1_000_000_000),
});

export type StockMovementBody = z.infer<typeof stockMovementBody>;

// Catalog batch read (Phase 2 §6): ids are opaque tokens, same charset/bound
// discipline as the cart path params; the array-length cap is the endpoint's
// request-size guard (COMMERCE_BATCH_ID_CAP in routes/catalog.ts — kept in
// sync by the route's own 400 test).
export const commerceBatchBody = z.object({
	productIds: z
		.array(
			z
				.string()
				.min(1)
				.max(200)
				.regex(/^[\x21-\x7e]+$/),
		)
		.max(100),
});

// Phase 5 (§7): customer auth, /me, address book, admin transition.
export const loginRequestBody = z.object({
	email: z.string().min(3).max(320),
});

export const loginVerifyBody = z.object({
	challengeId: idParam,
	token: z.string().min(1).max(400),
});

/** The ten modeled order states as a shared enum — the single wire-value bound
 *  reused by `transitionBody` (target state), `ordersListQuery` (CSV state
 *  filter), and the opaque-cursor filter re-validation. The DOMAIN rejects any
 *  illegal transition; this only bounds the wire value to a known state. */
export const orderStateEnum = z.enum([
	"pending",
	"paid",
	"failed",
	"expired",
	"processing",
	"shipped",
	"delivered",
	"completed",
	"cancelled",
	"refunded",
]);

export const transitionBody = z.object({
	toState: orderStateEnum,
});

// Admin Orders console: append an order note (admin-UX Increment 0). Author +
// body are bounded free text; the domain use-case trims and rejects empties (a
// blank note is meaningless), so the min here is a cheap 1-char floor and the
// substantive validation stays in the domain.
export const appendNoteBody = z.object({
	author: z.string().min(1).max(200),
	body: z.string().min(1).max(4000),
});

/** The three reconciliation dispositions (admin-UX Increment 1) — the wire bound
 *  mirrors the domain `ReconciliationOutcome`. The domain owns the legality (an
 *  order must actually be flagged); this only bounds the wire value. */
export const reconciliationOutcomeEnum = z.enum(["refunded", "fulfilled", "written_off"]);

// Admin Orders console: resolve an order's reconciliation flag (admin-UX
// Increment 1). `expectedFlag` is the flag detail the admin REVIEWED (as
// displayed) — the domain requires the live flag to still EQUAL it (a
// compare-and-clear), so a mid-review re-flag is a 409 conflict, never a blind
// clear. `outcome` is the disposition; `reason`/`resolvedBy` are bounded free
// text — the domain use-case trims and rejects empties, so the 1-char floor
// here is cheap and the substantive validation stays in the domain.
export const resolveReconciliationBody = z.object({
	expectedFlag: z.string().min(1).max(4000),
	outcome: reconciliationOutcomeEnum,
	reason: z.string().min(1).max(4000),
	resolvedBy: z.string().min(1).max(200),
});

// Admin Orders console: record shipping fulfillment (admin-UX Increment 1).
// Recording fulfillment ships the order (`processing → shipped`) and makes the
// shipped email carry tracking. `carrier`/`trackingNumber`/`recordedBy` are
// bounded free text — the domain use-case trims and rejects empties, so the
// 1-char floor here is cheap and the substantive validation stays in the domain.
// `trackingUrl` is optional (the buyer's tracking link) and `shippedAt` optional
// (absent ⇒ the store stamps its own clock at record time); both nullable so an
// explicit null clears them at the boundary the same way an absent field does.
// `trackingUrl` is SCHEME-BOUND to http(s) as defense-in-depth (PR #63 review):
// the value is rendered into the buyer's shipped email and the admin panel, so a
// `javascript:`/`data:` URI must never even be storable — the plugin validates
// the same bound client-side, and the email renderer escapes regardless.
export const recordFulfillmentBody = z.object({
	carrier: z.string().min(1).max(200),
	trackingNumber: z.string().min(1).max(200),
	trackingUrl: z
		.string()
		.max(2000)
		.regex(/^https?:\/\/\S+$/i, "trackingUrl must be an http(s) URL")
		.nullable()
		.optional(),
	shippedAt: z.string().datetime().nullable().optional(),
	recordedBy: z.string().min(1).max(200),
});

/** The five structured cancellation reasons (admin-UX Increment 1, "cancel with
 *  reason") — the wire bound mirrors the domain `CancellationReason`. The
 *  domain owns the legality (an order must actually be cancellable); this only
 *  bounds the wire value. */
export const cancellationReasonEnum = z.enum([
	"customer_request",
	"fraud_suspected",
	"out_of_stock",
	"pricing_error",
	"other",
]);

// Admin Orders console: cancel an order with a structured reason (admin-UX
// Increment 1). `reason` is the closed enum; `detail` is optional bounded free
// text (the domain trims + normalizes a blank to null); `cancelledBy` is
// bounded free text — the domain use-case trims and rejects an empty value, so
// the 1-char floor here is cheap and the substantive validation stays in the
// domain.
export const cancelOrderBody = z.object({
	reason: cancellationReasonEnum,
	detail: z.string().max(4000).nullable().optional(),
	cancelledBy: z.string().min(1).max(200),
});

// Admin Orders console: issue / record a refund (ADR-0008). `amountCents` is
// money — a POSITIVE integer minor-unit value (a $0 refund is meaningless; the
// domain also rejects it) + an ISO-4217 `currency` the domain checks against the
// order's currency. `reason` is optional bounded free text (the domain trims a
// blank → null); `refundedBy` is bounded free text (the domain trims + rejects an
// empty value, so the 1-char floor here is cheap and the substantive validation
// stays in the domain). The ceiling / capability / gateway error taxonomy all live
// in the domain + adapter — this only bounds the wire values. The `Idempotency-Key`
// header is REQUIRED at the route (refunds are ADDITIVE, like a restock — two
// deliberate refunds must NOT collapse), so there is no key field on the body.
export const refundOrderBody = z.object({
	amountCents: z.number().int().positive().max(1_000_000_000_000),
	currency: z.string().regex(/^[A-Z]{3}$/),
	reason: z.string().max(4000).nullable().optional(),
	refundedBy: z.string().min(1).max(200),
});

export type RefundOrderBody = z.infer<typeof refundOrderBody>;

// Admin Orders console: view-only list query (§ admin-orders). The date window
// is HALF-OPEN [from, to) — from inclusive, to EXCLUSIVE — deliberately DIFFERENT
// from the reporting queries' inclusive/inclusive BETWEEN (MOD-7); the store
// documents the same divergence. `states` is a CSV of the enum above (parsed +
// per-token validated in the route). `limit` is coerced + clamped to 1..100
// (default 25); `cursor` is the opaque base64url keyset token.
export const ordersListQuery = z.object({
	states: z.string().min(1).max(200).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	search: z.string().min(1).max(200).optional(),
	cursor: z.string().min(1).max(1000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

/** Validates the FILTER object carried inside a decoded opaque cursor (MOD-1:
 *  re-validate the decoded filter through zod before trusting it). `states` here
 *  is already an array (the encoder stored the parsed array), each token bound to
 *  the shared enum; the window bounds keep the ISO-8601 datetime discipline. */
export const orderListFilterSchema = z.object({
	states: z.array(orderStateEnum).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	search: z.string().min(1).max(200).optional(),
});

export type OrdersListQuery = z.infer<typeof ordersListQuery>;
export type OrderListFilterParsed = z.infer<typeof orderListFilterSchema>;

// Admin Products console: view-only list query (admin-UX Increment 2). Mirrors
// `ordersListQuery`'s shape: `limit` coerced + clamped to 1..100 (default 25),
// `cursor` the opaque base64url keyset token. No date window (products aren't
// filtered by creation date in this slice — see the port doc's ordering note);
// `active` is a single boolean (a two-value axis, unlike orders' multi-state
// `states` CSV); `search` matches EITHER an exact sku OR a substring of title
// (the store's shared predicate, port doc).
export const productKindEnum = z.enum(["physical", "digital"]);

// `deleted` (product lifecycle surfacing, admin-UX Increment 2): the
// tombstone-axis toggle for the admin archive view — omitted/"false" ⇒ the
// ORIGINAL default (live rows only); "true" ⇒ ONLY soft-deleted rows. Same
// tri-state-via-optional-enum shape as `active`.
export const productsListQuery = z.object({
	active: z.enum(["true", "false"]).optional(),
	deleted: z.enum(["true", "false"]).optional(),
	productKind: productKindEnum.optional(),
	search: z.string().min(1).max(200).optional(),
	cursor: z.string().min(1).max(1000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(25),
	// The low-stock predicate's query-string twin (the admin list's own filter,
	// port doc): a raw query param arrives as a string, so it is converted here
	// rather than kept as one, unlike the tri-state `active`/`deleted` enums
	// above — this one is a number, not a two-value axis. Same domain as
	// `lowStockQuery`/`settingsBody` below and as the port's own guard: a
	// non-negative integer no greater than `MAX_LOW_STOCK_THRESHOLD`, so nothing
	// outside it reaches the port (which would otherwise throw
	// `InvalidLowStockThresholdError` and 500 rather than 400 a bad query).
	//
	// THE DIGIT GATE IS NOT DECORATION, and it is why this does not use
	// `z.coerce` the way `limit` above does. Coercion is `Number(value)`, and
	// `Number("")` is 0 — so a bare `?lowStockThreshold=` would arrive as a
	// perfectly valid threshold of ZERO and silently narrow the list to
	// out-of-stock rows, which is the one answer an operator who typed nothing
	// cannot have meant. `Number` is equally content with `0x10` (16), `1e2`
	// (100) and `" 7 "`, none of which a query string should be allowed to mean
	// here. So the SHAPE is checked before the conversion: plain digits, or a
	// 400.
	//
	// (`limit` above keeps its coercion, and the difference is not that an empty
	// value is harmless there — `?limit=` coerces to 0, fails `min(1)` and 400s
	// the whole query; `.default(25)` only fires when the key is ABSENT. It is
	// that `limit`'s bounds catch every value coercion invents, whereas a
	// threshold has no upper bound tight enough to do the same job: `0` is a
	// perfectly valid threshold, so an empty parameter would sail through.)
	lowStockThreshold: z
		.string()
		.regex(/^\d+$/)
		.transform(Number)
		.pipe(z.number().int().nonnegative().max(MAX_LOW_STOCK_THRESHOLD))
		.optional(),
});

/** Validates the FILTER object carried inside a decoded opaque product-list
 *  cursor (MOD-1: re-validate the decoded filter through zod before trusting
 *  it) — mirrors `orderListFilterSchema`. `lowStockThreshold` mirrors
 *  `productsListQuery`'s own field one layer in: the cursor already carries a
 *  real number (not a query string), so it is validated rather than coerced. */
export const productListFilterSchema = z.object({
	active: z.boolean().optional(),
	deleted: z.boolean().optional(),
	productKind: productKindEnum.optional(),
	search: z.string().min(1).max(200).optional(),
	lowStockThreshold: z.number().int().nonnegative().max(MAX_LOW_STOCK_THRESHOLD).optional(),
});

export type ProductsListQuery = z.infer<typeof productsListQuery>;
export type ProductListFilterParsed = z.infer<typeof productListFilterSchema>;

export const productPathParams = z.object({ productId: idParam });

const addressFields = {
	kind: z.enum(["billing", "shipping"]),
	name: z.string().min(1).max(200),
	line1: z.string().min(1).max(300),
	line2: z.string().max(300).nullable().optional(),
	city: z.string().min(1).max(200),
	region: z.string().max(200).nullable().optional(),
	postalCode: z.string().min(1).max(40),
	country: z.string().min(2).max(2),
	isDefault: z.boolean().optional(),
};

export const createAddressBody = z.object(addressFields);
export const updateAddressBody = z.object(addressFields).partial();

export const addressPathParams = z.object({ addressId: idParam });

export type LoginRequestBody = z.infer<typeof loginRequestBody>;
export type LoginVerifyBody = z.infer<typeof loginVerifyBody>;
export type TransitionBody = z.infer<typeof transitionBody>;
export type CreateAddressBody = z.infer<typeof createAddressBody>;

// Phase 7 (§6): reporting query params + settings body. Money on the wire stays
// integer minor units + ISO-4217 currency (report responses); the domain
// use-case enforces the 400-day range cap (mapped to a 400 by the route).
export const reportRevenueQuery = z.object({
	from: z.string().datetime(),
	to: z.string().datetime(),
	interval: z.enum(["day", "week", "month"]).optional().default("day"),
});

export const ordersByStatusQuery = z.object({
	from: z.string().datetime(),
	to: z.string().datetime(),
});

export const topProductsQuery = z.object({
	from: z.string().datetime(),
	to: z.string().datetime(),
	metric: z.enum(["revenue", "quantity"]).optional().default("revenue"),
	limit: z.coerce.number().int().positive().max(1000).optional().default(10),
});

export const lowStockQuery = z.object({
	threshold: z.coerce.number().int().nonnegative().max(MAX_LOW_STOCK_THRESHOLD).optional(),
});

// Settings body — both fields optional (partial update). Bounds mirror the
// domain use-case (holdTtlMinutes positive, ≤ 1 week) and, for the threshold,
// the port's own guard: `MAX_LOW_STOCK_THRESHOLD` is `int4`'s maximum, because
// `inventory.on_hand` is a Postgres `integer` the threshold is compared
// against. The SAVED value is what every later list read binds, so an
// unbounded write here is how an out-of-range threshold would reach the query
// without ever appearing in a URL. Invalid values are a 400, never silently
// clamped (§5.3).
export const settingsBody = z.object({
	holdTtlMinutes: z.number().int().positive().max(10_080).optional(),
	lowStockThreshold: z.number().int().nonnegative().max(MAX_LOW_STOCK_THRESHOLD).optional(),
});

export type SettingsBody = z.infer<typeof settingsBody>;

export type CommerceBatchBody = z.infer<typeof commerceBatchBody>;
export type UpsertProductCommerceBody = z.infer<typeof upsertProductCommerceBody>;
export type CreateCartBody = z.infer<typeof createCartBody>;
export type AddLineBody = z.infer<typeof addLineBody>;
export type PatchLineBody = z.infer<typeof patchLineBody>;
