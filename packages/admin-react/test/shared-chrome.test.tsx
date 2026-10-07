/**
 * The console's shared chrome: the table card, the state pill, the reveal on
 * Copy, the dialog's backdrop, and the cursor cascade.
 *
 * NO DOCUMENT HERE ON PURPOSE. Every decision on this page is a pure function of
 * props — which class comes out, which declaration lands in the sheet, which
 * accent reaches which property — and the sheet in particular can only be
 * checked as a string, because no environment short of a real browser resolves a
 * cascade. The focus behaviour that genuinely needs a document lives in the
 * companion `*-dom` file.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
	CONSOLE_STYLES,
	ConfirmDialog,
	CURSOR_RESET_DESCENDANT_SELECTOR,
	CopyIdButton,
	FAIL_ACCENT,
	OK_ACCENT,
	ROW_ID_ATTRIBUTE,
	StatusPill,
	Table,
	WARN_ACCENT,
} from "../src/ui.js";

const sheet = (): string => CONSOLE_STYLES.replace(/\s+/g, " ");

const noop = (): void => undefined;

/**
 * The one opening tag that carries `data-testid`, so a style assertion is about
 * the control it names.
 *
 * `toContain(FAIL_ACCENT)` OVER A WHOLE DIALOG IS NOT A TONE ASSERTION. It is
 * satisfied by the accent landing on the deny button, on the way out, or on any
 * element the dialog ever grows — all of which are the defect the tone flag
 * exists to prevent, passing.
 */
function tagFor(html: string, testId: string): string {
	const found = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
	if (found === null) throw new Error(`no element with data-testid="${testId}"`);
	return found[0];
}

const CONFIRM = {
	open: false,
	title: "Add 100 to on hand?",
	text: "On hand goes from 4 to 104.",
	confirmLabel: "Yes, add 100",
	denyLabel: "Cancel",
} as const;

describe("the cursor cascade no longer needs !important", () => {
	test("cursor is a class rule, so the row reset wins without overriding anything", () => {
		const css = sheet();
		// The inline declaration is gone from every button, which is what makes
		// the rest of this possible: a rule in this sheet can now be outranked
		// only by another rule in this sheet.
		expect(css).toContain(".otta-btn { cursor: pointer; }");
		expect(css).toContain(
			`.otta-row[${ROW_ID_ATTRIBUTE}] :is(${CURSOR_RESET_DESCENDANT_SELECTOR}) { cursor: auto; }`,
		);
		expect(css).not.toContain("!important");
	});

	test("the disclosure's pointer is a class rule for the same reason", () => {
		// `summary` is named in the reset selector, so a `<summary>` inside an
		// activatable row has to be able to fall back to `auto` — which an inline
		// declaration on the element makes impossible, whatever the sheet says.
		const css = sheet();
		expect(css).toContain(".otta-summary { cursor: pointer; }");
		expect(CURSOR_RESET_DESCENDANT_SELECTOR.split(", ")).toContain("summary");
	});

	test("a disabled control keeps not-allowed, inside an activatable row and out", () => {
		// The old `!important` flattened this: every control in a row read `auto`
		// whether it was available or not, so the one signal that says "this
		// button is not going to do anything" was the one the row erased.
		const css = sheet();
		expect(css).toContain(".otta-btn:disabled { cursor: not-allowed; }");
		expect(css).toContain(
			`.otta-row[${ROW_ID_ATTRIBUTE}] :is(${CURSOR_RESET_DESCENDANT_SELECTOR}):disabled ` +
				"{ cursor: not-allowed; }",
		);
	});
});

describe("the table card", () => {
	test("is opt-in, because the detail tables already sit in a panel", () => {
		const headers = ["Order #"] as const;
		const row = (
			<tr>
				<td className="otta-td">x</td>
			</tr>
		);
		const carded = renderToStaticMarkup(
			<Table card caption="Orders" headers={headers}>
				{row}
			</Table>,
		);
		const bare = renderToStaticMarkup(
			<Table caption="Line items" headers={headers}>
				{row}
			</Table>,
		);
		expect(carded).toContain('class="otta-table-card"');
		expect(bare).not.toContain("otta-table-card");
		// The clip sits on the element that already scrolls sideways, so a narrow
		// viewport still reaches the far columns.
		expect(carded).toContain("overflow-x:auto");
	});

	test("frames without filling: shared hairline, clipped corners, banded header", () => {
		const css = sheet();
		expect(css).toContain(
			".otta-table-card { border: 1px solid rgba(128, 128, 128, 0.35); border-radius: 8px; " +
				"overflow: hidden; }",
		);
		// An alpha over whatever is behind it, so one value serves both grounds.
		expect(css).toContain(".otta-table-card thead tr { background: rgba(128, 128, 128, 0.06); }");
		// The card edge is the last line; a rule under the last row would double it.
		expect(css).toContain(".otta-table-card tbody tr:last-child .otta-td { border-block-end: 0; }");
	});

	test("insets the outer cells, and tightens them on a narrow viewport", () => {
		const css = sheet();
		expect(css).toContain(
			".otta-table-card :is(.otta-th, .otta-td):first-child { padding-inline-start: 16px; }",
		);
		expect(css).toContain(
			".otta-table-card :is(.otta-th, .otta-td):last-child { padding-inline-end: 16px; }",
		);
		expect(css).toContain(
			"@media (max-width: 599px) { .otta-table-card :is(.otta-th, .otta-td):first-child " +
				"{ padding-inline-start: 12px; }",
		);
		// Logical, not physical: the console is RTL-capable and the inset has to
		// follow the writing direction rather than the screen's left edge.
		expect(css).not.toContain("padding-left: 16px");
	});
});

