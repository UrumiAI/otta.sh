/**
 * The three faces (docs/theme/TEMPERED.md §3) are self-hosted through Astro's
 * font API. Two things are worth pinning:
 *
 *  - the FACES themselves, because the display/data width contrast is the
 *    theme's loudest move and a silent substitution reads as "generic
 *    starter";
 *  - the VARIABLE AXES. `wdth` is what makes Bricolage narrow and Martian
 *    Mono wide. Google's css2 endpoint only ships an axis you asked for, so a
 *    dropped `variableAxis` option leaves `font-variation-settings: "wdth" 78`
 *    a silent no-op — the page still renders, just at the wrong widths, which
 *    no test that only checks "a font loaded" would catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { STORE_THEMES } from "../src/themes/manifest.js";

// (INC-D3a: this file used to pin `COMMERCE_SERVICE_URL` before importing
// astro.config, because the config resolved it at module load. The config
// reads no commerce address any more — like site-config.test.ts, this suite
// now imports it with no env pinned at all.)

interface ConfiguredFont {
	name: string;
	cssVariable: string;
	provider: { name: string };
	weights?: unknown[];
	subsets?: string[];
	options?: { experimental?: { variableAxis?: Record<string, unknown> } };
}

const fonts = ((await import("../astro.config.js")).default.fonts ??
	[]) as unknown as ConfiguredFont[];
const byVariable = new Map(fonts.map((font) => [font.cssVariable, font]));

describe("astro.config fonts", () => {
	test("declares exactly each theme's roles, namespaced `--f-<theme>-<role>`", () => {
		// Namespaced per theme so a second theme's faces can never collide with
		// these; theme.css maps them onto the shared `--u-display/-body/-data`.
		// A theme that sets everything in one family declares one role; a theme
		// that pairs faces (a display face with a body face) declares one each.
		expect([...byVariable.keys()].toSorted()).toEqual([
			"--f-batch-body",
			"--f-batch-display",
			"--f-counter-sans",
			"--f-jumble-sans",
			"--f-plinth-body",
			"--f-pressing-body",
			"--f-tempered-body",
			"--f-tempered-data",
			"--f-tempered-display",
		]);
	});

	test("every face belongs to a theme this build ships — no stray or shared variable", () => {
		// A face outside every theme's namespace is either a collision waiting to
		// happen or a download no Layout ever emits.
		const ids = STORE_THEMES.map((theme) => theme.id).join("|");
		for (const variable of byVariable.keys()) {
			expect(variable).toMatch(new RegExp(`^--f-(${ids})-[a-z]+$`));
		}
		expect(fonts).toHaveLength(byVariable.size);
	});

	test.each([
		["--f-tempered-display", "Bricolage Grotesque"],
		["--f-tempered-body", "Schibsted Grotesk"],
		["--f-tempered-data", "Martian Mono"],
	])("%s is %s, self-hosted from the Google provider", (cssVariable, name) => {
		const font = byVariable.get(cssVariable);
		expect(font?.name).toBe(name);
		// The provider DOWNLOADS at build time; nothing is fetched from Google
		// at runtime. `local` would silently fall back to whatever the visitor
		// happens to have installed.
		expect(font?.provider.name).toBe("google");
		expect(font?.subsets).toEqual(["latin"]);
	});

	test.each([
		["--f-tempered-display", ["opsz", "wdth"]],
		["--f-tempered-data", ["wdth"]],
	])("%s requests its %s axis, so font-variation-settings is not a no-op", (cssVariable, axes) => {
		const requested = byVariable.get(cssVariable)?.options?.experimental?.variableAxis ?? {};
		expect(Object.keys(requested).toSorted()).toEqual((axes as string[]).toSorted());
	});

	test("every Google face is requested as a weight RANGE (one variable file, not N statics)", () => {
		// Only Tempered's faces still come from the Google provider; every other
		// theme's are vendored (below).
		const google = fonts.filter((f) => f.provider.name === "google");
		expect(google.map((f) => f.cssVariable).toSorted()).toEqual([
			"--f-tempered-body",
			"--f-tempered-data",
			"--f-tempered-display",
		]);
		for (const font of google) {
			expect(font.weights).toHaveLength(1);
			expect(String(font.weights?.[0])).toMatch(/^\d+ \d+$/);
		}
	});
});

/**
 * A woff2's tables, in directory order, with their decompressed bytes
 * (a transformed glyf/loca is kept in its transformed form).
 */
