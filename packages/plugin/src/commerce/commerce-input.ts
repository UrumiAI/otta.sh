/**
 * Input bounds for the in-process commerce client — the boundary check the wire
 * used to perform.
 *
 * WHY THIS FILE EXISTS AT ALL. When commerce was reached over HTTP, every call
 * passed through a request-body schema before it reached a use-case, and those
 * schemas were not decoration: they are the only thing standing between a
 * storefront-reachable input and a store that trusts what it is handed. Removing
 * the wire removed the schemas with it. This restores them, in front of the same
 * calls, so the in-process transport refuses exactly what the other one refuses.
 *
 * THE ONE THAT MATTERS MOST, stated plainly because it is the difference between
 * a rejected request and a store nobody can sync again: `contentUpdatedAt` and
 * `expectedUpdatedAt` are compared as RAW STRINGS, lexicographically, which is
 * only chronological while every value is fixed-width UTC. One garbage
 * high-sorting value stored once (`"ZZZZ"`) makes every later legitimate sync a
 * stale no-op FOREVER, because the ordinary write path preserves the stored
 * watermark and never heals it. So the format is exact — `Date.toISOString()`
 * output, nothing else — and it is checked before any store call.
 *
 * COPIED, NOT IMPORTED, and deliberately: these bounds are mirrored from the
 * service's request schemas, and that package goes away. An import would be a
 * dependency on something scheduled for deletion, and a second reading of a
 * schema file is not what the bound is — the bound is the number. Each mirrored
 * rule is named below so the two can be compared by eye, once, rather than
 * trusted.
 *
 * WHAT IS MIRRORED, per method of the storefront surface:
 *
 *  - every opaque id that travelled as a PATH parameter — cart id, line id,
 *    order id, challenge id, zone and method id — non-empty, at most 200
 *    characters, printable ASCII with no whitespace or control characters;
 *  - `productId` — non-empty only, which is all the product routes ever checked
 *    (their 400 is `MISSING_PRODUCT_ID`); the batch read bounds its ids further
 *    because its schema did;
 *  - `getCommerceBatch` — at most 100 ids, each one bounded as above;
 *  - `variantKey` — non-empty after trimming, which is the whole of what the
 *    variant routes checked (`MISSING_VARIANT_KEY`);
 *  - `title` — 1 to 500 characters, or an explicit null to clear it;
 *  - `price.amount` — a non-negative integer on the product upsert, and a
 *    STRICTLY POSITIVE one on the variant edit, matching the two schemas and the
 *    domain's own rule: an absent price is expressed by omitting the field, never
 *    by sending zero;
 *  - `currency` — exactly three upper-case letters, on every money field and on
 *    a cart's currency;
 *  - `qty` — a positive integer no greater than 10,000 (the shopper-facing cap,
 *    far tighter than the raw inventory primitive's);
 *  - `sku` — non-empty, and at most 200 characters where the entitlement check
 *    bounded it; never carrying U+0000 (an addition — see below);
 *  - `buyerRef` — 1 to 320 characters; `couponCode` — 1 to 200; the login token —
 *    1 to 400; the shipping address — the per-field bounds the address schema
 *    pins, which the domain then re-validates and trims;
 *  - the physical dimensions and `initialOnHand` — integers (nullable where the
 *    schema allowed null), never floats;
 *  - the idempotency key — non-empty, which is what every write route demanded of
 *    the header.
 *
 * ADDED, not mirrored (#379), because the wire's absence of a rule was a bug the
 * in-process store makes visible: U+0000 is refused in a `sku`, the cart add's
 * `productId` and an idempotency key, since Postgres cannot store it and a NUL
 * failed the first store read there as a throw; and the key of a write that makes
 * it part of a document id is capped at {@link IDEMPOTENCY_KEY_MAX}.
 *
 * NOT mirrored, and why: the email on a login request is validated but never
 * REPORTED on — that surface answers identically whatever it is handed, so a
 * malformed address is a silent no-op rather than a refusal a caller could use as
 * an account oracle. Unknown-key rejection (the `.strict()` bodies) has no
 * meaning here: the port's inputs are typed, so an unknown field does not
 * compile, and there is no serialization for one to hide in.
 *
 * Every failure is {@link CommerceInputError} — an awaited rejection carrying a
 * structural `code`, the field and the reason. No status codes: there is no wire
 * here to carry one, and a caller branches on the code.
 */

