/**
 * The WOFF2 reader the font suites lean on (`test/helpers/woff2.ts`), against
 * hand-built files. The case that matters: a font whose directory LISTS `prep`
 * but at length 0. FreeType checks the table's size, not its presence, so that
 * font is still autohinted — a tags-only check would pass it, and
 * `fonts-config.test.ts`'s non-empty assertion must not.
 */
import { brotliCompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { fvarAxes, KNOWN_TABLE_TAGS, woff2Tables } from "./helpers/woff2.js";

/** A 7-byte scan-control program: PUSHW 511 SCANCTRL PUSHB 4 SCANTYPE. */
const SCAN_CONTROL_PREP = Buffer.from([0xb8, 0x01, 0xff, 0x85, 0xb0, 0x04, 0x8d]);

/** A woff2 carrying `tables` untransformed, in order. Only the fields the reader reads are filled. */
function woff2(tables: Array<[string, Buffer]>): Buffer {
	const directory: number[] = [];
	for (const [tag, data] of tables) {
		const index = KNOWN_TABLE_TAGS.indexOf(tag);
		if (index === -1) directory.push(0x3f, ...Buffer.from(tag, "latin1"));
		// glyf/loca would need transform version 3 for "untransformed"; not used here.
		else directory.push(index);
		// UIntBase128 origLength (lengths here stay under 16384).
		const length = data.length;
		if (length >= 128) directory.push(0x80 | (length >> 7), length & 0x7f);
		else directory.push(length);
	}
	const compressed = brotliCompressSync(Buffer.concat(tables.map(([, data]) => data)));
	const header = Buffer.alloc(48);
	header.write("wOF2", 0, "latin1");
	header.writeUInt16BE(tables.length, 12);
	header.writeUInt32BE(compressed.length, 20);
	return Buffer.concat([header, Buffer.from(directory), compressed]);
}

/** An `fvar` with the given axis tags (20-byte records, no instances). */
function fvar(axes: string[]): Buffer {
	const table = Buffer.alloc(16 + axes.length * 20);
	table.writeUInt16BE(1, 0); // majorVersion
	table.writeUInt16BE(16, 4); // axesArrayOffset
	table.writeUInt16BE(2, 6); // reserved
	table.writeUInt16BE(axes.length, 8);
	table.writeUInt16BE(20, 10); // axisSize
	axes.forEach((tag, i) => table.write(tag, 16 + i * 20, "latin1"));
	return table;
}

describe("woff2Tables", () => {
	test("reads tags in directory order and each table's bytes, including an explicit-tag table", () => {
		const { tags, tables } = woff2Tables(
			woff2([
				["head", Buffer.alloc(54, 1)],
				["prep", SCAN_CONTROL_PREP],
				["HVAR", Buffer.alloc(200, 2)],
			]),
		);
		expect(tags).toEqual(["head", "prep", "HVAR"]);
		expect(tables.get("prep")).toEqual(SCAN_CONTROL_PREP);
		expect(tables.get("HVAR")).toEqual(Buffer.alloc(200, 2));
	});

	test("a zero-length prep is LISTED but EMPTY, so a presence check passes it and the size check does not", () => {
		const { tags, tables } = woff2Tables(
			woff2([
				["head", Buffer.alloc(54, 1)],
				["prep", Buffer.alloc(0)],
				["GPOS", Buffer.alloc(10, 3)],
			]),
		);
		expect(tags).toContain("prep");
		expect(tables.get("GPOS")).toEqual(Buffer.alloc(10, 3));
		// The exact assertion fonts-config.test.ts makes, failing on this file:
		expect(() => expect(tables.get("prep")?.length ?? 0).toBeGreaterThan(0)).toThrow();
	});
});

describe("fvarAxes", () => {
	test("reads the axis tags from fvar", () => {
		const font = woff2([
			["head", Buffer.alloc(54)],
			["fvar", fvar(["wght", "wdth", "opsz"])],
		]);
		expect(fvarAxes(font)).toEqual(["wght", "wdth", "opsz"]);
	});

	test("throws on a font with no fvar", () => {
		expect(() => fvarAxes(woff2([["head", Buffer.alloc(54)]]))).toThrow(/no fvar/);
	});
});
