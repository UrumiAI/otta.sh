/**
 * Pressing's bag strip (theme-briefs.md §2, "BAG STRIP"): one countdown for
 * the whole bag, fixed to the foot of the viewport, ticking on `/cart` through
 * HoldClock's hooks and stating a static wall clock everywhere else.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { stripLine, stripWallClock } from "../src/themes/pressing/strip.js";
import { SRC } from "./theme-views.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const read = (file: string): string => readFileSync(path.join(SRC, file), "utf8");
const template = (source: string): string =>
	source.slice(source.indexOf("\n---", 3) + 4).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

describe("stripLine — which hold the strip states", () => {
	test("the live hold that runs out FIRST: the deadline for keeping everything", () => {
		const lines = [
			{ id: "a", expiresAt: at(9) },
			{ id: "b", expiresAt: at(3) },
			{ id: "c", expiresAt: at(14) },
		];
		expect(stripLine(lines, NOW)?.id).toBe("b");
	});

	test("a released hold never beats a live one; with none live, the last released", () => {
		expect(
			stripLine(
				[
					{ id: "a", expiresAt: at(-1) },
					{ id: "b", expiresAt: at(5) },
				],
				NOW,
			)?.id,
		).toBe("b");
		expect(
			stripLine(
				[
					{ id: "a", expiresAt: at(-5) },
					{ id: "b", expiresAt: at(-1) },
				],
				NOW,
			)?.id,
		).toBe("b");
	});

	test("no reservation, or an unparseable one, is no hold at all", () => {
		expect(stripLine([{ id: "a", expiresAt: null }], NOW)).toBeNull();
		expect(stripLine([{ id: "a", expiresAt: "nope" }], NOW)).toBeNull();
		expect(stripLine([], NOW)).toBeNull();
	});

	test("the wall clock splits into its big figure and its small words (floored, UTC)", () => {
		expect(stripWallClock("2026-09-30T16:52:59Z")).toEqual({ time: "4:52", rest: "pm UTC" });
		expect(stripWallClock("nope")).toBeNull();
	});
});

describe("the strip's markup", () => {
	const strip = template(read("themes/pressing/BagStrip.astro"));
	const cart = template(read("themes/pressing/CartView.astro"));
	const layout = template(read("themes/pressing/Layout.astro"));

	test("it is a hold root only when it counts down — the contract's hooks, nothing new", () => {
		expect(strip).toContain('data-hold={hooks ? "" : undefined}');
		expect(strip).toContain("data-expires={hooks ? expiresAt : undefined}");
		expect(strip).toContain('data-hold-clock={hooks ? "" : undefined}');
		expect(strip).toContain('data-hold-label={hooks ? "" : undefined}');
		expect(strip).toMatch(/data-hold-note hidden=/);
		expect(strip).toMatch(
			/\{hooks && <span class="u-sr-only" data-hold-announce aria-live="polite" \/>\}/,
		);
		// The countdown is information: it keeps ticking under reduced motion.
		expect(strip).toContain('data-motion="essential"');
		// Tabular figures, so the width never jitters.
		expect(strip).toMatch(/class="pr-strip-clock u-mono"/);
	});

	test("/cart counts down and rises ON ADD; every other page states a static wall clock", () => {
		expect(cart).toMatch(/<BagStrip[\s\S]*?\slive\s[\s\S]*?\srise=\{stripRises\}[\s\S]*?\/>/);
		// It rises only when a line's hold was just taken — not on every render.
		expect(read("themes/pressing/CartView.astro")).toMatch(
			/const stripRises = lineViews\.some\(\(view\) => isFreshHold\(view\.line\.expiresAt, now\)\);/,
		);
		expect(cart.match(/<BagStrip/g)).toHaveLength(1);
		const drawn = /<BagStrip[\s\S]*?\/>/.exec(layout)?.[0] ?? "";
		expect(drawn).not.toBe("");
		expect(drawn).not.toMatch(/\slive\b|\srise\b/);
		// A timer only where it counts: the static wall clock is a time of day.
		expect(strip).toMatch(/role=\{hooks \? "timer" : undefined\}/);
		expect(strip).not.toMatch(/role="timer"/);
		// With no hold to state, the big type is the count, so the line under it
		// must not repeat it.
		expect(drawn).toMatch(/held === null\s*\?\s*"Stock is confirmed when you check out\."/);
		// Only for a bag with lines — never an empty, checked-out or unreadable one.
		expect(read("themes/pressing/Layout.astro")).toContain(
			'chrome.bag !== null && chrome.bag.state === "lines" ? chrome.bag : null',
		);
	});
});

describe("the strip's CSS", () => {
	const sheet = read("themes/pressing/commerce.css").replace(/\/\*[\s\S]*?\*\//g, "");

	test("fixed to the foot, and the page reserves its height and the safe area", () => {
		const [, rule = ""] = /\n\.pr-strip \{([^}]*)\}/.exec(sheet) ?? [];
		expect(rule).toMatch(/position: fixed;/);
		expect(rule).toMatch(/bottom: 0;/);
		expect(rule).toMatch(/padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
		expect(sheet).toMatch(
			/body:has\(\.pr-strip\) \{\s*padding-bottom: calc\(var\(--pr-strip-h\) \+ 0\.5rem \+ env\(safe-area-inset-bottom, 0px\)\);/,
		);
		// 56px on a phone.
		expect(sheet).toMatch(/:root \{\s*--pr-strip-h: 3\.5rem;\s*\}/);
	});

	test("it rises 360ms on the brief's curve, only for a visitor who has not asked for less", () => {
		expect(sheet).toMatch(
			/\.pr-strip\[data-rise\] \{\s*animation: pr-strip-rise 360ms var\(--pr-ease-out\) both;/,
		);
		const noPreference = sheet.slice(
			sheet.indexOf("@media (prefers-reduced-motion: no-preference)"),
		);
		expect(noPreference).toContain("pr-strip-rise 360ms");
		expect(sheet.indexOf("pr-strip-rise 360ms")).toBeGreaterThan(
			sheet.indexOf("@media (prefers-reduced-motion: no-preference)"),
		);
	});

	test("under a minute the ground crossfades to sodium over 300ms, with ultramarine words", () => {
		expect(sheet).toMatch(
			/\.pr-strip::before \{[^}]*background: var\(--pr-sodium\);[^}]*opacity: 0;/,
		);
		expect(sheet).toMatch(/\.pr-strip\[data-state="expiring"\]::before \{\s*opacity: 1;/);
		expect(sheet).toMatch(/\.pr-strip::before \{\s*transition: opacity 300ms ease-out;/);
		expect(sheet).toMatch(
			/\.pr-strip\[data-state="expiring"\],[^{]*\{\s*color: var\(--pr-on-pink\);/,
		);
	});
});
