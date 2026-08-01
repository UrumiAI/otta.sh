/**
 * How a product's LIFECYCLE and its STOCK read — the two cells whose wording is
 * the same convention, and which INC-21 needed on a second surface.
 *
 * WHY THESE TWO TRAVEL TOGETHER. They are one decision wearing two names:
 * **badge the exceptions, in words, and let the happy path be quiet.** INC-10
 * took that console-wide when it retired the last status pills, and both
 * functions here are it — `active` is one quiet word while every exception is
 * longer and says why (`inactive`, `deleted`, `active (not priced)`), and a
 * healthy count is a bare number while `0` and a low count carry their own
 * suffix (`0 · Out of stock`, `3 · Low`). Splitting them across two modules
 * would let one drift into a badge while the other stayed prose.
 *
 * WHY THEY MOVED HERE (INC-21). Both lived in `products-page.ts` and were
 * already shared across THREE Block Kit surfaces — the list table, the
 * `Open product` picker and the detail's identity strip — precisely so a
 * product could not read `low` in one place and plain in another. The React
 * Pricing & inventory screen is a fourth surface that cannot import
 * `@otta-sh/plugin` (ADR-0014 Decision 3), so the only way to keep that
 * property is the way INC-20 kept it for money, dates and short ids: one
 * definition, two importers.
 *
 * IO-FREE — string work only, safe inside the workerd sandbox (G7) and in a
 * browser.
 */
import { ABSENT } from "./copy.js";

/** The `On hand` cell for a row with no readable count. Also what the detail's
 *  `Stock on hand` shows when the sku carries no inventory record. */
export const ON_HAND_UNKNOWN = ABSENT;

/** The suffix a zero count carries. `0` is a FACT, not a missing value, and the
 *  word is what keeps it from reading as one. */
export const OUT_OF_STOCK_SUFFIX = "Out of stock";

/** The suffix a count at or below the store's low-stock threshold carries. */
export const LOW_STOCK_SUFFIX = "Low";

/**
 * The `On hand` cell — text, always, and never an empty string.
 *
 * THE BLOCK KIT CONSTRAINT THAT SHAPED IT, kept here because it is the reason
 * the return type is a string rather than a number plus a band: the pinned
 * renderer's `format:"number"` cell does `Number(value)` and prints the RAW
 * string only when that is NaN (`blocks/table.tsx`), so `"—"` and
 * `"0 · Out of stock"` survive verbatim, `"12"` renders as a number, and `""`
 * or a missing key would render as `0` — a zero nobody counted. The React tier
 * has no such constraint and renders the same string anyway: an operator
 * comparing the two screens must not have to work out whether two different
 * renderings mean the same thing.
 *
 * THREE INPUT CASES, NEVER FOLDED INTO EACH OTHER:
 *  - a number — a known count, `0` included;
 *  - `null` — the sku carries no inventory record, so the count is unknown for
 *    this row (and a row with no sku at all can have nothing else);
 *  - `undefined` — the response carried no stock figure at all (a service older
 *    than the on-hand projection, or one whose stock read degraded).
 *
 * A missing `threshold` costs the `Low` band and nothing else: a count still
 * renders and `0` still reads `Out of stock`, neither of which needs one.
 */
export function onHandCell(onHand: number | null | undefined, threshold: number | null): string {
	if (onHand === undefined || onHand === null) return ON_HAND_UNKNOWN;
	if (onHand <= 0) return `${onHand} · ${OUT_OF_STOCK_SUFFIX}`;
	if (threshold !== null && onHand <= threshold) return `${onHand} · ${LOW_STOCK_SUFFIX}`;
	return String(onHand);
}

/** The lifecycle facts `statusLabel` reads. A structural subset on purpose:
 *  both surfaces hold their own wire type for a product, and this names only
 *  the five fields the answer depends on. */
export interface ProductLifecycle {
	readonly active: boolean;
	readonly deletedAt: string | null;
	readonly sku: string | null;
	readonly priceCents: number | null;
	readonly currency: string | null;
}

/**
 * The lifecycle status label a merchant reads: a soft-deleted row shows
 * "deleted", never "inactive" — `deletedAt` outranks `active` (a tombstoned row
 * is always inactive too, but "deleted" is the honest,
 * non-recoverable-from-here status a merchant needs to see).
 *
 * FOUR VALUES: the CMS sync upserts a `product_commerce` row for EVERY products
 * document ("one home per field" PR 1b), so publishing a product that has never
 * been priced sets `active: true` on a row with no sku/price. A bare "active"
 * there would be a lie — the service's catalog read filters commerce-incomplete
 * rows — so this mirrors that exact filter.
 */
export function statusLabel(p: ProductLifecycle): string {
	if (p.deletedAt !== null) return "deleted";
	if (!p.active) return "inactive";
	const sellable = p.sku !== null && p.priceCents !== null && p.currency !== null;
	return sellable ? "active" : "active (not priced)";
}

/** Human label for the out-of-stock policy (read-only display). Only `"deny"`
 *  exists this slice; any other stored value renders verbatim (forward-safe). */
export function inventoryPolicyLabel(policy: string): string {
	return policy === "deny" ? "Deny (stop selling at zero stock)" : policy;
}
