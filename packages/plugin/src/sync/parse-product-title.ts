import { toWellFormedText } from "@urumi.ai/otta-domain";

/** Mirrors the `upsertProductCommerceBody.title` bound
 *  (`z.string().min(1).max(500)`) that the standalone `@otta-sh/service`
 *  enforced before it was folded into the plugin; restated as a constant here
 *  since no schema package survives to import it from. */
const TITLE_MAX_LENGTH = 500;

/** The outcome of validating a product title: a value fit to send, or a
 *  developer-facing reason it is not (which the caller LOGS — it never blocks
 *  the upsert; see `parseProductTitle`).
 *
 *  `rejection` (issue #112) is present when the record HAS a title that cannot
 *  be stored — over-long, blank, or not text. It is the merchant-facing reason
 *  the sync records on the commerce row, which clears the stale stored title.
 *  It is absent when the record carries no title at all: absence says nothing
 *  about the name, so the stored title is preserved. */
export type ParsedProductTitle = { title: string } | { problem: string; rejection?: string };

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
 * unusable title never withholds the upsert; the row itself is still
 * created/refreshed. An ABSENT title omits only itself; a PRESENT but unusable
 * one is sent as a `rejection` instead (issue #112), so the store clears the
 * stale title rather than keeping a name the storefront no longer shows. Vetoing the whole upsert would mean any collection whose
 * title field is absent or named something other than `title` silently loses
 * ALL commerce sync — a far worse failure than an untitled (and therefore
 * unpurchasable) product. Omitting an absent title is also safe against data
 * loss: the store PRESERVES a stored title when neither field is in the body, so
 * absence can never blank a good one.
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
		return {
			problem: `\`data.title\` is ${typeof value}, not a string`,
			rejection: `The title is not text (it is ${article(typeof value)}).`,
		};
	}
	// REPAIRED, not refused (review R3-B X1): the title is the CMS's text, already
	// saved there, and this hook cannot send the editor back to fix it. A lone
	// surrogate or NUL becomes U+FFFD — the one form Postgres can store — instead
	// of failing the whole sync at the commerce boundary, which refuses it.
	const title = toWellFormedText(value.trim());
	if (title.length === 0) {
		return { problem: "`data.title` is empty/whitespace", rejection: "The title is blank." };
	}
	if (title.length > TITLE_MAX_LENGTH) {
		return {
			problem: `\`data.title\` is ${title.length} characters; the service accepts at most ${TITLE_MAX_LENGTH}`,
			rejection: `The title is ${title.length} characters long; the most it can be is ${TITLE_MAX_LENGTH}.`,
		};
	}
	return { title };
}

/** "a number", "an object" — the `typeof` name with its article. */
function article(typeName: string): string {
	return /^[aeiou]/.test(typeName) ? `an ${typeName}` : `a ${typeName}`;
}
