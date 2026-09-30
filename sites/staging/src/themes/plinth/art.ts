/**
 * Plinth's product art — graphite objects on stone, for a product with no image.
 *
 * A fresh store ships no photography, and Plinth's whole idea is "the object on
 * a plinth", so the fallback is an object on a plinth: a flat graphite
 * silhouette standing on a slightly darker stone ledge. The silhouette is picked
 * from the product's own TITLE (a lamp is drawn for a lamp, never for a mug);
 * its proportions — height, lean, the hands of a clock — key off the product's
 * slug or id, so two vases in one shop are two different vases. A title that
 * names nothing in the set gets the brief's honest answer: the empty plinth,
 * with the product's title set beside it by the view.
 *
 * Pure and IO-free: numbers in, SVG markup out. Every value interpolated below
 * is a number this file computed — no content string reaches the markup — so
 * the view can inline it. Colours are CSS classes (`pl-o`, `pl-l`, …) styled
 * from the theme's own tokens in `views.css`, which is what makes dark mode
 * and a future palette change free.
 */

export type PlinthObject =
	| "lamp"
	| "vase"
	| "clock"
	| "tray"
	| "bowl"
	| "bookends"
	| "mug"
	| "folded"
	| "cards";

export interface PlinthArt {
	/** The object drawn, or `null` for the empty plinth. */
	object: PlinthObject | null;
	/** Complete `<svg>` markup, `aria-hidden` — it carries no information. */
	svg: string;
}

/** Words in a title → the silhouette that honestly depicts it. First match wins. */
const VOCABULARY: ReadonlyArray<readonly [RegExp, PlinthObject]> = [
	[/\b(lamp|light|sconce|lantern)s?\b/i, "lamp"],
	[/\b(vase|vessel|jug|carafe|bottle|pitcher)s?\b/i, "vase"],
	[/\b(clock|timer|watch)(es)?\b/i, "clock"],
	[/\b(tray|dish|plate|catch-all|coaster)s?\b/i, "tray"],
	[/\b(bowl|planter|pot)s?\b/i, "bowl"],
	[/\b(bookends?|book ?ends?|shelf|shelves)\b/i, "bookends"],
	[/\b(mug|cup|beaker|tumbler)s?\b/i, "mug"],
	[
		/\b(tee|t-shirt|shirt|sweater|jumper|hoodie|scarf|towel|blanket|throw|napkin|cloth)s?\b/i,
		"folded",
	],
	[/\b(sticker|card|postcard|print|poster|notebook|paper|notepad|stationery)s?\b/i, "cards"],
];

export function plinthObjectFor(title: string): PlinthObject | null {
	return VOCABULARY.find(([pattern]) => pattern.test(title))?.[1] ?? null;
}

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

/** One decimal: the art is 400 units wide, so a tenth is invisible. */
const n = (value: number): string => String(Math.round(value * 10) / 10);

/** The ledge every object stands on. */
const BASE = 392;

