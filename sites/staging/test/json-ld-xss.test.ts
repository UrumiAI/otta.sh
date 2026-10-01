/**
 * JSON-LD stored-XSS regression (review blocker): the PDP embeds the
 * plugin's jsonLd object in a <script type="application/ld+json"> via
 * set:html — set:html is REQUIRED (HTML-escaping the JSON breaks the
 * graph) but plain JSON.stringify lets a CMS-authored title/description
 * containing "</script>" break out of the script tag and execute markup on
 * the public PDP. The fix is em-dash's own safeJsonLdSerialize
 * (emdash/page), which escapes <, >, U+2028/U+2029.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeJsonLdSerialize } from "emdash/page";
import { describe, expect, test } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PDP_PATH = path.join(SRC, "pages/products/[slug].astro");
/** The one component that emits JSON-LD, rendered by the Storefront shell. */
const JSON_LD_PATH = path.join(SRC, "components/SafeJsonLd.astro");
const SHELL_PATH = path.join(SRC, "layouts/Storefront.astro");

describe("PDP JSON-LD serialization", () => {
	test("a </script>-bearing CMS title cannot break out of the script tag", () => {
		const jsonLd = {
			"@type": "Product",
			name: "</script><img src=x onerror=alert(1)>",
			description: "pwned via <!-- comment --> and    line terminators",
		};
		const serialized = safeJsonLdSerialize(jsonLd);

		// The breakout vectors must be gone in the raw output...
		expect(serialized).not.toContain("</script>");
		expect(serialized).not.toContain("<!--");
		expect(serialized).not.toContain(" ");
		expect(serialized).not.toContain(" ");
		// ...while the JSON stays semantically identical.
		expect(JSON.parse(serialized)).toEqual(jsonLd);
	});

	test("the JSON-LD emitter uses safeJsonLdSerialize, never bare JSON.stringify in set:html", () => {
		// The emission moved out of the PDP into one component the SHELL renders,
		// so no theme can drop the graph or re-serialize it unsafely.
		const source = readFileSync(JSON_LD_PATH, "utf8");
		expect(source).toContain("set:html={safeJsonLdSerialize(data)}");
		expect(source).not.toMatch(/set:html=\{JSON\.stringify/);
	});

	test("the PDP hands the route's jsonLd to the shell, which emits it through that component", () => {
		const pdp = readFileSync(PDP_PATH, "utf8");
		expect(pdp).toMatch(/const jsonLd = result !== null && result\.ok \? result\.jsonLd : null/);
		expect(pdp).toMatch(/<Storefront[\s\S]*?jsonLd=\{jsonLd\}/);
		expect(pdp).not.toMatch(/set:html=/);
		const shell = readFileSync(SHELL_PATH, "utf8");
		expect(shell).toContain('import SafeJsonLd from "../components/SafeJsonLd.astro"');
		expect(shell).toMatch(/<SafeJsonLd data=\{jsonLd\} \/>/);
	});

	test("no file anywhere under src/ bypasses that component with its own set:html JSON", () => {
		// Every source file under src/, whatever its directory — only the one
		// component may name the script type.
		const allowed = new Set([path.relative(SRC, JSON_LD_PATH)]);
		const files = (readdirSync(SRC, { recursive: true }) as string[]).filter(
			(file) => /\.(astro|ts|tsx|js|mjs)$/.test(file) && !allowed.has(file),
		);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = readFileSync(path.join(SRC, file), "utf8");
			expect(source, file).not.toMatch(/application\/ld\+json/);
		}
	});
});
