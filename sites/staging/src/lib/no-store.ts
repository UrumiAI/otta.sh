/**
 * Keep ONE response private: `Cache-Control: private, no-store`, and out of Astro's
 * route cache.
 *
 * For a page whose response depends on — or acts on — a shopper's own cookies. The
 * header keeps it out of HTTP caches; the route cache (e.g. Workers Cache) ignores
 * that header and takes its options from `cache.set`, so the page opts out there
 * too (the reasoning is middleware.ts's "TWO CACHES"). The order confirmation needs
 * it whenever it deletes a spent cart's cookie: a stored copy of that response
 * would delete the next shopper's cart. With no cache provider configured,
 * `cache` is absent or a no-op.
 */
export const PRIVATE_NO_STORE = "private, no-store";

export interface PrivatePage {
	response: { headers: Headers };
	cache?: { set(options: false): void };
}

export function keepPrivate(page: PrivatePage): void {
	page.response.headers.set("Cache-Control", PRIVATE_NO_STORE);
	page.cache?.set(false);
}
