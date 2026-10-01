/**
 * Pressing's product art and title fitting — pure, IO-free, numbers out.
 *
 * THE RECORD. A fresh store ships no photography, and Pressing is a record
 * shop, so a product with no image is a record: a printed sleeve and a black
 * disc behind it that slides out on hover (views.css). Everything that makes
 * one record differ from the next keys off the product's slug or id — the
 * sleeve's print (stripes, halftone dots, two suns, a horizon, a target), its
 * three inks, the disc's label colour (pink, sodium or vellum) and the angle
 * the disc stops at — so two records never share a cover or a resting angle.
 * The title runs around the label and across the sleeve's band.
 *
 * This module returns DATA, not markup: shapes as numbers and tone names, the
 * text as plain strings. `Record.astro` renders it, so every product string
 * goes through Astro's own escaping and nothing is ever `set:html`. Tones are
 * CSS classes (`pr-t-pink`, …) styled from theme tokens in views.css.
 *
 * THE FIT. The brief sets titles expanded and FILLING their column edge to
 * edge, like a sleeve front. Without client script that has to be decided on
 * the server: `fitScale` estimates the title's width in ems from Archivo's
 * real advance widths (measured in Chromium at wght 800 / wdth 125, and at
 * 700 / 100 for the label face) and returns the font size, in container-inline
 * units, that makes it span the column. CSS clamps it (views.css), so a long
 * title stops shrinking at a readable floor and wraps instead.
 */

export type Tone = "pink" | "sodium" | "vellum" | "cobalt" | "ultra" | "deep";

export type SleeveShape =
	| { kind: "rect"; x: number; y: number; w: number; h: number; tone: Tone }
	| { kind: "circle"; cx: number; cy: number; r: number; tone: Tone }
	| { kind: "path"; d: string; tone: Tone };

export interface SleeveArt {
	ground: Tone;
	shapes: readonly SleeveShape[];
	/** The title band across the foot of the sleeve. */
	band: Tone;
	ink: Tone;
	title: string;
	/** Font size of the band title, in the sleeve's 100-unit space. */
	titleSize: number;
	catalogue: string | null;
}

export interface RecordArt {
	/** Unique per rendered record — the id of the label's text path. */
	pathId: string;
	/** Where the disc comes to rest, in degrees — seeded, never the same twice. */
	rotation: number;
	label: "pink" | "sodium" | "vellum";
	/** The groove rings: radius and stroke opacity, 100-unit space. */
	grooves: ReadonlyArray<{ r: number; o: number }>;
	/** The text set around the label. */
	labelText: string;
	sleeve: SleeveArt;
}

// ── Seeds ────────────────────────────────────────────────────────────────

