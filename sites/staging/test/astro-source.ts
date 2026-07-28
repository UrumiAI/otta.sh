/**
 * Reading `.astro` files as SOURCE TEXT, once.
 *
 * Three suites need the same two questions answered — "where does the
 * frontmatter end?" and "does this file actually run code in the browser?" —
 * and each had grown its own answer. That is a bad place for three copies:
 * `checkout-client-js.test.ts` is a security fence (ADR-0012 decision 2), and a
 * fence whose definition of "a script" differs from the next file's is a fence
 * with a hole in it.
 *
 * Not a `.test.ts`, deliberately: `vitest.config.ts` collects `test/**` /`*`
 * `.test.ts` only, so this is a plain module the suites import.
 */

export interface AstroParts {
	/** Server-side TypeScript. Never reaches the browser. */
	frontmatter: string;
	/** The template that becomes markup — including any `<script>` in it. */
	body: string;
}

/**
 * Split an `.astro` file at its frontmatter fence.
 *
 * This is a REAL boundary, not a convenience: everything above the closing
 * `---` runs on the server and everything below becomes markup, so "can this
 * value reach the browser?" and "does this file ship code?" are both questions
 * about the body alone.
 */
export function splitAstro(source: string): AstroParts {
	const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
	if (fence === null) return { frontmatter: "", body: source };
	return { frontmatter: fence[1] ?? "", body: source.slice(fence[0].length) };
}

/**
 * The template with its COMMENTS removed — HTML comments and Astro's
 * `{/* … *\/}` expression comments both.
 *
 * The reason is a real bug this file exists to prevent rather than a tidiness
 * argument. `PollRibbon`'s whole purpose is to be the ribbon that does NOT ship
 * a script, and saying so in prose used to trip the very fence that guarantees
 * it — four assertions failed on a component that was, and is, correct. A
 * security test that cannot be described in a comment teaches people to write
 * vaguer comments, which is exactly backwards.
 */
export function templateOf(source: string): string {
	return splitAstro(source)
		.body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Does this file RUN code in the buyer's browser?
 *
 * Two ways it can, and both count:
 *
 *  - an executable `<script>` — i.e. not a data block like
 *    `type="application/ld+json"`, which carries no code;
 *  - a `client:*` directive, which hydrates a framework component and pulls a
 *    runtime with it. Nothing in this theme uses one today, which is precisely
 *    why the fence should notice the first one to arrive.
 *
 * Comments are stripped first (see `templateOf`).
 */
export function hasExecutableScript(source: string): boolean {
	const template = templateOf(source);
	for (const match of template.matchAll(/<script\b([^>]*)>/g)) {
		const attrs = match[1] ?? "";
		if (/type\s*=\s*["']application\/(ld\+json|json)["']/.test(attrs)) continue;
		return true;
	}
	return /\bclient:(load|idle|visible|media|only)\b/.test(template);
}
