/**
 * Decisions the `/checkout` review page makes about what it prints — kept here,
 * beside their tests, because `.astro` pages have no render harness in this
 * package.
 */

/**
 * The `?error=` the review may show. Once the cart has become an order the
 * review is LOCKED to it, and a place-time refusal in the URL (an invalid email,
 * a stale page, a coupon) describes a form that is no longer on the page —
 * typically the history entry Back returns to from the pay page. Showing it over
 * a locked order would explain a mistake the buyer can no longer make, so the
 * locked review shows none.
 */
export function reviewErrorToken(error: string | null, locked: boolean): string | null {
	if (error === null || error.length === 0) return null;
	return locked ? null : error;
}