/** FNV-1a — a stable 32-bit seed from a string. */
function hash(value: string): number {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** mulberry32 — a small deterministic generator, seeded per product. */
function generator(seed: string): () => number {
	let a = hash(seed);
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const between = (r: () => number, lo: number, hi: number): number => lo + (hi - lo) * r();

/** Two decimals: the art is 100 units wide. */
const n = (value: number): number => Math.round(value * 100) / 100;

function pick<T>(r: () => number, items: readonly T[]): T {
	return items[Math.floor(r() * items.length) % items.length] as T;
}

// ── Measuring ────────────────────────────────────────────────────────────

/**
 * Archivo's advance widths, per mille of the em, for these characters in this
 * order. Measured in Chromium off the same Google Fonts file the site
 * self-hosts. Anything not listed is costed at the face's average, which only
 * makes the fit slightly conservative for that one glyph.
 */
const GLYPHS =
	"0123456789 !\"#$%&'()*+,-./:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~’‘“”–—éèüöäñç×…";

/* wght 800, wdth 125 — the display voice. */
const DISPLAY = [
	786, 703, 783, 789, 781, 789, 791, 726, 803, 791, 304, 358, 522, 757, 710, 1132, 1001, 278, 371,
	371, 431, 736, 349, 416, 349, 308, 344, 349, 736, 736, 736, 715, 1253, 933, 914, 942, 933, 863,
	799, 1012, 989, 373, 734, 951, 754, 1148, 988, 1013, 861, 1013, 932, 867, 848, 968, 904, 1213,
	940, 918, 857, 360, 308, 360, 736, 655, 319, 776, 765, 771, 765, 780, 482, 766, 755, 315, 313,
	733, 315, 1166, 755, 781, 765, 765, 480, 710, 501, 755, 706, 1078, 764, 706, 660, 363, 293, 363,
	736, 305, 305, 557, 557, 625, 1250, 780, 780, 755, 781, 776, 755, 771, 736, 1042,
];

/* wght 700, wdth 100 — the label voice. */
const LABEL = [
	595, 596, 596, 596, 597, 595, 596, 596, 596, 595, 196, 301, 456, 600, 556, 973, 764, 253, 364,
	364, 407, 641, 307, 333, 307, 300, 335, 335, 641, 641, 641, 613, 1001, 724, 722, 733, 739, 683,
	622, 802, 754, 301, 603, 725, 591, 872, 754, 793, 681, 793, 730, 679, 641, 748, 694, 964, 706,
	699, 653, 350, 300, 350, 641, 518, 228, 580, 608, 573, 608, 584, 325, 607, 602, 267, 264, 570,
	267, 891, 602, 613, 608, 608, 380, 556, 342, 601, 547, 798, 572, 547, 519, 393, 253, 393, 641,
	280, 280, 488, 488, 500, 1000, 584, 584, 601, 613, 580, 602, 573, 641, 973,
];

const AVERAGE = { display: 710, label: 569 } as const;

export type Face = "display" | "label";

/** The width of `text` in ems at `face`, with `tracking` (em) after each glyph. */
export function textWidthEm(text: string, face: Face, tracking = 0): number {
	const table = face === "display" ? DISPLAY : LABEL;
	let total = 0;
	let count = 0;
	for (const char of text) {
		const at = GLYPHS.indexOf(char);
		total += at === -1 ? AVERAGE[face] : (table[at] ?? AVERAGE[face]);
		count++;
	}
	return total / 1000 + tracking * count;
}

/**
 * The font size, in `cqi` (1% of the container's inline size), at which
 * `text` set in the display voice spans its column. A 3% margin absorbs
 * kerning and rounding, so a fitted title never wraps by a pixel.
 */
export function fitScale(text: string, tracking = -0.03): number {
	const em = Math.max(textWidthEm(text.trim(), "display", tracking), 0.5);
	return n((100 / em) * 0.97);
}

/** `text`, shortened with an ellipsis until it is at most `maxEm` wide. */
function clip(text: string, face: Face, tracking: number, maxEm: number): string {
	if (textWidthEm(text, face, tracking) <= maxEm) return text;
	const chars = [...text];
	while (chars.length > 1 && textWidthEm(`${chars.join("").trimEnd()}…`, face, tracking) > maxEm) {
		chars.pop();
	}
	return `${chars.join("").trimEnd()}…`;
}

// ── The sleeve ───────────────────────────────────────────────────────────

/** [ground, first ink, second ink] — the preview's six print runs. */
const PALETTES: ReadonlyArray<readonly [Tone, Tone, Tone]> = [
	["pink", "ultra", "vellum"],
	["cobalt", "pink", "vellum"],
	["vellum", "cobalt", "pink"],
	["sodium", "ultra", "pink"],
	["ultra", "sodium", "pink"],
	["deep", "pink", "sodium"],
];

const LIGHT: ReadonlySet<Tone> = new Set<Tone>(["vellum", "sodium", "pink"]);

/** The print area is the sleeve above its band: 100 × 82. */
function print(
	design: number,
	r: () => number,
	seed: number,
	a: Tone,
	b: Tone,
	ground: Tone,
): SleeveShape[] {
	const shapes: SleeveShape[] = [];
	if (design === 0) {
		// Stripes, and one bar across them.
		const rows = 7;
		for (let i = 1; i < rows; i += 2) {
			shapes.push({ kind: "rect", x: 0, y: n((i * 82) / rows), w: 100, h: n(82 / rows), tone: a });
		}
		shapes.push({ kind: "rect", x: n(between(r, 56, 68)), y: 0, w: 9, h: 82, tone: b });
	} else if (design === 1) {
		// Halftone: a grid of dots whose sizes wander.
		for (let y = 0; y < 7; y++) {
			for (let x = 0; x < 8; x++) {
				const size = 1.6 + ((x * 7 + y * 3 + seed) % 5) * 0.75;
				shapes.push({
					kind: "circle",
					cx: n(7 + x * 12.3),
					cy: n(7 + y * 11),
					r: n(size),
					tone: a,
				});
			}
		}
	} else if (design === 2) {
		// Two suns.
		shapes.push({
			kind: "circle",
			cx: n(between(r, 58, 66)),
			cy: n(between(r, 34, 40)),
			r: n(between(r, 26, 30)),
			tone: a,
		});
		shapes.push({
			kind: "circle",
			cx: n(between(r, 28, 36)),
			cy: n(between(r, 56, 62)),
			r: n(between(r, 10, 13)),
			tone: b,
		});
	} else if (design === 3) {
		// A horizon: two hills.
		const h1 = n(between(r, 44, 54));
		const h2 = n(between(r, 64, 70));
		shapes.push({
			kind: "path",
			d: `M0 ${h1} Q50 ${n(between(r, 8, 24))} 100 ${h1} V82 H0Z`,
			tone: a,
		});
		shapes.push({
			kind: "path",
			d: `M0 ${h2} Q50 ${n(between(r, 46, 56))} 100 ${h2} V82 H0Z`,
			tone: b,
		});
	} else {
		// A target — the record, printed on its own sleeve.
		for (let i = 9; i > 0; i--) {
			shapes.push({
				kind: "circle",
				cx: 50,
				cy: 41,
				r: n(i * 4.4),
				tone: i % 2 === 1 ? a : ground,
			});
		}
		shapes.push({ kind: "circle", cx: 50, cy: 41, r: 4, tone: b });
	}
	return shapes;
}

// ── The record ───────────────────────────────────────────────────────────

/**
 * The record for one product.
 *
 * @param seed      the product's slug or id — what makes this record its own
 * @param title     set on the band and around the label
 * @param catalogue the SKU when the page has one (the PDP); `null` elsewhere
 * @param instance  distinguishes two renders of one product on a page (the
 *                  home hero and its grid card), so their label paths never
 *                  share an id
 */
export function pressingRecord(
	seed: string,
	title: string,
	catalogue: string | null,
	instance: string,
): RecordArt {
	const h = hash(seed);
	const sleeveRandom = generator(`${seed}s`);
	const discRandom = generator(`${seed}d`);

	/* The cover's print and inks draw on their own salted seed, so they vary
	   independently of the ids and the disc. */
	const cover = hash(`${seed}sleeve`);
	const design = cover % 5;
	const [ground, a, b] =
		PALETTES[(cover >>> 3) % PALETTES.length] ?? (["pink", "ultra", "vellum"] as const);
	const light = LIGHT.has(ground);
	const band: Tone = light ? "ultra" : "vellum";
	const ink: Tone = light ? "vellum" : "ultra";

	/* Band title: expanded 800 at up to 8 units, fitted into what the
	   catalogue number leaves. */
	const cleanTitle = title.trim() === "" ? "Untitled" : title.trim();
	const catalogueEm = catalogue === null ? 0 : textWidthEm(catalogue, "label") * 3.4 + 4;
	/* 8% held back: at card size the band is ~20px tall, and hinting at
	   that size runs a little wider than the measured advances. */
	const room = (88 - catalogueEm) * 0.92;
	const titleEm = textWidthEm(cleanTitle, "display", -0.02);
	const titleSize = n(Math.min(8, Math.max(4.2, room / titleEm)));
	const bandTitle = clip(cleanTitle, "display", -0.02, room / titleSize);

	const grooves: Array<{ r: number; o: number }> = [];
	for (let r = 17.5; r < 48.5; r += 1.35) {
		grooves.push({
			r: n(r),
			o: Math.round((0.04 + (Math.sin(r * 3.1) + 1) * 0.025) * 1000) / 1000,
		});
	}

	/* The label path is r = 11.5, about 72 units round; at 3.3 units and
	   0.06em tracking, keep the text inside ~64 so it never meets itself. */
	const around = catalogue === null ? cleanTitle : `${cleanTitle}   ${catalogue}`;
	const labelText = clip(around, "label", 0.06, 64 / 3.3);

	return {
		pathId: `pr-${instance}-${h.toString(36)}`,
		rotation: Math.round(between(discRandom, 0, 360)),
		label: pick(discRandom, ["pink", "sodium", "vellum"] as const),
		grooves,
		labelText,
		sleeve: {
			ground,
			shapes: print(design, sleeveRandom, h, a, b, ground),
			band,
			ink,
			title: bandTitle,
			titleSize,
			catalogue,
		},
	};
}
