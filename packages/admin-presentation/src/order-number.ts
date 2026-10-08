/**
 * The admin console's side of the order NUMBER (ADR-0033).
 *
 * The number itself ("#3F9A2") is the domain's `orderNumber`, computed by the server
 * and sent on every admin order row; this module never spells one. It only tells
 * apart rows on one page that SHARE a number, and names the order in the refund
 * confirm.
 */
import { shortIdsFor } from "./short-id.js";

/** One identity cell: the number, plus the characters that extend it on a row whose
 *  number another row on the page shares (`""` otherwise). */
export interface OrderNumberCell {
	readonly number: string;
	readonly extension: string;
}

/** An id's characters as a number reads them: `-` removed, folded. */
function hexOf(id: string): string {
	return id.replaceAll("-", "").toLowerCase();
}

/**
 * Every order on a page, paired with its identity cell. A number no other row
 * shares prints as sent. Rows that share one extend it, upper-cased, to their
 * shortest prefix that is unique WITHIN THAT GROUP, with the id's `-` removed — so
 * the cell is hex only and the admin search accepts it as a number.
 */
export function withOrderNumberCells<
	O extends { readonly id: string; readonly orderNumber: string },
>(orders: readonly O[]): Array<{ readonly order: O; readonly cell: OrderNumberCell }> {
	const groups = new Map<string, O[]>();
	for (const o of orders) groups.set(o.orderNumber, [...(groups.get(o.orderNumber) ?? []), o]);
	const extensions = new Map<string, string>();
	for (const [number, group] of groups) {
		if (group.length < 2) continue;
		const digits = number.length - 1;
		const unique = shortIdsFor(
			group.map((o) => hexOf(o.id)),
			digits,
		);
		for (const o of group) {
			extensions.set(o.id, (unique.get(hexOf(o.id)) ?? "").slice(digits).toUpperCase());
		}
	}
	return orders.map((order) => ({
		order,
		cell: { number: order.orderNumber, extension: extensions.get(order.id) ?? "" },
	}));
}

/** How many hex digits the refund confirm names: more than any tie-breaker a page
 *  realistically prints (that needs two ids agreeing on 12 hex digits — 48 random
 *  bits), so the confirm separates what the list separates. */
export const ORDER_CONFIRM_DIGITS = 12;

/** The order as the refund confirm names it: `#` + its first
 *  {@link ORDER_CONFIRM_DIGITS} hex digits, upper-cased — a visible superset of the
 *  row's number and of any tie-breaker beside it. */
export function orderConfirmLabel(orderId: string): string {
	return `#${hexOf(orderId).slice(0, ORDER_CONFIRM_DIGITS).toUpperCase()}`;
}
