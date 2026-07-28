/**
 * The coil (docs/theme/TEMPERED.md §5) — the product art a fresh install gets
 * when the seed ships no photography.
 *
 * The properties worth breaking a build over are the ones a screenshot cannot
 * catch: that the SAME slug always draws the SAME coil (otherwise every render
 * of a product page is a different picture, and the "keyed to its slug" promise
 * is a lie), that DIFFERENT slugs draw different ones (otherwise it repeats
 * like a logo — §5's stated failure), and that the geometry actually lands on
 * the panel rather than off in the margins.
 */
import { describe, expect, test } from "vitest";
import {
	COIL_HEIGHT,
	COIL_TINTS,
	COIL_WIDTH,
	buildCoil,
	coilGeometry,
	coilPath,
	coilTint,
} from "../src/lib/coil.js";

const SLUGS = [
	"urumi-tee",
	"urumi-mug",
	"urumi-sticker-pack",
	"a",
	"",
	"a-very-long-slug-with-many-segments-in-it",
	"Ünïcødé-slug",
	"01J8XQ4M7",
];

/** Every "x y" pair in a path, as numbers. */
function points(path: string): [number, number][] {
	return [...path.matchAll(/(-?\d+\.\d)\s(-?\d+\.\d)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("buildCoil — determinism", () => {
	test.each(SLUGS)("%j draws the same coil every time", (slug) => {
		expect(buildCoil(slug)).toEqual(buildCoil(slug));
	});

	test("different slugs draw different coils", () => {
		const paths = new Set(SLUGS.map((slug) => buildCoil(slug).path));
		expect(paths.size).toBe(SLUGS.length);
	});

	test("a one-character difference moves the drawing", () => {
		expect(buildCoil("urumi-tee").path).not.toBe(buildCoil("urumi-teo").path);
	});

	test("the tint is one of the three tokens, never a raw colour", () => {
		for (const slug of SLUGS) {
			expect(COIL_TINTS).toContain(buildCoil(slug).tint);
		}
	});

	test("all three tints are reachable — the palette is not effectively one colour", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(buildCoil(`product-${i}`).tint);
		expect(seen.size).toBe(COIL_TINTS.length);
	});
});

describe("coilTint — tint by POSITION, because a hash is lumpy over three products", () => {
	test("cycles through all three, in order", () => {
		expect([0, 1, 2, 3, 4, 5].map(coilTint)).toEqual([...COIL_TINTS, ...COIL_TINTS]);
	});

	test("a negative index still lands inside the palette", () => {
		// `%` alone in JS returns a negative remainder and falls off the array.
		expect(COIL_TINTS).toContain(coilTint(-1));
		expect(COIL_TINTS).toContain(coilTint(-7));
	});

	test("any three CONSECUTIVE products show all three tints", () => {
		// This is the whole point, and the thing the hash could not promise: the
		// three-product seed drew no straw at all, and a nine-slug strip drew no
		// violet. On a page that shows the catalog at once the eye compares the
		// coils to each other, not to a distribution.
		for (let start = 0; start < 12; start++) {
			const window = [start, start + 1, start + 2].map(coilTint);
			expect(new Set(window).size).toBe(COIL_TINTS.length);
		}
	});
});

describe("buildCoil — index cycles the tint, the slug keeps the shape", () => {
	test("passing an index takes the tint off the position", () => {
		for (const [index, tint] of COIL_TINTS.entries()) {
			expect(buildCoil("urumi-mug", index).tint).toBe(tint);
		}
	});

	test("the DRAWING is unchanged by position — a product does not reshape when something above it sells out", () => {
		const byHash = buildCoil("urumi-mug");
		for (let index = 0; index < 6; index++) {
			expect(buildCoil("urumi-mug", index).path).toBe(byHash.path);
		}
	});

	test("omitting the index falls back to the slug's own hash", () => {
		expect(buildCoil("urumi-mug").tint).toBe(coilGeometry("urumi-mug").tint);
	});

	test("two products at the same position in different lists still differ in shape", () => {
		expect(buildCoil("urumi-tee", 0).path).not.toBe(buildCoil("urumi-mug", 0).path);
	});
});

describe("coilGeometry — keyed off the slug, and on the panel", () => {
	test.each(SLUGS)("%j lands its centre inside the panel", (slug) => {
		const { cx, cy } = coilGeometry(slug);
		expect(cx).toBeGreaterThan(0);
		expect(cx).toBeLessThan(COIL_WIDTH);
		expect(cy).toBeGreaterThan(0);
		expect(cy).toBeLessThan(COIL_HEIGHT);
	});

	test.each(SLUGS)("%j turns between 2 and 3.5 times, at a usable outer radius", (slug) => {
		const { turns, rOuter } = coilGeometry(slug);
		expect(turns).toBeGreaterThanOrEqual(2);
		expect(turns).toBeLessThanOrEqual(3.5);
		expect(rOuter).toBeGreaterThanOrEqual(110);
		expect(rOuter).toBeLessThanOrEqual(180);
	});

	test("the whole parameter space is exercised, not collapsed onto one value", () => {
		const centres = new Set<string>();
		for (let i = 0; i < 60; i++) {
			const { cx, cy } = coilGeometry(`p-${i}`);
			centres.add(`${Math.round(cx)},${Math.round(cy)}`);
		}
		expect(centres.size).toBeGreaterThan(50);
	});
});

describe("coilPath — a closed ribbon that tapers", () => {
	const path = coilPath(coilGeometry("urumi-mug"));

	test("is one closed subpath: M … L … Z, and nothing else", () => {
		expect(path.startsWith("M ")).toBe(true);
		expect(path.endsWith(" Z")).toBe(true);
		expect(path).not.toMatch(/[^MLZ\d\s.-]/);
	});

	test("every coordinate is finite — no NaN reaches the markup", () => {
		const all = points(path);
		expect(all.length).toBeGreaterThan(100);
		for (const [x, y] of all) {
			expect(Number.isFinite(x)).toBe(true);
			expect(Number.isFinite(y)).toBe(true);
		}
	});

	test("it is a RIBBON — the two edges are swept separately and rejoined", () => {
		// outer edge, then the inner edge reversed: an even number of points.
		expect(points(path).length % 2).toBe(0);
	});

	test("it tapers: the two edges meet at the core and are widest at the tip", () => {
		const all = points(path);
		const n = all.length / 2;
		// outer[i] pairs with inner[n-1-i] (the inner edge is reversed).
		const width = (i: number): number => {
			const a = all[i] as [number, number];
			const b = all[all.length - 1 - i] as [number, number];
			return Math.hypot(a[0] - b[0], a[1] - b[1]);
		};
		// i = 0 is the CORE (f = 0, w = 0.7); i = n-1 is the tip (f = 1, w = 5.3).
		expect(width(0)).toBeLessThan(2);
		expect(width(n - 1)).toBeGreaterThan(8);
		expect(width(n - 1)).toBeGreaterThan(width(Math.floor(n / 2)));
	});

	test("the drawing stays within a panel's worth of the centre", () => {
		const { cx, cy, rOuter } = coilGeometry("urumi-mug");
		for (const [x, y] of points(path)) {
			expect(Math.hypot(x - cx, y - cy)).toBeLessThanOrEqual(rOuter + 8);
		}
	});
});
