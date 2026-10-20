/**
 * Which EmDash badge tone an order state wears, on the list and the detail.
 *
 * EVERY STATE IS A PILL (user decision, 2026-10-20): the status column reads
 * like EmDash's own content lists, where every row's state is a coloured badge
 * ("Published"). The words inside are still `orderStateCell`'s, so the pill and
 * the Block Kit cell cannot drift apart on wording — only the ink is React's.
 *
 * THE TONE SAYS WHAT HAPPENS NEXT, not how good the state is:
 *  - `warn` — waiting on the buyer or the provider (`pending`);
 *  - `info` — in progress (`processing`, `shipped`);
 *  - `ok`   — the money is in, or the job is done (`paid`, `delivered`,
 *             `completed`);
 *  - `fail` — `failed`, a legacy pre-ADR-0022 terminal state with no transitions;
 *             it keeps the alarm colour so it stands out in a list;
 *  - `neutral` — closed without a sale to act on (`expired`, `cancelled`,
 *             `refunded`), and any state this console has never heard of. An
 *             unknown state gets the QUIET tone, never a loud one, so a status
 *             invented upstream cannot arrive wearing the alarm colour.
 */
import type { OrderState } from "@urumi.ai/otta-admin-presentation";

import type { StatusTone } from "../ui.js";

const TONES = {
	pending: "warn",
	paid: "ok",
	failed: "fail",
	expired: "neutral",
	processing: "info",
	shipped: "info",
	delivered: "ok",
	completed: "ok",
	cancelled: "neutral",
	refunded: "neutral",
} as const satisfies Record<OrderState, StatusTone>;

export function orderStateTone(state: string): StatusTone {
	return Object.hasOwn(TONES, state) ? (TONES[state as OrderState] ?? "neutral") : "neutral";
}
