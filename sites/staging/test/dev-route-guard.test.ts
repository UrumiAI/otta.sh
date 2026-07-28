/**
 * The styleguide route is DEV ONLY.
 *
 * `src/pages/dev/tempered.astro` renders every theme component in every state,
 * which is how increments 3–6 and their reviewers look at them before they are
 * wired into a page. It must never be reachable on a deployed store: it is
 * unfinished-looking by design, it names states no shopper should be shown out
 * of context, and a route nobody thinks about is a route nobody maintains.
 *
 * `import.meta.env.DEV` is folded to a constant by Vite, so in a built worker
 * the guard becomes `if (true) return 404` and the whole page body is dead code
 * the bundler drops — the strongest exclusion available without a second build
 * config. This test is what stops that guard being weakened to a runtime check,
 * an env var, or nothing at all.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages");
const GUIDE = path.join(PAGES_DIR, "dev/tempered.astro");
const source = readFileSync(GUIDE, "utf8");
/** The frontmatter only — the guard has to run before anything renders. */
const frontmatter = source.slice(0, source.indexOf("\n---", 3));

describe("the styleguide route", () => {
	test("404s outside dev, and does so in the frontmatter", () => {
		expect(frontmatter).toContain("import.meta.env.DEV");
		expect(frontmatter).toMatch(/if \(!import\.meta\.env\.DEV\)\s*return new Response\(/);
		expect(frontmatter).toContain("status: 404");
	});

	test("the guard is the FIRST statement to run — nothing renders ahead of it", () => {
		const guard = frontmatter.indexOf("import.meta.env.DEV");
		const body = frontmatter.slice(guard);
		// Only inert declarations may follow; nothing may precede it except
		// imports.
		const before = frontmatter.slice(0, guard);
		expect(before.split("\n").filter((line) => /^\s*(const|let|await|if)\b/.test(line))).toEqual(
			[],
		);
		expect(body).not.toContain("Astro.redirect");
	});

	test("is folded at BUILD time, not decided at request time", () => {
		// An env var or a header check would ship the page to production and
		// rely on configuration to hide it.
		expect(frontmatter).not.toMatch(/process\.env|Astro\.request\.headers|locals\.runtime/);
	});

	test("makes no commerce call — a styleguide cannot rot against the service", () => {
		expect(source).not.toContain("dispatchUrumiRoute");
		expect(source).not.toContain("getPublicPluginApiRouteHandler");
	});

	test("nothing else lives under /dev", () => {
		// If this grows, each new route needs its own guard and its own reason.
		expect(readdirSync(path.join(PAGES_DIR, "dev"))).toEqual(["tempered.astro"]);
	});
});
