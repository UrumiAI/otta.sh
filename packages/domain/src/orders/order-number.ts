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

/** A search typed as an order number: `#`, then at least a number's worth of hex. */
const TYPED_ORDER_NUMBER = new RegExp(`^#([0-9a-f]{${String(ORDER_NUMBER_LENGTH)},})$`, "i");

/** Where a UUID's `-` falls, counted in hex digits before it — so a long number the
 *  console printed hex-only still prefixes the stored, hyphenated id. */
const UUID_HYPHENS_AFTER = [20, 16, 12, 8] as const;

/**
 * The id-prefix a search typed as an order number stands for (`"#3F9A2"` →
 * `"3f9a2"`, `"#ABCDEF123"` or `"#abcdef12-3"` → `"abcdef12-3"`), or `null` when the
 * search is not one (no `#`, a non-hex character other than `-`, or fewer than
 * {@link ORDER_NUMBER_LENGTH} hex digits).
 *
 * Only the store's ID arm reads this; the buyer and sku arms keep matching the text
 * as typed, `#` and all, so a sku spelled `#12345` is still found.
 */
export function orderNumberIdPrefix(search: string): string | null {
	// The id's own hyphens may be typed too (`#3f9a2b1c-7d4e`): dropped before the
	// hex check, and put back in the UUID's places below.
	const match = TYPED_ORDER_NUMBER.exec(search.trim().replaceAll("-", ""));
	const digits = match?.[1]?.toLowerCase();
	if (digits === undefined) return null;
	let prefix = digits;
	for (const at of UUID_HYPHENS_AFTER) {
		if (prefix.length > at) prefix = `${prefix.slice(0, at)}-${prefix.slice(at)}`;
	}
	return prefix;
}
