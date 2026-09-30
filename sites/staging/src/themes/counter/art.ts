/**
 * Counter's product art — the everyday object a product is drawn as when it
 * has no image of its own (brief §5 "No image"): a folded tee, a mug, a
 * notebook, a candle, a tote, a towel stack or a sticker sheet, standing on a
 * soft tint field.
 *
 * PURE AND DETERMINISTIC. Same seed in, same markup out, on the server, with no
 * client script: the object is chosen from the product's title (a "mug" is
 * drawn as a mug) and otherwise from a hash of its slug, and the tint and the
 * object's colour are seeded from the slug too — so a product looks the same on
 * the home page, in the shop grid and on its own page.
 *
 * SAFE TO `set:html`. No caller-supplied string ever reaches the markup: the
 * title is only matched against keywords and the seed is only hashed. Every
 * value interpolated below is a number or a constant from this file.
 *
 * THE TINT IS A TOKEN, THE OBJECT IS NOT. The field behind the object reads a
 * `--c-t1…6` custom property (theme.css darkens them in dark mode) through a
 * `style` attribute — never `fill="var(…)"`, which WebKit has a history of not
 * resolving, and which then paints black (see MediaPanel.astro). The objects'
 * own colours are fixed pigments, the way a real tee is the same colour in a
 * dark room.
 */

export type ArtKind = "tee" | "mug" | "notebook" | "candle" | "tote" | "towel" | "stickers";

const KINDS: readonly ArtKind[] = ["tee", "mug", "notebook", "candle", "tote", "towel"];

/** Title keywords → object. First match wins; no match → seeded by slug. */
const KEYWORDS: ReadonlyArray<readonly [RegExp, ArtKind]> = [
	[/\b(tee|t-shirt|shirt|top|hoodie|sweat\w*|jumper|sweater)\b/i, "tee"],
	[/\b(mug|cup|tumbler|beaker)\b/i, "mug"],
	[/\bstickers?\b|\bsticker pack\b|\bdecals?\b/i, "stickers"],
	[/\b(notebook|journal|diary|planner|sketchbook|notepad|book)\b/i, "notebook"],
	[/\b(candle|soap|jar|diffuser)\b/i, "candle"],
	[/\b(tote|bag|pouch|backpack)\b/i, "tote"],
	[/\b(towel|cloth|linen|napkin|blanket|throw)\b/i, "towel"],
];

/** Object pigments — muted, dyed-cloth and glazed-clay colours. */
const PIGMENTS = [
	"#D8CAAE", // oat
	"#A7B79E", // sage
	"#2F3E5C", // navy
	"#C4907A", // clay
	"#3E5B4A", // forest
	"#C58B45", // amber
	"#7C9CC0", // blue stripe
	"#C99A9A", // rose
	"#6E6A66", // smoke
	"#9DB198", // celadon
] as const;

