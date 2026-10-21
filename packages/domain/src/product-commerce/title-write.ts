import type { UpsertProductCommerceInput } from "../ports/product-commerce-store.js";

/** The two columns a content-sync title write moves together. */
export interface TitleState {
	readonly title: string | null;
	readonly titleRejection: string | null;
}

/** A row with no title written yet — what a CREATE resolves against. */
export const NO_TITLE: TitleState = { title: null, titleRejection: null };

/**
 * How an upsert moves `title` and `titleRejection` (issue #112). One function so
 * every store applies the same rule:
 *
 *  - a REJECTION clears the title and records the reason: the CMS has a name the
 *    store cannot hold, so the previous one is stale and must stop being what an
 *    order line snapshots;
 *  - an accepted title is stored and clears any rejection;
 *  - an explicit `null` title clears the title and leaves a rejection as it was;
 *  - neither field present preserves both — absence says nothing about the name,
 *    so it never blanks a good stored title.
 *
 * A rejection wins if a caller sends both; the plugin never does.
 */
export function resolveTitleWrite(
	input: Pick<UpsertProductCommerceInput, "title" | "titleRejection">,
	stored: TitleState,
): TitleState {
	if (input.titleRejection !== undefined) {
		return { title: null, titleRejection: input.titleRejection };
	}
	if (typeof input.title === "string") return { title: input.title, titleRejection: null };
	if (input.title === null) return { title: null, titleRejection: stored.titleRejection };
	return { title: stored.title, titleRejection: stored.titleRejection };
}
