/**
 * The admin console's side of the order NUMBER (ADR-0033).
 *
 * The number itself ("#3F9A2") is computed by the server with the domain's
 * `orderNumber` and arrives on the wire; this module never spells one from
 * scratch except where the wire omitted it. It owns the two things the console
 * needs beyond that: telling apart rows that SHARE a number, and recognising a
 * search the operator typed as a number.
 *
 * `ORDER_NUMBER_LENGTH` mirrors the domain's constant (this package depends on
 * nothing, by design); `@otta-sh/plugin`'s tests pin that the two are equal.
 */
import { shortIdsFor } from "./short-id.js";

/** How many id characters an order number shows — the domain's `ORDER_NUMBER_LENGTH`. */
export const ORDER_NUMBER_LENGTH = 5;

/** A search spelled the way a number is printed: `#`, then at least a number's
 *  worth of hex. */
const TYPED_ORDER_NUMBER = new RegExp(`^#([0-9a-f]{${String(ORDER_NUMBER_LENGTH)},})$`, "i");

/**
 * The hex digits of a search typed as an order number (`" #3F9A2 "` → `"3f9a2"`),
 * or `null` when the search is not one — no `#`, a non-hex character, or fewer
 * than {@link ORDER_NUMBER_LENGTH} digits (`#3F` is a prefix hunt, not a number).
 */
export function typedOrderNumberDigits(search: string | undefined): string | null {
	const match = TYPED_ORDER_NUMBER.exec(search?.trim() ?? "");
	return match?.[1]?.toLowerCase() ?? null;
}

/** An id's characters as a number reads them: the UUID's `-` removed. */
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
 * The identity cell for every order on a page.
 *
 * - A number no other row shares prints as the server sent it.
 * - Rows that SHARE a number extend it, upper-cased, to their shortest-unique
 *   HEX prefix (`#FEE1D` + `1`): the UUID's `-` is never part of it, so every
 *   cell is itself a number the admin search accepts.
 * - A row the wire sent no number for (an older server) gets `#` + its
 *   shortest-unique prefix, upper-cased — the same format, never a bare id.
 *
 * Computed over EXACTLY the rows rendered (§1.3), and deterministic in the set.
 */
export function orderNumberCells(
	orders: readonly { readonly id: string; readonly orderNumber?: string | undefined }[],
): Map<string, OrderNumberCell> {
	const unique = shortIdsFor(
		orders.map((o) => hexOf(o.id)),
		ORDER_NUMBER_LENGTH,
	);
	const seen = new Map<string, number>();
	for (const o of orders) {
		if (o.orderNumber !== undefined) seen.set(o.orderNumber, (seen.get(o.orderNumber) ?? 0) + 1);
	}
	const cells = new Map<string, OrderNumberCell>();
	for (const o of orders) {
		const full = `#${(unique.get(hexOf(o.id)) ?? hexOf(o.id)).toUpperCase()}`;
		if (o.orderNumber === undefined) {
			cells.set(o.id, { number: full, extension: "" });
		} else if ((seen.get(o.orderNumber) ?? 0) > 1 && full.startsWith(o.orderNumber)) {
			cells.set(o.id, { number: o.orderNumber, extension: full.slice(o.orderNumber.length) });
		} else {
			cells.set(o.id, { number: o.orderNumber, extension: "" });
		}
	}
	return cells;
}
