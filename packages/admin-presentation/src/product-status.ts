/**
 * How a product's LIFECYCLE and its STOCK read — the two cells whose wording is
 * the same convention, and which INC-21 needed on a second surface.
 *
 * WHY THESE TWO TRAVEL TOGETHER. They are one decision wearing two names:
 * **badge the exceptions, in words, and let the happy path be quiet.** INC-10
 * took that console-wide when it retired the last status pills, and both
 * functions here are it — `active` is one quiet word while every exception is
 * longer and says why (`inactive`, `deleted`, `active (not priced)`,
 * `active (needs a title)`), and a
 * healthy count is a bare number while `0` and a low count carry their own
 * suffix (`0 · Out of stock`, `3 · Low`). Splitting them across two modules
 * would let one drift into a badge while the other stayed prose.
 *
 * WHY THEY MOVED HERE (INC-21). Both lived in `products-page.ts` and were
 * already shared across THREE Block Kit surfaces — the list table, the
 * `Open product` picker and the detail's identity strip — precisely so a
 * product could not read `low` in one place and plain in another. The React
 * Pricing & inventory screen is a fourth surface that cannot import
 * `@urumi.ai/otta-plugin` (ADR-0014 Decision 3), so the only way to keep that
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
 *  the six fields the answer depends on. */
export interface ProductLifecycle {
	readonly active: boolean;
	readonly deletedAt: string | null;
	readonly sku: string | null;
	readonly priceCents: number | null;
	readonly currency: string | null;
	readonly title: string | null;
}

/**
 * Why a product cannot be sold, in rank order. The SAME vocabulary as the
 * domain's `UnsellableReason`.
 */
export type UnsellableReason = "deleted" | "unpublished" | "unpriced" | "untitled";

/**
 * THE SELLABILITY RULE, as the admin reads it (#166): live, priced and titled.
 *
 * It mirrors `unsellableReasons` in `@urumi.ai/otta-domain`, which every sell
 * path applies (storefront, add to cart, quote, `createOrderFromCart`). This
 * package cannot import the domain (it is dependency-free, and the React console
 * may import nothing else), so the rule is restated here and a plugin test
 * (`sellability-parity.test.ts`) holds the two equal over every combination.
 *
 * The one difference is the input: the admin sees a sku as well, and a row with
 * no sku is `unpriced` — the catalog read drops it, so nothing can sell it.
 *
 * Every missing piece is returned, so a surface can say all of why.
 */
export function unsellableReasons(p: ProductLifecycle): UnsellableReason[] {
	if (p.deletedAt !== null) return ["deleted"];
	const reasons: UnsellableReason[] = [];
	if (!p.active) reasons.push("unpublished");
	if (p.sku === null || p.priceCents === null || p.currency === null) reasons.push("unpriced");
	if (p.title === null || p.title === "") reasons.push("untitled");
	return reasons;
}

/**
 * The lifecycle status label a merchant reads: a soft-deleted row shows
 * "deleted", never "inactive" — `deletedAt` outranks `active` (a tombstoned row
 * is always inactive too, but "deleted" is the honest,
 * non-recoverable-from-here status a merchant needs to see).
 *
 * FIVE VALUES: the CMS sync upserts a `product_commerce` row for EVERY products
 * document ("one home per field" PR 1b), so publishing a product that has never
 * been priced sets `active: true` on a row with no sku/price, and a collection
 * whose title field is not `title` leaves the row with no title. A bare
 * "active" on either would be a lie — checkout refuses both — so a published
 * row says what it still needs, price first (the merchant sets it on the same
 * screen), from {@link unsellableReasons}.
 */
export function statusLabel(p: ProductLifecycle): string {
	const reasons = unsellableReasons(p);
	if (reasons[0] === "deleted") return "deleted";
	if (reasons[0] === "unpublished") return "inactive";
	if (reasons[0] === "unpriced") return "active (not priced)";
	if (reasons[0] === "untitled") return "active (needs a title)";
	return "active";
}

/**
 * How loudly a cell has to be drawn — the SAME decision the two label functions
 * above make, exposed as data so a renderer never has to read a phrase back.
 *
 * `plain` is the happy path AND absence, together and on purpose: an unpriced
 * product is an exception with a longer phrase, but an unknown count is not an
 * exception at all, and neither one may be dressed up on arrival.
 */
export type ProductTone = "plain" | "warn" | "fail";

/**
 * The tone of {@link statusLabel}'s answer.
 *
 * IT DERIVES FROM THE RECORD, NEVER FROM THE LABEL. Matching `"deleted"` or
 * testing for `"(not priced)"` in a rendered string would put the wording and
 * the ink one typo apart, and would break the moment a phrase is translated —
 * so both read the same rule and neither reads the other's output.
 *
 * `deleted` is the only irreversible one and is the only `fail`. `inactive`,
 * `active (not priced)` and `active (needs a title)` are all "this product is
 * not being sold", which is a state a merchant may well have chosen, so they
 * warn rather than fail. A sellable `active` is the quiet majority and gets
 * nothing.
 */
export function statusTone(p: ProductLifecycle): ProductTone {
	const reasons = unsellableReasons(p);
	if (reasons[0] === "deleted") return "fail";
	return reasons.length === 0 ? "plain" : "warn";
}

/**
 * The tone of {@link onHandCell}'s answer, on the same three input cases.
 *
 * ABSENCE IS NOT AN EXCEPTION (and this is the one that is easy to get wrong):
 * an unknown count returns `plain`, so the cell stays a bare em dash. Marking it
 * would claim the store had learned something about that sku, when the truth is
 * that it read nothing at all. `0` is the opposite — a fact, and the one that
 * stops a sale — so it is the `fail`. A count at or below the store's threshold
 * warns; a missing threshold costs that band and nothing else, exactly as it
 * costs `onHandCell` its suffix.
 */
export function stockTone(
	onHand: number | null | undefined,
	threshold: number | null,
): ProductTone {
	if (onHand === undefined || onHand === null) return "plain";
	if (onHand <= 0) return "fail";
	if (threshold !== null && onHand <= threshold) return "warn";
	return "plain";
}

/** Human label for the out-of-stock policy (read-only display). Only `"deny"`
 *  exists this slice; any other stored value renders verbatim (forward-safe). */
export function inventoryPolicyLabel(policy: string): string {
	return policy === "deny" ? "Deny (stop selling at zero stock)" : policy;
}
