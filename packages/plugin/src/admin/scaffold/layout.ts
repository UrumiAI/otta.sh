import type { AccordionBlock, Element, EmptyBlock, FormBlock } from "../../types.js";

/**
 * The two layout primitives the six admin screens share (admin-UX density
 * increment 1). Deliberately unopinionated about any particular screen — the
 * console design spec dictates per-screen usage and five page teams consume
 * these — so they stay thin, well-documented wrappers over the authoritative
 * block shapes rather than screen-specific builders.
 *
 * WHY THERE IS NO "FILTER FIELDS IN COLUMNS" HELPER. A `form`'s fields are
 * ALWAYS a full-width vertical stack: em-dash 0.29.0's `form.tsx` wraps them in
 * `flex flex-col gap-4` and its `FormField` union has no layout container.
 * `ColumnsBlock` takes `Block[][]`, so putting a filter's fields side by side
 * would mean splitting ONE filter across several `form` blocks — i.e. several
 * independent submits, each losing the others' unsubmitted edits. So the density
 * win for filters is VERTICAL: collapse the whole form and keep the active
 * filter legible in the collapsed label ({@link filterPanel}). `columns` remains
 * available for composing WHOLE blocks side by side (see `ColumnsBlock`'s note
 * on the renderer's 2-vs-3 grid), which no shared helper is needed for.
 *
 * IO-FREE: pure block construction.
 */

/** How many fields a filter form may have before it is worth collapsing. At or
 *  below this it renders inline: hiding one or two fields costs an operator a
 *  click and saves almost no scroll. */
const DEFAULT_INLINE_UP_TO = 2;

/** The label a collapsed filter panel falls back to with no active filter. */
const DEFAULT_LABEL = "Filters";

export interface FilterPanelOptions {
	/** The filter form, exactly as the screen builds it (its `submit.action_id`
	 *  is the screen's `applyFilter`). */
	form: FormBlock;
	/** Base label for the collapsed row. Default `"Filters"`. */
	label?: string;
	/**
	 * Human-readable summaries of the CURRENTLY ACTIVE filters, in reading order,
	 * appended to the label as `Filters — status: paid, last 30 days`. This is the
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
	/** Start expanded. Default `false` — reclaiming the scroll is the point. */
	defaultOpen?: boolean;
	/** The accordion's `block_id` (its React key; the form keeps its own). */
	blockId?: string;
}

/**
 * A filter form that does not cost a screenful of scroll: one `form`, collapsed
 * into an `accordion` whose label carries the active filter, or rendered inline
 * when it is small enough to not be worth a click.
 *
 * TWO THINGS THE ENGINE GUARANTEES AROUND THIS, so a screen need not remember
 * them:
 *  - At a drill depth ≥ 1 an `apply-filter` submit must carry the drill path or
 *    it would re-filter the ROOT list. `createListDetailHandler` injects that
 *    carrier into every `applyFilter` form it renders, and it looks INSIDE
 *    layout containers — so collapsing a deep filter form here does not silently
 *    break it. To carry the path INVISIBLY (no "Scope" dropdown) set the form's
 *    `block_id` to `encodeCarrier({[PATH_FIELD]: encodePath(path), …})`; the
 *    injection then stands down.
 *  - Accordion open/close is CLIENT side only and fires no interaction, so the
 *    collapsed body is still rendered on every response: this saves scroll, not
 *    work.
 */
export function filterPanel(opts: FilterPanelOptions): FormBlock | AccordionBlock {
	const inlineUpTo = opts.inlineUpTo ?? DEFAULT_INLINE_UP_TO;
	if (opts.form.fields.length <= inlineUpTo) return opts.form;
	return {
		type: "accordion",
		label: filterPanelLabel(opts.label ?? DEFAULT_LABEL, opts.summary),
		blocks: [opts.form],
		...(opts.defaultOpen === true ? { default_open: true } : {}),
		...(opts.blockId !== undefined ? { block_id: opts.blockId } : {}),
	};
}

/** The collapsed label: the base, plus the active-filter summary when there is
 *  one (`Filters — status: paid, last 30 days`). Exported so a screen can put the
 *  same string somewhere else (a `context` line under an inline filter, say)
 *  without re-deriving the format. */
export function filterPanelLabel(
	label: string,
	summary?: ReadonlyArray<string | false | null | undefined>,
): string {
	const active = (summary ?? []).filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	return active.length === 0 ? label : `${label} — ${active.join(", ")}`;
}

/**
 * The "nothing here" state as ONE `empty` block — an icon, a title and an
 * optional description/command line/actions — replacing the section heading plus
 * empty table that currently costs a full section of scroll.
 *
 * Note the other way a screen can express emptiness, so the choice is
 * deliberate: a `table` with `empty_text` renders that text INSTEAD of the whole
 * table (`table.tsx:69-71`) and is right when the columns carry no meaning
 * without rows; this block is right when the empty state should offer the way
 * out (`actions`) or explain itself.
 *
 * Option names are camelCase (mirroring em-dash's own `empty()` builder) and map
 * onto the block's snake_case wire fields.
 */
export function emptyState(opts: {
	title: string;
	description?: string;
	commandLine?: string;
	size?: "sm" | "base" | "lg";
	/** Rendered ELEMENTS (buttons), not blocks — em-dash renders them in a
	 *  centred row under the description. An empty array is omitted. */
	actions?: readonly Element[];
	blockId?: string;
}): EmptyBlock {
	return {
		type: "empty",
		title: opts.title,
		...(opts.description !== undefined ? { description: opts.description } : {}),
		...(opts.commandLine !== undefined ? { command_line: opts.commandLine } : {}),
		...(opts.size !== undefined ? { size: opts.size } : {}),
		...(opts.actions !== undefined && opts.actions.length > 0
			? { actions: [...opts.actions] }
			: {}),
		...(opts.blockId !== undefined ? { block_id: opts.blockId } : {}),
	};
}