import { isCodeShapedRegion, ORDER_ADDRESS_MAX_LENGTHS } from "@otta-sh/domain";

/** `Date.toISOString()` output, and only that: fixed-width UTC milliseconds. */
const ISO_MILLIS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Printable ASCII, no whitespace and no control characters. */
// oxlint-disable-next-line no-control-regex -- the range is the charset the ids are bounded to
const ID_CHARSET = /^[\x21-\x7e]+$/;

/** An opaque id's ceiling — long enough for any id the system mints. */
const ID_MAX = 200;

/** A coupon code's ceiling. Exported so a boundary parser in front of this
 *  client (the storefront checkout routes) rejects exactly what this refuses. */
export const COUPON_CODE_MAX = 200;

/** `requireIdToken`'s rule as a predicate, for a boundary parser that must turn
 *  a malformed id into its own INVALID_INPUT rather than let this client throw.
 *  One definition, so the two cannot drift. */
export function isIdToken(value: string): boolean {
	return value.length > 0 && value.length <= ID_MAX && ID_CHARSET.test(value);
}

/** A sign-in link token's ceiling. Exported so the verify route answers an
 *  over-long token as an invalid link instead of letting this client throw. */
export const LOGIN_TOKEN_MAX = 400;

/** A checkout's `buyerRef` (the buyer's email) ceiling — the wire schema's
 *  `z.string().min(1).max(320)`. Exported so the place route's parser and a
 *  storefront's email field use this one number. */
export const BUYER_REF_MAX = 320;

/**
 * The ceiling on an idempotency key that becomes (part of) a DOCUMENT ID — see
 * {@link requireDocumentIdempotencyKey} for which writes those are. A document id
 * is at most 1,024 characters (the host's `assertStorageKey`), and some ids
 * prefix the key — `adjust:<key>` when a cart line's quantity changes,
 * `<couponId>:<key>` on a coupon redemption, with a coupon id of up to 200 — so a
 * key near 1,024 throws there (a 1,018-character key already does, on a quantity
 * update). Half the id ceiling leaves every such prefix room. No earlier bound
 * existed to reuse: the wire only ever demanded a non-empty header.
 *
 * What those writes' callers send is far below it: a `crypto.randomUUID()` from
 * the site's cart forms (36 characters), `checkout:<cartId>`, and the admin
 * settings form's key.
 *
 * NOT applied to the product-row writes (upsert, activate, the variant writes,
 * …): their key is a FIELD on the row, and variant sync derives keys from opaque,
 * unbounded CMS text (`<collection>:<id>:variant:<variantKey>:<updatedAt>:<version>`),
 * which legitimately runs past this.
 */
export const IDEMPOTENCY_KEY_MAX = 512;

/** The shopper-facing quantity cap. Deliberately far below the raw inventory
 *  primitive's: this is the anonymous-caller surface. */
export const CART_LINE_MAX_QTY = 10_000;

/** The batch read's request-size guard — a size bound, not pagination. */
export const COMMERCE_BATCH_ID_CAP = 100;

/**
 * A refused input, before anything was read or written.
 *
 * `code` is structural rather than an `instanceof` check, so it survives a
 * bridge and a bundle boundary; `field` and `reason` are what a caller renders.
 */
export class CommerceInputError extends Error {
	override readonly name = "CommerceInputError";
	readonly code = "INVALID_INPUT";
	readonly field: string;
	readonly reason: string;

	constructor(field: string, reason: string) {
		super(`invalid ${field}: ${reason}`);
		this.field = field;
		this.reason = reason;
	}
}

/** Structural test, for a caller that must not depend on the class identity. */
export function isCommerceInputError(err: unknown): err is CommerceInputError {
	return (
		typeof err === "object" && err !== null && (err as { code?: unknown }).code === "INVALID_INPUT"
	);
}

