/**
 * JSON-LD stored-XSS regression (review blocker): the PDP embeds the
 * plugin's jsonLd object in a <script type="application/ld+json"> via
 * set:html — set:html is REQUIRED (HTML-escaping the JSON breaks the
 * graph) but plain JSON.stringify lets a CMS-authored title/description
 * containing "</script>" break out of the script tag and execute markup on
 * the public PDP. The fix is em-dash's own safeJsonLdSerialize
 * (emdash/page), which escapes <, >, U+2028/U+2029.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeJsonLdSerialize } from "emdash/page";
import { describe, expect, test } from "vitest";

const PDP_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/pages/products/[slug].astro",
);

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

	test("the PDP page uses safeJsonLdSerialize, never bare JSON.stringify in set:html", () => {
		const source = readFileSync(PDP_PATH, "utf8");
		expect(source).toContain("safeJsonLdSerialize");
		expect(source).not.toMatch(/set:html=\{JSON\.stringify/);
	});
});
