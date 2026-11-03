/**
 * The store's own words — its name and tagline from EmDash's site settings —
 * read by ONE set of rules wherever a page needs them: the home page's
 * headline, its meta description, and the store name every page's `<title>`
 * and wordmark carry (`layouts/Storefront.astro`). They lived in `tape.ts`
 * while only the home page read them; the shell reading `storeTitle` too is
 * why they are a module of their own.
 *
 * Pure and IO-free: the caller reads the settings (and guards that read).
 */

/** The name a store falls back to when it has neither tagline nor title. */
export const FALLBACK_THESIS = "Otta";

/** The subset of EmDash site settings the storefront reads. */
export interface StoreSettings {
	title?: string | undefined;
	tagline?: string | undefined;
}

/** A setting the operator left blank is the same as one they never set. A
 *  `??` chain disagrees — `""` is not nullish — and an operator who clears the
 *  tagline field gets the biggest type on the site rendering nothing.
 *
 *  Format characters go before the trim, not after: `trim` strips whitespace,
 *  and a zero-width space (U+200B) is not whitespace. A field cleared by
 *  selecting and deleting in a rich editor routinely keeps one behind, and it
 *  would otherwise be a "set" tagline that renders as an empty `<h1>` — the
 *  exact bug this function exists to prevent, arriving by another door. */
function filled(value: string | undefined): string {
	return (value ?? "").replace(/\p{Cf}/gu, "").trim();
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

/** The store's name: the home page's `<title>` and the suffix on every other
 *  page's. A blank or unset setting falls back to "Otta", the same name the
 *  home page shows, so the two can never disagree. */
export function storeTitle(settings: StoreSettings): string {
	return filled(settings.title) || FALLBACK_THESIS;
}

/** The meta description, or `undefined` — a blank tagline must not become a
 *  `<meta content="">`, which is worse for a search engine than no tag. */
export function storeDescription(settings: StoreSettings): string | undefined {
	return filled(settings.tagline) || undefined;
}
