/**
 * What EVERY React-console screen's branch on the `otta` admin route shares —
 * the two interaction types, the refusal shape, and the one way a console click
 * reaches a Block Kit write handler.
 *
 * WHY IT EXISTS (INC-21). INC-20 wrote all of this inside
 * `orders-console-route.ts`, correctly: there was one console screen, and a
 * shared module for one caller is a guess about the future. INC-21 migrates
 * Pricing & inventory and makes it two, and the alternative to this file is a
 * `products-console-route.ts` that either imports its interaction constants and
 * its `firstNotice` from a file named `orders-…` (saying something false about
 * how the two screens relate) or restates them (two definitions of the string
 * the dispatcher routes on, which is the one string that MUST be identical for
 * either screen to be reachable at all).
 *
 * NOTHING HERE CHANGES WHAT INC-20 SHIPPED. Every constant is byte-identical to
 * the one it replaced; `orders-console-route.ts` imports and re-exports them so
 * `admin-route.ts` and the INC-20 sandbox suite see the surface they already
 * saw. The one generalization is {@link nothingApplied}, which takes the noun
 * for the record being written — "Reload the order" on Orders, "Reload the
 * product" on Pricing & inventory — because a refusal that tells an operator to
 * reload the wrong thing is worse than one that says nothing.
 *
 * FOUR SYMBOLS BELOW HAVE NO CALLERS AS OF INC-R3, AND ARE RETAINED ON PURPOSE.
 * {@link firstNotice}, {@link forwardConsoleAct}, {@link forwardedFormSubmit}
 * and {@link nothingApplied} are the block-tree half of this module — the
 * forwarder, the carrier mint, the banner scrape and the empty-tree refusal —
 * and both consoles have now been extracted onto structured actions, so nothing
 * drives a Block Kit handler any more. They are DEAD, not live: read them as
 * history rather than as the way a console write works. ADR-0015 Decision 1 puts
 * their removal in the increment that follows this one ("once no caller remains,
 * the block-tree half of the console transport" goes), deliberately as its own
 * change, so this one stays a single thing. Everything else here — the two
 * interaction types, the refusal shape, the refusal constants and
 * {@link readConsolePayload} — is live and stays.
 *
 * G5 APPLIES UNCHANGED, one tier up: every response is HTTP 200 with an outcome
 * in the body. A refusal is a value.
 */
import type { Block, PluginContext, RouteHandler, SandboxedRouteContext } from "../types.js";
import { asRecord, encodeCarrier, readString, type CarriedContext } from "./scaffold/index.js";

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

/** The banner a Block Kit handler produced for a write, forwarded verbatim.
 *  `null` when the action succeeded quietly (the Block Kit screen re-renders
 *  with no banner in that case, and so does the console). */
export interface ConsoleNotice {
	readonly variant: string;
	readonly title: string;
	readonly description: string;
}

export interface ConsoleActPayload {
	readonly ok: true;
	readonly notice: ConsoleNotice | null;
}

export const UNREADABLE_REQUEST: ConsoleFailure = {
	ok: false,
	title: "That request could not be read",
	description:
		"The console asked for something this screen does not serve. Reload the page; if it happens again, this is a fault in the console itself.",
};

/** An action id the Block Kit screen does not register, or one the console is
 *  not allowed to ask for. Reachable from a stale tab after a deploy that
 *  renamed one, and from a console bug — never from a button this release
 *  rendered. */
export const UNKNOWN_ACTION: ConsoleFailure = {
	ok: false,
	title: "Nothing was changed",
	description:
		"This console asked for an action this screen does not offer. Nothing was applied. Reload the page; if it happens again, this is a fault in the console itself.",
};

/** A registered action that produced no screen at all — so it produced no
 *  outcome either, and must not be reported as a quiet success. `record` names
 *  the thing to reload, which differs per screen and is the only part of this
 *  sentence an operator can act on. */
export function nothingApplied(record: string): ConsoleFailure {
	return {
		ok: false,
		title: "Nothing was changed",
		description: `That action did not complete and nothing was applied. Reload the ${record} and try again; if it happens again, this is a fault in the console itself.`,
	};
}

