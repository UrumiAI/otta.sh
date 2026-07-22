import type { BannerBlock, BlockResponse } from "../../types.js";

/**
 * Consistent banner / fail-closed rendering for admin list/detail screens.
 *
 * Every screen surfaces the same two shapes: a {@link Notice} above a detail
 * view after a side effect (an `error` on failure, a non-error `default` on a
 * no-op), and a {@link failClosedResponse} when a read cannot reach the
 * service. Both emit em-dash's AUTHORITATIVE `{variant, title, description}`
 * banner shape (MOD-3) — never the legacy `{text}` shape the production
 * renderer drops — and NEVER echo a raw HTTP status/URL into the admin UI.
 */

/** A banner surfaced above a detail view after an action attempt. `variant`
 *  uses em-dash's banner union: `error` on failure, `default` on a no-op. */
export interface Notice {
	variant: "default" | "error";
	title: string;
	description: string;
}

export function noticeBanner(notice: Notice): BannerBlock {
	return {
		type: "banner",
		variant: notice.variant,
		title: notice.title,
		description: notice.description,
	};
}

export interface FailClosedOptions {
	/** The page header text (kept identical to the healthy view's header so the
	 *  screen shell does not visibly flip). */
	header: string;
	title: string;
	description: string;
	/** Optional toast message; emitted as an `error` toast when present. */
	toast?: string;
}

/** Fail CLOSED with a generic, em-dash-correct banner — never leaks a raw HTTP
 *  status/URL (e.g. an auth 401 from a missing/expired admin token). */
export function failClosedResponse(opts: FailClosedOptions): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: opts.header },
			{ type: "banner", variant: "error", title: opts.title, description: opts.description },
		],
		...(opts.toast !== undefined ? { toast: { message: opts.toast, type: "error" as const } } : {}),
	};
}
