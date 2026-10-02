/**
 * The storefront's one locale. The pages declare it in `<html lang>`, the
 * checkout summary formats money in it, and the delivery country picker names
 * countries in it — so it must be ONE value, already in canonical form (the
 * plugin's `sanitizeLocale` would otherwise rewrite it and the two could drift).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { countryOptions } from "../src/lib/countries.js";
import { STOREFRONT_LOCALE } from "@otta-sh/plugin";
import { orderMoney } from "../src/lib/account.js";
import { SITE_LOCALE } from "../src/lib/site-locale.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

describe("SITE_LOCALE", () => {
	test("is a canonical BCP 47 tag — what the plugin's sanitiser would hand back unchanged", () => {
		expect(new Intl.Locale(SITE_LOCALE).toString()).toBe(SITE_LOCALE);
	});

	test("is the language every theme's layout declares", () => {
		const themes = readdirSync(path.join(SRC, "themes"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		expect(themes.length).toBeGreaterThan(0);
		for (const theme of themes) {
			const layout = readFileSync(path.join(SRC, "themes", theme, "Layout.astro"), "utf8");
			expect(layout, theme).toMatch(new RegExp(`<html lang="${SITE_LOCALE}"[\\s>]`));
		}
	});

	test("is the plugin's STOREFRONT_LOCALE — the locale order emails are written in", () => {
		expect(SITE_LOCALE).toBe(STOREFRONT_LOCALE);
	});

	test("is the locale the account pages format money in", () => {
		// No second, hard-coded locale beside it.
		expect(readFileSync(path.join(SRC, "lib", "account.ts"), "utf8")).not.toMatch(/"en-[A-Z]{2}"/u);
		expect(orderMoney(123450, "INR")).toBe(
			new Intl.NumberFormat(SITE_LOCALE, { style: "currency", currency: "INR" }).format(1234.5),
		);
	});

	test("names countries in that language", () => {
		expect(countryOptions(SITE_LOCALE).find((o) => o.code === "DE")?.label).toBe(
			new Intl.DisplayNames([SITE_LOCALE], { type: "region" }).of("DE"),
		);
	});
});
