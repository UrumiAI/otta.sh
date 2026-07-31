/**
 * `assertBlockContract` — the shared, mechanical enforcement of every §13 `H`
 * row in `docs/admin/ADMIN-CONSOLE.md` (spec V-3/V-3a).
 *
 * WHY THIS FILE EXISTS. §13 marks 32 of its 53 anti-pattern rows `H` —
 * "mechanically decidable from a rendered block tree" — and until this PR
 * nothing shared enforced them: Orders hand-rolled a handful of its own
 * assertions and every other screen enforced none. V-3a: "no screen should
 * write the thing that judges it", so this lives in its own `[Plugin]` PR,
 * never inside a screen PR, and every screen from here on calls it once per
 * rendered response.
 *
 * WHAT IS **NOT** HERE, ON PURPOSE. Several `H`-marked rows are not
 * implemented below because they cannot be decided from a single rendered
 * response without guessing (see each `NOT IMPLEMENTED` comment for the
 * specific reason). Per the brief that commissioned this file: an honest "I
 * could not check this without guessing" beats a heuristic that
 * false-positives on legitimate content across six future screens — the
 * exact failure mode §13 already documents for X-9 (E-i: flagged "Refunds
 * recorded") and X-11a (E-j: a data-derived email busts an authored budget).
 * A rule not enforced here is a human review catch (§15's own framing of
 * every non-`H` row) — it is not silently dropped, it is named below and in
 * the PR that shipped this file.
 *
 * SINGLE-RESPONSE ONLY. `assertBlockContract` sees one rendered `BlockResponse`
 * and the two facts it cannot otherwise infer (`screen`, `level`). Several
 * `H` rows (X-29, X-39, and the payload half of X-38) are inherently
 * CROSS-response claims — "did this block_id change between two renders",
 * "does this refusal echo what an earlier response staged" — which V-4 tier 1
 * already scopes to "the token changed/did not change between these two
 * responses". Those stay the calling screen's own before/after test; a
 * single-`blocks` signature cannot supply the earlier response to compare
 * against, and V-3a fixes this signature as `(blocks, { screen, level })`,
 * unchanged.
 *
 * ALL-OR-NOTHING, PER CALL. Every implemented check runs on every call; there
 * is no per-rule opt-out. A screen mid-build that has not reached (say) its
 * money panel yet will trip whatever rules its CURRENT response violates —
 * which is correct: a response is either compliant or it names what is wrong
 * with it, and a screen not yet built simply does not call this on blocks it
 * has not produced. Making rules individually selectable would let a screen
 * quietly suppress the one rule it fails today, which is the drive-by V-3a
 * exists to prevent one level up.
 */

import {
	accessories,
	allBlocks,
	buttons,
	columnsOf,
	confirmOf,
	contextTexts,
	emptyActions,
	findBlocks,
	valueOf,
	type LooseBlock,
	type LooseElement,
} from "./blocks.js";
import { decodeJsonToken } from "../../src/admin/scaffold/base64url.js";
import { CARRIER_MARKER, PREFILL_FIELD, decodeCarrier } from "../../src/admin/scaffold/carrier.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The seven admin screens this spec governs (§0 front matter, D-2, §12). */
export type ScreenName =
	| "orders"
	| "products"
	| "coupons"
	| "tax"
	| "shipping"
	| "reports"
	| "settings";

/**
 * Whether this response is a list/registry render or a leaf detail render.
 * X-27's second half ("no `next_cursor` inside a leaf detail", T-8) and
 * X-16 (§4's tab skeleton is detail-only) both need this; the blocks alone
 * cannot say it, because an empty detail and an empty list can look alike.
 */
export type BlockLevel = "list" | "detail";

export interface BlockContractOptions {
	screen: ScreenName;
	level: BlockLevel;
}

/**
 * Assert every mechanically-decidable §13 `H` rule against one rendered
 * response. Throws ONE `Error` naming every violation found (rule id, the
 * offending block/value, and what to do instead) — call it once per response
 * your suite already renders (list, each detail record-state, each staged/
 * refused re-render).
 */
export function assertBlockContract(
	blocks: readonly LooseBlock[],
	options: BlockContractOptions,
): void {
	const violations: string[] = [
		...checkX1(blocks),
		...checkX2(blocks),
		...checkX4(blocks),
		...checkX6(blocks),
		...checkX9(blocks),
		...checkX11(blocks),
		...checkX13(blocks),
		...checkX14(blocks),
		...checkX15(blocks),
		...checkX16(blocks, options.screen, options.level),
		...checkX17(blocks),
		...checkX18(blocks),
		...checkX20(blocks),
		...checkX22(blocks),
		...checkX23(blocks),
		...checkX24(blocks),
		...checkX25(blocks),
		...checkX26(blocks),
		...checkX27(blocks, options.level),
		...checkX28(blocks),
		...checkX31(blocks),
		...checkX35(blocks),
		...checkX36(blocks),
		...checkX37(blocks),
		...checkX41(blocks),
		...checkX42(blocks),
		...checkX52(blocks, options.screen),
		...checkMoneyIsIntegerMinorUnits(blocks),
	];
	if (violations.length > 0) {
		throw new Error(
			`assertBlockContract: ${violations.length} violation(s) on screen "${options.screen}" (${options.level}):\n` +
				violations.map((v) => `  - ${v}`).join("\n"),
		);
	}
}

// ---------------------------------------------------------------------------
// Shared scanning helpers
// ---------------------------------------------------------------------------

function formFields(form: LooseBlock | undefined): LooseElement[] {
	return Array.isArray(form?.fields) ? (form.fields as LooseElement[]) : [];
}

/** Every button-typed element anywhere in the tree: `actions` blocks,
 *  `empty.actions`, a `section.accessory`, AND a `button` sitting inside a
 *  form's own field list (R-22 — it renders, it just cannot read the form's
 *  values). Budgets (X-11) and confirm-style (X-37) bind on all of them. */
