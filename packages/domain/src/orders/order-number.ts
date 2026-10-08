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
 * so two orders WILL eventually share a number (even odds somewhere past ~1,200
 * orders). It is a DISPLAY label, derived on read and never stored: nothing resolves
 * an order by its number alone. The id stays the identity everywhere a machine reads
 * it (URLs, Stripe metadata, idempotency keys, the outbox). The admin search finds
 * orders by it as an id PREFIX ({@link orderNumberSearchText}), and may return
 * several; the console then tells them apart by the full id.
 *
 * ONE FUNCTION, so the storefront, the emails and the admin console print the same
 * order the same way. The storefront and the admin wire reach it through
 * `@otta-sh/plugin`; the email renderer calls it directly.
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

/** An order number as an operator types it back: a `#`, then hex. */
const TYPED_ORDER_NUMBER = /^#[0-9a-f]+$/iu;

/**
 * An admin search string with an order number's `#` taken off, so `"#3F9A2"` finds
 * the orders whose id starts `3f9a2` (the store's id arm is an anchored, case-folded
 * prefix, so the rest already works). Anything else is returned unchanged — an email
 * or a sku is not touched, and a bare `"3F9A2"` already searches.
 *
 * ACCEPTED EDGE: a search that is literally `#` + hex (`"#BEEF"`) is read as an
 * order number, so a sku or an email local part spelled that way is found by
 * searching without the `#` instead. No real id starts with `#`.
 */
export function orderNumberSearchText(search: string): string {
	return TYPED_ORDER_NUMBER.test(search) ? search.slice(1) : search;
}
