/**
 * Batch's product art — what a product is drawn as when it has no photograph
 * (theme-briefs.md §3 "No image"): a kraft bag with a lino-cut stripe band and
 * a printed label, or, for things that do not come in a bag, a simple object
 * from the same world standing in front of a lino-printed backdrop — a
 * stoneware mug, a folded tee in a paper belly band, a glassine packet of
 * stickers.
 *
 * PURE AND DETERMINISTIC. Same seed in, same markup out, on the server, with no
 * client script. The object is chosen from the product's title (a "mug" is
 * drawn as a mug) and is otherwise the bag; the band's wave, line count, weight
 * and angle are seeded from the slug, so every bag is cut differently but a
 * product looks the same on the home page, in the grid and on its own page.
 *
 * SAFE TO `set:html`. `body` never contains a caller-supplied string: the title
 * is only matched against keywords and split into words, and the seed is only
 * hashed. Every value interpolated into `body` is a number or a constant from
 * this file. The printed label's WORDS are returned separately (`label.lines`)
 * and rendered by `Art.astro` as ordinary escaped template text.
 *
 * COLOURS ARE TOKENS. Every fill reads a `--b-*` custom property through a
 * `style` attribute (theme.css redefines them for the roasted dark mode) —
 * never `fill="var(…)"`, which WebKit has a history of not resolving.
 */

export type ArtKind = "bag" | "mug" | "tee" | "packet";

/** Title keywords → object. First match wins; no match → the bag. */
const KEYWORDS: ReadonlyArray<readonly [RegExp, ArtKind]> = [
	[/\b(mug|cup|tumbler|beaker|dripper)\b/i, "mug"],
	[/\b(tee|t-shirt|shirt|top|hoodie|sweat\w*|jumper|sweater)\b/i, "tee"],
	[/\bstickers?\b|\bdecals?\b|\bpins?\b|\bbadges?\b|\bpostcards?\b/i, "packet"],
];

export function artKind(title: string): ArtKind {
	return KEYWORDS.find(([pattern]) => pattern.test(title))?.[1] ?? "bag";
}

