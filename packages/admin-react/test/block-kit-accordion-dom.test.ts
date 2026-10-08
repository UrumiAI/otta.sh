/**
 * @vitest-environment happy-dom
 *
 * The Block Kit accordion sheet is mounted once, into `<head>`, and only ever
 * once — the console module is imported by EmDash's generated registry, and a
 * hot reload or a second import must not stack copies of it (a hot reload
 * refreshes the one copy's text).
 */
import { afterEach, expect, test } from "vitest";

import {
	BLOCK_KIT_ACCORDION_STYLE_ID,
	BLOCK_KIT_ACCORDION_STYLES,
	mountBlockKitAccordionStyles,
	OTTA_CURRENT_PAGE_LINK,
	OTTA_PAGE_SCOPE,
} from "../src/block-kit-accordion.js";

afterEach(() => {
	document.getElementById(BLOCK_KIT_ACCORDION_STYLE_ID)?.remove();
});

test("mounts the sheet into head once", () => {
	mountBlockKitAccordionStyles(document);
	mountBlockKitAccordionStyles(document);
	const sheets = document.head.querySelectorAll(`#${BLOCK_KIT_ACCORDION_STYLE_ID}`);
	expect(sheets).toHaveLength(1);
	expect(sheets[0]?.textContent).toBe(BLOCK_KIT_ACCORDION_STYLES);
});

test("a re-mount (hot reload) refreshes a stale sheet instead of keeping it", () => {
	const stale = document.createElement("style");
	stale.id = BLOCK_KIT_ACCORDION_STYLE_ID;
	stale.textContent = "/* an older revision */";
	document.head.append(stale);
	mountBlockKitAccordionStyles(document);
	const sheets = document.head.querySelectorAll(`#${BLOCK_KIT_ACCORDION_STYLE_ID}`);
	expect(sheets).toHaveLength(1);
	expect(sheets[0]?.textContent).toBe(BLOCK_KIT_ACCORDION_STYLES);
});

test("a document-less environment is a no-op", () => {
	expect(() => mountBlockKitAccordionStyles(undefined)).not.toThrow();
});

test("every rule is scoped to the otta plugin's pages and to Block Kit accordions", () => {
	// Each rule needs BOTH halves: the page scope (the sidebar link to an
	// `otta` plugin page is the current one) so other plugins' Block Kit pages,
	// dashboard widgets and editor panels keep EmDash's look, and the attribute
	// @emdash-cms/blocks' accordion sets so the rest of an Otta page does too.
	const selectors = [...BLOCK_KIT_ACCORDION_STYLES.matchAll(/([^{}]+)\{/g)]
		.map((m) => (m[1] ?? "").trim())
		.filter((sel) => !sel.startsWith("@media"));
	expect(selectors.length).toBeGreaterThan(5);
	for (const sel of selectors) {
		for (const part of sel.split(/,(?![^(]*\))/)) {
			expect(part.trim().startsWith(OTTA_PAGE_SCOPE)).toBe(true);
			expect(part).toContain('[data-testid="collapsible"]');
		}
	}
});

test("the scope matches an otta page and nothing else", () => {
	// The page scope is `:root:has(<this link>)`; happy-dom cannot evaluate
	// `:has()`, so the link half is checked directly (the whole scope was checked
	// in Chromium against the EmDash 1.0.1 admin).
	expect(OTTA_PAGE_SCOPE).toBe(`:root:has(${OTTA_CURRENT_PAGE_LINK})`);
	const link = document.createElement("a");
	link.setAttribute("aria-current", "page");
	document.body.append(link);
	try {
		const cases: [string, boolean][] = [
			["/_emdash/admin/plugins/otta/reports", true],
			["/_emdash/admin/plugins/otta/settings", true],
			["/_emdash/admin/plugins/otta-console/orders", false],
			["/_emdash/admin/plugins/forms/", false],
			["/_emdash/admin/", false],
		];
		for (const [href, matches] of cases) {
			link.setAttribute("href", href);
			expect(link.matches(OTTA_CURRENT_PAGE_LINK), href).toBe(matches);
		}
		link.removeAttribute("aria-current");
		link.setAttribute("href", "/_emdash/admin/plugins/otta/reports");
		expect(link.matches(OTTA_CURRENT_PAGE_LINK)).toBe(false);
	} finally {
		link.remove();
	}
});

/** The deepest `:has(` nesting in a selector (1 = a plain `:has()`). */
function maxHasDepth(selector: string): number {
	// Track, for each open paren, whether it opened a `:has(`.
	const stack: boolean[] = [];
	let max = 0;
	for (let i = 0; i < selector.length; i++) {
		const ch = selector[i];
		if (ch === "(") {
			stack.push(selector.slice(Math.max(0, i - 4), i) === ":has");
			max = Math.max(max, stack.filter(Boolean).length);
		} else if (ch === ")") {
			stack.pop();
		}
	}
	return max;
}

test("no selector nests a :has() inside another :has()", () => {
	// CSS forbids it, and the browser drops the WHOLE rule that tries — the
	// grouped-list rules once vanished this way while every string check here
	// still passed. Guard the generated sheet, not the source spelling.
	expect(maxHasDepth(":root:has(a) div:has(> b):has(+ c)")).toBe(1);
	expect(maxHasDepth("div:has(> a:has(> b))")).toBe(2);
	const selectors = [...BLOCK_KIT_ACCORDION_STYLES.matchAll(/([^{}]+)\{/g)]
		.map((m) => (m[1] ?? "").trim())
		.filter((sel) => !sel.startsWith("@media"));
	for (const sel of selectors) {
		expect(maxHasDepth(sel), sel).toBeLessThanOrEqual(1);
	}
});

test("motion is dropped under prefers-reduced-motion", () => {
	expect(BLOCK_KIT_ACCORDION_STYLES).toMatch(
		/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none;/,
	);
});
