/**
 * The drift guard for the one contract copy that survives.
 *
 * `test/order-store-contract-narrowed.ts` carries a COPY of `orderStoreContract`,
 * because the domain's contract suites register every case for the whole port and offer no
 * per-case filter — and FOUR of its cases assert an unanchored `buyer_ref` SUBSTRING that
 * the ratified prefix-only search cannot serve (see that file's docblock). The transition
 * and timeline suites need no copy any more and call the domain's own functions directly.
 * A copy is a drift risk by nature: the domain can edit, add or rename a case and the copy
 * would keep asserting the old one, silently, and the run would stay green.
 *
 * So this file closes the loop from the other side. It reads the ONE domain suite the copy
 * stands in for — `order-store-contract.ts`, now the single authority file — as TEXT,
 * extracts every `test("…")` title, and asserts that the copy's ACTIVE titles plus its
 * `test.todo` names cover exactly that set: no title missing, none invented, none left with
 * a stale spelling. A domain-side edit therefore fails here, in this package, naming the
 * case.
 *
 * It is a text scan on purpose. Importing the suite would register the four blocked cases
 * against a store that cannot serve them, which is the very thing the copy exists to avoid;
 * and the thing at risk is the TITLE, which is text.
 *
 * **What it does NOT check, stated plainly: the case BODIES.** It compares title sets and
 * nothing else, so a domain-side edit to a copied case's assertions passes here. That
 * residual is why the copy's own rule is "the only edits it may receive are DELETIONS": the
 * guard catches a case that was added, removed or renamed, not one that was rewritten in
 * place.
 *
 * **The pins, and the single accepted suffix.** 43 titles must be ACTIVE and 4 must be
 * todos, and every todo name must end with
 * ` — blocked on the ratified search narrowing; needs a [Domain] contract change` — the one
 * form this file accepts. The earlier `— lands in INC-B4` / `— not coverage: …` suffixes are
 * gone with the staging they described: every method is implemented, so a todo here can only
 * ever mean a semantic the storage cannot serve, and the remedy is a `[Domain]` change
 * rather than further adapter work. When that change lands, this file and the copy go away
 * together and `order-store-contract.dialects.test.ts` calls the domain suite directly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The domain source file whose titles are the authority. */
const SUITES = ["order-store-contract.ts"] as const;

const DOMAIN_TESTING = new URL("../../domain/src/testing/", import.meta.url);
const STAGED = new URL("./order-store-contract-narrowed.ts", import.meta.url);

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
 * the call, which is what oxfmt emits for every case in the two files this guard reads
 * (the domain suite and the copy — the transition and timeline copies are gone); a title
 * spelled any other way would show up as a MISSING title rather than being silently
 * skipped, which is the failure direction this guard wants.
 */
function activeTitles(source: string): string[] {
	return [...source.matchAll(/\btest\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

/**
 * The marker a todo name must end with, and there is now exactly ONE accepted form.
 *
 * A todo here no longer means "a later increment will build the method" — every method
 * is built. It means the case asserts a search semantic the ratified narrowing cannot
 * serve, and the remedy is a `[Domain]` change to the port/contract rather than any
 * further adapter work. Spelling that out in the name is what stops the residue from
 * being read as unfinished adapter work and quietly re-owned.
 */
const TODO_SUFFIX =
	/ — blocked on the ratified search narrowing; needs a \[Domain\] contract change$/;

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
		expect(domain.length).toBeGreaterThan(40); // the scan found the suite at all

		const covered = new Set([...stagedActive, ...stagedTodos]);
		const missing = domain.filter((title) => !covered.has(title));
		const invented = [...covered].filter((title) => !domain.includes(title));
		// Named, so a failure says WHICH case moved rather than just how many.
		expect({ missing, invented }).toEqual({ missing: [], invented: [] });
		expect(covered.size).toBe(new Set(domain).size);
	});

	test("every todo names the narrowing that blocks it, and every copied case is active", () => {
		const todoSource = todoSourceTitles(staged);
		for (const title of todoSource) {
			expect(title, `todo without a stated blocker: ${title}`).toMatch(TODO_SUFFIX);
		}
		// The proportions the evidence publishes: 43 of `orderStoreContract`'s 47 cases
		// run against the document store. The 4 that do not are blocked on the buyer_ref
		// arm being a PREFIX rather than the port's unanchored SUBSTRING — a mid-string
		// fragment, a bare `%`/`_`, a bare `\`, and the count taken under that predicate.
		expect(todoSource).toHaveLength(4);
		expect(stagedActive).toHaveLength(43);
	});
});
