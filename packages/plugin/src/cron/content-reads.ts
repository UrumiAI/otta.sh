/**
 * What a CMS read through `ctx.content` costs the tick, and how the host refuses
 * one. Shared by the sweep legs that walk the CMS (`product-orphans`,
 * `product-reconcile`), so the counting context and the legs that size their units
 * by these numbers cannot disagree.
 */

/**
 * What ONE `ctx.content.get` costs, in D1 queries, on either EmDash path: the row
 * read, then — only when there IS a document — whether the collection has SEO
 * enabled and, when it does, the document's SEO row. So a miss is exactly ONE query
 * (trusted `findById` returns before the SEO reads; the sandbox bridge makes one
 * query, full stop) and a hit is at most THREE.
 *
 * The counting context charges it that way: `CONTENT_MISS_QUERIES` before the call
 * (so the ceiling refuses it whole) and the rest after a document comes back. The
 * leg always checks `CONTENT_READ_QUERIES` are left before a read, so the second
 * half always fits. A confirming re-read of a missing row therefore costs one query.
 */
export const CONTENT_READ_QUERIES = 3;
export const CONTENT_MISS_QUERIES = 1;

/**
 * What ONE `ctx.content.list` is charged. EmDash's trusted `findMany` runs the page
 * query AND an unbounded `COUNT(*)` (in parallel — two queries), then, with any
 * item, whether the collection has SEO enabled and the page's SEO rows: four. The
 * sandbox bridge's `contentList` is one query; the worst case is charged.
 */
export const CONTENT_LIST_QUERIES = 4;

/** The host's refusal of a page cursor it cannot decode. It does not export the
 *  class, so it is matched by name, like `StorageQueryError`. */
export function isInvalidCursorError(err: unknown): boolean {
	return err instanceof Error && err.name === "InvalidCursorError";
}
