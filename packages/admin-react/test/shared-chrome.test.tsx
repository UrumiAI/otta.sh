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
	Group,
	INTERACTIVE_DESCENDANT_SELECTOR,
	ROW_ID_ATTRIBUTE,
	StatusPill,
	Table,
	rowActivationId,
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
		expect(css).toMatch(/\.otta-btn \{[^}]*cursor: pointer;/);
		expect(css).toContain(
			`.otta-row[${ROW_ID_ATTRIBUTE}] :is(${CURSOR_RESET_DESCENDANT_SELECTOR}) { cursor: auto; }`,
		);
		expect(css).not.toContain("!important");
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

	test("frames in EmDash's own card: line border, lg radius, tinted header band", () => {
		const css = sheet();
		// EmDash's list tables are `rounded-lg border bg-kumo-base` with a
		// `bg-kumo-tint/50` header row — read from the admin's own tokens, so the
		// card follows light and dark with the rest of the admin.
		expect(css).toContain(".otta-table-card { border: 1px solid var(--color-kumo-line");
		expect(css).toMatch(/\.otta-table-card \{[^}]*border-radius: 8px;[^}]*overflow: hidden;/);
		expect(css).toMatch(/\.otta-table-card \{[^}]*background: var\(--color-kumo-base/);
		expect(css).toMatch(
			/\.otta-table-card thead tr \{ background: color-mix\([^}]*--color-kumo-tint/,
		);
		// The card edge is the last line; a rule under the last row would double it.
		expect(css).toContain(".otta-table-card tbody tr:last-child .otta-td { border-block-end: 0; }");
	});

	test("headers are sentence case in EmDash's medium weight, not a shouting caps bar", () => {
		const th = /\} \.otta-th \{([^}]*)\}/.exec(sheet())?.[1] ?? "";
		expect(th).not.toContain("text-transform");
		expect(th).not.toContain("letter-spacing");
		expect(th).toContain("font-weight: 500");
		expect(th).toContain("font-size: 13px");
	});

	test("a row hover is EmDash's tint, not a fixed grey", () => {
		expect(sheet()).toMatch(/\.otta-row:hover \{ background: color-mix\([^}]*--color-kumo-tint/);
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
		["ok", "--color-kumo-success-tint", "--text-color-kumo-success"],
		["info", "--color-kumo-info-tint", "--text-color-kumo-info"],
		["warn", "--color-kumo-warning-tint", "--text-color-kumo-warning"],
		["fail", "--color-kumo-danger-tint", "--text-color-kumo-danger"],
		["neutral", "--color-kumo-fill", "--text-color-kumo-badge-neutral-subtle"],
	] as const)("the %s tone is EmDash's own badge fill and ink", (tone, fill, ink) => {
		const html = renderToStaticMarkup(<StatusPill tone={tone}>Out of stock</StatusPill>);
		expect(html).toContain(`data-tone="${tone}"`);
		expect(html).toContain('class="otta-pill"');
		const rule = new RegExp(`\\.otta-pill\\[data-tone="${tone}"\\] \\{([^}]*)\\}`).exec(sheet());
		expect(rule?.[1]).toContain(fill);
		expect(rule?.[1]).toContain(ink);
	});

	test("wraps the phrase it is given and never composes one", () => {
		const html = renderToStaticMarkup(<StatusPill tone="fail">Out of stock</StatusPill>);
		expect(html).toContain(">Out of stock<");
		// The colour lives in the sheet, so an inline declaration cannot pin a
		// tone that ignores the theme.
		expect(html).not.toContain("style=");
	});
});

