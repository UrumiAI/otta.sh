/**
 * Jumble's product art — what a product is drawn as when it has no photograph
 * (theme-briefs.md §4 "No image"): a still life of wooden toy blocks — a
 * plank, then two of an arch, a square and a cylinder, topped with a ball or
 * a triangle — stacked on the product's colour field. Not a logo, not a
 * mascot: a pile of blocks, arranged differently for every product.
 *
 * PURE AND DETERMINISTIC. Same seed in, same markup out, on the server, with no
 * client script. Everything — which colour field the product sits on, which
 * blocks are stacked, their widths, offsets and colours, and the product's
 * tilt on the home page — is drawn from the slug through the same FNV-1a hash
 * and mixer as the approved preview, so a product looks the same on the home
 * page, in the grid and on its own page, on every visit (brief "Designer
 * touches": the home page should feel arranged, not random).
 *
 * SAFE TO `set:html`. `body` never contains a caller-supplied string: the seed
 * is only hashed. Every value interpolated into it is a number or a constant
 * from this file.
 *
 * COLOURS ARE TOKENS. Every fill reads a `--j-*` custom property through a
 * `style` attribute (theme.css dims the fields toward indigo for the
 * "night-light" dark mode) — never `fill="var(…)"`, which WebKit has a history
 * of not resolving.
 */

/** The five crayon fields (theme.css `--j-f1` … `--j-f5`); 5 is Sun. */
export type FieldIndex = 1 | 2 | 3 | 4 | 5;

const FIELDS: readonly FieldIndex[] = [1, 2, 3, 4, 5];

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
const fill = (colour: string): string => `style="fill:${colour}"`;

/** The colour field a product sits on — the same everywhere it is drawn. */
export function fieldFor(seed: string): FieldIndex {
	return FIELDS[hash(seed) % FIELDS.length] ?? 1;
}

/**
 * Fields for the home hero's tiles, which sit ON the Sun field: never Sun
 * (a sun tile on a sun field has no edge), and no two alike, so three tiles
 * read as three toys. A product keeps its own field whenever it can.
 */
export function heroFields(seeds: readonly string[]): FieldIndex[] {
	const used = new Set<FieldIndex>();
	return seeds.map((seed) => {
		const own = fieldFor(seed);
		const start = own === 5 ? hash(`${seed}:hero`) % 4 : own - 1;
		for (let step = 0; step < 4; step++) {
			const candidate = (((start + step) % 4) + 1) as FieldIndex;
			if (!used.has(candidate)) {
				used.add(candidate);
				return candidate;
			}
		}
		return own === 5 ? 1 : own;
	});
}

/**
 * The product's resting tilt on the home hero, in degrees: 1–3.5 either way,
 * in half-degree steps. Keyed to the slug, so the arrangement is the same on
 * every visit.
 */
export function tiltFor(seed: string): number {
	const r = rng(`${seed}:tilt`);
	const magnitude = Math.round(between(r, 1, 3.5) * 2) / 2;
	return r() < 0.5 ? -magnitude : magnitude;
}

/**
 * The block stack as SVG children for a `0 0 400 400` viewBox — no field
 * rectangle: the field is the HTML box behind it (so the photo and the drawing
 * share one field, one radius and one hover). `field` is the field it will
 * stand on, which its blocks never repeat.
 */
export function blockStack(seed: string, field: FieldIndex): string {
	const r = rng(seed);
	const others = FIELDS.filter((index) => index !== field);
	const pickField = (): string => `var(--j-f${others[Math.floor(r() * others.length)] ?? 1})`;
	const colours = [
		pickField(),
		"var(--j-block-ink)",
		"var(--j-block-light)",
		pickField(),
		"var(--j-block-royal)",
	];
	const colour = (): string =>
		colours.splice(Math.floor(r() * colours.length), 1)[0] ?? "var(--j-block-ink)";

	const cx = 200 + between(r, -10, 10);
	let y = 330;
	let out = `<ellipse cx="${n(cx)}" cy="${y + 6}" rx="118" ry="11" ${fill("var(--j-block-ink)")} opacity=".14"/>`;

	// The plank everything stands on.
	const pw = between(r, 190, 230);
	const ph = 30;
	out += `<rect x="${n(cx - pw / 2)}" y="${y - ph}" width="${n(pw)}" height="${ph}" rx="10" ${fill(colour())}/>`;
	y -= ph;

	// Two of the three middle blocks, in a seeded order.
	const order = (["arch", "square", "cylinder"] as const)
		.map((shape) => ({ shape, key: r() }))
		.toSorted((a, b) => a.key - b.key)
		.slice(0, 2)
		.map(({ shape }) => shape);
	for (const shape of order) {
		const off = between(r, -16, 16);
		const c = colour();
		if (shape === "arch") {
			const w = between(r, 140, 170);
			const h = 70;
			const x = cx - w / 2 + off;
			const hr = w * 0.24;
			out += `<path d="M${n(x)} ${n(y)} V${n(y - h + 12)} Q${n(x)} ${n(y - h)} ${n(x + 12)} ${n(y - h)} H${n(x + w - 12)} Q${n(x + w)} ${n(y - h)} ${n(x + w)} ${n(y - h + 12)} V${n(y)} H${n(x + w / 2 + hr)} A${n(hr)} ${n(hr)} 0 0 0 ${n(x + w / 2 - hr)} ${n(y)} Z" ${fill(c)}/>`;
			y -= h;
		} else if (shape === "square") {
			const w = between(r, 84, 104);
			const turn = between(r, -6, 6);
			out += `<rect x="${n(cx - w / 2 + off)}" y="${n(y - w)}" width="${n(w)}" height="${n(w)}" rx="12" ${fill(c)} transform="rotate(${n(turn)} ${n(cx + off)} ${n(y - w / 2)})"/>`;
			y -= w - 2;
		} else {
			const w = between(r, 70, 90);
			const h = 56;
			out += `<rect x="${n(cx - w / 2 + off)}" y="${n(y - h)}" width="${n(w)}" height="${h}" ${fill(c)}/>`;
			out += `<ellipse cx="${n(cx + off)}" cy="${n(y - h)}" rx="${n(w / 2)}" ry="10" ${fill(c)}/>`;
			out += `<ellipse cx="${n(cx + off)}" cy="${n(y - h)}" rx="${n(w / 2)}" ry="10" ${fill("var(--j-block-light)")} opacity=".28"/>`;
			y -= h + 8;
		}
	}

	// The top: a ball with a highlight, or a rounded triangle.
	const top = colour();
	if (r() > 0.45) {
		const radius = between(r, 30, 38);
		out += `<circle cx="${n(cx + between(r, -10, 10))}" cy="${n(y - radius + 2)}" r="${n(radius)}" ${fill(top)}/>`;
		out += `<circle cx="${n(cx - radius * 0.35)}" cy="${n(y - radius * 1.35)}" r="${n(radius * 0.22)}" ${fill("var(--j-block-light)")} opacity=".45"/>`;
	} else {
		const w = between(r, 70, 86);
		const h = w * 0.86;
		out += `<path d="M${n(cx - w / 2)} ${n(y)} L${n(cx)} ${n(y - h)} L${n(cx + w / 2)} ${n(y)} Z" style="fill:${top};stroke:${top}" stroke-width="10" stroke-linejoin="round"/>`;
	}
	return out;
}
