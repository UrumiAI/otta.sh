import type { AccordionBlock, Element, EmptyBlock, FormBlock, PlainBlockId } from "../../types.js";
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
 * unsubmitted edits. So the density win for filters is VERTICAL: collapse the whole
 * form, keep a count of what is on in its label, and put the active values in the
 * `section` beneath it ({@link filterPanel} + {@link filterSummary}). `columns`
 * remains available for composing WHOLE blocks side by side (see `ColumnsBlock`'s note on the renderer's 2-vs-3 grid), which
 * needs no shared helper.
 *
 * IO-FREE: pure block construction.
 */

/** How many fields a filter form may have before it is worth collapsing. At or
 *  below this it renders inline: hiding one or two fields costs an operator a
 *  click and saves almost no scroll. Matches the design spec's threshold table for
 *  all six screens (orders 4, products 3, coupons 1, tax 1, shipping 1). */
const DEFAULT_INLINE_UP_TO = 2;

/** More than this many filter fields is a design-spec violation, not a layout
 *  problem — collapsing them would hide the violation instead of surfacing it. */
const MAX_FILTER_FIELDS = 4;

/** The base label of a collapsed filter panel. */
const DEFAULT_LABEL = "Filters";

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
	/**
	 * The accordion's `block_id`. REQUIRED, and a React key ONLY — an accordion
	 * never echoes it back, so it must not be a carrier token (the type forbids it).
	 *
	 * Give it a value that is STABLE across an `apply-filter` on the same level, so
	 * the panel does not slam shut on an operator who filters repeatedly, and that
	 * CHANGES when the level does. `"orders:filters"` or `` `tax:filters:${classId}` ``
	 * is the shape. The inner form's key is the thing that must track prefilled
	 * values — that is `carriedForm`'s job, not this one's.
	 */
	blockId: PlainBlockId;
	/** Base label for the collapsed row. Default `"Filters"`. */
	label?: string;
	/**
	 * The CURRENTLY ACTIVE filter parts, in reading order — but ONLY THEIR COUNT
	 * reaches the label, which is `Filters` or `Filters (2 active)` and nothing else.
	 * The values themselves do NOT belong in an accordion label: it is a control, it
	 * has a tight width budget, and free-text search would blow it. Put them in the
	 * `section` beneath the panel, composed from the SAME array by
	 * {@link filterSummary}, so the count and the summary can never disagree.
	 *
	 * ONE PART PER AUTHORED FILTER FIELD, so the count matches what an operator sees
	 * in the panel: a from/to date range is TWO fields and therefore two parts, not one
	 * "last 30 days". Falsy entries are dropped, so a call site can inline its
	 * conditionals:
	 *
	 * ```ts
	 * activeFilters: [
	 *   form.status && `status: ${form.status}`,
	 *   form.from && `from: ${form.from}`,
	 *   form.to && `to: ${form.to}`,
	 *   form.search && `search: ${form.search}`,
	 * ]
	 * ```
	 *
	 * Composition of each part is left to the screen because six screens describe
	 * their filters differently (a status, a date bound, a zone id, a currency).
	 */
	activeFilters?: ReadonlyArray<string | false | null | undefined>;
	/** Render inline (no accordion) at or below this many fields. Default 2; pass
	 *  `0` to always collapse. Counts the fields the SCREEN authored — the engine
	 *  may inject one more (the drill-path carrier) after this runs. */
	inlineUpTo?: number;
}

/**
 * A filter form that does not cost a screenful of scroll: one `form`, collapsed
 * into an `accordion` whose label reports HOW MANY filters are active
 * (`Filters (2 active)` — a count, never the values), or rendered inline when it is
 * small enough to not be worth a click. The values go in the `section` beneath,
 * from {@link filterSummary}.
 *
 * Always renders CLOSED. `accordion.default_open` is read once in a `useState`
 * initialiser, so it can neither reopen a panel the operator closed nor be relied
 * on across re-renders — and a filter that reopens itself on every response is the
 * scroll cost this helper exists to remove. It is therefore not an option here.
 *
 * TWO THINGS THE ENGINE GUARANTEES AROUND THIS, so a screen need not remember
 * them:
 *  - At a drill depth ≥ 1 an `apply-filter` submit must carry the drill path or it
 *    would re-filter the ROOT list. `createListDetailHandler` injects that carrier
 *    into every `applyFilter` form it renders, and it looks INSIDE layout
 *    containers — so collapsing a deep filter form here does not silently break it.
 *    To carry the path INVISIBLY (no visible "Scope" dropdown), build the form with
 *    `carriedForm({namespace, context: {[PATH_FIELD]: encodePath(path)}, form})`;
 *    the injection then stands down, but ONLY for the exact current path.
 *  - Accordion open/close is CLIENT side only and fires no interaction, so the
 *    collapsed body is still rendered on every response: this saves scroll, not
 *    work.
 *
 * THROWS in two cases, both of them screen bugs that must not render as something
 * subtly wrong: above {@link MAX_FILTER_FIELDS} authored fields (a design-spec
 * violation collapsing would hide), and when `form` does not carry a prefill digest
 * matching itself (i.e. it did not come from `carriedForm`, or was edited after).
 * Both are contained by `createListDetailHandler` and surface as that screen's
 * fail-closed banner, with the cause in the worker log.
 */
export function filterPanel(opts: FilterPanelOptions): FormBlock | AccordionBlock {
	if (opts.form.fields.length > MAX_FILTER_FIELDS) {
		throw new Error(
			`filterPanel: ${opts.form.fields.length} filter fields exceeds the ${MAX_FILTER_FIELDS}-field maximum ` +
				`(submit ${opts.form.submit.action_id}) — reduce the filter set rather than collapsing it`,
		);
	}
	// EVERY form here must come from `carriedForm`, whether or not it prefills
	// anything today. A form whose React key cannot change when its prefilled values
	// change strands those values on screen — Block Kit inputs are uncontrolled, so
	// the `Clear filters` re-render leaves the cleared filter visible and the next
	// submit re-applies it — and nesting guarantees the key is stable (a form inside
	// an accordion is index 0 of that accordion forever). Requiring it
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
	const inlineUpTo = opts.inlineUpTo ?? DEFAULT_INLINE_UP_TO;
	if (opts.form.fields.length <= inlineUpTo) return opts.form;
	return {
		type: "accordion",
		label: filterPanelLabel(opts.label ?? DEFAULT_LABEL, activeParts(opts.activeFilters).length),
		blocks: [opts.form],
		block_id: opts.blockId,
	};
}

/**
 * The collapsed label: `Filters`, or `Filters (2 active)` when filters are on.
 * COUNT ONLY — no values, no truncation, no ellipsis.
 *
 * The label is a control with a tight width budget, and a free-text search term
 * would blow it; the values go in the `section` beneath the panel via
 * {@link filterSummary}. Exported so a screen can render the same string elsewhere
 * (an inline filter's `context` line) without re-deriving the format.
 */
export function filterPanelLabel(label: string, activeCount: number): string {
	return activeCount <= 0 ? label : `${label} (${activeCount} active)`;
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
 * const blocks = [filterPanel({ form, blockId: "orders:filters", activeFilters: parts })];
 * if (summary !== undefined) blocks.push({ type: "section", text: summary, accessory: clearButton });
 * ```
 *
 * Pass the SAME array to both, so the panel's count and this summary can never
 * disagree.
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
