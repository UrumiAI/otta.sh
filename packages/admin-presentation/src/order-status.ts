/**
 * The order-status vocabulary — the words BOTH admin surfaces put on screen.
 *
 * WHY IT LIVES HERE RATHER THAN ON A SCREEN. It arrived in `orders-page.ts` and
 * was correct there while there was one Orders screen. INC-20 gives the console
 * a second one (the React tier, `@otta-sh/admin-react`), and the two are the
 * same screen to an operator: they read the same list, one is reachable from the
 * other's sidebar, and a state that says `cancelled · closed` on one and
 * `cancelled` on the other is precisely the list/detail disagreement INC-13
 * spent an increment closing for `Placed`. A shared constant makes the drift
 * impossible rather than tested-for.
 *
 * The React package cannot import `@otta-sh/plugin` at all
 * (`console-imports-no-workspace-package` — ADR-0014 Decision 3 gives the
 * console exactly one data path), so "share it" means "extract it", and this
 * package is where the extraction lands.
 */

/**
 * The ten order states, and the ONE source the per-state transition ids and the
 * Block Kit dispatcher's registration are both derived from (DA-6).
 *
 * WHY THIS MATTERS: `ORDERS_ACTION_IDS` is fixed at module load, `admin-route.ts`
 * dispatches on set membership, and an unmatched id falls through to
 * `{blocks: []}` — a BLANK console. Offered transitions come from the SERVICE
 * (`detail.allowedTransitions`), so a service offering a state this plugin has
 * never heard of would render a button that blanks the page. Hence: the ids come
 * from this list, `customActions` comes from this list, and the screens DROP
 * anything outside it.
 */
export const ORDER_STATES = [
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
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_STATE_SET: ReadonlySet<string> = new Set(ORDER_STATES);

/**
 * THE ORDER-STATE EXCEPTIONS — the four states `ORDER_STATE_MACHINE`
 * (`domain/src/orders/state-machine.ts`) gives NO legal outbound transition:
 * `failed: [] · expired: [] · cancelled: [] · refunded: []`. This is not an
 * editorial pick of "the bad ones"; it is that table read out loud, which is
 * also why `completed` is NOT here — a completed order can still be refunded,
 * so it is not a dead end.
 *
 * Neither consumer can IMPORT the machine — `@otta-sh/domain` is a
 * devDependency of the plugin (the published plugin has no runtime dependency
 * on it) and is forbidden outright to the console — so the set is restated
 * here, once, against the citation above. New states are absent from it by
 * default, which is the safe direction: an unrecognised state renders as a bare
 * word rather than silently acquiring the loudest rendering on the screen.
 */
export const TERMINAL_ORDER_STATES: ReadonlySet<string> = new Set([
	"failed",
	"expired",
	"cancelled",
	"refunded",
]);

/**
 * EVERY SURFACE THAT RENDERS AN ORDER STATE AS A VALUE READS THROUGH THIS
 * (INC-10): on Block Kit the list row, the customer's other-orders table, the
 * identity strip and the timeline's `Status → …`; on the React console the same
 * four. One vocabulary, so a state cannot say one thing on the list and another
 * one click away — or one thing on one surface and another on the other.
 *
 * ONE SURFACE IS DELIBERATELY EXCLUDED, AND IT SITS ON THE SAME RESPONSE AS THE
 * FIRST: the Block Kit drill-in picker's option label. That label is a
 * ` · `-joined 4-tuple, so a marked state would silently make it a 5-tuple — the
 * exact ambiguity `products-page.ts` avoids by keeping `active (not priced)` in
 * parentheses rather than spelling it with a middot. A picker option is a
 * CHOOSER, not a rendering of the record: the row directly above it carries the
 * marked value. The suite pins that segment BARE so the exclusion cannot be
 * "fixed" into ambiguity. (The React screen has no picker at all — INC-20
 * deletes it — so the exclusion is Block Kit's alone.)
 *
 * BADGE THE EXCEPTIONS, PLAIN-TEXT THE HAPPY PATH — done in WORDS, because the
 * Block Kit renderer cannot do it in ink. `format` is a property of the COLUMN,
 * not of a cell (`blocks/table.tsx`'s `formatCell` reads `col.format`), so a
 * table badges every row of a column or none of them; and blanking the
 * happy-path cell to fake the split is worse than either end, because `Badge`
 * draws its pill from padding and a radius alone — an empty cell in a badge
 * column is a solid mark with no word in it. Column-level badging is not merely
 * a compromise either, it is a defect waiting for an operator: filter this list
 * to `paid` and every row carries the same value, which is exactly the column
 * X-4 (T-5) rejects as decoration.
 *
 * REACT COULD DRAW THE INK, AND STILL DOES NOT. The React tier has per-cell
 * control and could badge exactly the four exceptions. It renders the same
 * words anyway, because the words are the decision and the ink was never the
 * point: `cancelled · closed` states the fact the state machine guarantees, and
 * an operator comparing the two surfaces during the migration must not have to
 * work out whether a pill and a phrase mean the same thing. The React screen
 * spends its extra expressiveness on the affordance Block Kit could not have at
 * all — a copy button — not on re-litigating settled copy.
 *
 * WHAT THE EXCEPTION SAYS. Not a restatement of the word already in the cell,
 * and not a claim the console cannot stand behind (`refunded` is a bookkeeping
 * disposition here — it "does not move money" — so a cell reading
 * `refunded · money returned` would be false). It says the one thing the state
 * machine guarantees: the order is CLOSED, no further status change is possible
 * from it. Two facts in a cell of one word is also the visual weight a badge
 * was reaching for: in a column of bare words, the long cells are the marks.
 */
export function orderStateCell(state: string): string {
	return TERMINAL_ORDER_STATES.has(state) ? `${state} · closed` : state;
}

/**
 * The identity strip's `Reconciliation` value — `None`, a warning, or the
 * recorded disposition.
 *
 * Shared for the same reason `orderStateCell` is: both admin surfaces render
 * this field, from the same two wire values, and an operator comparing them
 * during the migration must not have to decide whether two different phrasings
 * mean the same thing. Takes primitives so this module stays free of wire types.
 */
export function reconciliationSummary(flag: string | null, resolvedOutcome: string | null): string {
	if (flag !== null) return "\u26a0 Needs reconciliation";
	if (resolvedOutcome !== null) return `Resolved (${resolvedOutcome})`;
	return "None";
}