function allButtonElements(blocks: readonly LooseBlock[]): LooseElement[] {
	const out: LooseElement[] = [...buttons(blocks), ...emptyActions(blocks), ...accessories(blocks)];
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) if (f.type === "button") out.push(f);
	}
	return out;
}

/** Every string leaf anywhere in the (JSON) block tree — for a banned-phrase
 *  scan that must not care which block or field it is buried in. Because this
 *  walks the RENDERED response, not source, a code comment documenting the
 *  domain invariant is structurally out of reach — it was never in the JSON. */
function allStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const v of value) allStrings(v, out);
	} else if (typeof value === "object" && value !== null) {
		for (const v of Object.values(value)) allStrings(v, out);
	}
	return out;
}

// X-9's own money-label heuristic, verbatim (§13 row, V-3a "Must hoist ...
// X-9's heuristic with its count exclusion"). Reused by X-9 and X-25 — the
// same "does this label READ as money" question, asked of a table/fields
// value and of a meter respectively.
const MONEY_LABEL_RE = /amount|total|price|revenue|cost|subtotal|discount|refund/i;
const COUNT_EXCLUSION_RE = /count|recorded|quantity|qty|items/i;
const RAW_DIGITS_RE = /^\d+$/;

function isMoneyLabel(label: string): boolean {
	return MONEY_LABEL_RE.test(label) && !COUNT_EXCLUSION_RE.test(label);
}

// ---------------------------------------------------------------------------
// X-1 (F-2, F-4) — an internal name, or camelCase, leaking into a label.
// ---------------------------------------------------------------------------

const INTERNAL_NAME_RE =
	/\b(orderId|classId|zoneId|methodId|rateId|productId|couponId|nonce|idempotencyKey|expectedUpdatedAt|expectedRateBps|expectedAmountCents|expectedFlag|__path|__v|scope|revision)\b/i;