describe("buttons follow EmDash's Kumo button", () => {
	test("the default button is the surface, a line ring and the lg radius", () => {
		const rule = /\.otta-btn \{([^}]*)\}/.exec(sheet())?.[1] ?? "";
		expect(rule).toContain("background: var(--color-kumo-base");
		expect(rule).toContain("border: 1px solid var(--color-kumo-line");
		expect(rule).toContain("border-radius: 8px");
		expect(rule).toContain("font-weight: 500");
		expect(rule).toContain("cursor: pointer");
	});

	test("primary is the brand blue and destructive is the danger red", () => {
		const css = sheet();
		expect(css).toMatch(
			/\.otta-btn\[data-variant="primary"\] \{[^}]*background: var\(--color-kumo-brand/,
		);
		expect(css).toMatch(
			/\.otta-btn\[data-variant="destructive"\] \{[^}]*background: var\(--color-kumo-danger/,
		);
		// The quieter in-page danger: red ink on the ordinary surface.
		expect(css).toMatch(
			/\.otta-btn\[data-variant="danger"\] \{[^}]*color: var\(--text-color-kumo-danger/,
		);
	});

	test("a small button is Kumo's sm size", () => {
		expect(sheet()).toMatch(/\.otta-btn\[data-size="sm"\] \{[^}]*block-size: 26px/);
	});
});

describe("a group is a heading and a card, never a dropdown", () => {
	test("renders an always-visible section with its label as a heading", () => {
		const html = renderToStaticMarkup(
			<Group label="Customer" testId="detail-customer">
				<p>body</p>
			</Group>,
		);
		expect(html).not.toContain("<details");
		expect(html).not.toContain("<summary");
		expect(html).toMatch(/^<section[^>]*data-testid="detail-customer"/);
		expect(html).toContain('<h3 class="otta-group-title"');
		expect(html).toContain(">Customer</h3>");
		expect(html).toContain("<p>body</p>");
	});

	test("a group inside a group is a sub-section, not a card in a card", () => {
		const html = renderToStaticMarkup(
			<Group label="Outer">
				<Group label="Inner" testId="inner">
					x
				</Group>
			</Group>,
		);
		expect(html).toMatch(
			/<section[^>]*class="otta-group"[^>]*data-nested="true"[^>]*data-testid="inner"/,
		);
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
		expect(tagFor(html, "otta-confirm-yes")).toContain('data-variant="destructive"');
		// ON THE BUTTON THAT DOES THE THING. Weight on the way out reads as `Cancel`
		// being the dangerous answer — this dialog has exactly one weighted control.
		expect(tagFor(html, "otta-confirm-deny")).not.toContain("data-variant");
		expect(html.split("data-variant=").length - 1).toBe(1);
	});

	test("an additive confirm is EmDash's primary, not destruction", () => {
		const html = renderToStaticMarkup(
			<ConfirmDialog {...CONFIRM} confirmTone="neutral" onConfirm={noop} onDeny={noop} />,
		);
		expect(tagFor(html, "otta-confirm-yes")).toContain('data-variant="primary"');
		expect(html).not.toContain('data-variant="destructive"');
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

describe("a copy button over a natural key", () => {
	test("names what it copies, so a SKU is not announced as an order id", () => {
		// §1.3 exempts a natural key, so a SKU is copied rendered in full rather
		// than as the full form of a truncated uuid. A screen-reader user must hear
		// the right noun.
		const html = renderToStaticMarkup(<CopyIdButton id="APR-LIN-NAT" what="SKU" />);
		expect(html).toContain('aria-label="Copy SKU APR-LIN-NAT"');
		expect(html).toContain('data-full-id="APR-LIN-NAT"');
	});
});

/**
 * ROW ACTIVATION over a cell whose content is a code (F11). The guards
 * themselves are pinned in the Orders suite; what matters here is that a `code`
 * cell survives them — it must be selectable AND activatable, and the copy
 * button beside it must be neither.
 */
describe("row activation and a code cell", () => {
	const cell = (tag: string, inControl: string | null) => ({
		closest: (selectors: string) => {
			const wanted = selectors.split(",").map((raw) => raw.trim());
			if (wanted.includes(`[${ROW_ID_ATTRIBUTE}]`)) return row;
			if (inControl !== null && wanted.includes(inControl)) return row;
			return wanted.includes(tag) ? row : null;
		},
		getAttribute: () => "prod_41c",
		contains: () => false,
	});
	const row = {
		closest: () => row,
		getAttribute: (name: string) => (name === ROW_ID_ATTRIBUTE ? "prod_41c" : null),
		contains: () => false,
	};
	const STEADY = {
		modified: false,
		origin: { x: 10, y: 10 },
		point: { x: 10, y: 10 },
		selection: null,
	} as const;

	test("clicking the code opens the row; clicking Copy beside it does not", () => {
		// `code` is deliberately not exempt: exempting it would make the one cell
		// an operator most needs the one cell that does nothing.
		expect(rowActivationId(cell("code", null), STEADY)).toBe("prod_41c");
		expect(rowActivationId(cell("span", "button"), STEADY)).toBeNull();
		expect(rowActivationId(cell("span", "a"), STEADY)).toBeNull();
	});

	test("the pointer stops at the row's controls", () => {
		const css = sheet();
		// Scoped to rows that actually activate, so the detail tables — same
		// `Table`, no callback, no row id — keep the default cursor.
		expect(css).toContain(`.otta-row[${ROW_ID_ATTRIBUTE}] { cursor: pointer; }`);
		expect(INTERACTIVE_DESCENDANT_SELECTOR).not.toContain("code");
		// The drill-in link goes to the same destination the row does, so it
		// keeps the row's pointer instead of falling back to auto with the rest.
		expect(CURSOR_RESET_DESCENDANT_SELECTOR.split(", ")).not.toContain("a");
		expect(INTERACTIVE_DESCENDANT_SELECTOR.split(", ")).toContain("a");
	});
});