function woff2Tables(bytes: Buffer): { tags: string[]; tables: Map<string, Buffer> } {
	// The WOFF2 spec's known-table order (§5.1): a 6-bit index names these.
	const known =
		"cmap,head,hhea,hmtx,maxp,name,OS/2,post,cvt ,fpgm,glyf,loca,prep,CFF ,VORG,EBDT,EBLC,gasp,hdmx,kern,LTSH,PCLT,VDMX,vhea,vmtx,BASE,GDEF,GPOS,GSUB,EBSC,JSTF,MATH,CBDT,CBLC,COLR,CPAL,SVG ,sbix,acnt,avar,bdat,bloc,bsln,cvar,fdsc,feat,fmtx,fvar,gvar,hsty,just,lcar,mort,morx,opbd,prop,trak,Zapf,Silf,Glat,Gloc,Feat,Sill".split(
			",",
		);
	const entries: Array<[string, number]> = [];
	let at = 48;
	const base128 = (): number => {
		let value = 0;
		for (;;) {
			const byte = bytes[at++] ?? 0;
			value = value * 128 + (byte & 0x7f);
			if ((byte & 0x80) === 0) return value;
		}
	};
	for (let i = 0; i < bytes.readUInt16BE(12); i++) {
		const flags = bytes[at++] ?? 0;
		const index = flags & 0x3f;
		let tag = known[index] ?? `#${index}`;
		if (index === 0x3f) {
			tag = bytes.subarray(at, at + 4).toString("latin1");
			at += 4;
		}
		let length = base128();
		const transformed = (flags >> 6) & 3;
		const glyfOrLoca = tag === "glyf" || tag === "loca";
		if ((glyfOrLoca && transformed === 0) || (!glyfOrLoca && transformed !== 0)) length = base128();
		entries.push([tag, length]);
	}
	const stream = brotliDecompressSync(bytes.subarray(at, at + bytes.readUInt32BE(20)));
	const tables = new Map<string, Buffer>();
	let offset = 0;
	for (const [tag, length] of entries) {
		tables.set(tag, stream.subarray(offset, offset + length));
		offset += length;
	}
	return { tags: entries.map(([tag]) => tag), tables };
}

/** The variation axes a font's `fvar` declares. */
function fvarAxes(bytes: Buffer): string[] {
	const fvar = woff2Tables(bytes).tables.get("fvar");
	expect(fvar).toBeDefined();
	const table = fvar as Buffer;
	const axesAt = table.readUInt16BE(4);
	return Array.from({ length: table.readUInt16BE(8) }, (_, i) =>
		table.subarray(axesAt + i * 20, axesAt + i * 20 + 4).toString("latin1"),
	);
}

/**
 * THE VENDORED FACES. Every theme but Tempered serves its faces from files
 * checked in beside the theme, NOT through the Google provider, and the
 * reason is a rendering defect, so the reason is what is pinned.
 *
 * Unifont asks Google's css2 with a pinned Chrome/121 user agent, and that UA
 * is served builds stripped of their hinting (for a variable face, no `prep`
 * table; for a static face's cuts, no `fpgm`/`prep`/`cvt ` at all). An
 * uninstructed TrueType font goes to FreeType's autohinter (Chromium on
 * Linux/Android), which rounds each glyph's advance at text sizes: body copy
 * set as "lapt op", "Cont ent". The vendored files are the builds a current
 * browser gets, which carry the instructions. If someone swaps one back to
 * the provider — or drops in a file without instructions — these fail.
 */
