/**
 * The document `<title>` every storefront page gets (`layouts/Storefront.astro`).
 *
 * QA: product pages lacked the "— Otta" suffix every other page carries. The
 * shell skipped the suffix whenever the page title merely CONTAINED the store's
 * name, and the seed's products are all called "Otta …" — so "Otta Mug" was
 * taken for the home page. Only the page whose title IS the store's name goes
 * without it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { documentTitle } from "../src/lib/document-title.js";

const SHELL = readFileSync(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/layouts/Storefront.astro"),
	"utf8",
);

describe("documentTitle", () => {
	test("a page is suffixed with the store's name", () => {
		expect(documentTitle("Shop", "Otta")).toBe("Shop — Otta");
	});

	test("a product whose name CONTAINS the store's name is still suffixed", () => {
		expect(documentTitle("Otta Mug", "Otta")).toBe("Otta Mug — Otta");
		expect(documentTitle("The Otta Tee", "Otta")).toBe("The Otta Tee — Otta");
	});

	test("the page whose title IS the store's name (the home page) is not doubled", () => {
		expect(documentTitle("Otta", "Otta")).toBe("Otta");
	});

	test("stray whitespace on the store's name neither doubles the home title nor rides the suffix", () => {
		expect(documentTitle("My Shop", "My Shop ")).toBe("My Shop");
		expect(documentTitle("Cart", " My Shop ")).toBe("Cart — My Shop");
	});

	test("a blank store name adds no dangling dash", () => {
		expect(documentTitle("Cart", "")).toBe("Cart");
		expect(documentTitle("Cart", "   ")).toBe("Cart");
	});

	test("the shell builds every page's <title> through it — no second rule beside it", () => {
		// ONE name for the store: the same `storeTitle` the home page titles
		// itself with, so "is this the home page's title?" compares like with
		// like (a blank or padded setting cannot make the two disagree).
		expect(SHELL).toContain("const siteTitle = storeTitle(settings);");
		expect(SHELL).toContain("const fullTitle = documentTitle(title, siteTitle);");
		expect(SHELL).not.toMatch(/title\.includes\(siteTitle\)/);
	});
});
