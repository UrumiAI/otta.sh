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
 *    bounded it;
 *  - `buyerRef` — 1 to 320 characters; `couponCode` — 1 to 200; the login token —
 *    1 to 400; the shipping address — the per-field bounds the address schema
 *    pins, which the domain then re-validates and trims;
 *  - the physical dimensions and `initialOnHand` — integers (nullable where the
 *    schema allowed null), never floats;
 *  - the idempotency key — non-empty, which is what every write route demanded of
 *    the header.
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

/** `Date.toISOString()` output, and only that: fixed-width UTC milliseconds. */
const ISO_MILLIS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Printable ASCII, no whitespace and no control characters. */
// oxlint-disable-next-line no-control-regex -- the range is the charset the ids are bounded to
const ID_CHARSET = /^[\x21-\x7e]+$/;

/** An opaque id's ceiling — long enough for any id the system mints. */
const ID_MAX = 200;

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
 * A product id where the schema bounded it as TEXT rather than as a path
 * parameter: non-empty, at most 200 characters, and no charset rule. The
 * distinction is not pedantry — imposing the path parameter's printable-ASCII
 * charset here would refuse ids the other transport accepts, and a divergence
 * that refuses MORE is still a divergence.
 */
export function requireBoundedProductId(value: string): string {
	return requireBoundedText("productId", value, 1, 200);
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

export function requireIdempotencyKey(value: string): string {
	if (value.length === 0) fail("idempotencyKey", "must not be empty");
	return value;
}

export function requireSku(value: string, max?: number): string {
	if (value.length === 0) fail("sku", "must not be empty");
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
	requireBoundedText("shippingAddress.name", address.name, 1, 200);
	requireBoundedText("shippingAddress.line1", address.line1, 1, 200);
	if (address.line2 !== undefined)
		requireBoundedText("shippingAddress.line2", address.line2, 0, 200);
	requireBoundedText("shippingAddress.city", address.city, 1, 120);
	if (address.region !== undefined)
		requireBoundedText("shippingAddress.region", address.region, 0, 120);
	requireBoundedText("shippingAddress.postalCode", address.postalCode, 1, 32);
	requireBoundedText("shippingAddress.country", address.country, 1, 100);
	if (address.email !== undefined)
		requireBoundedText("shippingAddress.email", address.email, 0, 320);
	if (address.phone !== undefined)
		requireBoundedText("shippingAddress.phone", address.phone, 0, 64);
}
