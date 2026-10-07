/**
 * `forms/CartLineFields.astro` — the hidden-field contract a cart line's form
 * posts to `/cart/update` and `/cart/remove` from OUTSIDE `/cart` (a theme's
 * bag drawer). No theme this repo ships draws a drawer today, so the partial
 * is rendered here directly rather than through a theme: exactly the two
 * fields the endpoints read, and never a `returnTo` (a change lands on
 * `/cart`, where it is visible — pinned end to end in `bag.test.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";
import CartLineFields from "../src/forms/CartLineFields.astro";
import { SRC } from "./theme-views.js";

const inputs = (html: string): string[] => [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);

describe("CartLineFields", () => {
	test("renders exactly the line id and the page-minted idempotency key, both hidden", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(CartLineFields, {
			props: { lineId: "line-7", idempotencyKey: "key-42" },
		});
		const fields = inputs(html);
		expect(fields).toHaveLength(2);
		expect(fields[0]).toMatch(/type="hidden"/);
		expect(fields[0]).toMatch(/name="lineId"/);
		expect(fields[0]).toMatch(/value="line-7"/);
		expect(fields[1]).toMatch(/type="hidden"/);
		expect(fields[1]).toMatch(/name="idempotencyKey"/);
		expect(fields[1]).toMatch(/value="key-42"/);
		expect(html).not.toContain("returnTo");
	});

	test("escapes what it is handed — a value cannot break out of its attribute", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(CartLineFields, {
			props: { lineId: '"><script>x</script>', idempotencyKey: "k" },
		});
		// The quote is escaped, so the value stays one attribute of one input.
		expect(html).not.toContain('value=""><script>');
		expect(html).toContain("&quot;");
		expect(inputs(html)).toHaveLength(2);
	});

	test("the endpoints it posts to read these field names", () => {
		for (const file of ["pages/cart/update.ts", "pages/cart/remove.ts"]) {
			const source = readFileSync(path.join(SRC, file), "utf8");
			expect(source, file).toContain('"lineId"');
			expect(source, file).toContain('"idempotencyKey"');
		}
	});
});
