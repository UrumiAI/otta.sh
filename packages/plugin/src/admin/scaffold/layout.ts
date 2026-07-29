import type { AccordionBlock, Element, EmptyBlock, FormBlock, PlainBlockId } from "../../types.js";

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
 * form and keep the active filter legible in the collapsed label
 * ({@link filterPanel}). `columns` remains available for composing WHOLE blocks
 * side by side (see `ColumnsBlock`'s note on the renderer's 2-vs-3 grid), which
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

/** The label a collapsed filter panel falls back to with no active filter. */
const DEFAULT_LABEL = "Filters";

/** Separator between active-filter summaries in a collapsed label. */
const SUMMARY_SEPARATOR = " · ";

/** Hard cap on a collapsed label; longer is tail-truncated with an ellipsis. A
 *  filter row has to stay one line, and orders filters on free text. */
const MAX_LABEL_LENGTH = 60;

export interface FilterPanelOptions {
	/** The filter form, exactly as the screen builds it (its `submit.action_id` is
	 *  the screen's `applyFilter`). Prefer building it through `carriedForm` so its
	 *  own React key tracks its prefilled values. */
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
	 * Human-readable summaries of the CURRENTLY ACTIVE filters, in reading order,
	 * appended to the label as `Filters · status: paid · last 30 days`. This is the
	 * whole point of collapsing: a closed filter must still tell the operator what
	 * they are looking at.
	 *
	 * Falsy entries are dropped, so a call site can inline its conditionals:
	 * `summary: [form.status && \`status: ${form.status}\`, dateRangeLabel(form)]`.
	 * Composition is left to the screen because six screens describe their filters
	 * differently (a status, a date range, a zone id, a currency).
	 */
	summary?: ReadonlyArray<string | false | null | undefined>;
	/** Render inline (no accordion) at or below this many fields. Default 2; pass
	 *  `0` to always collapse. Counts the fields the SCREEN authored — the engine
	 *  may inject one more (the drill-path carrier) after this runs. */
	inlineUpTo?: number;
}

/**
 * A filter form that does not cost a screenful of scroll: one `form`, collapsed
 * into an `accordion` whose label carries the active filter, or rendered inline
 * when it is small enough to not be worth a click.
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
 * Throws above {@link MAX_FILTER_FIELDS} authored fields: that is a design-spec
 * violation, and collapsing it silently would hide it.
 */
export function filterPanel(opts: FilterPanelOptions): FormBlock | AccordionBlock {
	if (opts.form.fields.length > MAX_FILTER_FIELDS) {
		throw new Error(
			`filterPanel: ${opts.form.fields.length} filter fields exceeds the ${MAX_FILTER_FIELDS}-field maximum ` +
				`(submit ${opts.form.submit.action_id}) — reduce the filter set rather than collapsing it`,
		);
	}
	const inlineUpTo = opts.inlineUpTo ?? DEFAULT_INLINE_UP_TO;
	if (opts.form.fields.length <= inlineUpTo) return opts.form;
	return {
		type: "accordion",
		label: filterPanelLabel(opts.label ?? DEFAULT_LABEL, opts.summary),
		blocks: [opts.form],
		block_id: opts.blockId,
	};
}

/**
 * The collapsed label: the base, plus the active-filter summary when there is one
 * (`Filters · status: paid · last 30 days`), tail-truncated with `…` at
 * {@link MAX_LABEL_LENGTH} characters so a filter row stays one line.
 *
 * Exported so a screen can put the same string somewhere else (a `context` line
 * under an inline filter, say) without re-deriving the format.
 */
export function filterPanelLabel(
	label: string,
	summary?: ReadonlyArray<string | false | null | undefined>,
): string {
	const active = (summary ?? []).filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	const full =
		active.length === 0 ? label : label + SUMMARY_SEPARATOR + active.join(SUMMARY_SEPARATOR);
	return full.length <= MAX_LABEL_LENGTH
		? full
		: `${full.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
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
