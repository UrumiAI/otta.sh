/**
 * The styleguide route is DEV ONLY.
 *
 * `src/pages/dev/tempered.astro` renders every theme component in every state,
 * which is how increments 3–6 and their reviewers look at them before they are
 * wired into a page. It must never be reachable on a deployed store: it is
 * unfinished-looking by design, it names states no shopper should be shown out
 * of context, and a route nobody thinks about is a route nobody maintains.
 *
 * Two separate things have to hold, and the first cut of this suite only
 * checked one of them:
 *
 *  1. THE ROUTE ANSWERS 404. `import.meta.env.DEV` is folded to a constant by
 *     Vite, so the built body is `return new Response(null, { status: 404 })`.
 *     Verified in a real build, on workerd.
 *
 *  2. THE COMPONENTS DO NOT SHIP. Folding the body does NOT drop the page's
 *     dependencies — a static `import` is hoisted above the guard and stays in
 *     the module graph regardless. It did: a 25.9 kB server chunk of component
 *     code, plus a 10.3 kB `tempered.*.css` that no page linked, both shipped
 *     and neither was reachable. The fix is a dynamic `import()` inside the
 *     dead branch, and this suite pins that shape, because a static import
 *     here would put both chunks back with nothing failing.
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

describe("the styleguide route — the 404", () => {
	test("404s outside dev, and does so in the frontmatter", () => {
		expect(frontmatter).toContain("import.meta.env.DEV");
		expect(frontmatter).toMatch(/if \(!import\.meta\.env\.DEV\)\s*return new Response\(/);
		expect(frontmatter).toContain("status: 404");
	});

	test("the guard is the FIRST statement to run — nothing renders ahead of it", () => {
		const guard = frontmatter.indexOf("import.meta.env.DEV");
		// Only inert declarations may follow; nothing may precede it except
		// imports.
		const before = frontmatter.slice(0, guard);
		expect(before.split("\n").filter((line) => /^\s*(const|let|await|if)\b/.test(line))).toEqual(
			[],
		);
		expect(frontmatter.slice(guard)).not.toContain("Astro.redirect");
	});

	test("is folded at BUILD time, not decided at request time", () => {
		// An env var or a header check would ship the page to production and
		// rely on configuration to hide it.
		expect(frontmatter).not.toMatch(/process\.env|Astro\.request\.headers|locals\.runtime/);
	});
});

describe("the styleguide route — the components must not ship with it", () => {
	/** Every module the frontmatter pulls in with a hoisted static import. */
	const staticImports = [...frontmatter.matchAll(/^import\s[^\n]*?from\s+["']([^"']+)["']/gm)].map(
		(m) => m[1] ?? "",
	);

	test("no component is imported statically — a static import outlives the guard", () => {
		const leaked = staticImports.filter((specifier) => specifier.includes("/components/"));
		expect(leaked, "these would ship a server chunk and an orphan stylesheet").toEqual([]);
	});

	test("the components arrive through a dynamic import INSIDE the dead branch", () => {
		const guard = frontmatter.indexOf("import.meta.env.DEV");
		const afterGuard = frontmatter.slice(guard);
		const dynamic = [...afterGuard.matchAll(/import\(["']([^"']+)["']\)/g)].map((m) => m[1] ?? "");
		expect(dynamic.length).toBeGreaterThan(0);
		for (const specifier of dynamic) expect(specifier).toContain("/components/");
	});

	test("every component the page renders came from that block", () => {
		// A component used in the template but imported some other way would
		// defeat the whole arrangement.
		const dynamic = new Set(
			[...frontmatter.matchAll(/import\(["'][^"']*\/components\/(\w+)\.astro["']\)/g)].map(
				(m) => m[1],
			),
		);
		const used = new Set(
			[...source.slice(source.indexOf("\n---", 3)).matchAll(/<([A-Z]\w*)[\s/>]/g)].map((m) => m[1]),
		);
		// `Base` is the layout — it is on every real page anyway, so importing
		// it statically costs this route nothing.
		used.delete("Base");
		used.delete("Fragment");
		for (const name of used)
			expect(dynamic, `<${name}> is not dynamically imported`).toContain(name);
	});

	test("the layout is still static — it is not this route's weight to carry", () => {
		expect(staticImports.some((specifier) => specifier.includes("layouts/Base.astro"))).toBe(true);
	});
});

describe("the styleguide route — housekeeping", () => {
	test("makes no commerce call — a styleguide cannot rot against the service", () => {
		expect(source).not.toContain("dispatchUrumiRoute");
		expect(source).not.toContain("getPublicPluginApiRouteHandler");
	});

	test("nothing else lives under /dev", () => {
		// If this grows, each new route needs its own guard and its own reason.
		expect(readdirSync(path.join(PAGES_DIR, "dev"))).toEqual(["tempered.astro"]);
	});
});
