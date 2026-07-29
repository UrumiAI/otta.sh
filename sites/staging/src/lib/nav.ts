/**
 * Nav helpers for the site chrome (src/layouts/Base.astro).
 *
 * The primary menu is CMS-authored, so the layout cannot assume any particular
 * spelling of a URL: it has to RECOGNISE the cart entry rather than be told
 * which one it is. That recognition is the sort of thing that breaks quietly —
 * the badge just stops appearing — so it lives here as a plain function the
 * test can import and exercise directly.
 */

/** The shape the layout renders a nav entry from — the fields it reads off
 *  em-dash's own `MenuItem`, and no more, so the fallback below can satisfy it
 *  without pretending to be a CMS record. */
export interface NavItem {
	label: string;
	url: string;
}

/**
 * The nav the layout renders when the content store cannot be reached.
 *
 * These are not a guess at what the operator configured — they are the routes
 * THIS THEME defines (`src/pages/index.astro`, `products/index.astro`,
 * `cart/index.astro`), so they resolve whatever the content store is doing.
 * That is the whole justification for substituting them: a shopper whose visit
 * runs into an outage keeps a way to the shop and to their cart, rather than
 * being left on a page with a wordmark and no exits.
 *
 * They are used ONLY on a thrown read. A menu that comes back empty or `null`
 * is an operator's answer, not a failure, and it stands.
 *
 * The labels match the seeded menu on purpose, so the chrome does not visibly
 * change wording halfway through an outage.
 */
export const FALLBACK_MENU_ITEMS: readonly NavItem[] = [
	{ label: "Home", url: "/" },
	{ label: "Shop", url: "/products" },
	{ label: "Cart", url: "/cart" },
];

/**
 * Does this menu URL point at the cart? Tolerates the query string, the
 * fragment and a trailing slash, all of which are legal things for an editor
 * to type into the menu.
 */
export function isCartLink(url: string): boolean {
	const path = url.split(/[?#]/)[0] ?? "";
	return path.replace(/\/+$/, "") === "/cart";
}

/**
 * The accessible name for the cart badge. The badge renders as "(3)", which a
 * screen reader announces as "left paren three right paren"; this is what it
 * says instead.
 */
export function cartCountLabel(count: number): string {
	return count === 1 ? "1 item" : `${count} items`;
}