/** FNV-1a, as in the approved preview — stable across runtimes. */
function hash(input: string): number {
	let h = 2166136261;
	for (const ch of input) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** A seeded [0, 1) stream (the preview's mulberry-style mixer). */
function rng(seed: string): () => number {
	let a = hash(seed);
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const between = (r: () => number, lo: number, hi: number): number => lo + (hi - lo) * r();
const n = (value: number): string => String(Math.round(value * 10) / 10);
const fill = (token: string): string => `style="fill:var(--b-${token})"`;
const stroke = (token: string): string => `style="stroke:var(--b-${token})"`;

/** The words printed on a label, already wrapped, and where they sit. */
export interface PrintedLabel {
	lines: ReadonlyArray<{ text: string; y: number }>;
	/** Font size in viewBox units — shrinks so a long word still fits. */
	size: number;
}

export interface ProductArt {
	kind: ArtKind;
	/** SVG children for a `0 0 300 400` viewBox. No caller string inside. */
	body: string;
	/** Words to print on the object's label, or `null` for an unlabelled object. */
	label: PrintedLabel | null;
}

/**
 * A stamp's seeded tilt in degrees, −4 to −1 (brief "Designer touches": each
 * stamp's rotation is seeded so they don't repeat) — for the "Sold out" stamp
 * laid across a picture, photographed or drawn.
 */
export function stampTilt(seed: string): number {
	return -1 - Math.round(rng(`${seed}:stamp`)() * 30) / 10;
}

/**
 * Wrap a title onto at most two printed lines of roughly `measure` characters,
 * and size the type so the longest line fits `width` viewBox units. The words
 * are the caller's; they are returned for the template to escape.
 */
function printLabel(
	title: string,
	opts: { width: number; centreY: number; maxSize: number; minSize: number },
): PrintedLabel {
	const words = title.trim().split(/\s+/).filter(Boolean);
	const measure = 11;
	let lines: string[] = [words.join(" ")];
	if (lines[0]!.length > measure && words.length > 1) {
		// Balanced two-line break: the split whose longer half is shortest.
		let best: [string, string] = [words[0]!, words.slice(1).join(" ")];
		for (let i = 1; i < words.length; i++) {
			const pair: [string, string] = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
			if (Math.max(pair[0].length, pair[1].length) < Math.max(best[0].length, best[1].length)) {
				best = pair;
			}
		}
		lines = best;
	}
	const longest = Math.max(1, ...lines.map((line) => line.length));
	// Zilla Slab 700 averages ~0.52em per character.
	const size = Math.max(opts.minSize, Math.min(opts.maxSize, opts.width / (longest * 0.52)));
	const leading = size * 1.08;
	const first = opts.centreY - ((lines.length - 1) * leading) / 2 + size * 0.34;
	return {
		lines: lines.map((text, i) => ({ text, y: Math.round((first + i * leading) * 10) / 10 })),
		size: Math.round(size * 10) / 10,
	};
}

/** The lino-cut band: seeded wavy lines, printed in darker kraft. */
function linoBand(r: () => number, x: number, y: number, w: number): string {
	const top = y + between(r, 40, 58);
	const height = between(r, 58, 74);
	const lines = 5 + Math.floor(r() * 4);
	const amp = between(r, 3, 9);
	const freq = between(r, 2, 4.5);
	const phase = r() * 6;
	const angle = between(r, -8, 8);
	let out = `<g transform="rotate(${n(angle)} 150 ${n(top + height / 2)})">`;
	for (let i = 0; i < lines; i++) {
		const yy = top + (i * height) / lines;
		let d = `M${n(x - 30)} ${n(yy)}`;
		for (let xx = x - 30; xx <= x + w + 30; xx += 6) {
			d += ` L${n(xx)} ${n(yy + Math.sin((xx / w) * freq * Math.PI * 2 + phase + i * 0.6) * amp)}`;
		}
		out += `<path d="${d}" fill="none" ${stroke("lino")} stroke-width="${n((height / lines) * 0.52)}" stroke-linecap="round" opacity=".82"/>`;
	}
	return `${out}</g>`;
}

/** Nine flat stripes behind a standing object — the backdrop is a print too. */
function backdrop(): string {
	let out = `<g ${fill("lino")} opacity=".14">`;
	for (let i = 0; i < 9; i++) out += `<rect x="0" y="${60 + i * 16}" width="300" height="7"/>`;
	return `${out}</g>`;
}

function bag(r: () => number, id: string): { body: string; labelY: number; labelW: number } {
	const x = 66;
	const y = 96;
	const w = 168;
	const h = 264;
	let o = `<ellipse cx="150" cy="${y + h + 6}" rx="${n(w * 0.62)}" ry="12" ${fill("ink")} opacity=".16"/>`;
	o += `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/></clipPath>`;
	o += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${fill("bag")}/>`;
	o += `<g clip-path="url(#${id})">`;
	o += `<rect x="${x}" y="${y}" width="14" height="${h}" ${fill("bag-2")}/>`;
	o += `<rect x="${x + w - 14}" y="${y}" width="14" height="${h}" ${fill("bag-2")}/>`;
	o += linoBand(r, x, y, w);
	o += `</g>`;
	// The rolled top, its crimped edge and the tin tie.
	o += `<rect x="${x}" y="${y}" width="${w}" height="22" ${fill("bag-2")}/>`;
	let zig = `M${x} ${y}`;
	for (let i = 0; i <= 28; i++) zig += ` L${n(x + (i * w) / 28)} ${y - (i % 2 ? 5 : 0)}`;
	o += `<path d="${zig} L${x + w} ${y + 2} L${x} ${y + 2}Z" ${fill("bag-2")}/>`;
	o += `<rect x="${x - 6}" y="${y + 24}" width="${w + 12}" height="5" rx="2.5" ${fill("bag-3")}/>`;
	// The printed label: paper, two printed rules, the words (Art.astro).
	const ly = y + h - 112;
	o += `<rect x="${x + 26}" y="${ly}" width="${w - 52}" height="84" rx="4" ${fill("label")}/>`;
	o += `<rect x="${x + 34}" y="${ly + 8}" width="${w - 68}" height="1.2" ${fill("ink")} opacity=".55"/>`;
	o += `<rect x="${x + 34}" y="${ly + 74.8}" width="${w - 68}" height="1.2" ${fill("ink")} opacity=".55"/>`;
	return { body: o, labelY: ly + 42, labelW: w - 72 };
}

function mug(r: () => number, id: string): string {
	let o = backdrop();
	o += `<ellipse cx="150" cy="318" rx="98" ry="12" ${fill("ink")} opacity=".16"/>`;
	// Handle first, so the body overlaps its roots.
	o += `<path d="M198 196 q44 2 38 46 q-4 30 -38 34" fill="none" ${stroke("glaze")} stroke-width="13" stroke-linecap="round"/>`;
	o += `<clipPath id="${id}"><rect x="94" y="166" width="112" height="148" rx="16"/></clipPath>`;
	o += `<rect x="94" y="166" width="112" height="148" rx="16" ${fill("glaze")}/>`;
	o += `<g clip-path="url(#${id})">`;
	// A lino band printed round the mug, and the shade on its far side.
	o += linoBand(r, 94, 150, 112);
	o += `<rect x="170" y="160" width="40" height="160" ${fill("ink")} opacity=".06"/>`;
	o += `</g>`;
	o += `<ellipse cx="150" cy="166" rx="56" ry="10" ${fill("glaze")}/>`;
	o += `<ellipse cx="150" cy="167" rx="47" ry="6.5" ${fill("roast")}/>`;
	return o;
}

function tee(r: () => number): { body: string; labelY: number; labelW: number } {
	const tone = r() > 0.5 ? "cotton" : "cotton-2";
	let o = backdrop();
	o += `<ellipse cx="150" cy="316" rx="112" ry="12" ${fill("ink")} opacity=".16"/>`;
	// The folded body, its sleeves folded behind, the collar.
	o += `<rect x="62" y="150" width="176" height="160" rx="6" ${fill(tone)}/>`;
	o += `<path d="M62 150 L92 150 L78 196 L62 190 Z" ${fill("ink")} opacity=".07"/>`;
	o += `<path d="M238 150 L208 150 L222 196 L238 190 Z" ${fill("ink")} opacity=".07"/>`;
	o += `<path d="M118 150 Q150 184 182 150" fill="none" ${stroke("ink")} stroke-opacity=".22" stroke-width="7" stroke-linecap="round"/>`;
	o += `<rect x="62" y="286" width="176" height="1.5" ${fill("ink")} opacity=".1"/>`;
	// The kraft belly band, lino-printed, carrying the label.
	o += `<rect x="54" y="206" width="192" height="64" rx="2" ${fill("bag")}/>`;
	o += `<rect x="54" y="206" width="192" height="4" ${fill("bag-3")}/>`;
	o += `<rect x="54" y="266" width="192" height="4" ${fill("bag-3")}/>`;
	o += `<rect x="96" y="214" width="108" height="48" rx="3" ${fill("label")}/>`;
	return { body: o, labelY: 238, labelW: 92 };
}

function packet(r: () => number, id: string): { body: string; labelY: number; labelW: number } {
	const x = 84;
	const y = 138;
	const w = 132;
	const h = 184;
	let o = `<ellipse cx="150" cy="${y + h + 6}" rx="96" ry="11" ${fill("ink")} opacity=".16"/>`;
	// Two stickers peeking out of the top, tilted by the seed.
	o += `<circle cx="${n(between(r, 112, 124))}" cy="${y + 2}" r="24" ${fill("accent")}/>`;
	o += `<circle cx="${n(between(r, 112, 124))}" cy="${y + 2}" r="15" fill="none" ${stroke("label")} stroke-width="3"/>`;
	o += `<rect x="150" y="${y - 30}" width="48" height="48" rx="10" transform="rotate(${n(between(r, 8, 18))} 174 ${y - 6})" ${fill("label")}/>`;
	o += `<rect x="160" y="${y - 20}" width="28" height="7" rx="3.5" transform="rotate(${n(between(r, 8, 18))} 174 ${y - 6})" ${fill("low")}/>`;
	o += `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/></clipPath>`;
	o += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${fill("bag")}/>`;
	o += `<g clip-path="url(#${id})">${linoBand(r, x, y - 18, w)}</g>`;
	o += `<path d="M${x} ${y} L${x + w} ${y} L${x + w / 2} ${y + 34} Z" ${fill("bag-2")}/>`;
	const ly = y + h - 78;
	o += `<rect x="${x + 16}" y="${ly}" width="${w - 32}" height="58" rx="4" ${fill("label")}/>`;
	return { body: o, labelY: ly + 29, labelW: w - 44 };
}

/**
 * The art for one product. `id` keeps each rendering's clip-path id unique on
 * a page that draws the same product twice (the home hero and its card).
 */
export function productArt(seed: string, title: string, id = "a"): ProductArt {
	const kind = artKind(title);
	const r = rng(seed);
	const clip = `b${hash(seed).toString(36)}${id.replace(/[^a-z0-9]/gi, "")}`;
	const panel = `<rect width="300" height="400" ${fill("panel")}/>`;

	if (kind === "mug") return { kind, body: panel + mug(r, clip), label: null };

	const drawn = kind === "tee" ? tee(r) : kind === "packet" ? packet(r, clip) : bag(r, clip);
	const small = kind !== "bag";
	// No words (the home hero's blank bag): the label stays unprinted paper.
	if (title.trim() === "") return { kind, body: panel + drawn.body, label: null };
	const label = printLabel(title, {
		width: drawn.labelW,
		centreY: drawn.labelY,
		maxSize: small ? 15 : 19,
		minSize: small ? 10 : 12,
	});
	return { kind, body: panel + drawn.body, label };
}
