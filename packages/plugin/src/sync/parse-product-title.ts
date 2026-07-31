/** Mirrors `@otta-sh/service`'s `upsertProductCommerceBody.title` bound
 *  (`z.string().min(1).max(500)`) — the plugin declares no dependency on the
 *  service package, so the bound is restated here, not imported. */
const TITLE_MAX_LENGTH = 500;

/** The outcome of validating a product title: a value fit to send, or a
 *  human-readable reason it is not (which the caller LOGS — it never blocks the
 *  upsert; see `parseProductTitle`). */
export type ParsedProductTitle = { title: string } | { problem: string };

/**
 * Validate the product title an order line will snapshot.
 *
 * WHERE THE VALUE COMES FROM: `content.data.title`. em-dash's `ContentItem` has
 * NO top-level `title` — `mapRow()` copies every column that is not in
 * `SYSTEM_COLUMNS` into `data`, and `title` is an ordinary user-defined
 * collection field. The caller (`sync/hooks.ts`) owns that read; this function
 * owns the RULES. It lives in `sync/` because the title projection is now the
 * ONLY thing the CMS sync carries — commercial fields moved to Pricing &
 * inventory ("one home per field", PR 1b), and the widget-bag validator this
 * function used to share a module with is deleted.
 *
 * BEST-EFFORT BY DESIGN — the caller must never treat a `problem` as fatal. An
 * unusable title omits ONLY the title from the upsert; the row itself is still
 * created/refreshed. Vetoing the whole upsert would mean any collection whose
 * title field is absent or named something other than `title` silently loses
 * ALL commerce sync — a far worse failure than an untitled (and therefore
 * unpurchasable) product. Omitting is also safe against data loss: the store
 * PRESERVES a stored title when the field is absent from the body, so this can
 * never blank a good one.
 *
 * Nor is the raw value ever sent as-is: `""` and an over-long string are both
 * 400s at the service, and a 400 is a TRANSPORT failure — which at
 * `content:afterPublish` fails closed and skips the activate. A content problem
 * must never masquerade as a transport problem.
 */
export function parseProductTitle(value: unknown): ParsedProductTitle {
	if (value === undefined || value === null) {
		return { problem: "no `title` field on the content record (expected `data.title`)" };
	}
	if (typeof value !== "string") {
		return { problem: `\`data.title\` is ${typeof value}, not a string` };
	}
	const title = value.trim();
	if (title.length === 0) return { problem: "`data.title` is empty/whitespace" };
	if (title.length > TITLE_MAX_LENGTH) {
		return {
			problem: `\`data.title\` is ${title.length} characters; the service accepts at most ${TITLE_MAX_LENGTH}`,
		};
	}
	return { title };
}