function checkX1(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			if (typeof f.label !== "string" || f.label.length === 0) continue;
			const label = f.label;
			if (INTERNAL_NAME_RE.test(label)) {
				out.push(
					`X-1: form field labelled "${label}" (action_id "${String(f.action_id)}") names an internal identifier (F-2) — move it into the block_id/value carrier and give the operator no field for it.`,
				);
				continue;
			}
			const camelToken = label
				.split(/\s+/)
				.map((tok) => tok.replace(/[^A-Za-z]/g, ""))
				.find((tok) => /^[a-z]+[A-Z]/.test(tok));
			if (camelToken !== undefined) {
				out.push(
					`X-1: form field labelled "${label}" reads camelCase ("${camelToken}") — F-4 requires sentence case, no camelCase, no API names.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-2 (F-3) — a select with one option.
// ---------------------------------------------------------------------------

function checkX2(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			if (f.type === "select" && Array.isArray(f.options) && f.options.length === 1) {
				out.push(
					`X-2: select "${String(f.label)}" (action_id "${String(f.action_id)}") has exactly one option (F-3) — a one-option dropdown is a leaked variable; delete it and state the constraint in a context line.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-4 (T-5) — a badge column that never chunks, or more than one per table.
// ---------------------------------------------------------------------------

function checkX4(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const table of findBlocks(blocks, "table")) {
		const id = String(table.block_id ?? "(no block_id)");
		const columns = columnsOf(table);
		const badgeCols = columns.filter((c) => c.format === "badge");
		if (badgeCols.length > 1) {
			out.push(
				`X-4: table "${id}" has ${badgeCols.length} badge columns (${badgeCols.map((c) => String(c.label)).join(", ")}) — T-5 allows at most one badge column per table.`,
			);
		}
		const rows = Array.isArray(table.rows) ? (table.rows as Array<Record<string, unknown>>) : [];
		if (rows.length > 1) {
			for (const col of badgeCols) {
				const key = String(col.key);
				const values = new Set(rows.map((r) => String(r[key])));
				if (values.size === 1) {
					out.push(
						`X-4: table "${id}" column "${String(col.label)}" is a badge whose value ("${String(rows[0]?.[key])}") is identical across every row in this response (T-5) — a badge that cannot chunk two values apart is decoration; demote it to plain text or delete the column.`,
					);
				}
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-6 (R-4, §2) — any divider.
// ---------------------------------------------------------------------------

function checkX6(blocks: readonly LooseBlock[]): string[] {
	return findBlocks(blocks, "divider").map(
		() =>
			`X-6: a "divider" block is present (R-4/§2) — dividers are forbidden everywhere; accordion boundaries already separate groups.`,
	);
}

// ---------------------------------------------------------------------------
// X-9 (M-1, M-3, T-4) — money as raw minor units, or format:"number"/
// number_input on a money field. The heuristic is the one §13 authors:
// reject a digits-only value whose label reads as money and does not read
// as a count.
// ---------------------------------------------------------------------------

function checkX9(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const table of findBlocks(blocks, "table")) {
		const id = String(table.block_id ?? "(no block_id)");
		const rows = Array.isArray(table.rows) ? (table.rows as Array<Record<string, unknown>>) : [];
		for (const col of columnsOf(table)) {
			const label = String(col.label ?? "");
			if (!isMoneyLabel(label)) continue;
			if (col.format === "number") {
				out.push(
					`X-9: table "${id}" column "${label}" uses format:"number" (T-4) — a money column must be pre-formatted by formatMoney and rendered as plain text; format:"number" would render 9900 as "9,900", worse than raw because it looks formatted.`,
				);
			}
			const key = String(col.key ?? "");
			for (const row of rows) {
				const value = row[key];
				if (typeof value === "string" && RAW_DIGITS_RE.test(value)) {
					out.push(
						`X-9: table "${id}" column "${label}" cell "${value}" looks like raw minor units (M-1) — format it through formatMoney before rendering.`,
					);
				} else if (typeof value === "number" && Number.isInteger(value)) {
					out.push(
						`X-9: table "${id}" column "${label}" cell ${value} is a raw number on a money column (M-1) — format it through formatMoney before rendering.`,
					);
				}
			}
		}
	}
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			const label = String(f.label ?? "");
			if (!isMoneyLabel(label)) continue;
			if (f.type === "number_input") {
				out.push(
					`X-9: field "${label}" is a number_input on a money field (F-6/M-3) — money must be text_input parsed to integer minor units; number_input yields a float-risking JS number.`,
				);
			}
		}
	}
	for (const fb of findBlocks(blocks, "fields")) {
		const entries = Array.isArray(fb.fields)
			? (fb.fields as Array<{ label: unknown; value: unknown }>)
			: [];
		for (const entry of entries) {
			const label = String(entry.label ?? "");
			if (!isMoneyLabel(label)) continue;
			const value = entry.value;
			if (typeof value === "string" && RAW_DIGITS_RE.test(value)) {
				out.push(
					`X-9: fields row "${label}" = "${value}" looks like raw minor units (M-1) — format it through formatMoney before rendering.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-10 (M-4) — NOT IMPLEMENTED. "A money ladder in a `fields` block instead
// of a two-column `table`." Not decidable as written: telling "a ladder that
// belongs in a table" apart from a legitimate few-money-value `fields` block
// is a question about AUTHORIAL INTENT, not shape — M-11 explicitly REQUIRES
// a `Captured`/`Remaining` pair to live in `fields` (the reconciliation
// case), which is exactly the shape a naive "N money-labelled entries" count
// would also flag. No count threshold is non-arbitrary: 2 falsely condemns
// M-11's own mandated pattern, and any higher threshold is a guess about how
// long a "real" ladder is. Reported as a spec defect rather than
// heuristic-guessed, on the same footing as X-9's own count-exclusion fix
// (E-i) and X-11a's demotion (E-j) — both already document that a shape-only
// heuristic here produces false positives on legitimate content.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// X-11 (§1) — the seven authored prose budgets. Deliberately SEVEN, not
// eight: the `fields`-value 40-char budget (X-11a) is data-derived and is
// NEVER enforced here (§1's own text, E-j) — see `checkX11` below, which
// implements exactly the seven AUTHOR-CONTROLLED budgets and stops there.
// ---------------------------------------------------------------------------

const BUDGET = {
	pageContext: 140,
	otherContext: 200,
	bannerDescription: 240,
	accordionLabel: 60,
	confirmTitle: 60,
	confirmText: 200,
	emptyDescription: 200,
} as const;

function checkX11(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	// "Page-level context" = a `context` block literally in the TOP-LEVEL array
	// (P-1's whitelist position), never one recursed out of a tab/accordion.
	const topLevelContext = blocks.filter((b) => b.type === "context");
	const topLevelSet = new Set<LooseBlock>(topLevelContext);
	for (const ctx of topLevelContext) {
		const text = String(ctx.text ?? "");
		if (text.length > BUDGET.pageContext) {
			out.push(
				`X-11: page-level context is ${text.length} chars (budget ${BUDGET.pageContext}, §1) — "${text}"`,
			);
		}
	}
	for (const ctx of findBlocks(blocks, "context")) {
		if (topLevelSet.has(ctx)) continue;
		const text = String(ctx.text ?? "");
		if (text.length > BUDGET.otherContext) {
			out.push(
				`X-11: a nested context line is ${text.length} chars (budget ${BUDGET.otherContext}, §1) — "${text}"`,
			);
		}
	}
	for (const b of findBlocks(blocks, "banner")) {
		if (typeof b.description !== "string") continue;
		if (b.description.length > BUDGET.bannerDescription) {
			out.push(
				`X-11: banner.description is ${b.description.length} chars (budget ${BUDGET.bannerDescription}, §1) — "${b.description}"`,
			);
		}
	}
	for (const a of findBlocks(blocks, "accordion")) {
		const label = String(a.label ?? "");
		if (label.length > BUDGET.accordionLabel) {
			out.push(
				`X-11: accordion.label is ${label.length} chars (budget ${BUDGET.accordionLabel}, §1) — "${label}"`,
			);
		}
	}
	for (const el of allButtonElements(blocks)) {
		const confirm = confirmOf(el);
		if (typeof confirm.title === "string" && confirm.title.length > BUDGET.confirmTitle) {
			out.push(
				`X-11: confirm.title is ${confirm.title.length} chars (budget ${BUDGET.confirmTitle}, §1) — "${confirm.title}"`,
			);
		}
		if (typeof confirm.text === "string" && confirm.text.length > BUDGET.confirmText) {
			out.push(
				`X-11: confirm.text is ${confirm.text.length} chars (budget ${BUDGET.confirmText}, §1) — "${confirm.text}"`,
			);
		}
	}
	for (const e of findBlocks(blocks, "empty")) {
		if (typeof e.description !== "string") continue;
		if (e.description.length > BUDGET.emptyDescription) {
			out.push(
				`X-11: empty.description is ${e.description.length} chars (budget ${BUDGET.emptyDescription}, §1) — "${e.description}"`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-13 (M-6) — millisecond timestamps, or any non-UTC offset.
// ---------------------------------------------------------------------------

const MS_TIMESTAMP_RE = /T\d{2}:\d{2}:\d{2}\.\d+/;
const OFFSET_TZ_RE = /T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:?\d{2}\b/;
/** A wire timestamp of ANY precision or zone — the shape INC-13 says must not
 *  reach an operator at all, not merely be trimmed. */
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Walk every literal-text surface of a rendered response — `fields` values,
 * non-`relative_time` table cells, `context` lines — handing each to `scan`
 * with the label that names it. The traversal both X-13 and
 * {@link assertNoRawTimestamps} run on, so a surface added to one is checked by
 * the other by construction.
 */
function scanRenderedText(
	blocks: readonly LooseBlock[],
	scan: (label: string, value: string) => void,
): void {
	for (const fb of findBlocks(blocks, "fields")) {
		const entries = Array.isArray(fb.fields)
			? (fb.fields as Array<{ label: unknown; value: unknown }>)
			: [];
		for (const entry of entries) {
			if (typeof entry.value === "string") scan(String(entry.label), entry.value);
		}
	}
	for (const table of findBlocks(blocks, "table")) {
		const rows = Array.isArray(table.rows) ? (table.rows as Array<Record<string, unknown>>) : [];
		for (const col of columnsOf(table)) {
			// T-4/M-6: a `relative_time` column carries the RAW timestamp on
			// purpose — the renderer, not this data, turns it into "3 days ago".
			// Only a column rendered as literal text is subject to the M-6
			// display rule; the underlying data is exempt by design.
			if (col.format === "relative_time") continue;
			const key = String(col.key);
			for (const row of rows) {
				const value = row[key];
				if (typeof value === "string") scan(String(col.label), value);
			}
		}
	}
	for (const text of contextTexts(blocks)) scan("context", text);
}

function checkX13(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	scanRenderedText(blocks, (label, value) => {
		if (MS_TIMESTAMP_RE.test(value)) {
			out.push(
				`X-13: "${label}" = "${value}" carries millisecond precision (M-6) — trim to seconds.`,
			);
		} else if (OFFSET_TZ_RE.test(value)) {
			out.push(
				`X-13: "${label}" = "${value}" carries a non-UTC offset (M-6) — no timezone conversion anywhere; render absolute UTC.`,
			);
		}
	});
	return out;
}

/**
 * INC-13 — NO RAW WIRE TIMESTAMP REACHES AN OPERATOR. Every rendered instant
 * goes through `scaffold/datetime.js` and reads `8 Jul 2026, 10:30 UTC`; a
 * literal `2026-07-08T10:30:35Z` on any surface is a defect, not a formatting
 * preference. This subsumes X-13 — a trimmed-to-seconds UTC ISO string passes
 * X-13 and fails here — and is the strictly stronger successor to it.
 *
 * WHY THIS IS A SEPARATE EXPORT RATHER THAN A RULE INSIDE
 * `assertBlockContract`, which is where it belongs and where it should end up.
 * This file is deliberately ALL-OR-NOTHING PER CALL (see the header): no screen
 * may suppress the one rule it fails today. Adding this to the X-13 set would
 * therefore have to fail `coupons-page.ts`, whose detail still renders
 * `Created (UTC) = <raw ISO>` and which INC-13 could not touch — another
 * increment held that file. Rather than smuggle a per-screen opt-out into a
 * helper whose whole point is that it has none, the rule ships as its own
 * assertion, wired into the screens that are compliant.
 *
 * THE FOLLOW-UP IS ONE LINE. When Coupons' detail is converted, fold this into
 * `checkX13` (it already shares that check's traversal) and delete this export;
 * every screen then gets it from the single `assertBlockContract` call it
 * already makes.
 */
export function assertNoRawTimestamps(blocks: readonly LooseBlock[]): void {
	const violations: string[] = [];
	scanRenderedText(blocks, (label, value) => {
		if (!ISO_TIMESTAMP_RE.test(value)) return;
		violations.push(
			`INC-13: "${label}" = "${value}" renders a raw wire timestamp — format it through \`scaffold/datetime.js\` (\`formatTimestamp\` → "8 Jul 2026, 10:30 UTC").`,
		);
	});
	if (violations.length > 0) {
		throw new Error(
			`Rendered response renders ${violations.length} raw timestamp(s):\n  - ${violations.join("\n  - ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// X-14 (T-3) — sortable:true on any column.
// ---------------------------------------------------------------------------

function checkX14(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const table of findBlocks(blocks, "table")) {
		for (const col of columnsOf(table)) {
			if (col.sortable === true) {
				out.push(
					`X-14: table "${String(table.block_id ?? "")}" column "${String(col.label)}" sets sortable:true (T-3) — forbidden until the scaffold's page action threads an ordering parameter end to end.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-15 (§2) — any columns or chart block.
// ---------------------------------------------------------------------------

function checkX15(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	if (findBlocks(blocks, "columns").length > 0) {
		out.push(`X-15: a "columns" block is present — forbidden on all seven screens (§2).`);
	}
	if (findBlocks(blocks, "chart").length > 0) {
		out.push(`X-15: a "chart" block is present — forbidden; it cannot format money (R-19, §2).`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-16 (D-3, D-4) — a non-constant panel set, or default_tab !== 0.
// Needs `screen` (compared against D-2's per-screen table) and `level`
// (tab is detail-only) — the reason the signature carries both.
// ---------------------------------------------------------------------------

const D2_PANELS: Partial<Record<ScreenName, readonly string[]>> = {
	orders: ["Order", "Fulfilment", "Money", "History"],
	products: ["Product", "Stock"],
	coupons: ["Coupon", "Redemptions"],
};

function checkX16(blocks: readonly LooseBlock[], screen: ScreenName, level: BlockLevel): string[] {
	const out: string[] = [];
	const tabs = findBlocks(blocks, "tab");
	if (level === "list") {
		if (tabs.length > 0) {
			out.push(
				`X-16: a "tab" block is present on the LIST level of "${screen}" — tab is detail-screens-only (§2, D-2).`,
			);
		}
		return out;
	}
	const expected = D2_PANELS[screen];
	if (expected === undefined) {
		out.push(
			`X-16: screen "${screen}" has no detail screen per D-2 (§4) — assertBlockContract should never be called with level:"detail" for it.`,
		);
		return out;
	}
	if (tabs.length !== 1) {
		out.push(
			`X-16: expected exactly one "tab" block on ${screen}'s detail (D-2), found ${tabs.length}.`,
		);
		return out;
	}
	const tab = tabs[0];
	if (tab === undefined) return out;
	const panels = Array.isArray(tab.panels) ? tab.panels : [];
	const labels = panels.map((p) => String((p as { label?: unknown }).label));
	if (labels.length !== expected.length || labels.some((l, i) => l !== expected[i])) {
		out.push(
			`X-16: ${screen}'s tab panel set is ${JSON.stringify(labels)}, expected the constant D-2 set ${JSON.stringify(expected)} — a conditionally-present or reordered panel strands activeTab past the end on a shrinking count (R-14).`,
		);
	}
	const defaultTab = tab.default_tab;
	if (defaultTab !== undefined && defaultTab !== 0) {
		out.push(
			`X-16: ${screen}'s tab.default_tab is ${JSON.stringify(defaultTab)} — must always be 0 (D-4); urgency is communicated by the block-4 banner, never by which tab opens.`,
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-17 (B-1, B-3, B-3a) — a form with no block_id; a prefilling form whose
// block_id did not come from carriedForm (no `__v` digest); a block_id that
// looks like an encoded payload with no ":u1." marker; a button carrying a
// block_id at all (only form/table may).
// ---------------------------------------------------------------------------

function checkX17(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const form of findBlocks(blocks, "form")) {
		const submitId = String(
			(form.submit as { action_id?: unknown } | undefined)?.action_id ?? "(no submit)",
		);
		const blockId = form.block_id;
		if (typeof blockId !== "string" || blockId.length === 0) {
			out.push(
				`X-17: form (submit "${submitId}") has no explicit block_id (B-1) — every form must carry one, even a plain semantic id when it needs no carrier.`,
			);
			continue;
		}
		const isPrefilling = formFields(form).some(
			(f) => "initial_value" in f && f.initial_value !== undefined,
		);
		const carried = decodeCarrier(blockId);
		if (isPrefilling) {
			if (carried === undefined) {
				out.push(
					`X-17: prefilling form "${blockId}" (submit "${submitId}") carries no :u1. carrier context (B-3/B-3a) — build it with carriedForm({...}) so a changed prefill remounts the form.`,
				);
			} else if (!(PREFILL_FIELD in carried)) {
				out.push(
					`X-17: prefilling form "${blockId}" (submit "${submitId}") carries context but no "${PREFILL_FIELD}" prefill digest (B-3a) — it must come from carriedForm({...}), not a hand-rolled encodeCarrier call.`,
				);
			}
		}
		if (carried === undefined && looksLikeUnmarkedCarrier(blockId)) {
			out.push(
				`X-17: block_id "${blockId}" looks like an encoded payload with no ":u1." marker (B-1/B-2a) — route it through encodeCarrier/carriedForm.`,
			);
		}
	}
	for (const el of allButtonElements(blocks)) {
		if (typeof el.block_id === "string" && el.block_id.length > 0) {
			out.push(
				`X-17: button "${String(el.action_id)}" carries a block_id — only form and table echo block_id back (B-1); a button's only context channel is value.`,
			);
		}
	}
	return out;
}

/** Does the LAST colon-segment of `blockId` decode as base64url JSON, while
 *  the whole string is missing the ":u1." marker? A plain semantic id
 *  (`orders:hdr`, `orders:<id>:tabs`) never looks like this; only a
 *  hand-rolled carrier that forgot the marker does. */
function looksLikeUnmarkedCarrier(blockId: string): boolean {
	if (blockId.includes(CARRIER_MARKER)) return false;
	const at = blockId.lastIndexOf(":");
	if (at < 1) return false;
	const suffix = blockId.slice(at + 1);
	if (!/^[A-Za-z0-9_-]{8,}$/.test(suffix)) return false;
	try {
		const parsed = decodeJsonToken(suffix);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// X-18 (D-5, B-5, B-8) — more than one default_open:true per response.
// ---------------------------------------------------------------------------

function checkX18(blocks: readonly LooseBlock[]): string[] {
	const open = findBlocks(blocks, "accordion")
		.filter((a) => a.default_open === true)
		.map((a) => String(a.block_id));
	if (open.length > 1) {
		return [
			`X-18: ${open.length} groups carry default_open:true in this response (${open.join(", ")}) — D-5 allows AT MOST ONE per EMITTED response. This rule constrains the JSON this handler returns, not the viewport: a compliant response can still LOOK like two groups are open, because default_open is read once at mount (R-14a) and an earlier response's open group stays open across an unchanged block_id (B-5) — that is not this finding. Fix the render path that computed these booleans; do NOT "fix" it by changing an unrelated group's block_id, which would remount that group and destroy the operator's unsubmitted input in it (B-8, F-5a-i).`,
		];
	}
	return [];
}

// ---------------------------------------------------------------------------
// X-29 (B-6) — NOT IMPLEMENTED. "A DA-3 state-2 accordion that changes its
// block_id without default_open:true, or sets the flag without changing the
// id." Not decidable from a single response: "changes" is a claim about TWO
// renders (this one vs. the one before it), and `assertBlockContract` sees
// exactly one `blocks` argument. V-3a fixes the signature as
// `(blocks, {screen, level})` — there is no parameter to hand it the prior
// response's block_id to diff against. This is a V-4 tier-1 "the token
// changed/did not change between these two responses" claim (§15), which
// stays the calling screen's own before/after test, not this helper.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// X-20 (voice) — the banned slogan in any rendered string. Operates on the
// emitted JSON, so a source-code comment documenting the domain invariant is
// structurally exempt: it was never part of what this function reads.
// ---------------------------------------------------------------------------

const BANNED_SLOGAN_RE = /oversell|oversold|overselling/i;

function checkX20(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const s of allStrings(blocks)) {
		if (BANNED_SLOGAN_RE.test(s)) {
			out.push(
				`X-20: rendered string contains the banned slogan — "${s}" — no operator-facing copy may say "oversell"/"oversold"/"overselling" (voice); state the mechanism instead.`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-22 (L-7, M-7, R-17a/b) — an "Open X" picker that is a select instead of
// a combobox, more than one per response, or any select/combobox option
// whose label leaks its own opaque-id value IN FULL.
//
// The last clause is narrower than it once read, and §1.3 (the UUID display
// rule) is why: the console now REQUIRES the Orders picker to lead its label
// with a short unique prefix of the very id it carries as a value, because two
// orders of one repeat customer are otherwise identical character for
// character. So "no id in a label" was never the rule worth enforcing — "no
// WHOLE id in a label" is. What the check tests is unchanged (`includes` of the
// entire value); only the sentence describing it has been brought back in line
// with the screens.
//
// KNOWN EDGE, noted rather than resolved: `shortIdsFor` maps an id SHORTER than
// its 4-character floor to itself, so such an id would BE its own prefix and
// compliant code leading a label with it would trip this check. Nothing on any
// screen is that short today (every opaque id here is a uuid), and the
// fragility belongs to this helper rather than to the console — recording it
// beats loosening the rule for a case that has never occurred.
// ---------------------------------------------------------------------------

function checkX22(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	const openForms = findBlocks(blocks, "form").filter((f) =>
		String((f.submit as { action_id?: unknown } | undefined)?.action_id ?? "").endsWith(":open"),
	);
	if (openForms.length > 1) {
		out.push(
			`X-22: ${openForms.length} "Open X" picker forms in one response (L-7) — at most one per list.`,
		);
	}
	for (const form of openForms) {
		const fields = formFields(form);
		const first = fields[0];
		if (fields.length === 1 && first !== undefined && first.type === "select") {
			out.push(
				`X-22: the "Open X" picker (submit "${String((form.submit as { action_id?: unknown } | undefined)?.action_id)}") is a select — a select puts the id in the trigger (R-17a); use combobox (R-17b).`,
			);
		}
	}
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			if (f.type !== "select" && f.type !== "combobox") continue;
			const options = Array.isArray(f.options)
				? (f.options as Array<{ value: unknown; label: unknown }>)
				: [];
			for (const opt of options) {
				const value = String(opt.value ?? "");
				const label = String(opt.label ?? "");
				if (value.length >= 4 && looksLikeOpaqueId(value) && label.includes(value)) {
					out.push(
						`X-22: option label "${label}" (field "${String(f.label ?? f.action_id)}") contains its own id-like value "${value}" IN FULL (M-7/X-22, §1.3) — a whole id is the option's VALUE, never its text. A §1.3 short prefix MAY lead the label (the Orders picker requires one); it is the id in full that must not appear.`,
					);
				}
			}
		}
	}
	return out;
}

function looksLikeOpaqueId(value: string): boolean {
	return (
		/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(value) ||
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	);
}

// ---------------------------------------------------------------------------
// X-23 (F-6a) — select/radio/combobox with no initial_value, an
// initial_value absent from options, or a "" option value.
// ---------------------------------------------------------------------------

function checkX23(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			if (f.type !== "select" && f.type !== "combobox" && f.type !== "radio") continue;
			const options = Array.isArray(f.options) ? (f.options as Array<{ value: unknown }>) : [];
			const iv = f.initial_value;
			const label = String(f.label ?? f.action_id ?? "(unlabeled)");
			if (iv === undefined) {
				out.push(
					`X-23: "${label}" (${String(f.type)}) declares no initial_value (F-6a) — an unresolved trigger renders blank.`,
				);
			} else if (!options.some((o) => o.value === iv)) {
				out.push(
					`X-23: "${label}" (${String(f.type)}) initial_value ${JSON.stringify(iv)} is absent from its options (F-6a).`,
				);
			}
			if (options.some((o) => o.value === "")) {
				out.push(
					`X-23: "${label}" (${String(f.type)}) has an option with value "" (F-6a) — use a real sentinel ("any"/"none"), never empty string.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-24 (F-6b) — a toggle with no initial_value.
// ---------------------------------------------------------------------------

function checkX24(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			if (f.type === "toggle" && f.initial_value === undefined) {
				out.push(
					`X-24: toggle "${String(f.label ?? f.action_id)}" has no initial_value (F-6b) — mount-only plus no initial_value means it is absent from values, and a handler doing Boolean(values.x) silently writes false.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-25 (M-8) — a meter that reads as money with no custom_value. Reuses
// X-9's money-label heuristic against the meter's own `label`.
// ---------------------------------------------------------------------------

function checkX25(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const m of findBlocks(blocks, "meter")) {
		const label = String(m.label ?? "");
		if (isMoneyLabel(label) && m.custom_value === undefined) {
			out.push(
				`X-25: meter "${label}" reads as money (M-8) but has no custom_value — meter has no currency; a money meter must carry custom_value with the formatted readout.`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-26 (M-9, §2) — banner.variant outside default|alert|error, or a legacy
// `text` field.
// ---------------------------------------------------------------------------

const VALID_BANNER_VARIANTS = new Set(["default", "alert", "error"]);

function checkX26(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const b of findBlocks(blocks, "banner")) {
		const variant = String(b.variant ?? "");
		if (!VALID_BANNER_VARIANTS.has(variant)) {
			out.push(
				`X-26: banner.variant is "${variant}" (M-9) — only default|alert|error are real; "info"/"success" are phantoms the renderer forwards unvalidated.`,
			);
		}
		if (typeof b.text === "string" && b.text.length > 0) {
			out.push(
				`X-26: banner carries a legacy "text" field ("${b.text}") — the renderer drops it silently; use title/description.`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-27 (T-6, T-8) — a table with no page_action_id, or next_cursor inside a
// leaf detail. The second half needs `level`.
// ---------------------------------------------------------------------------

function checkX27(blocks: readonly LooseBlock[], level: BlockLevel): string[] {
	const out: string[] = [];
	for (const t of findBlocks(blocks, "table")) {
		const id = String(t.block_id ?? "(no block_id)");
		if (t.page_action_id === undefined || t.page_action_id === "") {
			out.push(
				`X-27: table "${id}" has no page_action_id (T-6/R-21) — every table must set one, even if it can never page (keep the "// never fires" comment convention).`,
			);
		}
		if (level === "detail" && typeof t.next_cursor === "string" && t.next_cursor.length > 0) {
			out.push(
				`X-27: table "${id}" sets next_cursor inside a leaf detail (T-8) — cap the read and state the cap in a context line instead of paging a sub-table.`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-28 (F-2a) — an idempotency key or nonce anywhere in a form field, a
// carrier payload, or a button.value.
// ---------------------------------------------------------------------------

const NONCE_RE = /idempot|nonce/i;

function checkX28(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			const label = String(f.label ?? "");
			const actionId = String(f.action_id ?? "");
			if (NONCE_RE.test(label) || NONCE_RE.test(actionId)) {
				out.push(
					`X-28: form field "${label || actionId}" looks like an idempotency key or nonce (F-2a) — derive it server-side from the write's own content and its observed watermark; never render, carry, or mint one at render time.`,
				);
			}
		}
		const blockId = form.block_id;
		if (typeof blockId === "string") {
			const decoded = decodeCarrier(blockId);
			if (decoded !== undefined) {
				for (const key of Object.keys(decoded)) {
					if (key !== PREFILL_FIELD && NONCE_RE.test(key)) {
						out.push(
							`X-28: form "${blockId}" carrier context carries key "${key}" (F-2a) — no idempotency key or nonce may ride in block_id.`,
						);
					}
				}
			}
		}
	}
	for (const el of allButtonElements(blocks)) {
		for (const key of Object.keys(valueOf(el))) {
			if (NONCE_RE.test(key)) {
				out.push(
					`X-28: button "${String(el.action_id)}" value carries key "${key}" (F-2a) — no idempotency key or nonce may ride in a carried payload.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-31 (§2) — more than 2 banners at the top level (accordion-nested ones
// don't count).
// ---------------------------------------------------------------------------

function checkX31(blocks: readonly LooseBlock[]): string[] {
	const topBanners = blocks.filter((b) => b.type === "banner");
	if (topBanners.length > 2) {
		return [
			`X-31: ${topBanners.length} banners at the top level of this response (§2) — at most 2 (banners inside an accordion are not counted).`,
		];
	}
	return [];
}

// ---------------------------------------------------------------------------
// X-35 (D-6a) — a destructive accordion labelled with a bare verb/noun and
// no consequence clause.
// ---------------------------------------------------------------------------

function isDestructiveGroup(accordion: LooseBlock): boolean {
	const body = Array.isArray(accordion.blocks) ? (accordion.blocks as LooseBlock[]) : [];
	return allBlocks(body).some(
		(b) =>
			b.type === "actions" &&
			Array.isArray(b.elements) &&
			(b.elements as LooseElement[]).some(
				(e) =>
					e.type === "button" &&
					e.style === "danger" &&
					typeof e.confirm === "object" &&
					e.confirm !== null,
			),
	);
}

function checkX35(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const a of findBlocks(blocks, "accordion")) {
		if (!isDestructiveGroup(a)) continue;
		const label = String(a.label ?? "");
		if (!label.includes("—") && !/ - /.test(label)) {
			out.push(
				`X-35: destructive accordion "${label}" has no consequence clause (D-6a) — e.g. "${label} — permanent" or "${label} — cannot be reversed".`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-36 (D-6b) — a degenerate ratio in an accordion label.
// ---------------------------------------------------------------------------

const DEGENERATE_RATIO_RE = /\$0\.00\s+of\s+\$0\.00|\b0\s+of\s+0\b|0%\s+of\s+nothing/i;

function checkX36(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const a of findBlocks(blocks, "accordion")) {
		const label = String(a.label ?? "");
		if (DEGENERATE_RATIO_RE.test(label)) {
			out.push(
				`X-36: accordion label "${label}" states a degenerate ratio (D-6b) — replace the arithmetic with the fact (e.g. "nothing captured, nothing to refund").`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-37 (DA-2c) — more than 4 danger buttons in one actions block, or any
// confirm dialog that lost style:"danger" (DA-5: the guard is always the
// dialog, so a confirm never loses it, even when the button's own colour
// drops under DA-2c/DA-3a-v).
// ---------------------------------------------------------------------------

function checkX37(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const ab of findBlocks(blocks, "actions")) {
		const elements = Array.isArray(ab.elements) ? (ab.elements as LooseElement[]) : [];
		const dangerCount = elements.filter((e) => e.style === "danger").length;
		if (dangerCount > 4) {
			out.push(
				`X-37: an actions block has ${dangerCount} style:"danger" buttons (DA-2c) — above 4, buttons drop style (default secondary) while confirm keeps style:"danger".`,
			);
		}
	}
	for (const el of allButtonElements(blocks)) {
		const confirm = el.confirm;
		if (typeof confirm === "object" && confirm !== null) {
			const style = (confirm as Record<string, unknown>).style;
			if (style !== "danger") {
				out.push(
					`X-37: button "${String(el.action_id)}" carries a confirm dialog whose style is not "danger" (DA-5/DA-2c) — a confirm never loses style:"danger", even when the button's own colour drops.`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-38 (DA-2a, DA-3a, DA-3a-iv) — NOT IMPLEMENTED. "A DA-2b/DA-3 button.value
// carrying no watermark, or a confirm handler that writes without
// re-reading." Two separate reasons, both in the row's own text:
//  - The "re-read" half is explicitly BEHAVIOURAL — the row's own wording
//    assigns it to "the screen's own stale-watermark test", not a static
//    check over one rendered response.
//  - The "no watermark" half needs to know WHICH payload key is the
//    watermark, and that name has no shared convention across writes: F-2a's
//    own table shows `state`, `onHandAtRender`, `refundedSoFarCents` — no
//    common prefix or suffix a generic regex could key on without either
//    missing real watermarks (false negative) or flagging an ordinary
//    accompanying id as if it were the missing watermark (false positive).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// X-39 (DA-3a-i) — NOT IMPLEMENTED. "A DA-3a or DA-3c refusal that does not
// re-render the same group, forced open per B-6, with the submitted values
// prefilled and flattened onto that group." Like X-29, this compares TWO
// responses — the earlier staged response's group id and submitted values
// against the refusal's — which a single-`blocks` signature cannot supply.
// Stays the calling screen's own before/after test (V-4 tier 1).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// X-48 (DA-3a-v, DA-3a-i, DA-5) — NOT IMPLEMENTED. "A refusal body carrying
// any control that would commit the class of act just refused... or a
// refusal response carrying any style:danger button outside the refused
// group." This needs to know THIS RESPONSE IS A REFUSAL, as distinct from an
// ordinary D-5-Rule-2-opened group or a DA-3 state-2 confirm — both of which
// ALSO have exactly one forced-open group (X-18), so "one open group" cannot
// itself distinguish them. A structural proxy is imaginable (one open group
// plus an error-variant banner present, since E-1/E-6 restrict error-variant
// banners to a primary fail-close or a DA-3a/DA-3c refusal notice) — but
// V-3a fixes this helper's signature as `(blocks, {screen, level})`,
// "unchanged", with no `isRefusal` flag to lean on, and the shapes the
// vocabulary allows are not fully enumerable from here. Reported rather than
// shipping a heuristic that could false-positive on an ordinary open detail
// panel, or false-negative on a refusal shape this reasoning didn't predict.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// X-41 (DA-7a, E-4) — "deliberately" / "there is no" / "we do not" in any
// context or banner line. (The row's second clause — a DA-7 line with no
// actionable verb — is NOT implemented; see the triage report.)
// ---------------------------------------------------------------------------

const NARRATES_DESIGN_RE = /deliberately|there is no|we do not/i;

function checkX41(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	const prose = [
		...contextTexts(blocks),
		...findBlocks(blocks, "banner").flatMap((b) => [
			String(b.title ?? ""),
			String(b.description ?? ""),
		]),
	];
	for (const text of prose) {
		if (NARRATES_DESIGN_RE.test(text)) {
			out.push(
				`X-41: "${text}" narrates a design decision (DA-7a/E-4) — say what to do instead, not what was withheld.`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-42 (E-7) — a fail-closed banner naming a single external cause without
// E-7's normative "fault in the console itself" disclaimer.
// ---------------------------------------------------------------------------

const CONNECTIVITY_CAUSE_RE =
	/could not (reach|connect)|service (is )?(unreachable|down)|connection (failed|lost|error)/i;
const CONSOLE_FAULT_RE = /fault in the (console|plugin)|not your data/i;

function checkX42(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	for (const b of findBlocks(blocks, "banner")) {
		if (b.variant !== "error") continue;
		const text = `${String(b.title ?? "")} ${String(b.description ?? "")}`.trim();
		if (CONNECTIVITY_CAUSE_RE.test(text) && !CONSOLE_FAULT_RE.test(text)) {
			out.push(
				`X-42: fail-closed banner names a single external cause ("${text}") without E-7's normative disclaimer — E-6 makes this path swallow a console bug too, so the copy must also say this could be "a fault in the console itself — not your data".`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// X-52 (F-2b) — a form field for a value another system owns, or a
// read-only row whose label omits the owner. Per-screen because "who owns
// this field" is a per-field ADR decision (ADR-0013), not a general shape.
// ---------------------------------------------------------------------------

interface OwnedField {
	actionId: RegExp;
	label: RegExp;
}

const OWNED_FIELDS: Partial<Record<ScreenName, readonly OwnedField[]>> = {
	products: [{ actionId: /^(active|title)$/i, label: /^(status|title)$/i }],
};

function checkX52(blocks: readonly LooseBlock[], screen: ScreenName): string[] {
	const out: string[] = [];
	const owned = OWNED_FIELDS[screen];
	if (owned === undefined) return out;
	for (const form of findBlocks(blocks, "form")) {
		for (const f of formFields(form)) {
			const actionId = String(f.action_id ?? "");
			if (owned.some((o) => o.actionId.test(actionId))) {
				out.push(
					`X-52: form field "${actionId}" on screen "${screen}" writes to a value another system owns (F-2b) — remove the input; render it read-only in a fields row instead.`,
				);
			}
		}
	}
	for (const fb of findBlocks(blocks, "fields")) {
		const entries = Array.isArray(fb.fields) ? (fb.fields as Array<{ label: unknown }>) : [];
		for (const entry of entries) {
			const label = String(entry.label ?? "");
			const bare = label.replace(/\s*\([^)]*\)\s*$/, "").trim();
			if (owned.some((o) => o.label.test(bare)) && !/\([^)]+\)/.test(label)) {
				out.push(
					`X-52: fields row labelled "${label}" on screen "${screen}" is owned by another system but its label omits the owner (F-2b) — e.g. "${bare} (set in the CMS)".`,
				);
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Money is integer minor units, never a float, with an explicit currency
// (task requirement, hoisted alongside X-20 — not a numbered §13 row). Every
// spec-documented money key ends "Cents" (`amountCents`, `refundedSoFarCents`,
// `capCents`, `unitPriceCents`, …); B-2 requires it cross a carrier as
// `String(cents)`, never a decimal.
// ---------------------------------------------------------------------------

const CENTS_KEY_RE = /Cents$/;

function checkMoneyIsIntegerMinorUnits(blocks: readonly LooseBlock[]): string[] {
	const out: string[] = [];
	const scan = (source: string, record: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(record)) {
			if (!CENTS_KEY_RE.test(key)) continue;
			if (typeof value === "number") {
				if (!Number.isInteger(value) || value < 0) {
					out.push(
						`MONEY-INTEGER: ${source} key "${key}" = ${value} is not a non-negative integer (M-1/M-3) — money crosses as an integer minor-unit count, never a float.`,
					);
				}
			} else if (typeof value === "string") {
				if (!/^\d+$/.test(value)) {
					out.push(
						`MONEY-INTEGER: ${source} key "${key}" = "${value}" is not a non-negative integer string (B-2: "money crosses as String(cents)") — never a decimal or a negative value.`,
					);
				}
			} else {
				out.push(
					`MONEY-INTEGER: ${source} key "${key}" = ${JSON.stringify(value)} is neither a number nor a string (B-2).`,
				);
			}
		}
	};
	for (const el of allButtonElements(blocks)) {
		scan(`button "${String(el.action_id)}" value`, valueOf(el));
	}
	for (const form of findBlocks(blocks, "form")) {
		const blockId = form.block_id;
		if (typeof blockId === "string") {
			const decoded = decodeCarrier(blockId);
			if (decoded !== undefined)
				scan(`form "${blockId}" carrier`, decoded as Record<string, unknown>);
		}
	}
	return out;
}
