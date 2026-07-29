/**
 * Recursive Block Kit search for the admin sandbox suites (design spec §15, V-1).
 *
 * WHY THIS EXISTS. Every admin suite used to search the TOP-LEVEL block array
 * (`blocks.filter(b => b.type === "form")`), while em-dash's `BlockRenderer`
 * recurses into `columns.columns[]`, `tab.panels[].blocks` and
 * `accordion.blocks` (spec R-25). The moment a screen's content moves inside a
 * layout container those searches return `[]`/`undefined` and the suite PASSES
 * WHILE ASSERTING NOTHING. These helpers mirror the renderer's traversal
 * exactly, so a test keeps asserting on the block it named no matter how deeply
 * the layout nests it.
 *
 * WHY EVERYTHING IS LOOSELY TYPED. A sandbox test observes the block tree as
 * JSON that has crossed the workerd boundary — it is deliberately NOT the
 * plugin's `Block` union, because asserting against the same types the screen
 * was built from would let a type-level mistake pass unnoticed. So these take
 * and return `LooseBlock` (an object with a `string` `type`) and the caller
 * narrows what it actually reads.
 *
 * TWO RULES FOR CALLERS:
 *  1. **Resolve an accordion by `block_id`, never by label.** Spec D-6 makes
 *     accordion labels deliberately dynamic (`Refunds — $0.00 of $99.00
 *     refunded`, `Notes (2)`), so a label-keyed lookup hard-codes formatted
 *     money into the assertion and breaks on any figure change. `block_id` is
 *     stable and semantic by B-5 — see {@link group}.
 *  2. **Never `expect()` inside a screen's render/handler.** A screen's throw is
 *     CONTAINED by the scaffold and rendered as its fail-closed banner, so a
 *     failed in-render expectation would be swallowed and the test would pass
 *     against an error banner. Assert on the returned `BlockResponse` from the
 *     outside — which is all these helpers let you do.
 */

/** A block as it comes back over the sandbox boundary: JSON with a `type`. */
export interface LooseBlock extends Record<string, unknown> {
	type: string;
}

/** An element (button, field) as it comes back over the sandbox boundary. */
export type LooseElement = Record<string, unknown>;

/** The blocks of a sandbox `invokeRoute` outcome, or `[]` when the invocation
 *  errored (so an assertion fails on the missing block rather than on a
 *  destructuring `TypeError` that hides which call went wrong). */
export function blocksOf(outcome: unknown): LooseBlock[] {
	if (!(typeof outcome === "object" && outcome !== null && "result" in outcome)) return [];
	const result = (outcome as { result: { blocks?: LooseBlock[] } }).result;
	return result.blocks ?? [];
}

/** Every nested block list a container block holds — the EXACT three the
 *  renderer recurses into (`blocks/columns.tsx`, `blocks/tab.tsx`,
 *  `blocks/accordion.tsx`). A leaf block yields none.
 *
 *  Deliberately data-driven rather than a `switch` over the block union: this
 *  runs against JSON from the sandbox, where a block type the suite has never
 *  heard of must be traversed (or not) on its shape alone. */
function childBlockLists(block: LooseBlock): LooseBlock[][] {
	const lists: LooseBlock[][] = [];
	if (block.type === "columns" && Array.isArray(block.columns)) {
		for (const column of block.columns) if (Array.isArray(column)) lists.push(column);
	}
	if (block.type === "tab" && Array.isArray(block.panels)) {
		for (const p of block.panels) {
			const inner = (p as { blocks?: unknown }).blocks;
			if (Array.isArray(inner)) lists.push(inner);
		}
	}
	if (block.type === "accordion" && Array.isArray(block.blocks)) lists.push(block.blocks);
	return lists;
}

/** Every block in the tree, in render order (a container BEFORE its children). */
export function allBlocks(blocks: readonly LooseBlock[]): LooseBlock[] {
	const out: LooseBlock[] = [];
	for (const block of blocks) {
		out.push(block);
		for (const list of childBlockLists(block)) out.push(...allBlocks(list));
	}
	return out;
}

/**
 * Every block of `type` anywhere in the tree — the drop-in replacement for
 * `blocks.filter(b => b.type === t)`.
 *
 * Order is the renderer's: a container appears before the blocks it contains,
 * so `findBlocks(blocks, "table")[0]` is the first table an operator would
 * scroll past. `findBlocks(blocks, "accordion")` includes NESTED accordions,
 * because the renderer renders those too.
 */
export function findBlocks(blocks: readonly LooseBlock[], type: string): LooseBlock[] {
	return allBlocks(blocks).filter((b) => b.type === type);
}

/** The first block of `type`, or `undefined` — the replacement for
 *  `blocks.find(b => b.type === t)`. */
export function findBlock(blocks: readonly LooseBlock[], type: string): LooseBlock | undefined {
	return findBlocks(blocks, type)[0];
}

/**
 * The blocks inside a `tab` panel, resolved by its VISIBLE label — safe because
 * spec D-2 fixes the panel set per screen, so panel labels are static in a way
 * accordion labels are not. `[]` when no such panel exists (which makes a
 * missing panel fail on the block the test wanted, not on an undefined deref).
 */
export function panel(blocks: readonly LooseBlock[], label: string): LooseBlock[] {
	for (const tab of findBlocks(blocks, "tab")) {
		const panels = Array.isArray(tab.panels) ? tab.panels : [];
		for (const p of panels) {
			const entry = p as { label?: unknown; blocks?: unknown };
			if (entry.label === label && Array.isArray(entry.blocks)) return entry.blocks as LooseBlock[];
		}
	}
	return [];
}