/** FNV-1a, as in the approved preview — stable across runtimes. */
function hash(input: string): number {
	let h = 2166136261;
	for (const ch of input) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export function artKind(seed: string, title = ""): ArtKind {
	for (const [pattern, kind] of KEYWORDS) if (pattern.test(title)) return kind;
	return KINDS[hash(`${seed}:kind`) % KINDS.length] ?? "tee";
}

/** 1–6: which `--c-t*` field a product stands on. */
export function artTint(seed: string): number {
	return (hash(seed) % 6) + 1;
}

export function artPigment(seed: string): string {
	return PIGMENTS[hash(`${seed}:colour`) % PIGMENTS.length] ?? PIGMENTS[0];
}

const SHADE = 'fill="#000" opacity=".09"';
const LIGHT = 'fill="#fff" opacity=".22"';

/** One object, base-centred at (cx, base), drawn at scale s. */
function object(kind: ArtKind, col: string, cx: number, base: number, s = 1): string {
	const g = (inner: string): string =>
		`<g transform="translate(${cx} ${base}) scale(${s})">${inner}</g>`;
	switch (kind) {
		case "tee":
			return g(
				`<ellipse cx="0" cy="4" rx="118" ry="10" fill="#000" opacity=".08"/>` +
					`<rect x="-100" y="-200" width="200" height="200" rx="12" fill="${col}"/>` +
					`<path d="M-100 -188 L-58 -200 L-100 -120 Z" fill="${col}"/><path d="M-100 -188 L-58 -200 L-100 -120 Z" ${SHADE}/>` +
					`<path d="M100 -188 L58 -200 L100 -120 Z" fill="${col}"/><path d="M100 -188 L58 -200 L100 -120 Z" ${SHADE}/>` +
					`<path d="M-34 -200 Q0 -168 34 -200 Z" fill="#000" opacity=".16"/><path d="M-34 -200 Q0 -176 34 -200" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="5"/>` +
					`<rect x="-100" y="-96" width="200" height="3" ${SHADE}/><rect x="-100" y="-12" width="200" height="12" rx="6" ${SHADE}/>`,
			);
		case "mug":
			return g(
				`<ellipse cx="0" cy="4" rx="84" ry="9" fill="#000" opacity=".08"/>` +
					`<path d="M52 -120 q52 0 52 46 q0 46 -52 46" fill="none" stroke="${col}" stroke-width="15"/><path d="M52 -120 q52 0 52 46 q0 46 -52 46" fill="none" stroke="#000" stroke-opacity=".1" stroke-width="15"/>` +
					`<path d="M-62 -150 V-14 Q-62 0 -48 0 H48 Q62 0 62 -14 V-150 Z" fill="${col}"/><path d="M8 -150 V0 H48 Q62 0 62 -14 V-150 Z" ${SHADE}/>` +
					`<ellipse cx="0" cy="-150" rx="62" ry="12" fill="${col}"/><ellipse cx="0" cy="-150" rx="62" ry="12" ${LIGHT}/><ellipse cx="0" cy="-149" rx="52" ry="8" fill="#000" opacity=".22"/>`,
			);
		case "notebook":
			return g(
				`<ellipse cx="0" cy="4" rx="110" ry="9" fill="#000" opacity=".08"/><g transform="rotate(-4)">` +
					`<rect x="-88" y="-250" width="176" height="248" rx="8" fill="${col}"/><rect x="-88" y="-250" width="16" height="248" rx="6" ${SHADE}/>` +
					`<rect x="-40" y="-212" width="96" height="40" rx="4" fill="#fff" opacity=".85"/><rect x="-28" y="-198" width="56" height="4" rx="2" fill="#000" opacity=".3"/><rect x="-28" y="-188" width="36" height="4" rx="2" fill="#000" opacity=".18"/>` +
					`<rect x="58" y="-250" width="8" height="248" fill="#000" opacity=".35"/><rect x="88" y="-244" width="4" height="236" fill="#fff" opacity=".7"/></g>`,
			);
		case "candle":
			return g(
				`<ellipse cx="0" cy="4" rx="82" ry="9" fill="#000" opacity=".08"/>` +
					`<rect x="-60" y="-170" width="120" height="170" rx="14" fill="${col}"/><rect x="18" y="-170" width="42" height="170" rx="14" ${SHADE}/><rect x="-50" y="-160" width="12" height="140" rx="6" ${LIGHT}/>` +
					`<ellipse cx="0" cy="-170" rx="60" ry="11" fill="${col}"/><ellipse cx="0" cy="-165" rx="52" ry="8" fill="#F1E6D2"/><rect x="-1.5" y="-186" width="3" height="18" rx="1.5" fill="#2A2522"/>` +
					`<rect x="-40" y="-104" width="80" height="54" rx="4" fill="#F7F4EE"/><rect x="-26" y="-88" width="52" height="5" rx="2.5" fill="#2A2522" opacity=".75"/><rect x="-18" y="-76" width="36" height="4" rx="2" fill="#2A2522" opacity=".35"/>`,
			);
		case "tote":
			return g(
				`<ellipse cx="0" cy="4" rx="112" ry="10" fill="#000" opacity=".08"/>` +
					`<path d="M-44 -196 V-250 Q-44 -290 0 -290 Q44 -290 44 -250 V-196" fill="none" stroke="${col}" stroke-width="12"/><path d="M-44 -196 V-250 Q-44 -290 0 -290 Q44 -290 44 -250 V-196" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="12"/>` +
					`<path d="M-100 -200 H100 L92 -6 Q92 0 86 0 H-86 Q-92 0 -92 -6 Z" fill="${col}"/><path d="M-100 -200 H100 L99 -176 H-99 Z" ${SHADE}/>` +
					`<rect x="-34" y="-122" width="68" height="40" rx="3" fill="#000" opacity=".14"/><rect x="-22" y="-106" width="44" height="5" rx="2.5" fill="#fff" opacity=".7"/>`,
			);
		case "stickers": {
			// A backing sheet, slightly turned, with three die-cut shapes and one
			// corner peeling — the sticker pack's "ten shapes on a card".
			const accent = col === "#2F3E5C" ? "#C58B45" : "#2F3E5C";
			return g(
				`<ellipse cx="0" cy="4" rx="104" ry="9" fill="#000" opacity=".08"/><g transform="rotate(3)">` +
					`<rect x="-90" y="-236" width="180" height="232" rx="10" fill="#F4F2EC"/><rect x="-90" y="-236" width="180" height="232" rx="10" fill="none" stroke="#000" stroke-opacity=".06" stroke-width="2"/>` +
					`<circle cx="-34" cy="-172" r="36" fill="${col}"/><circle cx="-34" cy="-172" r="36" fill="none" stroke="#fff" stroke-width="6"/>` +
					`<rect x="10" y="-212" width="58" height="58" rx="16" fill="${accent}" transform="rotate(12 39 -183)"/><rect x="10" y="-212" width="58" height="58" rx="16" fill="none" stroke="#fff" stroke-width="6" transform="rotate(12 39 -183)"/>` +
					`<path d="M-60 -70 Q-60 -110 -20 -110 H40 Q60 -110 60 -90 V-66 Q60 -46 40 -46 H-40 Q-60 -46 -60 -70 Z" fill="${col}" opacity=".75"/><path d="M-60 -70 Q-60 -110 -20 -110 H40 Q60 -110 60 -90 V-66 Q60 -46 40 -46 H-40 Q-60 -46 -60 -70 Z" fill="none" stroke="#fff" stroke-width="6"/>` +
					`<path d="M90 -40 L90 -4 L54 -4 Z" fill="#000" opacity=".08"/><path d="M90 -40 L54 -4 L62 -30 Z" fill="#fff"/></g>`,
			);
		}
		case "towel": {
			let out = `<ellipse cx="0" cy="4" rx="120" ry="10" fill="#000" opacity=".08"/>`;
			for (const i of [0, 1, 2]) {
				const y = -44 - i * 42;
				const x = i % 2 === 1 ? 6 : -4;
				out +=
					`<rect x="${x - 100}" y="${y}" width="200" height="44" rx="8" fill="#EFEBE3"/>` +
					(i > 0 ? `<rect x="${x - 100}" y="${y}" width="200" height="44" rx="8" ${SHADE}/>` : "") +
					`<rect x="${x - 100}" y="${y + 10}" width="200" height="7" fill="${col}"/><rect x="${x - 100}" y="${y + 23}" width="200" height="3" fill="${col}"/>`;
			}
			return g(out);
		}
	}
}

const SVG_OPEN = (w: number, h: number): string =>
	`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">`;

/**
 * One product's art at 4:5 — the object on its seeded tint field.
 *
 * @param seed  the product's slug (or id) — the same key the other themes use
 * @param title only matched against keywords, never rendered
 */
export function productArt(seed: string, title = ""): string {
	const tint = artTint(seed);
	return (
		SVG_OPEN(400, 500) +
		`<rect width="400" height="500" style="fill:var(--c-t${tint})"/>` +
		object(artKind(seed, title), artPigment(seed), 200, 390) +
		`</svg>`
	);
}

/**
 * The home hero's still life (7:5) — five objects on one field and a shelf
 * line, exactly the approved preview's composition. Decorative; used only when
 * the catalog has no photograph to lead with.
 */
export function heroScene(): string {
	return (
		SVG_OPEN(700, 500) +
		`<rect width="700" height="500" style="fill:var(--c-t4)"/><rect y="390" width="700" height="110" fill="#000" opacity=".035"/>` +
		object("towel", "#7C9CC0", 150, 392, 0.9) +
		object("notebook", "#3E5B4A", 520, 392, 0.95) +
		object("tee", "#A7B79E", 340, 392, 1.05) +
		object("mug", "#9DB198", 180, 300, 0.72) +
		object("candle", "#C58B45", 610, 392, 0.72) +
		`</svg>`
	);
}
