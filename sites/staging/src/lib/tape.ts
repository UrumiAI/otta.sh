/**
 * The home hero's inventory tape, and the catalog counts that go with it
 * (docs/theme/TEMPERED.md §7, §8, §10).
 *
 * The tape is the one place in the theme where a page turns a list of view
 * models into rows of its own, and the counts are the one place a page states a
 * figure the store did not hand it. Both have honesty rules that are easy to
 * get wrong in `.astro` frontmatter and impossible to unit-test there, so they
 * live here — the pattern `totals.ts`, `hold.ts` and `coil.ts` already set.
 *
 * Pure and IO-free: a page calls these at render time, a test calls them
 * without a CMS, a commerce service or a DOM.
 */
import type { ProductViewModel } from "@urumi/plugin";

/**
 * How many rows the hero tape shows.
 *
 * The tape is a HERO, not the catalog: six rows is the deepest the mockup's
 * hero column runs before the shop link falls below the fold, and a store with
 * forty products would otherwise push its own call to action off the screen.
 * The link carries the count when the count is known, so nothing is hidden.
 */
export const TAPE_ROWS = 6;

/**
 * How many products the home page asks the CMS for.
 *
 * Twice the rows, and no more. The home page is the site's most-hit page and
 * every product it fetches is a row joined against the commerce store, so
 * fetching the full page cap to render six rows costs eight joins nobody
 * reads. The ×2 slack is for unpriced products, which the tape drops: a store
 * where half the catalog has no price still fills the tape from one fetch.
 *
 * The cost of the small fetch is that the home page can rarely state an exact
 * catalog count — see `exactCount`, which then makes it say no number at all.
 */
export const TAPE_FETCH_LIMIT = TAPE_ROWS * 2;

/** The name a store falls back to when it has neither tagline nor title. */
export const FALLBACK_THESIS = "Urumi";

export interface TapeRow {
	/** The sku — the store's own name for the thing. A product with no
	 *  commerce row never reaches this list, so the title fallback is a
	 *  belt-and-braces for a priced product whose sku is somehow absent. */
	item: string;
	/** Pre-formatted, straight off the view model. Never assembled (§7). */
	price: string;
	/** The availability TOKEN in words. The view model carries no count, so the
	 *  tape states the fact it actually has rather than the mockup's "12 in
	 *  stock" — §7's spirit: never render a figure the store did not quote. */
	stock: string;
	/**
	 * Drives the struck-and-muted price cell, the same signal `PriceTag` gives
	 * a sold-out card.
	 *
	 * The rows are NOT reordered to push sold-out products to the end: the tape
	 * is the shelf in the order the catalog lists it, and a shopper who saw a
	 * product third on the home page and second on the shop page would be right
	 * to wonder which one is the store. The strike carries the state instead.
	 */
	soldOut: boolean;
}

/**
 * Only a product the store can actually sell gets a row: it is an INVENTORY
 * tape, and an unpriced product has no price cell to fill. §7 forbids inventing
 * one, and a dash in a money column is indistinguishable from free.
 *
 * `flatMap` rather than `filter` + `map` because a filter does not narrow
 * `price` for the mapping step that follows it.
 */
export function tapeRows(
	view: readonly ProductViewModel[] | null,
	limit: number = TAPE_ROWS,
): TapeRow[] {
	return (view ?? [])
		.flatMap((product) =>
			product.purchasable && product.price !== null
				? [
						{
							item: product.sku ?? product.title,
							price: product.price.formatted,
							stock: product.availability === "in_stock" ? "In stock" : "Sold out",
							soldOut: product.availability !== "in_stock",
						},
					]
				: [],
		)
		.slice(0, Math.max(0, limit));
}

/**
 * How many products the store has — or `null` when the page cannot know.
 *
 * A page fetches a bounded window of the catalog, so the length of what came
 * back is a count of the WINDOW, not of the store. It is the store's count only
 * when the window did not fill: fewer rows than were asked for means there were
 * no more to give. A full window means "at least this many", and printing that
 * as "48 items" under a shop that has 900 is a lie the shopper cannot catch.
 *
 * `hasMore` (set by the loader whenever a limit was passed) can only VETO a
 * number here, never add one. It is a second opinion, and the conservative
 * combination means a wrong `hasMore` costs a number rather than the truth.
 */
export function exactCount(fetched: number, limit: number, hasMore?: boolean): number | null {
	if (hasMore === true) return null;
	return fetched < limit ? fetched : null;
}

/** `n items`, singular at one. `null` in — an unknown count — `null` out, and
 *  the caller renders no eyebrow rather than an empty one. */
export function itemCountLabel(count: number | null): string | null {
	if (count === null) return null;
	return count === 1 ? "1 item" : `${count} items`;
}

/**
 * The home page's call to action.
 *
 * It carries the count when the count is exact, because "Shop all 3 items" tells
 * a shopper the size of the shop before they spend a click on it. With the count
 * unknown it says "Shop everything" — the same promise, minus the figure. At one
 * item or none a number is noise, so it is simply "Shop".
 */
export function shopLinkLabel(count: number | null): string {
	if (count === null) return "Shop everything";
	return count > 1 ? `Shop all ${count} items` : "Shop";
}

/** The subset of EmDash site settings the home page reads. */
export interface StoreSettings {
	title?: string | undefined;
	tagline?: string | undefined;
}

/** A setting the operator left blank is the same as one they never set. A
 *  `??` chain disagrees — `""` is not nullish — and an operator who clears the
 *  tagline field gets the biggest type on the site rendering nothing. */
function filled(value: string | undefined): string {
	return (value ?? "").trim();
}

/**
 * The line the home page sets in its loudest type.
 *
 * The store's own tagline where it has one; its name where it does not — the
 * wordmark above already carries the name, so repeating it there wastes the
 * page's biggest type on a word the shopper just read, but a nameless headline
 * is worse.
 */
export function storeThesis(settings: StoreSettings): string {
	return filled(settings.tagline) || filled(settings.title) || FALLBACK_THESIS;
}

/** The `<title>` the page sets. */
export function storeTitle(settings: StoreSettings): string {
	return filled(settings.title) || FALLBACK_THESIS;
}

/** The meta description, or `undefined` — a blank tagline must not become a
 *  `<meta content="">`, which is worse for a search engine than no tag. */
export function storeDescription(settings: StoreSettings): string | undefined {
	return filled(settings.tagline) || undefined;
}