describe("the state pill", () => {
	test.each([
		["ok", OK_ACCENT],
		["warn", WARN_ACCENT],
		["fail", FAIL_ACCENT],
	] as const)("spends the %s accent on the border and nowhere else", (tone, accent) => {
		const html = renderToStaticMarkup(<StatusPill tone={tone}>Out of stock</StatusPill>);
		expect(html).toContain(`border:1px solid ${accent}`);
		// Measured, not preferred: each accent fails 4.5:1 as text against one
		// ground or the other, and clears 3:1 as a border against both. One
		// occurrence means the accent reached `border` and nothing else.
		expect(html.split(accent).length - 1).toBe(1);
		expect(html).toContain("color:currentColor");
	});

	test("wraps the phrase it is given and never composes one", () => {
		const html = renderToStaticMarkup(<StatusPill tone="fail">Out of stock</StatusPill>);
		expect(html).toContain(">Out of stock<");
		expect(html).toContain('data-tone="fail"');
		// Transparent fill: a filled pill would need a foreground this file is not
		// allowed to pick.
		expect(html).toContain("background:transparent");
	});
});

describe("Copy stops being the heaviest ink in the row", () => {
	test("the reveal is opacity, so the control never leaves the tab order", () => {
		const css = sheet();
		expect(css).toContain(".otta-copy-reveal { opacity: 0; }");
		// `visibility: hidden` and `display: none` both remove the button from the
		// tab order, which would make a hover-revealed control unreachable by
		// keyboard — a new defect, not a fix.
		expect(css).not.toContain(".otta-copy-reveal { visibility");
		expect(css).not.toContain(".otta-copy-reveal { display");
		expect(css).toContain(
			".otta-row:hover .otta-copy-reveal, .otta-row:focus-within .otta-copy-reveal, " +
				".otta-copy-reveal:focus-visible { opacity: 0.85; }",
		);
		// Touch has no hover; an invisible but tappable control is worse than a
		// visible one.
		expect(css).toContain("@media (hover: none) { .otta-copy-reveal { opacity: 0.85; } }");
	});

	test("is a prop, and it hands opacity to the sheet when it is on", () => {
		const revealed = renderToStaticMarkup(
			<CopyIdButton id="APR-LIN-NAT" what="SKU" revealOnRowHover />,
		);
		const always = renderToStaticMarkup(<CopyIdButton id="APR-LIN-NAT" what="SKU" />);
		expect(revealed).toContain("otta-copy-reveal");
		// An inline opacity would outrank every reveal trigger in the sheet.
		expect(revealed).not.toContain("opacity:0.85");
		// The detail call sites sit in an identity strip with no row to hover, so
		// they keep the steady control they have.
		expect(always).not.toContain("otta-copy-reveal");
		expect(always).toContain("opacity:0.85");
		// The accessible name names the value either way.
		expect(revealed).toContain('aria-label="Copy SKU APR-LIN-NAT"');
	});
});

describe("the confirm dialog", () => {
	test("the confirm button — and only it — is destructive by default", () => {
		// Two of the three live confirms — removing stock, and leaving with unsaved
		// work — are correctly destructive and pass nothing. Flipping this default
		// would de-weight both of them.
		const html = renderToStaticMarkup(
			<ConfirmDialog {...CONFIRM} onConfirm={noop} onDeny={noop} />,
		);
		expect(tagFor(html, "otta-confirm-yes")).toContain(`border-color:${FAIL_ACCENT}`);
		expect(tagFor(html, "otta-confirm-yes")).toContain("font-weight:600");
		// ON THE BUTTON THAT DOES THE THING. Weight on the way out reads as `Cancel`
		// being the dangerous answer, and a whole-markup match cannot tell the two
		// apart — this dialog has exactly one destructive control.
		expect(tagFor(html, "otta-confirm-deny")).not.toContain(FAIL_ACCENT);
		expect(html.split(FAIL_ACCENT).length - 1).toBe(1);
	});

	test("an additive confirm can opt out of destructive weight", () => {
		const html = renderToStaticMarkup(
			<ConfirmDialog {...CONFIRM} confirmTone="neutral" onConfirm={noop} onDeny={noop} />,
		);
		expect(tagFor(html, "otta-confirm-yes")).not.toContain(FAIL_ACCENT);
		expect(tagFor(html, "otta-confirm-yes")).not.toContain("font-weight:600");
		expect(html).not.toContain(FAIL_ACCENT);
		expect(html).toContain(">Yes, add 100<");
		// Only the weight changes; the sentence and the way out are untouched.
		expect(html).toContain(">Cancel<");
	});

	test("the backdrop separates on both grounds, and the modal is centred", () => {
		const css = sheet();
		// A 10% black wash — the browser default, and what shipped, because no
		// backdrop rule existed anywhere — cannot dim an already-near-black page.
		expect(css).toContain(
			".otta-dialog::backdrop { background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px); }",
		);
		// The blur destroys detail rather than luminance, which is what makes one
		// rule work in dark as well as light; it degrades to the plain wash where
		// unsupported.
		expect(css).toContain("blur(2px)");
		// The host reset zeroes the user-agent margin a modal dialog centres with,
		// which pinned the dialog to the top-left corner over the sidebar.
		expect(css).toContain(".otta-dialog { margin: auto; }");
	});
});
