import { describe, expect, test } from "vitest";
import { productId } from "../src/money/ids.js";
import {
	DOWNLOAD_FALLBACK_CONTENT_TYPE,
	DOWNLOAD_FALLBACK_FILENAME,
	downloadContentTypeFor,
	isDownloadAssetKeyFor,
	MAX_DOWNLOAD_FILENAME_LENGTH,
	mintDownloadAssetKey,
	sanitizeDownloadFilename,
	validateDownloadAsset,
} from "../src/product-commerce/download-asset.js";

const PID = productId("01KAPRODUCT0000000000000000");

/** The descriptor the upload endpoint would build from these parts — and the
 *  validator the admin save runs on it. The point of every case below: what the
 *  upload side produces, the save side accepts. */
function accepted(filename: string, contentType: string): boolean {
	try {
		validateDownloadAsset(PID, {
			key: mintDownloadAssetKey(PID, 1_700_000_000_000, new Uint8Array(10)),
			filename,
			contentType,
			size: 1,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * The upload endpoint's coercions (issue #376, increment 4). The validator
 * (increment 1) accepts or refuses and never rewrites; these are the other half
 * of that contract — the ONE place an untrusted browser's filename and declared
 * type are turned into values the validator accepts. Each is total: any input
 * yields a value, and that value always passes.
 */
describe("mintDownloadAssetKey — the server-minted key", () => {
	test("is dl/{productId}/{ulid} and passes isDownloadAssetKeyFor", () => {
		const key = mintDownloadAssetKey(PID, 1_700_000_000_000, new Uint8Array(10).fill(255));
		expect(key).toMatch(/^dl\/01KAPRODUCT0000000000000000\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		expect(isDownloadAssetKeyFor(PID, key)).toBe(true);
	});

	test("encodes the timestamp first, so keys sort by upload time", () => {
		const random = new Uint8Array(10);
		const earlier = mintDownloadAssetKey(PID, 1_700_000_000_000, random);
		const later = mintDownloadAssetKey(PID, 1_700_000_000_001, random);
		expect(earlier < later).toBe(true);
		// The canonical ULID of 0 ms with zero randomness.
		expect(mintDownloadAssetKey(PID, 0, random)).toBe(`dl/${PID}/${"0".repeat(26)}`);
	});

	test("differs whenever the random bytes differ", () => {
		const a = mintDownloadAssetKey(PID, 5, new Uint8Array(10));
		const b = mintDownloadAssetKey(PID, 5, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 1));
		expect(a).not.toBe(b);
	});

	test("refuses a clock or randomness it cannot encode, rather than mint a weak key", () => {
		expect(() => mintDownloadAssetKey(PID, -1, new Uint8Array(10))).toThrow(RangeError);
		expect(() => mintDownloadAssetKey(PID, 2 ** 48, new Uint8Array(10))).toThrow(RangeError);
		expect(() => mintDownloadAssetKey(PID, 1.5, new Uint8Array(10))).toThrow(RangeError);
		expect(() => mintDownloadAssetKey(PID, 1, new Uint8Array(9))).toThrow(RangeError);
	});
});

describe("downloadContentTypeFor — the declared type, coerced to the allowlist", () => {
	test("keeps a safe type, lower-cased and without parameters", () => {
		expect(downloadContentTypeFor("application/pdf")).toBe("application/pdf");
		expect(downloadContentTypeFor("Application/ZIP")).toBe("application/zip");
		expect(downloadContentTypeFor("text/plain; charset=utf-8")).toBe("text/plain");
		expect(downloadContentTypeFor("  text/csv  ")).toBe("text/csv");
		expect(downloadContentTypeFor("image/png")).toBe("image/png");
		expect(downloadContentTypeFor("audio/mpeg")).toBe("audio/mpeg");
	});

	test("turns every active or unknown type into application/octet-stream", () => {
		for (const declared of [
			"text/html",
			"text/html; charset=utf-8",
			"TEXT/HTML",
			"image/svg+xml",
			"application/xhtml+xml",
			"application/xml",
			"text/xml",
			"text/javascript",
			"application/javascript",
			"application/x-ecmascript",
			"text/css",
			"multipart/x-mixed-replace",
			"",
			"pdf",
			"application/",
			"a/b/c",
			"application/pdf\r\nX-Evil: 1",
			null,
			undefined,
		]) {
			expect(downloadContentTypeFor(declared), String(declared)).toBe(
				DOWNLOAD_FALLBACK_CONTENT_TYPE,
			);
		}
		expect(DOWNLOAD_FALLBACK_CONTENT_TYPE).toBe("application/octet-stream");
	});

	test("whatever it returns, the validator accepts", () => {
		for (const declared of ["image/svg+xml", "text/plain;x=y", "video/mp4", "x/y", "\u0000"]) {
			expect(accepted("a.bin", downloadContentTypeFor(declared))).toBe(true);
		}
	});
});

describe("sanitizeDownloadFilename — a name the buyer's browser can save, never a path", () => {
	test("keeps an ordinary name exactly", () => {
		expect(sanitizeDownloadFilename("Field Guide.pdf")).toBe("Field Guide.pdf");
		expect(sanitizeDownloadFilename("Café menu – 2026.pdf")).toBe("Café menu – 2026.pdf");
		expect(sanitizeDownloadFilename("🎵 track.mp3")).toBe("🎵 track.mp3");
	});

	test("drops any directory part, from either slash", () => {
		expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitizeDownloadFilename("C:\\Users\\me\\book.epub")).toBe("book.epub");
		expect(sanitizeDownloadFilename("folder/")).toBe(DOWNLOAD_FALLBACK_FILENAME);
	});

	test("removes header-breaking, quoting and bidi characters, and lone surrogates", () => {
		expect(sanitizeDownloadFilename('a"b.pdf')).toBe("ab.pdf");
		expect(sanitizeDownloadFilename("evil\r\nSet-Cookie: x.pdf")).toBe("evilSet-Cookie: x.pdf");
		expect(sanitizeDownloadFilename("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
		expect(sanitizeDownloadFilename("a\u2028b\u0000c.txt")).toBe("abc.txt");
		expect(sanitizeDownloadFilename("x\uD800y.txt")).toBe("xy.txt");
	});

	test("removes invisible characters: zero-width, word joiner, BOM, soft hyphen, tags", () => {
		for (const cp of [
			0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2064, 0xfeff, 0x00ad, 0xe0000, 0xe0041, 0xe007f,
		]) {
			const raw = `gui${String.fromCodePoint(cp)}de.pdf`;
			expect(sanitizeDownloadFilename(raw), cp.toString(16)).toBe("guide.pdf");
			expect(accepted(sanitizeDownloadFilename(raw), "application/pdf")).toBe(true);
		}
		// Neighbours that are visible stay.
		expect(sanitizeDownloadFilename("a\u2065b\u00ACc.txt")).toBe("a\u2065b\u00ACc.txt");
		expect(sanitizeDownloadFilename(`${String.fromCodePoint(0xfeff)}\u200B`)).toBe(
			DOWNLOAD_FALLBACK_FILENAME,
		);
	});

	test("trims, and falls back to a plain name when nothing is left", () => {
		expect(sanitizeDownloadFilename("  report.pdf  ")).toBe("report.pdf");
		for (const raw of ["", "   ", ".", "..", "\u202E", "/", null, undefined]) {
			expect(sanitizeDownloadFilename(raw), String(raw)).toBe(DOWNLOAD_FALLBACK_FILENAME);
		}
	});

	test("shortens a long name to the limit and keeps its extension", () => {
		const name = sanitizeDownloadFilename(`${"a".repeat(400)}.pdf`);
		expect(name.length).toBe(MAX_DOWNLOAD_FILENAME_LENGTH);
		expect(name.endsWith(".pdf")).toBe(true);
		// Never splits a surrogate pair.
		const emoji = sanitizeDownloadFilename(`${"🎵".repeat(200)}.mp3`);
		expect(emoji.length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_LENGTH);
		expect(emoji.endsWith(".mp3")).toBe(true);
		expect(accepted(emoji, "audio/mpeg")).toBe(true);
	});

	test("whatever it returns, the validator accepts", () => {
		for (const raw of [
			'../"weird"\r\n\u202Ename .pdf ',
			"\uDC00",
			"x".repeat(1000),
			" . ",
			"a/../..",
			"\u0085next.txt",
		]) {
			expect(accepted(sanitizeDownloadFilename(raw), "application/pdf"), raw).toBe(true);
		}
	});
});
