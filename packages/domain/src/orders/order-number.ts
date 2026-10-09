/**
 * The order NUMBER: a short, human label for an order — `"#3F9A2"`.
 *
 * WHAT IT IS. The first {@link ORDER_NUMBER_LENGTH} characters of the order's id,
 * upper-cased, behind a `#`. Order ids are random UUIDs (`crypto.randomUUID()`,
 * version 4 — `uuidIdGen` in `@otta-sh/store-emdash`), so those leading characters
 * are uniformly random hex: no timestamp, no shared prefix. That is what makes a
 * prefix usable as a label at all (a time-ordered id such as UUIDv7 would give every
 * order of the same hour the same five characters).
 *
 * WHAT IT IS NOT — A KEY (ADR-0033). Five hex characters are about a million values,
 * so two orders WILL eventually share a number. It is a DISPLAY label, derived on
 * read and never stored: nothing resolves an order by it alone. The id stays the
 * identity everywhere a machine reads it. The admin search reads a typed number as an
 * id PREFIX ({@link orderNumberIdPrefix}) and may answer several orders.
 *
 * ONE SOURCE, so the storefront, the emails and the admin console print the same
 * order the same way. The storefront and the admin wire reach it through
 * `@otta-sh/plugin`; the email renderer calls it directly; the React console gets
 * the number on the wire and never spells one itself.
 *
 * Pure and total: any string in, a string out — no validation of the id's shape, so
 * a test's counter id (`"ord-1"`) still renders something (`"#ORD-1"`). It is not
 * localised, and needs not be: `#` + an identifier reads the same in every locale a
 * storefront renders, and the copy AROUND it ("Order #3F9A2") is the caller's.
 */

/** How many characters of the id the number shows. */
export const ORDER_NUMBER_LENGTH = 5;

/** The order number for an order id: `"#"` + its first five characters, upper-cased. */
export function orderNumber(orderId: string): string {
	return `#${orderId.slice(0, ORDER_NUMBER_LENGTH).toUpperCase()}`;
}

/**
 * A search typed as an order number: an optional leading `Order` (any case, then an
 * optional `:` and spaces), then `#`, then hex in which a `-` may only sit BETWEEN two
 * hex digits, then optional trailing `.`, `:`, `,` or `;`. At least
 * {@link ORDER_NUMBER_LENGTH} hex digits are required.
 *
 * Written so no two parts can match the same run of spaces (`\s*(?::\s*)?`, not
 * `\s*:?\s*`): the ambiguous form backtracks quadratically on `"order"` + many spaces
 * with no `#` (CodeQL js/polynomial-redos). Same language either way.
 */
const TYPED_ORDER_NUMBER = /^(?:order\s*(?::\s*)?)?#([0-9a-f]+(?:-[0-9a-f]+)*)[.:,;]*$/i;

/** Where a UUID's `-` falls, counted in hex digits before it — so a long number the
 *  console printed hex-only still prefixes the stored, hyphenated id. */
const UUID_HYPHENS_AFTER = [20, 16, 12, 8] as const;

/**
 * The id-prefix a search typed as an order number stands for, or `null` when the
 * search is not one. Accepted forms (the caller passes the search already trimmed —
 * the admin client trims it once, for every arm):
 *
 *  - `#3F9A2` → `3f9a2`; any case;
 *  - a longer number, hex only or with the id's own hyphens between digits:
 *    `#ABCDEF123` or `#abcdef12-3` → `abcdef12-3` (hyphens go back in the UUID's places);
 *  - with a leading `Order`, `Order:` or `Order#` and trailing punctuation, as pasted
 *    from an email: `Order #3F9A2:`, `Order#3F9A2`, `Order: #3F9A2.`
 *
 * Not a number, so matched literally: anything without that leading `#` (`3F9A2`,
 * `-#12345`), fewer than five hex digits, a `-` right after `#` or at the end
 * (`#-12345`, `#12345-`), or any other character.
 *
 * Only the store's ID arm reads this; the buyer and sku arms keep matching the text
 * as typed, `#` and all, so a sku spelled `#12345` is still found.
 */
export function orderNumberIdPrefix(search: string): string | null {
	const digits = TYPED_ORDER_NUMBER.exec(search)?.[1]?.replaceAll("-", "").toLowerCase();
	if (digits === undefined || digits.length < ORDER_NUMBER_LENGTH) return null;
	let prefix = digits;
	for (const at of UUID_HYPHENS_AFTER) {
		if (prefix.length > at) prefix = `${prefix.slice(0, at)}-${prefix.slice(at)}`;
	}
	return prefix;
}