/** The labels of a `tab`'s panels, in order — for asserting the panel SET (spec
 *  D-3: it is constant per screen, and a shrinking set strands `activeTab` on a
 *  blank panel). */
export function panelLabels(blocks: readonly LooseBlock[]): string[] {
	const tab = findBlock(blocks, "tab");
	const panels = tab !== undefined && Array.isArray(tab.panels) ? tab.panels : [];
	return panels.map((p) => String((p as { label?: unknown }).label));
}

/**
 * An `accordion` resolved by its **`block_id`**, at any depth.
 *
 * NEVER resolve one by label: D-6 makes labels carry live figures
 * (`Refunds — $0.00 of $99.00 refunded`), so a label-keyed lookup bakes
 * formatted money into every test. `block_id` is stable and semantic (B-5).
 */
export function group(blocks: readonly LooseBlock[], blockId: string): LooseBlock | undefined {
	return findBlocks(blocks, "accordion").find((a) => a.block_id === blockId);
}

/** The blocks inside the accordion with this `block_id`, or `[]`. */
export function groupBlocks(blocks: readonly LooseBlock[], blockId: string): LooseBlock[] {
	const found = group(blocks, blockId);
	return found !== undefined && Array.isArray(found.blocks) ? (found.blocks as LooseBlock[]) : [];
}

/** Every `block_id` that carries a `default_open: true` — spec X-18 caps this at
 *  ONE per rendered response, and D-5 says which one. */
export function openGroupIds(blocks: readonly LooseBlock[]): string[] {
	return findBlocks(blocks, "accordion")
		.filter((a) => a.default_open === true)
		.map((a) => String(a.block_id));
}

/** The `form` whose SUBMIT fires `actionId`, at any depth. Keyed on the submit
 *  rather than on a `block_id`, because a form's `block_id` is a carrier token
 *  that changes whenever its carried context or prefill does (B-3a). */
export function formFor(
	blocks: readonly LooseBlock[],
	submitActionId: string,
): LooseBlock | undefined {
	return findBlocks(blocks, "form").find(
		(f) => (f.submit as { action_id?: unknown } | undefined)?.action_id === submitActionId,
	);
}

/** A form's field `action_id`s in authored order (spec F-1 fixes the order). */
export function fieldIds(form: LooseBlock | undefined): Array<string | undefined> {
	const fields = Array.isArray(form?.fields) ? (form.fields as LooseElement[]) : [];
	return fields.map((f) => (typeof f.action_id === "string" ? f.action_id : undefined));
}

/** One form field by its `action_id`. */
export function field(form: LooseBlock | undefined, actionId: string): LooseElement | undefined {
	const fields = Array.isArray(form?.fields) ? (form.fields as LooseElement[]) : [];
	return fields.find((f) => f.action_id === actionId);
}

/** Every `fields` entry in the tree as `"Label=Value"` — the shape almost every
 *  existing assertion wants, and stable under re-layout. */
export function fieldEntries(blocks: readonly LooseBlock[]): string[] {
	return findBlocks(blocks, "fields")
		.flatMap((b) => (Array.isArray(b.fields) ? (b.fields as LooseElement[]) : []))
		.map((f) => `${String(f.label)}=${String(f.value)}`);
}

/** Every `context` line's text, anywhere in the tree. */
export function contextTexts(blocks: readonly LooseBlock[]): string[] {
	return findBlocks(blocks, "context").map((b) => String(b.text));
}

/** Every `actions` block's elements, anywhere in the tree. Does NOT include an
 *  `empty` block's actions or a `section`'s accessory — those are separate
 *  channels ({@link emptyActions}, {@link accessories}) and conflating them
 *  would hide a control rendered in the wrong place. */
export function buttons(blocks: readonly LooseBlock[]): LooseElement[] {
	return findBlocks(blocks, "actions").flatMap((b) =>
		Array.isArray(b.elements) ? (b.elements as LooseElement[]) : [],
	);
}

/** An `empty` block's action elements (spec E-2's create affordance). */
export function emptyActions(blocks: readonly LooseBlock[]): LooseElement[] {
	return findBlocks(blocks, "empty").flatMap((b) =>
		Array.isArray(b.actions) ? (b.actions as LooseElement[]) : [],
	);
}

/** Every `section.accessory` element (spec L-6's `Clear filters`). */
export function accessories(blocks: readonly LooseBlock[]): LooseElement[] {
	return findBlocks(blocks, "section")
		.map((b) => b.accessory)
		.filter((a): a is LooseElement => typeof a === "object" && a !== null);
}

/** Every row of every table in the tree. */
export function tableRows(blocks: readonly LooseBlock[]): Array<Record<string, unknown>> {
	return findBlocks(blocks, "table").flatMap((t) =>
		Array.isArray(t.rows) ? (t.rows as Array<Record<string, unknown>>) : [],
	);
}

/** The table carrying this `block_id` — the reliable way to name ONE of a
 *  detail screen's several sub-tables. */
export function tableWithId(
	blocks: readonly LooseBlock[],
	blockId: string,
): LooseBlock | undefined {
	return findBlocks(blocks, "table").find((t) => t.block_id === blockId);
}

/** A table's column keys, in order (spec T-1/T-2 govern count and order). */
export function columnKeys(table: LooseBlock | undefined): string[] {
	const columns = Array.isArray(table?.columns) ? (table.columns as LooseElement[]) : [];
	return columns.map((c) => String(c.key));
}