function fail(field: string, reason: string): never {
	throw new CommerceInputError(field, reason);
}

/** Whether `value` passes {@link requireIdToken}, without throwing — for a
 *  boundary that answers a bad id as a refused request. */
export function isCommerceIdToken(value: string): boolean {
	return value.length > 0 && value.length <= ID_MAX && ID_CHARSET.test(value);
}

/** An opaque id token: non-empty, bounded, no whitespace or control characters. */
export function requireIdToken(field: string, value: string): string {
	if (value.length === 0) fail(field, "must not be empty");
	if (value.length > ID_MAX) fail(field, `must be at most ${String(ID_MAX)} characters`);
	if (!ID_CHARSET.test(value)) fail(field, "must be printable ASCII with no whitespace");
	return value;
}

/** A product id: non-empty, which is the whole of what the product routes checked. */
export function requireProductId(value: string): string {
	if (value.length === 0) fail("productId", "must not be empty");
	return value;
}

/**
 * Whether `value` is free of U+0000 — the one character Postgres `text` can never
 * hold. A NUL that reaches a store read there fails as `invalid byte sequence for
 * encoding "UTF8": 0x00`, a throw (RENDER_FAILED), not an answer; SQLite stores it
 * happily, so only one dialect shows the bug. Nothing legitimate is refused: no
 * value carrying it could ever have been saved. The id-token charset already
 * excludes it; this is for the fields that have no charset rule.
 */
function isStorableText(value: string): boolean {
	return !value.includes("\u0000");
}

/** {@link requireBoundedProductId}'s ceiling. */
const BOUNDED_PRODUCT_ID_MAX = 200;

/*
 * ONE DEFINITION PER RULE. Each rule below is a `…Problem` function answering
 * what is wrong with a value, or null. The exported predicate (`is…`, which the
 * storefront routes answer a bad value with) and the `require…` (which this
 * client throws from) are both read off it, so the route can never let through
 * what the client throws on, nor refuse what it accepts (#379).
 */

function skuProblem(value: string): string | null {
	if (value.length === 0) return "must not be empty";
	if (!isStorableText(value)) return "must not contain U+0000";
	return null;
}

function boundedProductIdProblem(value: string): string | null {
	if (value.length < 1) return "must be at least 1 characters";
	if (value.length > BOUNDED_PRODUCT_ID_MAX) {
		return `must be at most ${String(BOUNDED_PRODUCT_ID_MAX)} characters`;
	}
	if (!isStorableText(value)) return "must not contain U+0000";
	return null;
}

function idempotencyKeyProblem(value: string): string | null {
	if (value.length === 0) return "must not be empty";
	if (!isStorableText(value)) return "must not contain U+0000";
	return null;
}

function documentIdempotencyKeyProblem(value: string): string | null {
	const problem = idempotencyKeyProblem(value);
	if (problem !== null) return problem;
	if (value.length > IDEMPOTENCY_KEY_MAX) {
		return `must be at most ${String(IDEMPOTENCY_KEY_MAX)} characters`;
	}
	return null;
}

/**
 * A product id where the schema bounded it as TEXT rather than as a path
 * parameter: non-empty, at most 200 characters, and no charset rule. The
 * distinction is not pedantry — imposing the path parameter's printable-ASCII
 * charset here would refuse ids the other transport accepts, and a divergence
 * that refuses MORE is still a divergence.
 */
export function requireBoundedProductId(value: string): string {
	const problem = boundedProductIdProblem(value);
	if (problem !== null) fail("productId", problem);
	return value;
}

/** `requireBoundedProductId`'s rule as a predicate — length, and no U+0000, but
 *  NO charset — for the cart add route, which must answer a bad product id as its
 *  own INVALID_INPUT rather than let this client throw. Not {@link isIdToken},
 *  which would refuse ids this accepts. */
export function isBoundedProductId(value: string): boolean {
	return boundedProductIdProblem(value) === null;
}

/** A variant key: non-empty after trimming. The key is opaque CMS text, so no
 *  charset is imposed — a key carrying a slash or a space is legitimate. */
