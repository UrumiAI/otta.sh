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
 * **What it does NOT check, stated plainly: the case BODIES.** It compares title sets
 * and nothing else, so a domain-side edit to a copied case's assertions passes here.
 * That residual is why the copy's own rule is "the only edits it may receive are
 * DELETIONS", and why the staging's end state is a deletion rather than a long life:
 * the guard catches a case that was added, removed or renamed, not one that was
 * rewritten in place.
 *
 * INC-B3 un-todo'd 13 cases (copying each body verbatim); of the 33 that remain, 32
 * are INC-B4's and one is NOT COVERAGE at all — the forced-rollback case, which cannot
 * be driven on a document store. So the suffix this file accepts is either
 * `— lands in INC-B4` (optionally with a parenthesized reason) or an explicit
 * `— not coverage: …`, and nothing else.
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

/**
 * The marker a todo name must end with: either the owning increment (optionally
 * followed by a parenthesized note saying what the case is waiting for), or an
 * explicit `not coverage: <reason>` for the one case that will never become real here
 * — the property it pins cannot be driven on a document store at all, so naming an
 * increment would promise work nobody should do.
 */
const TODO_SUFFIX = / — (?:lands in INC-B4(?: \([^)]*\))?|not coverage: .+)$/;

/** Every `test.todo("…")` title, exactly as registered (the marker still attached). */
function todoSourceTitles(source: string): string[] {
	return [...source.matchAll(/\btest\.todo\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

/** The same, reduced to the DOMAIN title the todo stands in for. */
function todoTitles(source: string): string[] {
	return todoSourceTitles(source).map((title) => title.replace(TODO_SUFFIX, ""));
}

describe("staged order contract slices do not drift from the domain suites", () => {
	const staged = read(STAGED);
	const stagedTodos = todoTitles(staged);
	// `\btest\(` does NOT match `test.todo(` — the `(` has to follow `test`
	// immediately — so the two scans are already disjoint and no subtraction is
	// needed. This filter exists only to keep the two sets disjoint if a future
	// spelling (`test . todo`, a renamed wrapper) ever made `activeTitles` pick a
	// todo up, and it compares titles EXACTLY: a `startsWith` test would quietly
	// swallow any active case whose title merely begins with a todo's, which is a
	// real hazard here (several domain titles share a long prefix).
	const stagedActive = activeTitles(staged).filter((title) => !stagedTodos.includes(title));

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
		const todoSource = todoSourceTitles(staged);
		for (const title of todoSource) {
			expect(title, `todo without an owning increment: ${title}`).toMatch(TODO_SUFFIX);
		}
		// The two halves of the staging, in the proportions the evidence publishes:
		// INC-B2's 22 plus INC-B3's 13 (7 of its own, 6 the email-outbox lease made
		// servable), against the 33 that remain — 32 the lists increment owes, and one
		// that is not coverage on this store at all.
		expect(todoSource).toHaveLength(33);
		expect(stagedActive).toHaveLength(35);
	});
});
