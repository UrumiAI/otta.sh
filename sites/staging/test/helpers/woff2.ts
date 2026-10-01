/**
 * A minimal WOFF2 reader for the font suites: it mirrors the WOFF2 spec's
 * header and table directory (§5.1–5.2) and reads only the table tags, each
 * table's decompressed bytes, and the `fvar` axis tags — enough for any theme's
 * font test to pin hinting (`prep`) and variation axes without a font library.
 *
 * Not a `.test.ts`, deliberately: `vitest.config.ts` collects `test/**` /`*`
 * `.test.ts` only, so this is a plain module the suites import.
 */
import { brotliDecompressSync } from "node:zlib";

/** The spec's known-table order (§5.1): a 6-bit flags index names these; 63 means an explicit tag follows. */
export const KNOWN_TABLE_TAGS =
	"cmap,head,hhea,hmtx,maxp,name,OS/2,post,cvt ,fpgm,glyf,loca,prep,CFF ,VORG,EBDT,EBLC,gasp,hdmx,kern,LTSH,PCLT,VDMX,vhea,vmtx,BASE,GDEF,GPOS,GSUB,EBSC,JSTF,MATH,CBDT,CBLC,COLR,CPAL,SVG ,sbix,acnt,avar,bdat,bloc,bsln,cvar,fdsc,feat,fmtx,fvar,gvar,hsty,just,lcar,mort,morx,opbd,prop,trak,Zapf,Silf,Glat,Gloc,Feat,Sill".split(
		",",
	);

/** The WOFF2 header is fixed-size; the table directory starts right after it. */
const HEADER_SIZE = 48;

/**
 * A woff2's table tags, in directory order, and the decompressed bytes of
 * each (a transformed glyf/loca is kept in its transformed form).
 */
export function woff2Tables(bytes: Buffer): { tags: string[]; tables: Map<string, Buffer> } {
	const entries: Array<[string, number]> = [];
	let at = HEADER_SIZE;
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
		let tag = KNOWN_TABLE_TAGS[index] ?? `#${index}`;
		if (index === 0x3f) {
			tag = bytes.subarray(at, at + 4).toString("latin1");
			at += 4;
		}
		let length = base128(); // origLength
		// A transformLength follows when the table IS transformed: glyf/loca use
		// version 0 for "transformed", every other table uses a non-zero version.
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

/** The variation axes a woff2's `fvar` declares, in table order. Throws if it has no `fvar`. */
export function fvarAxes(bytes: Buffer): string[] {
	const fvar = woff2Tables(bytes).tables.get("fvar");
	if (fvar === undefined) throw new Error("woff2 has no fvar table");
	const axesAt = fvar.readUInt16BE(4);
	const axisSize = fvar.readUInt16BE(10);
	return Array.from({ length: fvar.readUInt16BE(8) }, (_, i) =>
		fvar.subarray(axesAt + i * axisSize, axesAt + i * axisSize + 4).toString("latin1"),
	);
}
