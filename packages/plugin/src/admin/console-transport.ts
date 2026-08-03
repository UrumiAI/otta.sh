/**
 * What EVERY React-console screen's branch on the `otta` admin route shares —
 * the two interaction types, the refusal shape, and the reading of an untrusted
 * write payload.
 *
 * WHY IT EXISTS (INC-21). INC-20 wrote all of this inside
 * `orders-console-route.ts`, correctly: there was one console screen, and a
 * shared module for one caller is a guess about the future. INC-21 migrated
 * Pricing & inventory and made it two, and the alternative to this file is a
 * `products-console-route.ts` that either imports its interaction constants from
 * a file named `orders-…` (saying something false about how the two screens
 * relate) or restates them (two definitions of the string the dispatcher routes
 * on, which is the one string that MUST be identical for either screen to be
 * reachable at all).
 *
 * THE BLOCK-TREE HALF IS GONE (INC-R4). This module used to hold the other side
 * of a console write as well: a forwarder that drove a Block Kit page handler
 * with a synthesized interaction, the carrier mint that shaped a form submit for
 * it, the banner scrape that read the outcome back out of the rendered blocks,
 * and the empty-tree refusal that stood in for "nothing applied". Both consoles
 * now dispatch to structured actions (`orders-actions.ts`, `products-actions.ts`)
 * that RETURN an outcome, so nothing drives a renderer and none of that had a
 * caller left. ADR-0015 Decision 1 put the removal in its own change once no
 * caller remained; this is that change. What stays is what both tiers must agree
 * on — the two interaction types, the refusal shape, the refusal constants and
 * {@link readConsolePayload}.
 *
 * G5 APPLIES UNCHANGED, one tier up: every response is HTTP 200 with an outcome
 * in the body. A refusal is a value.
 */
import { asRecord, readString } from "./scaffold/index.js";

/**
 * The interaction types the console answers to.
 *
 * Deliberately NOT `page_load` / `block_action` / `form_submit`: those belong to
 * EmDash's `SandboxedPluginPage` transport and the Block Kit screens keep them
 * exclusively. A disjoint pair means the dispatcher can never confuse a console
 * request with an admin-shell one, and — the reason that matters — it means
 * nothing the console does can change what a Block Kit screen renders. ADR-0014
 * requires every migrated screen's original to keep working until its
 * replacement is proven; two disjoint interaction types is that requirement
 * expressed in the dispatch table.
 */
export const CONSOLE_READ_INTERACTION = "otta_console_read";
export const CONSOLE_ACT_INTERACTION = "otta_console_act";

/** The interaction types the dispatcher routes to a console branch. Exported so
 *  `admin-route.ts` and its suite name the same two strings. */
export const CONSOLE_INTERACTIONS: ReadonlySet<string> = new Set([
	CONSOLE_READ_INTERACTION,
	CONSOLE_ACT_INTERACTION,
]);

/** A refusal the console renders instead of a blank pane (G5's reasoning, one
 *  tier up): the request completed, the answer is "no", and it says why. */
export interface ConsoleFailure {
	readonly ok: false;
	readonly title: string;
	readonly description: string;
}

export const UNREADABLE_REQUEST: ConsoleFailure = {
	ok: false,
	title: "That request could not be read",
	description:
		"The console asked for something this screen does not serve. Reload the page; if it happens again, this is a fault in the console itself.",
};

/** An action id the screen's own action table does not carry, or one the
 *  console is not allowed to ask for. Reachable from a stale tab after a deploy
 *  that renamed one, and from a console bug — never from a button this release
 *  rendered. */
export const UNKNOWN_ACTION: ConsoleFailure = {
	ok: false,
	title: "Nothing was changed",
	description:
		"This console asked for an action this screen does not offer. Nothing was applied. Reload the page; if it happens again, this is a fault in the console itself.",
};

/** A console write's payload: the flat string record the React button carried.
 *  Untrusted, exactly as anything else arriving off the wire is. */
export type ConsolePayload = Readonly<Record<string, string>>;

/** Read a console write's flat string payload out of an untrusted request. A
 *  non-string value is DROPPED rather than coerced: everything a console button
 *  carries is already a string on the wire (money as its integer minor-unit
 *  string, counts as digits), so a number arriving here is a console bug and
 *  must not be laundered into one. */
export function readConsolePayload(raw: unknown): ConsolePayload {
	const record = asRecord(raw);
	if (record === undefined) return {};
	const payload: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		const text = readString(value);
		if (text !== undefined) payload[key] = text;
	}
	return payload;
}