export function requireVariantKey(value: string): string {
	if (value.trim().length === 0) fail("variantKey", "must not be empty or whitespace");
	return value;
}

/** The ordering / compare-and-set watermark. See this module's doc: the format is
 *  exact because the comparison is lexicographic on raw text. */
export function requireWatermark(field: string, value: string): string {
	if (!ISO_MILLIS_UTC.test(value)) {
		fail(field, "must be a Date.toISOString()-format UTC timestamp");
	}
	return value;
}

/** `requireIdempotencyKey`'s rule as a predicate: non-empty, no U+0000. */
export function isIdempotencyKeyText(value: string): boolean {
	return idempotencyKeyProblem(value) === null;
}

/** Every write's key: non-empty, and no U+0000 (Postgres cannot store it). No
 *  length rule — see {@link requireDocumentIdempotencyKey} for the writes that
 *  need one. */
export function requireIdempotencyKey(value: string): string {
	const problem = idempotencyKeyProblem(value);
	if (problem !== null) fail("idempotencyKey", problem);
	return value;
}

/** `requireDocumentIdempotencyKey`'s rule as a predicate, for the cart routes,
 *  which must answer a bad key as their own INVALID_INPUT rather than let this
 *  client throw. */
export function isDocumentIdempotencyKey(value: string): boolean {
	return documentIdempotencyKeyProblem(value) === null;
}

/**
 * The key of a write that makes it (part of) a DOCUMENT ID: {@link
 * requireIdempotencyKey}'s rule plus the {@link IDEMPOTENCY_KEY_MAX} ceiling.
 * The writes on THIS client whose key becomes a document id:
 *  - the cart mutations (add, adjust, remove): `cart_mutation_index/{key}`,
 *    `reservation_keys/{key}`, and `adjust:{key}` in the movement collection;
 *  - the order create: `order_keys/{key}`, and `{couponId}:{key}` when a coupon
 *    is redeemed;
 *  - the settings update: `settings_mutations/{key}`.
 * Past the ceiling the store threw on the id length (or, for a megabyte-sized
 * key, on the 1 MiB value cap) instead of refusing. Other stores also build
 * document ids from a key — refunds (`refund_keys/{key}`), restock/remove-stock
 * (`stock:{key}`) and the sku-rename ledger — but those keys are built by the
 * admin tier from bounded parts and do not pass through this function.
 */
export function requireDocumentIdempotencyKey(value: string): string {
	const problem = documentIdempotencyKeyProblem(value);
	if (problem !== null) fail("idempotencyKey", problem);
	return value;
}

/** `requireSku`'s rule (without the optional ceiling) as a predicate: non-empty
 *  and storable, and nothing else — the admin saves any such sku, so a route that
 *  asked more would refuse a product the store sells. */
export function isSkuText(value: string): boolean {
	return skuProblem(value) === null;
}

export function requireSku(value: string, max?: number): string {
	const problem = skuProblem(value);
	if (problem !== null) fail("sku", problem);
	if (max !== undefined && value.length > max) {
		fail("sku", `must be at most ${String(max)} characters`);
	}
	return value;
}

export function requireCurrencyCode(field: string, value: string): string {
	if (!/^[A-Z]{3}$/.test(value)) fail(field, "must be a three-letter ISO-4217 code");
	return value;
}

/**
 * A money field. `positive` distinguishes the two schemas: the product upsert
 * accepted a zero amount, the variant edit never did.
 */
export function requireMoney(
	field: string,
	value: { amount: number; currency: string },
	options: { positive?: boolean } = {},
): { amount: number; currency: string } {
	const amountField = `${field}.amount`;
	if (!Number.isSafeInteger(value.amount)) fail(amountField, "must be an integer minor amount");
	if (options.positive === true) {
		if (value.amount <= 0) fail(amountField, "must be greater than zero");
	} else if (value.amount < 0) {
		fail(amountField, "must not be negative");
	}
	requireCurrencyCode(`${field}.currency`, value.currency);
	return value;
}

export function requireTitle(value: string | null): string | null {
	if (value === null) return null;
	if (value.length === 0) fail("title", "must not be empty");
	if (value.length > 500) fail("title", "must be at most 500 characters");
	return value;
}

