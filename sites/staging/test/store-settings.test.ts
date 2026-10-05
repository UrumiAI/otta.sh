/**
 * `src/lib/store-settings.ts` — the store's own words, blank-safe
 * (docs/theme/TEMPERED.md §8, §10). Moved from `tape.test.ts` with the
 * functions themselves.
 */
import { describe, expect, test } from "vitest";
import {
	FALLBACK_THESIS,
	storeDescription,
	storeThesis,
	storeTitle,
} from "../src/lib/store-settings.js";

describe("the store's own words — blank is not the same as set", () => {
	test("the tagline leads where there is one", () => {
		expect(storeThesis({ title: "Otta", tagline: "A reference storefront" })).toBe(
			"A reference storefront",
		);
	});

	test("an EMPTY tagline falls through to the title, not to an empty h1", () => {
		// The bug this function exists for: `settings.tagline ?? settings.title`
		// keeps `""`, and the biggest type on the site renders nothing.
		expect(storeThesis({ title: "Otta", tagline: "" })).toBe("Otta");
	});

	test("a WHITESPACE tagline is empty too", () => {
		expect(storeThesis({ title: "Otta", tagline: "   \n\t " })).toBe("Otta");
	});

	test("a ZERO-WIDTH tagline is empty too — `trim` alone does not catch it", () => {
		// U+200B is a format character, not whitespace, so `"​".trim()` is
		// still truthy. A field cleared by select-and-delete in a rich editor
		// routinely keeps one behind, and it would otherwise be a "set" tagline
		// rendering as an empty `<h1>` — the same bug through another door.
		expect(storeThesis({ title: "Otta", tagline: "​" })).toBe("Otta");
		expect(storeThesis({ title: "Otta", tagline: " ​ ﻿ " })).toBe("Otta");
		expect(storeDescription({ tagline: "​" })).toBeUndefined();
		expect(storeTitle({ title: "​", tagline: "A reference storefront" })).toBe(FALLBACK_THESIS);
		// A real tagline keeps every character a shopper can see.
		expect(storeThesis({ tagline: "Spring steel" })).toBe("Spring steel");
	});

	test("a blank title falls through as well, to the theme's own name", () => {
		expect(storeThesis({ title: "  ", tagline: "" })).toBe(FALLBACK_THESIS);
		expect(storeThesis({})).toBe(FALLBACK_THESIS);
	});

	test("a set tagline is trimmed rather than rendered with its padding", () => {
		expect(storeThesis({ tagline: "  Spring steel  " })).toBe("Spring steel");
	});

	test("the document title never falls back to the TAGLINE", () => {
		// A page title is the store's name, and a tagline in the browser tab is a
		// different fact. Blank ⇒ the theme's own name.
		expect(storeTitle({ title: "Otta", tagline: "A reference storefront" })).toBe("Otta");
		expect(storeTitle({ title: "", tagline: "A reference storefront" })).toBe(FALLBACK_THESIS);
	});

	test("a blank tagline yields NO meta description, not an empty one", () => {
		expect(storeDescription({ tagline: "A reference storefront" })).toBe("A reference storefront");
		expect(storeDescription({ tagline: "" })).toBeUndefined();
		expect(storeDescription({ tagline: "  " })).toBeUndefined();
		expect(storeDescription({})).toBeUndefined();
	});
});
