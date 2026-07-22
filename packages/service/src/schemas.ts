import { z } from "zod";

// Zod request bodies mirroring the inventory port 1:1 (§0.6). `Idempotency-Key`
// travels as a header, not in the body.
export const reserveBody = z.object({
	sku: z.string().min(1),
	qty: z.number().int().positive(),
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
	qty: z.number().int().positive(),
	// Phase 4: the product this line references. Optional for backward-compat with
	// bare Phase-3 adds; REQUIRED to later check out (an order needs a priced
	// product). When present, the service resolves the fulfillment kind from
	// `product_commerce` (server-authoritative) so a digital line reserves nothing.
	productId: z.string().min(1).max(200).optional(),
});

export const patchLineBody = z.object({
	qty: z.number().int().positive(),
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
export const checkoutBody = z.object({
	cartId: idParam,
	paymentMethod: z.enum(["stripe", "x402"]),
	// Email/session claim token — the pre-Phase-5 entitlement key (§6).
	buyerRef: z.string().min(1).max(320),
	// Phase 6: optional shipping selection + coupon (absent ⇒ zero shipping/tax).
	shippingZoneId: idParam.optional(),
	shippingMethodId: idParam.optional(),
	couponCode: z.string().min(1).max(200).optional(),
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

export const entitlementCheckQuery = z
	.object({
		orderId: z.string().min(1).max(200).optional(),
		buyerRef: z.string().min(1).max(320).optional(),
		sku: z.string().min(1).max(200),
	})
	.refine((q) => q.orderId !== undefined || q.buyerRef !== undefined, {
		message: "one of orderId or buyerRef is required",
	});

export type ReserveBody = z.infer<typeof reserveBody>;
export type CommitBody = z.infer<typeof commitBody>;
export type ReleaseBody = z.infer<typeof releaseBody>;

// Product-commerce (Phase 1 §7). Money on the wire is an integer + an
// ISO-4217 string — never a float (DEVELOPMENT.md §4). Every commercial
// field is optional: "create then price" (plan §1 case 3) — a bare sync
// upsert may carry only the product_id.
export const upsertProductCommerceBody = z.object({
	sku: z.string().min(1).optional(),
	price: z
		.object({
			amount: z.number().int().nonnegative(),
			currency: z.string().regex(/^[A-Z]{3}$/),
		})
		.optional(),
	// Phase 4 §4: the title an order line snapshots at purchase time.
	title: z.string().min(1).max(500).nullable().optional(),
	taxClass: z.string().nullable().optional(),
	weightGrams: z.number().int().nullable().optional(),
	lengthMm: z.number().int().nullable().optional(),
	widthMm: z.number().int().nullable().optional(),
	heightMm: z.number().int().nullable().optional(),
	productKind: z.enum(["physical", "digital"]).optional(),
	// Initial stock (Phase 1 §8 Risk 4) — a create-if-absent seed attempted on
	// any save that carries it (self-healing after a partial failure, review
	// B1); never a restock path.
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
	threshold: z.coerce.number().int().nonnegative().optional(),
});

// Settings body — both fields optional (partial update). Bounds mirror the
// domain use-case (holdTtlMinutes positive, ≤ 1 week; lowStockThreshold ≥ 0):
// invalid values are a 400, never silently clamped (§5.3).
export const settingsBody = z.object({
	holdTtlMinutes: z.number().int().positive().max(10_080).optional(),
	lowStockThreshold: z.number().int().nonnegative().optional(),
});

export type SettingsBody = z.infer<typeof settingsBody>;

export type CommerceBatchBody = z.infer<typeof commerceBatchBody>;
export type UpsertProductCommerceBody = z.infer<typeof upsertProductCommerceBody>;
export type CreateCartBody = z.infer<typeof createCartBody>;
export type AddLineBody = z.infer<typeof addLineBody>;
export type PatchLineBody = z.infer<typeof patchLineBody>;
