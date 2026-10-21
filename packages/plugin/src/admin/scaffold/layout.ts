import type { Block, Element, EmptyBlock, FormBlock, PlainBlockId } from "../../types.js";
import { decodeCarrier, prefillDigest, PREFILL_FIELD } from "./carrier.js";

/**
 * The two layout primitives the six admin screens share (admin-UX density
 * increment 1). Deliberately unopinionated about any particular screen — the
 * console design spec dictates per-screen usage and five page teams consume
 * these — so they stay thin, well-documented wrappers over the authoritative
 * block shapes rather than screen-specific builders.
 *
 * WHY THERE IS NO "FILTER FIELDS IN COLUMNS" HELPER. A `form`'s fields are
 * ALWAYS a full-width vertical stack: `blocks/form.tsx` wraps them in
 * `flex flex-col gap-4` and the `FormField` union has no layout container (true in
 * 0.29.0 and in the pinned 0.31.1). `ColumnsBlock` takes `Block[][]`, so putting a
 * filter's fields side by side would mean splitting ONE filter across several
 * `form` blocks — i.e. several independent submits, each losing the others'
 * unsubmitted edits. So a filter stays ONE inline form and the active values go in
 * the `section` beneath it ({@link filterPanel} + {@link filterSummary}). `columns`
 * remains available for composing WHOLE blocks side by side (see `ColumnsBlock`'s note on the renderer's 2-vs-3 grid), which
 * needs no shared helper.
 *
 * IO-FREE: pure block construction.
 */

/** More than this many filter fields is a design-spec violation, not a layout
 *  problem — a bigger form would be a screenful of fields, so it fails loudly. */
const MAX_FILTER_FIELDS = 4;

/** Separator between active-filter parts in a {@link filterSummary}. */
const SUMMARY_SEPARATOR = " · ";

export interface FilterPanelOptions {
	/** The filter form, exactly as the screen builds it (its `submit.action_id` is
	 *  the screen's `applyFilter`). It MUST come from `carriedForm` — unconditionally,
	 *  whether or not it prefills anything today — and `carriedForm` must be the LAST
	 *  thing applied to it, or the digest it carries will not match. A form without a
	 *  matching digest throws: its React key could not change when its prefilled
	 *  values do, which strands cleared filters on screen. */
	form: FormBlock;
}

/**
 * A screen's filter form. It ALWAYS renders inline, as the `form` itself: the
 * admin console has no dropdowns (an operator should not have to open a panel to
 * see a screen's controls), so a multi-field filter is never collapsed. The
 * active values go in the `section` beneath, from {@link filterSummary}.
 *
 * ENGINE GUARANTEE AROUND THIS, so a screen need not remember it: at a drill depth
 * >= 1 an `apply-filter` submit must carry the drill path or it would re-filter the
 * ROOT list. `createListDetailHandler` injects that carrier into every
 * `applyFilter` form it renders, and it looks INSIDE layout containers. To carry
 * the path INVISIBLY (no visible "Scope" dropdown), build the form with
 * `carriedForm({namespace, context: {[PATH_FIELD]: encodePath(path)}, form})`; the
 * injection then stands down, but ONLY for the exact current path.
 *
 * THROWS in two cases, both of them screen bugs that must not render as something
 * subtly wrong: above {@link MAX_FILTER_FIELDS} authored fields (a design-spec
 * violation), and when `form` does not carry a prefill digest matching itself
 * (i.e. it did not come from `carriedForm`, or was edited after). Both are
 * contained by `createListDetailHandler` and surface as that screen's fail-closed
 * banner, with the cause in the worker log.
 */
export function filterPanel(opts: FilterPanelOptions): FormBlock {
	if (opts.form.fields.length > MAX_FILTER_FIELDS) {
		throw new Error(
			`filterPanel: ${opts.form.fields.length} filter fields exceeds the ${MAX_FILTER_FIELDS}-field maximum ` +
				`(submit ${opts.form.submit.action_id}) — reduce the filter set`,
		);
	}
	// EVERY form here must come from `carriedForm`, whether or not it prefills
	// anything today. A form whose React key cannot change when its prefilled values
	// change strands those values on screen — Block Kit inputs are uncontrolled, so
	// the `Clear filters` re-render leaves the cleared filter visible and the next
	// submit re-applies it — and nesting guarantees the key is stable (a form nested in a container is index 0 of it forever). Requiring it
	// UNCONDITIONALLY means the very first render test on every screen trips this,
	// rather than only the tests that happen to render with a filter applied, and a
	// filter form that gains a prefill later cannot quietly become wrong.
	//
	// The digest must also MATCH this form: a present-but-stale one (hand-rolled, or
	// left over from before a field was added) is exactly the stale key it is meant
	// to rule out, so presence alone is not enough.
	const carriedDigest = decodeCarrier(opts.form.block_id)?.[PREFILL_FIELD];
	if (carriedDigest !== prefillDigest(opts.form)) {
		throw new Error(
			`filterPanel: the form for ${opts.form.submit.action_id} ${
				carriedDigest === undefined ? "carries no prefill digest" : "carries a STALE prefill digest"
			} — build it with carriedForm({namespace, context, form}), last, so its React key tracks its prefilled values`,
		);
	}
	return opts.form;
}

/**
 * The human-readable summary of the active filters — `status: paid · last 30 days`
 * — for the `section` that sits beneath a filter panel (alongside its
 * `Clear filters` accessory). Falsy parts are dropped, and `undefined` comes back
 * when nothing is active, so a screen can omit the section entirely rather than
 * render an empty line:
 *
 * ```ts
 * // One part per authored field — `from`/`to` are two fields, so two parts.
 * const parts = [
 *   form.status && `status: ${form.status}`,
 *   form.from && `from: ${form.from}`,
 *   form.to && `to: ${form.to}`,
 * ];
 * const summary = filterSummary(parts);
 * const blocks = [filterPanel({ form })];
 * if (summary !== undefined) blocks.push({ type: "section", text: summary, accessory: clearButton });
 * ```
 *
 */