export function requireQty(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) fail("qty", "must be a positive integer");
	if (value > CART_LINE_MAX_QTY) {
		fail("qty", `must be at most ${String(CART_LINE_MAX_QTY)}`);
	}
	return value;
}

export function requireBatchIds(ids: string[]): string[] {
	if (ids.length > COMMERCE_BATCH_ID_CAP) {
		fail("productIds", `must hold at most ${String(COMMERCE_BATCH_ID_CAP)} ids`);
	}
	for (const id of ids) requireIdToken("productIds[]", id);
	return ids;
}

/** An integer, or null where the schema allowed one. Never a float. */
export function requireNullableInteger(field: string, value: number | null): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value)) fail(field, "must be an integer");
	return value;
}

export function requireNonNegativeInteger(field: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) fail(field, "must be a non-negative integer");
	return value;
}

export function requireBoundedText(field: string, value: string, min: number, max: number): string {
	if (value.length < min) fail(field, `must be at least ${String(min)} characters`);
	if (value.length > max) fail(field, `must be at most ${String(max)} characters`);
	return value;
}

/** True when the string is a plausible email by the same loose bound the login
 *  surface applied. NOT a refusal: the caller answers identically either way. */
export function looksLikeEmail(value: string): boolean {
	return value.length >= 3 && value.length <= 320;
}

/** The optional ship-to snapshot's per-field bounds. The domain re-validates and
 *  trims; this is the boundary's first pass, exactly as the wire's was. */
export function requireShippingAddress(address: {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	region?: string;
	postalCode: string;
	country: string;
	email?: string;
	phone?: string;
}): void {
	// The domain's own bounds (ORDER_ADDRESS_MAX_LENGTHS), never copied literals:
	// a bound that drifted from the domain's would refuse what it accepts, or
	// let through what it then refuses as a generic failure.
	const max = ORDER_ADDRESS_MAX_LENGTHS;
	requireBoundedText("shippingAddress.name", address.name, 1, max.name);
	requireBoundedText("shippingAddress.line1", address.line1, 1, max.line1);
	if (address.line2 !== undefined)
		requireBoundedText("shippingAddress.line2", address.line2, 0, max.line2);
	requireBoundedText("shippingAddress.city", address.city, 1, max.city);
	if (address.region !== undefined)
		requireBoundedText("shippingAddress.region", address.region, 0, max.region);
	requireBoundedText("shippingAddress.postalCode", address.postalCode, 1, max.postalCode);
	requireBoundedText("shippingAddress.country", address.country, 1, max.country);
	requireCodeShapes("shippingAddress", address.country, address.region);
	if (address.email !== undefined)
		requireBoundedText("shippingAddress.email", address.email, 0, max.email);
	if (address.phone !== undefined)
		requireBoundedText("shippingAddress.phone", address.phone, 0, max.phone);
}

/**
 * ADR-0021: a destination's SHAPE — a two-letter country and, when given, a
 * code-shaped region. Shape only: whether the codes are REAL (in CLDR) is the
 * domain's call, and it answers with a typed reason a buyer can act on
 * (`INVALID_SHIPPING_ADDRESS` / `SHIPPING_REGION_CODE_REQUIRED`). The routes'
 * parsers refuse the same shapes first, so a buyer never reaches this throw.
 */
export function requireDestination(destination: { country: string; region?: string }): void {
	requireCodeShapes("destination", destination.country, destination.region);
}

function requireCodeShapes(prefix: string, country: string, region: string | undefined): void {
	if (!COUNTRY_SHAPE.test(country.trim())) {
		fail(`${prefix}.country`, "must be an ISO 3166-1 alpha-2 code");
	}
	if (region !== undefined && region.trim().length > 0 && !isCodeShapedRegion(region)) {
		fail(`${prefix}.region`, "must be an ISO 3166-2 subdivision code");
	}
}

/** Two letters, either case — the SHAPE of an ISO 3166-1 alpha-2 code. */
export const COUNTRY_SHAPE = /^[A-Za-z]{2}$/;