function draw(object: PlinthObject, r: () => number): string {
	const between = (low: number, high: number): number => low + (high - low) * r();
	const cx = 200 + between(-8, 8);
	let o = "";
	switch (object) {
		case "lamp": {
			const top = between(165, 205);
			const ex = cx + between(58, 78);
			const ey = top - between(38, 52);
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="58" ry="6"/>`;
			o += `<rect class="pl-o" x="${n(cx - 42)}" y="${BASE - 12}" width="84" height="12" rx="2"/><rect class="pl-l" x="${n(cx)}" y="${BASE - 12}" width="42" height="12" rx="2"/>`;
			o += `<rect class="pl-o" x="${n(cx - 3.5)}" y="${n(top)}" width="7" height="${n(BASE - 12 - top)}"/>`;
			o += `<line class="pl-st" x1="${n(cx)}" y1="${n(top)}" x2="${n(ex)}" y2="${n(ey)}" stroke-width="6" stroke-linecap="round"/>`;
			o += `<circle class="pl-o" cx="${n(cx)}" cy="${n(top)}" r="7"/>`;
			o += `<g transform="rotate(${n(between(18, 30))} ${n(ex)} ${n(ey)})"><path class="pl-o" d="M${n(ex - 34)} ${n(ey + 46)} Q${n(ex - 30)} ${n(ey - 4)} ${n(ex)} ${n(ey - 6)} Q${n(ex + 30)} ${n(ey - 4)} ${n(ex + 34)} ${n(ey + 46)} Z"/><path class="pl-l" d="M${n(ex)} ${n(ey - 6)} Q${n(ex + 30)} ${n(ey - 4)} ${n(ex + 34)} ${n(ey + 46)} L${n(ex)} ${n(ey + 46)} Z"/><ellipse class="pl-glow" cx="${n(ex)}" cy="${n(ey + 46)}" rx="34" ry="5"/></g>`;
			break;
		}
		case "vase": {
			const h = between(200, 245);
			const b = between(34, 44);
			const w = between(64, 82);
			const neck = between(16, 22);
			const top = BASE - h;
			const right = `C${n(cx + w * 1.15)} ${n(BASE - h * 0.3)} ${n(cx + w * 0.95)} ${n(BASE - h * 0.58)} ${n(cx + neck)} ${n(BASE - h * 0.82)} L${n(cx + neck + 7)} ${n(top)}`;
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(b + 26)}" ry="6"/>`;
			o += `<path class="pl-o" d="M${n(cx - b)} ${BASE} L${n(cx + b)} ${BASE} ${right} L${n(cx - neck - 7)} ${n(top)} L${n(cx - neck)} ${n(BASE - h * 0.82)} C${n(cx - w * 0.95)} ${n(BASE - h * 0.58)} ${n(cx - w * 1.15)} ${n(BASE - h * 0.3)} ${n(cx - b)} ${BASE} Z"/>`;
			o += `<path class="pl-l" d="M${n(cx)} ${BASE} L${n(cx + b)} ${BASE} ${right} L${n(cx)} ${n(top)} Z"/>`;
			o += `<ellipse class="pl-o" cx="${n(cx)}" cy="${n(top)}" rx="${n(neck + 7)}" ry="3"/>`;
			break;
		}
		case "clock": {
			const radius = between(84, 96);
			const cy = BASE - radius - 10;
			const hour = between(0, 360);
			const minute = between(0, 360);
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(radius * 0.8)}" ry="6"/>`;
			o += `<rect class="pl-o" x="${n(cx - radius * 0.55)}" y="${BASE - 14}" width="8" height="14"/><rect class="pl-o" x="${n(cx + radius * 0.55 - 8)}" y="${BASE - 14}" width="8" height="14"/>`;
			o += `<circle class="pl-o" cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}"/><circle class="pl-l" cx="${n(cx)}" cy="${n(cy)}" r="${n(radius - 9)}"/>`;
			for (let i = 0; i < 12; i++) {
				o += `<rect class="pl-stone" x="${n(cx - 1.2)}" y="${n(cy - radius + 16)}" width="2.4" height="${i % 3 === 0 ? 12 : 6}" transform="rotate(${i * 30} ${n(cx)} ${n(cy)})"/>`;
			}
			o += `<rect class="pl-stone" x="${n(cx - 2.5)}" y="${n(cy - radius * 0.45)}" width="5" height="${n(radius * 0.45)}" rx="2.5" transform="rotate(${n(hour)} ${n(cx)} ${n(cy)})"/>`;
			o += `<rect class="pl-stone" x="${n(cx - 1.6)}" y="${n(cy - radius * 0.7)}" width="3.2" height="${n(radius * 0.7)}" rx="1.6" transform="rotate(${n(minute)} ${n(cx)} ${n(cy)})"/>`;
			o += `<circle class="pl-stone" cx="${n(cx)}" cy="${n(cy)}" r="5"/>`;
			break;
		}
		case "tray": {
			const rx = between(104, 118);
			const y = BASE - 18;
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(rx + 8)}" ry="9"/>`;
			o += `<path class="pl-o" d="M${n(cx - rx)} ${y} L${n(cx - rx + 6)} ${BASE - 4} Q${n(cx)} ${BASE + 14} ${n(cx + rx - 6)} ${BASE - 4} L${n(cx + rx)} ${y} Z"/>`;
			o += `<ellipse class="pl-l" cx="${n(cx)}" cy="${y}" rx="${n(rx)}" ry="24"/><ellipse class="pl-o" cx="${n(cx)}" cy="${y + 2}" rx="${n(rx - 10)}" ry="18"/>`;
			o += `<rect class="pl-stone" x="${n(cx - 44)}" y="${y - 6}" width="70" height="7" rx="3.5" transform="rotate(${n(between(-14, -4))} ${n(cx)} ${y})"/><circle class="pl-l" cx="${n(cx + 42)}" cy="${y + 4}" r="9"/>`;
			break;
		}
		case "bowl": {
			const radius = between(92, 108);
			const y = BASE - between(58, 72) - 8;
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(radius * 0.7)}" ry="7"/>`;
			o += `<rect class="pl-o" x="${n(cx - 30)}" y="${BASE - 10}" width="60" height="10"/>`;
			o += `<path class="pl-o" d="M${n(cx - radius)} ${n(y)} Q${n(cx - radius * 0.9)} ${BASE - 6} ${n(cx)} ${BASE - 8} Q${n(cx + radius * 0.9)} ${BASE - 6} ${n(cx + radius)} ${n(y)} Z"/>`;
			o += `<path class="pl-l" d="M${n(cx)} ${BASE - 8} Q${n(cx + radius * 0.9)} ${BASE - 6} ${n(cx + radius)} ${n(y)} L${n(cx)} ${n(y)} Z"/>`;
			o += `<ellipse class="pl-o" cx="${n(cx)}" cy="${n(y)}" rx="${n(radius)}" ry="12"/><ellipse class="pl-in" cx="${n(cx)}" cy="${n(y + 1)}" rx="${n(radius - 8)}" ry="8"/>`;
			break;
		}
		case "bookends": {
			const h = between(120, 140);
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="120" ry="7"/>`;
			o += `<path class="pl-o" d="M${n(cx - 112)} ${BASE} V${n(BASE - h)} H${n(cx - 104)} V${BASE - 6} H${n(cx - 64)} V${BASE} Z"/>`;
			o += `<path class="pl-o" d="M${n(cx + 112)} ${BASE} V${n(BASE - h)} H${n(cx + 104)} V${BASE - 6} H${n(cx + 64)} V${BASE} Z"/>`;
			const books: ReadonlyArray<readonly [number, number, number, string]> = [
				[-100, 30, h - 22, "pl-l"],
				[-68, 22, h - 40, "pl-ped2"],
				[-44, 28, h - 12, "pl-o"],
				[-14, 18, h - 48, "pl-l"],
			];
			for (const [x, w, bh, cls] of books) {
				o += `<rect class="${cls}" x="${n(cx + x)}" y="${n(BASE - 6 - bh)}" width="${w}" height="${n(bh)}"/>`;
			}
			o += `<rect class="pl-ped2" x="${n(cx + 8)}" y="${BASE - 36}" width="${n(h - 50)}" height="30"/>`;
			break;
		}
		case "mug": {
			const w = between(88, 104);
			const h = between(96, 118);
			const left = cx - w / 2 - 14;
			const top = BASE - h;
			const hx = left + w;
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(w * 0.72)}" ry="6"/>`;
			o += `<path class="pl-st" d="M${n(hx - 2)} ${n(top + h * 0.24)} C${n(hx + 44)} ${n(top + h * 0.2)} ${n(hx + 44)} ${n(top + h * 0.74)} ${n(hx - 2)} ${n(top + h * 0.7)}" stroke-width="13" fill="none" stroke-linecap="round"/>`;
			o += `<rect class="pl-o" x="${n(left)}" y="${n(top)}" width="${n(w)}" height="${n(h)}" rx="6"/>`;
			o += `<rect class="pl-l" x="${n(left + w / 2)}" y="${n(top)}" width="${n(w / 2)}" height="${n(h)}" rx="6"/>`;
			o += `<ellipse class="pl-in" cx="${n(left + w / 2)}" cy="${n(top + 1)}" rx="${n(w / 2 - 3)}" ry="4"/>`;
			break;
		}
		case "folded": {
			const w = between(170, 196);
			const layer = between(20, 26);
			const count = 2 + Math.floor(r() * 2);
			const left = cx - w / 2;
			for (let i = 0; i < count; i++) {
				const y = BASE - layer * (i + 1);
				const inset = i * between(2, 6);
				o += `<rect class="${i % 2 === 0 ? "pl-o" : "pl-l"}" x="${n(left + inset)}" y="${n(y)}" width="${n(w - inset * 2)}" height="${n(layer - 1.5)}" rx="4"/>`;
			}
			const topY = BASE - layer * count;
			// The collar of the top garment: a shallow notch in stone.
			o += `<path class="pl-stone" d="M${n(cx - 22)} ${n(topY)} Q${n(cx)} ${n(topY + 14)} ${n(cx + 22)} ${n(topY)} Z"/>`;
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(w / 2 + 10)}" ry="6"/>`;
			break;
		}
		case "cards": {
			const w = between(96, 116);
			const h = w * 1.36;
			const lean = between(-9, -4);
			o += `<ellipse class="pl-sh" cx="${n(cx)}" cy="${BASE}" rx="${n(w * 0.9)}" ry="6"/>`;
			o += `<rect class="pl-l" x="${n(cx - w / 2 + 18)}" y="${n(BASE - h)}" width="${n(w)}" height="${n(h)}" rx="3" transform="rotate(${n(-lean)} ${n(cx)} ${BASE})"/>`;
			o += `<rect class="pl-o" x="${n(cx - w / 2 - 12)}" y="${n(BASE - h + 6)}" width="${n(w)}" height="${n(h - 6)}" rx="3" transform="rotate(${n(lean)} ${n(cx)} ${BASE})"/>`;
			const dot = between(14, 20);
			o += `<circle class="pl-stone" cx="${n(cx - 14)}" cy="${n(BASE - h * 0.62)}" r="${n(dot)}" transform="rotate(${n(lean)} ${n(cx)} ${BASE})"/>`;
			o += `<rect class="pl-ped2" x="${n(cx - 40)}" y="${n(BASE - h * 0.34)}" width="${n(w * 0.5)}" height="7" rx="3.5" transform="rotate(${n(lean)} ${n(cx)} ${BASE})"/>`;
			break;
		}
	}
	return o;
}

