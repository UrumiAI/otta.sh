/**
 * The coil — product art for a store that ships no photography
 * (docs/theme/TEMPERED.md §5).
 *
 * An Archimedean spiral swept as a ribbon that tapers to a point at its inner
 * end: the blade coiled, which is how an urumi is worn. It is GENERATED, never
 * hand-authored path data, because §5's requirement is that centre, turn count,
 * rotation and outer radius all key off the product slug — so each product
 * crops differently instead of repeating like a logo.
 *
 * The mockup's reference `coilPath()` keys off a 0/1/2 seed and indexes three
 * hand-picked arrays, which is all its three demo products needed. A real store
 * has arbitrary slugs, so the arrays become CONTINUOUS RANGES chosen to contain
 * the mockup's values (cx offset −52/34/68 ⊂ [−60, 70]; cy 22/−34/30 ⊂
 * [−40, 35]; turns 2.3/3.1/2.7 ⊂ [2.1, 3.3]; rOuter 150/128/166 ⊂ [120, 170]),
 * sampled by a hash of the slug. The taper (`w = 0.7 + 4.6·f²`) and the 0.94
 * ellipse factor are ported verbatim — they are the shape, not the crop.
 *
 * Pure and dependency-free: a `.astro` component can call it at render time and
 * a unit test can call it without a DOM.
 */

/** The panel's coordinate space. The SVG slices to fill whatever box it is
 *  given, so this is a drawing grid, not a display size. */
export const COIL_WIDTH = 400;
export const COIL_HEIGHT = 320;

/** The three tint tokens §5 allows. Tokens, never raw colours — the coil has to
 *  lift onto a dark ground with everything else. */
export const COIL_TINTS = ["--u-tint-violet", "--u-tint-straw", "--u-tint-blue"] as const;

export type CoilTint = (typeof COIL_TINTS)[number];

export interface CoilGeometry {
	/** Centre, in the drawing grid — deliberately allowed off-centre so the
	 *  spiral crops against the panel edge instead of sitting like a target. */
	cx: number;
	cy: number;
	/** Full turns of the spiral. */
	turns: number;
	/** Starting angle, radians. */
	rot: number;
	/** Radius at the outermost (widest) end. */
	rOuter: number;
	tint: CoilTint;
}

export interface Coil {
	/** An SVG `d` attribute: one closed, tapering ribbon. */
	path: string;
	/** A custom-property NAME — the component wraps it in `var(…)`. */
	tint: CoilTint;
}

/** FNV-1a over the slug's code units: a cheap, stable 32-bit spread with no
 *  dependency and no crypto (this is art, not a secret). Code units rather
 *  than bytes so a non-ASCII slug hashes without an encoder. */
function hash(slug: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < slug.length; i++) {
		h ^= slug.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** mulberry32 — one hash in, a stream of well-distributed [0, 1) out, so each
 *  parameter gets its OWN sample. Deriving them all from the same number makes
 *  the parameters move together and the coils rhyme. */
function sampler(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function lerp(from: number, to: number, f: number): number {
	return from + (to - from) * f;
}

/** The slug's coil parameters. Same slug ⇒ same geometry, forever. */
export function coilGeometry(slug: string): CoilGeometry {
	const next = sampler(hash(slug));
	return {
		cx: COIL_WIDTH / 2 + lerp(-60, 70, next()),
		cy: COIL_HEIGHT / 2 + lerp(-40, 35, next()),
		turns: lerp(2.1, 3.3, next()),
		rot: lerp(0, Math.PI * 2, next()),
		rOuter: lerp(120, 170, next()),
		tint: COIL_TINTS[Math.floor(next() * COIL_TINTS.length)] ?? COIL_TINTS[0],
	};
}

/**
 * Sample count along the spiral. The mockup's reference implementation uses
 * 300; 220 is a deliberate trade. The ribbon is drawn as straight segments, and
 * at 220 the facets are already sub-pixel at the largest size the panel is ever
 * rendered (~640px wide) — while the `d` string is INLINE in the HTML of every
 * card, so the resolution is a payload decision as much as a drawing one.
 * Measured: 6.1 kB per coil, 2.2 kB gzipped. Raising it to 300 buys nothing
 * visible and costs ~40% more on a page that can carry 48 of them.
 */
const SAMPLES = 220;

/** Geometry → the `d` attribute of one closed, tapering ribbon. */
export function coilPath(geometry: CoilGeometry): string {
	const { cx, cy, turns, rot, rOuter } = geometry;
	const tMax = turns * Math.PI * 2;
	const rInner = 16;
	const growth = (rOuter - rInner) / tMax;
	const outer: string[] = [];
	const inner: string[] = [];
	for (let i = 0; i <= SAMPLES; i++) {
		const f = i / SAMPLES;
		const t = f * tMax;
		const r = rInner + growth * t;
		// A point at the core, full width at the tip — the taper IS the blade.
		const w = 0.7 + 4.6 * f * f;
		const a = t + rot;
		const cos = Math.cos(a);
		// A shade elliptical, so the coil does not read as a target.
		const sin = Math.sin(a) * 0.94;
		outer.push(`${(cx + (r + w) * cos).toFixed(1)} ${(cy + (r + w) * sin).toFixed(1)}`);
		inner.push(`${(cx + (r - w) * cos).toFixed(1)} ${(cy + (r - w) * sin).toFixed(1)}`);
	}
	inner.reverse();
	return `M ${outer.join(" L ")} L ${inner.join(" L ")} Z`;
}

/**
 * Tint by POSITION rather than by hash.
 *
 * The hash gives an even spread over many products and a lumpy one over few,
 * and few is the case that actually ships: the three-product seed draws no
 * straw at all, and a nine-slug strip drew no violet. On a page that shows the
 * whole catalog at once that reads as a bug rather than as variety, because
 * the eye compares the coils to each other rather than to a distribution. So
 * where a caller knows a product's position in the rendered list it passes it,
 * and the tints cycle: every three products show all three.
 *
 * GEOMETRY still keys off the slug, deliberately — position is a property of
 * one page's ordering, and a product must not change shape because something
 * above it sold out.
 */
export function coilTint(index: number): CoilTint {
	// `%` alone would fall off the front of the array for a negative index.
	const wrapped = ((index % COIL_TINTS.length) + COIL_TINTS.length) % COIL_TINTS.length;
	return COIL_TINTS[wrapped] ?? COIL_TINTS[0];
}

/**
 * The one call a component makes: slug → the drawing and its tint.
 *
 * `index` is the product's position in the list being rendered. Omit it — on a
 * PDP, on a cart line, anywhere there is no list — and the tint falls back to
 * the slug's own hash, which is at least stable per product.
 */
export function buildCoil(slug: string, index?: number): Coil {
	const geometry = coilGeometry(slug);
	return {
		path: coilPath(geometry),
		tint: index === undefined ? geometry.tint : coilTint(index),
	};
}
