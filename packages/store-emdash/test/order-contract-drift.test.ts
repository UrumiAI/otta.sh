/**
 * The drift guard for the staged contract slices.
 *
 * `test/order-contract-b2.ts` carries a COPY of the cases INC-B2 owns, because the
 * domain's contract suites register every case for the whole port and offer no
 * per-case filter (see that file's docblock). A copy is a drift risk by nature: the
 * domain can edit, add or rename a case and the copy would keep asserting the old
 * one, silently, and the run would stay green.
 *
 * So this file closes the loop from the other side. It reads the three domain
 * contract suites as TEXT, extracts every `test("…")` title, and asserts that the
 * staged file's ACTIVE titles plus its `test.todo` names cover exactly that set —
 * no title missing, none invented, none left with a stale spelling. A domain-side
 * edit therefore fails here, in this package, naming the case.
 *
 * It is a text scan on purpose. Importing the suites would register all 68 cases
 * against a store that cannot serve most of them yet, which is the very thing the
 * staging exists to avoid; and the thing at risk is the TITLE, which is text.
 *
 * When INC-B4 lands the last method, this file and the staged copy go away together:
 * the three `.dialects.test.ts` files call the domain suites directly and there is no
 * copy left to drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The domain source files whose titles are the authority. */
const SUITES = [
	"order-store-contract.ts",
	"order-transition-contract.ts",
	"order-timeline-contract.ts",
] as const;

const DOMAIN_TESTING = new URL("../../domain/src/testing/", import.meta.url);
const STAGED = new URL("./order-contract-b2.ts", import.meta.url);

/**
 * Read a file relative to this test, as text, with comments removed.
 *
 * Stripping comments is not cosmetic: every one of these files DOCUMENTS the
 * `test(`/`test.todo(` shapes in its own docblock, so a scan over raw text would
 * pick a docblock's example up as a registered case.
 */
function read(url: URL): string {
	return readFileSync(fileURLToPath(url), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every title registered by `test("…")` in a source text.
 *
 * The pattern deliberately accepts only a double-quoted literal on the same line as
 * the call, which is what oxfmt emits for every case in all four files; a title
 * spelled any other way would show up as a MISSING title rather than being silently
 * skipped, which is the failure direction this guard wants.
 */
function activeTitles(source: string): string[] {
	return [...source.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

/** Every title registered by `test.todo("…")`, with the increment suffix stripped. */
function todoTitles(source: string): string[] {
	return [...source.matchAll(/\btest\.todo\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
		(m[1] ?? "").replace(/ — lands in INC-B[34]$/, ""),
	);
}

describe("staged order contract slices do not drift from the domain suites", () => {
	const staged = read(STAGED);
	// `test.todo(` also matches `test(`, so the active set is the difference.
	const stagedTodos = todoTitles(staged);
	const stagedActive = activeTitles(staged).filter(
		(title) => !stagedTodos.some((todo) => title.startsWith(todo)),
	);

	test("every domain case is either copied or registered as a named todo, and nothing else is", () => {
		const domain = SUITES.flatMap((name) => activeTitles(read(new URL(name, DOMAIN_TESTING))));
		expect(domain.length).toBeGreaterThan(60); // the scan found the suites at all

		const covered = new Set([...stagedActive, ...stagedTodos]);
		const missing = domain.filter((title) => !covered.has(title));
		const invented = [...covered].filter((title) => !domain.includes(title));
		// Named, so a failure says WHICH case moved rather than just how many.
		expect({ missing, invented }).toEqual({ missing: [], invented: [] });
		expect(covered.size).toBe(new Set(domain).size);
	});

	test("every todo names the increment that owns it, and every copied case is active", () => {
		const todoSource = [...staged.matchAll(/\btest\.todo\(\s*"((?:[^"\\]|\\.)*)"/g)].map(
			(m) => m[1] ?? "",
		);
		for (const title of todoSource) {
			expect(title, `todo without an owning increment: ${title}`).toMatch(/ — lands in INC-B[34]$/);
		}
		// The two halves of the staging, in the proportions the evidence publishes.
		expect(todoSource).toHaveLength(46);
		expect(stagedActive).toHaveLength(22);
	});
});
