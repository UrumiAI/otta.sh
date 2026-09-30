/**
 * The three faces (docs/theme/TEMPERED.md §3) are self-hosted through Astro's
 * font API from files checked in under `src/fonts/`. Three things are worth
 * pinning:
 *
 *  - the FACES themselves, because the display/data width contrast is the
 *    theme's loudest move and a silent substitution reads as "generic
 *    starter";
 *  - the HINTING. Astro's Google provider asks Google with a macOS user agent
 *    and is served builds with no `prep` table. An uninstructed TrueType font
 *    goes to FreeType's autohinter (Chromium on Linux/Android), which rounds
 *    each glyph's advance at text sizes, so body copy spaces unevenly. The
 *    vendored files are the builds a Windows/Linux browser gets, which carry
 *    `prep`. If someone swaps a face back to the Google provider, or drops in
 *    a file without the table, these fail;
 *  - the VARIABLE AXES. `wdth` is what makes Bricolage narrow and Martian
 *    Mono wide. A file without the axis leaves
 *    `font-variation-settings: "wdth" 78` a silent no-op — the page still
 *    renders, just at the wrong widths, which no test that only checks "a font
 *    loaded" would catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";

// (INC-D3a: this file used to pin `COMMERCE_SERVICE_URL` before importing
// astro.config, because the config resolved it at module load. The config
// reads no commerce address any more — like site-config.test.ts, this suite
// now imports it with no env pinned at all.)

interface ConfiguredFont {
	name: string;
	cssVariable: string;
	provider: { name: string };
	options?: {
		variants?: Array<{ src: string[]; weight: string; style?: string; stretch?: string }>;
	};
}

const fonts = ((await import("../astro.config.js")).default.fonts ??
	[]) as unknown as ConfiguredFont[];
const byVariable = new Map(fonts.map((font) => [font.cssVariable, font]));

const here = path.dirname(fileURLToPath(import.meta.url));
const fileOf = (src: string | undefined): string => path.resolve(here, "..", src ?? "");

/**
 * A woff2's table tags, in directory order, and the decompressed bytes of
 * each (a transformed glyf/loca is kept in its transformed form).
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

const FACES = [
	// [cssVariable, family, weight range, axes the theme needs in the file]
	["--u-face-display", "Bricolage Grotesque", "400 800", ["opsz", "wdth", "wght"]],
	["--u-face-body", "Schibsted Grotesk", "400 700", ["wght"]],
	["--u-face-data", "Martian Mono", "300 700", ["wdth", "wght"]],
] as const;

describe("astro.config fonts", () => {
	test("declares exactly the three roles: display, body, data", () => {
		expect([...byVariable.keys()].toSorted()).toEqual([
			"--u-face-body",
			"--u-face-data",
			"--u-face-display",
		]);
	});

	describe.each(FACES)("%s (%s)", (cssVariable, name, weight, axes) => {
		const font = byVariable.get(cssVariable);
		const variants = font?.options?.variants ?? [];
		const src = variants[0]?.src[0];

		test("is the family, from the LOCAL provider, as one variable variant over a weight range", () => {
			expect(font?.name).toBe(name);
			// Not `google`: that provider is served the unhinted macOS build.
			// Nothing is fetched from Google at build time or at runtime.
			expect(font?.provider.name).toBe("local");
			expect(variants).toHaveLength(1);
			expect(variants[0]?.src).toHaveLength(1);
			expect(variants[0]?.weight).toBe(weight);
			expect(variants[0]?.style).toBe("normal");
			// The latin subset only, as a variable file under src/fonts/.
			expect(src).toMatch(/^\.\/src\/fonts\/[a-z-]+\/[a-z-]+-variable-latin\.woff2$/);
		});

		test("the file is a woff2 that carries a prep program, so it is never autohinted", () => {
			const bytes = readFileSync(fileOf(src));
			expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
			expect(woff2Tables(bytes).tags).toEqual(
				expect.arrayContaining(["prep", "gvar", "HVAR", "GPOS"]),
			);
		});

		test(`the file carries the ${axes.join("/")} axes, so font-variation-settings is not a no-op`, () => {
			expect(fvarAxes(readFileSync(fileOf(src))).toSorted()).toEqual([...axes]);
		});

		test("ships with its OFL licence beside it", () => {
			expect(readFileSync(path.join(path.dirname(fileOf(src)), "OFL.txt"), "utf8")).toContain(
				"SIL Open Font License",
			);
		});
	});
});