export function filterSummary(
	parts: ReadonlyArray<string | false | null | undefined>,
): string | undefined {
	const active = activeParts(parts);
	return active.length === 0 ? undefined : active.join(SUMMARY_SEPARATOR);
}

/** The non-empty string parts of an active-filter array. */
function activeParts(
	parts: ReadonlyArray<string | false | null | undefined> | undefined,
): string[] {
	return (parts ?? []).filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
}

/**
 * The "nothing here" state as ONE `empty` block — an icon, a title and an optional
 * description/actions — replacing the section heading plus empty table that
 * currently costs a full section of scroll.
 *
 * Note the other way a screen can express emptiness, so the choice is deliberate:
 * a `table` with `empty_text` renders that text INSTEAD of the whole table
 * (`blocks/table.tsx`) and is right when the columns carry no meaning without rows;
 * this block is right when the empty state should offer the way out (`actions`) or
 * explain itself.
 *
 * `empty.command_line` is deliberately NOT exposed: it renders a copyable shell
 * command, and there is no command an operator of these screens should be running.
 *
 * Option names are camelCase (mirroring em-dash's own `empty()` builder) and map
 * onto the block's snake_case wire fields.
 */
export function emptyState(opts: {
	title: string;
	description?: string;
	size?: "sm" | "base" | "lg";
	/** Rendered ELEMENTS (buttons), not blocks — em-dash renders them in a centred
	 *  row under the description. An empty array is omitted. Like every bare
	 *  element, their interactions echo NO `block_id`: context goes in
	 *  `ButtonElement.value`. */
	actions?: readonly Element[];
	/** React key ONLY — an `empty` block echoes nothing back, so this can never be
	 *  a carrier (the type forbids it). */
	blockId?: PlainBlockId;
}): EmptyBlock {
	return {
		type: "empty",
		title: opts.title,
		...(opts.description !== undefined ? { description: opts.description } : {}),
		...(opts.size !== undefined ? { size: opts.size } : {}),
		...(opts.actions !== undefined && opts.actions.length > 0
			? { actions: [...opts.actions] }
			: {}),
		...(opts.blockId !== undefined ? { block_id: opts.blockId } : {}),
	};
}

/** The group-heading budget (X-11, §1): a section heading is at most this many
 *  characters. {@link section} enforces it on every `title`. */
export const LABEL_BUDGET = 60;

/** Separator between the values on a D-6 label. */
const VALUE_SEPARATOR = " · ";

/** Trim `text` to `max` characters, ellipsis included, keeping the leading part. */
export function fit(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Fit a heading to {@link LABEL_BUDGET} by plain tail truncation. */
export function fitLabel(text: string): string {
	return fit(text, LABEL_BUDGET);
}

/**
 * A D-6 `<group> — <value> · <value>` label, kept inside {@link LABEL_BUDGET}
 * by shortening a VALUE rather than the tail. Right-truncation would eat the
 * LAST value outright: an operator-supplied name has no length bound of its own,
 * and the values after it (an id, a flag) are worth keeping. So the truncation
 * costs the LONGEST value, and only by the overflow; when no value can absorb
 * it, the whole label is tail-truncated.
 */
export function valueLabel(prefix: string, values: readonly string[]): string {
	if (values.length === 0) return fitLabel(prefix);
	const full = `${prefix} — ${values.join(VALUE_SEPARATOR)}`;
	if (full.length <= LABEL_BUDGET) return full;
	let longest = 0;
	values.forEach((value, index) => {
		if (value.length > (values[longest] ?? "").length) longest = index;
	});
	const room = (values[longest] ?? "").length - (full.length - LABEL_BUDGET) - 1;
	if (room < 1) return fitLabel(full);
	const shortened = values.map((value, index) =>
		index === longest ? `${value.slice(0, room)}…` : value,
	);
	return `${prefix} — ${shortened.join(VALUE_SEPARATOR)}`;
}

/**
 * A titled group that is ALWAYS OPEN: a `header` naming it, an optional `context`
 * line under that, then its blocks inline. It is how EmDash's own admin pages
 * group content (Settings → General: "Site Identity", then its fields), and it
 * replaces the collapsible `accordion` groups the screens used to emit — an
 * operator should not have to open a dropdown to see a screen's content.
 *
 * NOT the Block Kit `section` block type (text + accessory): this emits a `header`
 * followed by the body blocks, nothing else.
 *
 * The `title` is fitted to {@link LABEL_BUDGET} here, so no screen can ship an
 * over-budget heading; a caller that must keep the full text passes it as `note`.
 *
 * `blockId` goes on the heading: a React key ONLY (a header echoes nothing back,
 * so the type forbids a carrier), and the stable name tests find the group by.
 * The body's blocks join the SAME list as the heading, so any of them whose key
 * must track its prefilled values (a form) still needs its own `carriedForm`
 * `block_id` — which every prefilling form here already carries.
 */
export function section(opts: {
	blockId: PlainBlockId;
	title: string;
	/** What a collapsed label used to say beyond its name — a count, the current
	 *  values, a threshold — as one `context` line under the heading. */
	note?: string;
	blocks: readonly Block[];
}): Block[] {
	return [
		{ type: "header", text: fitLabel(opts.title), block_id: opts.blockId },
		...(opts.note !== undefined ? [{ type: "context" as const, text: opts.note }] : []),
		...opts.blocks,
	];
}