/**
 * Pull the outcome banner out of the block tree a Block Kit handler returned.
 *
 * WHY INDEX-FREE AND VARIANT-KEYED. A detail render emits at most two banners at
 * the top level: the notice, then a screen-specific ALERT (the Orders
 * reconciliation warning, the Products tombstone). An alert is a property of the
 * RECORD, not of what just happened — forwarding one as the outcome of a refund
 * would tell the operator their refund produced a settlement warning, and as the
 * outcome of a restock would tell them their restock deleted the product. A
 * `Notice` is only ever `default` or `error` (`scaffold/banner.ts`), so keying
 * on the variant separates the two without depending on either one's position.
 * Banners nested inside accordions are not top-level blocks and are not seen
 * here, which is why a scan is safe.
 */
export function firstNotice(blocks: readonly Block[]): ConsoleNotice | null {
	for (const block of blocks) {
		if (block.type !== "banner") continue;
		const banner = block as { variant?: unknown; title?: unknown; description?: unknown };
		const variant = readString(banner.variant);
		if (variant !== "default" && variant !== "error") continue;
		return {
			variant,
			title: readString(banner.title) ?? "",
			description: readString(banner.description) ?? "",
		};
	}
	return null;
}

/** The envelope a console write is forwarded as — either the `block_action` a
 *  Block Kit BUTTON would have fired, or the `form_submit` a Block Kit FORM
 *  would have, carrier and all. */
export type ForwardedInteraction =
	| { type: "block_action"; action_id: string; value: unknown }
	| { type: "form_submit"; action_id: string; values: Record<string, unknown>; block_id: string };

/** A console write's payload: the flat string record the React button carried.
 *  Untrusted, exactly as a Block Kit `value` or a decoded carrier is. */
export type ConsolePayload = Readonly<Record<string, string>>;

/** Split a console payload into the carrier half and the visible-field half,
 *  and mint the `form_submit` the Block Kit handler already reads. Only the keys
 *  a screen NAMES ride in the carrier — an unnamed key is a form field, never
 *  silently promoted to context. */
export function forwardedFormSubmit(
	actionId: string,
	payload: ConsolePayload,
	form: { readonly namespace: string; readonly carried: readonly string[] },
): ForwardedInteraction {
	const context: Record<string, string> = {};
	const values: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (form.carried.includes(key)) context[key] = value;
		else values[key] = value;
	}
	return {
		type: "form_submit",
		action_id: actionId,
		values,
		block_id: encodeCarrier(form.namespace, context as CarriedContext),
	};
}

/**
 * Forward a console click to a Block Kit action handler and return its notice.
 *
 * WRITES ARE NOT REIMPLEMENTED, AND THAT IS THE POINT. Refunds, cancellations,
 * status transitions, product saves and stock movements are all paths with
 * watermarks, content-derived idempotency keys and a large, hard-won vocabulary
 * of refusal copy — all of it in the screen's own page module and all of it
 * covered by that module's sandbox suite. A second implementation for React
 * would be a second set of concurrency bugs.
 *
 * THE GATE ON `registered` IS NOT BELT-AND-BRACES. The Block Kit dispatcher
 * answers an id it does not recognise with `{blocks: []}` — the house-style
 * fall-through — which on this branch is indistinguishable from "the write
 * succeeded and had nothing to say". So a typo'd or stale action id would have
 * rendered as a silent success on a refund button. And a REGISTERED id that
 * still came back with no blocks did not render a screen, so it did not do what
 * it was asked either: `{ok: true, notice: null}` there would report a refund
 * that never happened as a quiet success.
 */
export async function forwardConsoleAct<Input>({
	actionId,
	interaction,
	registered,
	handler,
	ctx,
	request,
	record,
}: {
	actionId: string;
	interaction: ForwardedInteraction;
	registered: ReadonlySet<string>;
	handler: RouteHandler<Input>;
	ctx: PluginContext;
	request: SandboxedRouteContext<unknown>["request"];
	record: string;
}): Promise<ConsoleActPayload | ConsoleFailure> {
	if (!registered.has(actionId)) return UNKNOWN_ACTION;
	const result = await handler({ input: interaction as Input, request }, ctx);
	const envelope = asRecord(result);
	const blocks = Array.isArray(envelope?.["blocks"]) ? (envelope["blocks"] as Block[]) : [];
	if (blocks.length === 0) return nothingApplied(record);
	return { ok: true, notice: firstNotice(blocks) };
}

/** Read a console write's flat string payload out of an untrusted request. A
 *  non-string value is DROPPED rather than coerced: everything a console button
 *  carries is already a string on the Block Kit side (money as its integer
 *  minor-unit string, counts as digits), so a number arriving here is a console
 *  bug and must not be laundered into one. */
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