/**
 * The art for one product.
 *
 * `crop` frames the object's detail (the card's hover state and the PDP's
 * second panel) — the same drawing through a closer viewBox, so the two can
 * never disagree about what the object is.
 */
export function plinthArt(
	seed: string,
	title: string,
	options: { crop?: boolean } = {},
): PlinthArt {
	const object = plinthObjectFor(title);
	const r = generator(seed);
	let body: string;
	if (object === null) {
		// The empty plinth: a pedestal block and nothing on it.
		const w = 132 + r() * 40;
		const h = 120 + r() * 50;
		const x = 200 - w / 2;
		body =
			`<ellipse class="pl-sh" cx="200" cy="${BASE}" rx="${n(w / 2 + 16)}" ry="6"/>` +
			`<rect class="pl-ped2" x="${n(x)}" y="${n(BASE - h)}" width="${n(w)}" height="${n(h)}"/>` +
			`<rect class="pl-ped3" x="${n(x)}" y="${n(BASE - h)}" width="${n(w)}" height="7"/>` +
			`<rect class="pl-ped3" x="${n(200)}" y="${n(BASE - h + 7)}" width="${n(w / 2)}" height="${n(h - 7)}"/>`;
	} else {
		body = draw(object, r);
	}
	const viewBox = options.crop ? "90 120 220 275" : "0 0 400 500";
	const svg =
		`<svg class="pl-art" viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">` +
		`<rect class="pl-bg" width="400" height="500"/><rect class="pl-ped" y="${BASE}" width="400" height="${500 - BASE}"/>` +
		body +
		`</svg>`;
	return { object, svg };
}

/**
 * The per-product `view-transition-name` for the card → product-page morph:
 * the card's media and the PDP's first panel carry the same one. A slug may hold
 * characters an identifier may not, so anything outside `[A-Za-z0-9_-]` becomes
 * `-`; the prefix keeps it from starting with a digit or being `none`.
 *
 * COLLISION-RESISTANT (slug + 32-bit hash), because two elements sharing a name
 * abort the whole transition: sanitising alone maps `a.b` and `a-b` (or two
 * non-ASCII slugs) to one name, so the name ends in a hash of the RAW seed. The
 * readable part is for a person reading the DOM; the hash is what keeps two
 * products apart.
 */
export function plinthTransitionName(seed: string, part: "media" | "title"): string {
	return `pl-${part}-${seed.replace(/[^A-Za-z0-9_-]/g, "-")}-${hash(seed).toString(36)}`;
}
