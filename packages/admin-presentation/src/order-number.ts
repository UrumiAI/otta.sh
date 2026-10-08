/**
 * The admin side of the order NUMBER (ADR-0033) — the ONE place that decides what
 * an operator typed as a number, how a page tells apart rows that share one, and
 * how much of the id the refund confirm names.
 *
 * The number itself ("#3F9A2") is the domain's `orderNumber`, computed by the
 * server and sent on the admin wire. This module is pure and depends on nothing
 * (so the React console can use it); the plugin uses the same matcher to read the
 * search, so the console's note and the server's query cannot disagree.
 * `ORDER_NUMBER_LENGTH` mirrors the domain's constant; `@otta-sh/plugin`'s tests
 * pin that the two are equal.
 */
import { shortIdsFor } from "./short-id.js";

/** How many id characters an order number shows — the domain's `ORDER_NUMBER_LENGTH`. */
export const ORDER_NUMBER_LENGTH = 5;

/** How many hex digits the refund confirm names. Longer than any tie-breaker a
 *  page realistically shows (two ids would have to agree on their first 12 hex
 *  digits — 48 random bits), so the confirm separates what the list separates. */
export const ORDER_CONFIRM_DIGITS = 12;

/** A search spelled the way a number is printed: `#`, then at least a number's
 *  worth of hex. Shorter (`#3F`) is not a number and is searched literally. */
const TYPED_ORDER_NUMBER = new RegExp(`^#([0-9a-f]{${String(ORDER_NUMBER_LENGTH)},})$`, "i");

/**
 * The hex digits of a search typed as an order number (`" #3F9A2 "` → `"3f9a2"`),
 * or `null` when the search is not one.
 */
export function typedOrderNumberDigits(search: string | undefined): string | null {
	const match = TYPED_ORDER_NUMBER.exec(search?.trim() ?? "");
	return match?.[1]?.toLowerCase() ?? null;
}

/** Where a UUID's `-` falls, counted in hex digits before it. */
const UUID_HYPHENS_AFTER = [20, 16, 12, 8] as const;

/**
 * The admin search as the store's id-prefix arm should see it. A typed number has
 * its `#` removed; one long enough to cross a UUID hyphen (a tie-breaker such as
 * `#ABCDEF123`, printed hex-only) gets the hyphens back in the UUID's places, so it
 * still prefixes the stored id. The stored id and its search key are unchanged
 * (no migration — ADR-0033). Anything else is returned as typed.
 */
export function orderNumberSearchText(search: string): string {
	const digits = typedOrderNumberDigits(search);
	if (digits === null) return search;
	let text = digits;
	for (const at of UUID_HYPHENS_AFTER) {
		if (text.length > at) text = `${text.slice(0, at)}-${text.slice(at)}`;
	}
	return text;
}

/** An id's characters as a number reads them: `-` removed, folded. */
function hexOf(id: string): string {
	return id.replaceAll("-", "").toLowerCase();
}

/** Does this order's id start with these typed digits (hyphens ignored)? */
export function idMatchesOrderNumber(id: string, digits: string): boolean {
	return hexOf(id).startsWith(digits.toLowerCase());
}

/** One identity cell: the number, plus the characters that extend it on a row
 *  whose number another row on the page shares (`""` otherwise). */
export interface OrderNumberCell {
	readonly number: string;
	readonly extension: string;
}

/**
 * Every order on a page, paired with its identity cell.
 *
 * - A number no other row shares prints as the server sent it.
 * - Rows that SHARE a number (or arrived without one) print `#` + their
 *   shortest-unique id prefix, upper-cased, with `-` dropped so a UUID's cell is
 *   hex only. Uniqueness is decided on the RAW ids (`ord-10` and `ord-11` differ);
 *   where dropping `-` would make two cells read the same, those keep their `-`.
 * - The cell is split into the number and its extension when it starts with the
 *   number, so the extension can be drawn quieter.
 *
 * Computed over EXACTLY the rows rendered (§1.3), deterministic in the set.
 */
export function withOrderNumberCells<
	O extends { readonly id: string; readonly orderNumber?: string | undefined },
>(orders: readonly O[]): Array<{ readonly order: O; readonly cell: OrderNumberCell }> {
	const unique = shortIdsFor(
		orders.map((o) => o.id.toLowerCase()),
		ORDER_NUMBER_LENGTH,
	);
	const prefixOf = (o: O): string => unique.get(o.id.toLowerCase()) ?? o.id.toLowerCase();
	const sharedNumber = new Map<string, number>();
	for (const o of orders) {
		if (o.orderNumber !== undefined) {
			sharedNumber.set(o.orderNumber, (sharedNumber.get(o.orderNumber) ?? 0) + 1);
		}
	}
	const needsCell = (o: O): boolean =>
		o.orderNumber === undefined || (sharedNumber.get(o.orderNumber) ?? 0) > 1;
	const stripped = new Map<string, Set<string>>();
	for (const o of orders) {
		if (!needsCell(o)) continue;
		const text = prefixOf(o).replaceAll("-", "");
		stripped.set(text, (stripped.get(text) ?? new Set()).add(o.id));
	}
	return orders.map((order) => {
		if (!needsCell(order)) {
			return { order, cell: { number: order.orderNumber ?? "", extension: "" } };
		}
		const raw = prefixOf(order);
		const hex = raw.replaceAll("-", "");
		const text = `#${((stripped.get(hex)?.size ?? 0) > 1 ? raw : hex).toUpperCase()}`;
		const number = order.orderNumber;
		const cell =
			number !== undefined && text.startsWith(number)
				? { number, extension: text.slice(number.length) }
				: { number: text, extension: "" };
		return { order, cell };
	});
}

/** The order as the refund confirm names it: `#` + its first
 *  {@link ORDER_CONFIRM_DIGITS} id characters (`-` dropped), upper-cased — it
 *  visibly extends the row's number and any tie-breaker. */
export function orderConfirmLabel(orderId: string): string {
	return `#${hexOf(orderId).slice(0, ORDER_CONFIRM_DIGITS).toUpperCase()}`;
}