interface VendoredFont {
	name: string;
	provider: { name: string };
	options: {
		variants: Array<{ src: string[]; weight: string; style?: string; stretch?: string }>;
	};
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fileOf = (src: string | undefined): string => path.resolve(here, "..", src ?? "");
const vendored = (cssVariable: string): VendoredFont =>
	byVariable.get(cssVariable) as unknown as VendoredFont;

/** The file is a woff2 whose table directory holds every one of `tables`. */
function expectHintedWoff2(src: string | undefined, tables: string[]): void {
	const bytes = readFileSync(fileOf(src));
	expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
	expect(woff2Tables(bytes).tags).toEqual(expect.arrayContaining(tables));
}

/** Every variant's file has the SIL OFL beside it. */
function expectOflBeside(font: VendoredFont): void {
	for (const variant of font.options.variants) {
		expect(
			readFileSync(path.join(path.dirname(fileOf(variant.src[0])), "OFL.txt"), "utf8"),
		).toContain("SIL Open Font License");
	}
}

/** Plinth: ONE face — small type, big objects. */
describe("Plinth's Host Grotesk (vendored)", () => {
	const hostGrotesk = vendored("--f-plinth-body");
	const variant = hostGrotesk.options.variants[0];

	test("is Host Grotesk, from the local provider, as one variable variant", () => {
		expect(hostGrotesk.name).toBe("Host Grotesk");
		expect(hostGrotesk.provider.name).toBe("local");
		expect(hostGrotesk.options.variants).toHaveLength(1);
		// 300 is the home statement; 400/500 everything else.
		expect(variant?.weight).toBe("300 800");
		expect(variant?.style).toBe("normal");
	});

	test("the file is a woff2 that carries a prep program, so it is never autohinted", () => {
		expectHintedWoff2(variant?.src[0], ["prep", "gvar", "HVAR", "GPOS"]);
	});

	test("ships with its OFL licence beside it", () => expectOflBeside(hostGrotesk));
});

/** Pressing: ONE family, Archivo; its second voice is the width axis. */
describe("Pressing's Archivo (vendored)", () => {
	const archivo = vendored("--f-pressing-body");
	const variant = archivo.options.variants[0];

	test("is Archivo, from the local provider, as one variable variant", () => {
		expect(archivo.name).toBe("Archivo");
		expect(archivo.provider.name).toBe("local");
		expect(archivo.options.variants).toHaveLength(1);
		expect(variant?.weight).toBe("100 900");
		// The width axis IS the theme's second voice (titles at wdth 125).
		expect(variant?.stretch).toBe("62% 125%");
	});

	test("the file is a woff2 that carries a prep program, so it is never autohinted", () => {
		expectHintedWoff2(variant?.src[0], ["prep", "gvar", "HVAR", "GPOS"]);
	});

	test("ships with its OFL licence beside it", () => expectOflBeside(archivo));
});

/** Batch: a letterpress slab for titles and prices, a grotesque to read. */
describe("Batch's Zilla Slab and Karla (vendored)", () => {
	const zilla = vendored("--f-batch-display");
	const karla = vendored("--f-batch-body");

	test("Zilla Slab is its two static cuts (it has no variable file), from the local provider", () => {
		expect(zilla.name).toBe("Zilla Slab");
		expect(zilla.provider.name).toBe("local");
		// Titles and prices use exactly these two cuts — one file per weight.
		expect(zilla.options.variants.map((v) => [v.weight, v.style])).toEqual([
			["600", "normal"],
			["700", "normal"],
		]);
		for (const variant of zilla.options.variants) expect(variant.src).toHaveLength(1);
	});

	test("Karla is one variable variant across its whole weight range, from the local provider", () => {
		expect(karla.name).toBe("Karla");
		expect(karla.provider.name).toBe("local");
		expect(karla.options.variants).toHaveLength(1);
		expect(karla.options.variants[0]?.weight).toBe("200 800");
		expect(karla.options.variants[0]?.style).toBe("normal");
	});

	test.each(zilla.options.variants.map((v) => [v.weight, v.src[0]]))(
		"the Zilla Slab %s file is a hinted woff2 (fpgm + prep + cvt), so it is never autohinted",
		(_weight, src) => {
			expectHintedWoff2(src, ["fpgm", "prep", "cvt ", "GPOS"]);
		},
	);

	test("the Karla file is a woff2 that carries a prep program, so it is never autohinted", () => {
		expectHintedWoff2(karla.options.variants[0]?.src[0], ["prep", "gvar", "HVAR", "GPOS"]);
	});

	test.each([
		["Zilla Slab", zilla],
		["Karla", karla],
	])("%s ships with its OFL licence beside it", (_name, font) => expectOflBeside(font));
});

/** Jumble: ONE family, Recursive; its playfulness is the Casual axis. */
describe("Jumble's Recursive (vendored)", () => {
	const recursive = vendored("--f-jumble-sans");
	const variant = recursive.options.variants[0];

	test("is Recursive, from the local provider, as one variable variant", () => {
		expect(recursive.name).toBe("Recursive");
		expect(recursive.provider.name).toBe("local");
		expect(recursive.options.variants).toHaveLength(1);
		expect(variant?.weight).toBe("300 1000");
	});

	test("the file is a woff2 that carries a prep program, so it is never autohinted", () => {
		expectHintedWoff2(variant?.src[0], ["prep", "gvar", "fvar", "GPOS"]);
	});

	test("its variable axes are exactly wght and CASL — the Casual voice, and no MONO", () => {
		expect(fvarAxes(readFileSync(fileOf(variant?.src[0]))).toSorted()).toEqual(["CASL", "wght"]);
	});

	test("ships with its OFL licence beside it", () => expectOflBeside(recursive));
});

/** Counter: ONE family for every role, money included. */
describe("Counter's Rethink Sans (vendored)", () => {
	const rethink = vendored("--f-counter-sans");
	const variant = rethink.options.variants[0];

	test("is Rethink Sans, from the local provider, as one variable variant", () => {
		expect(rethink.name).toBe("Rethink Sans");
		expect(rethink.provider.name).toBe("local");
		expect(rethink.options.variants).toHaveLength(1);
		// Every role, money included, sits inside 400–800.
		expect(variant?.weight).toBe("400 800");
		expect(variant?.style).toBe("normal");
	});

	test("the file is a woff2 that carries a prep program, so it is never autohinted", () => {
		expectHintedWoff2(variant?.src[0], ["prep", "gvar", "HVAR", "GPOS"]);
	});

	test("ships with its OFL licence beside it", () => expectOflBeside(rethink));
});
