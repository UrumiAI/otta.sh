import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency, money } from "../src/money/cents.js";
import { idempotencyKey, productId, type ProductId } from "../src/money/ids.js";
import type { DownloadAsset, ProductCommerce } from "../src/ports/product-commerce-store.js";
import { isDownloadAssetKeyFor } from "../src/product-commerce/download-asset.js";
import { InvalidProductFieldError } from "../src/product-commerce/errors.js";
import { updateProductCommerceFields } from "../src/product-commerce/use-cases.js";
import { CountingIdGen, FixedClock } from "../src/testing/deterministic.js";
import { InMemoryInventoryStore } from "../src/testing/in-memory-inventory-store.js";
import { InMemoryProductCommerceStore } from "../src/testing/in-memory-product-commerce-store.js";

/** A canonical ULID — 26 Crockford base-32 characters, first one 0–7. */
const ULID = "01J9ZQ3V8K4M2N6P7R8S9T0VWX";
const PID = productId("prod-dl");

function asset(over: Partial<DownloadAsset> = {}): DownloadAsset {
	return {
		key: `dl/${PID}/${ULID}`,
		filename: "Field Guide.pdf",
		contentType: "application/pdf",
		size: 1_048_576,
		...over,
	};
}

/**
 * The write-path rules for `downloadAsset` (issue #376, increment 1). The
 * validator ACCEPTS OR REFUSES; it never rewrites a value, so what the merchant's
 * console submitted is exactly what is stored and served. Each refusal is an
 * `InvalidProductFieldError` naming the sub-field, which the admin surface maps
 * to its `{ reason: "invalid", field }` answer.
 */
describe("updateProductCommerceFields — downloadAsset validation", () => {
	let productCommerce: InMemoryProductCommerceStore;
	let inventory: InMemoryInventoryStore;
	let seeded: ProductCommerce;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	beforeEach(async () => {
		productCommerce = new InMemoryProductCommerceStore({ clock });
		inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
		seeded = await productCommerce.upsert(
			{
				productId: PID,
				price: money(cents(900), currency("USD")),
				productKind: "digital",
			},
			idempotencyKey("seed"),
		);
	});

	function edit(downloadAsset: DownloadAsset | null, key = "edit-1", pid: ProductId = PID) {
		return updateProductCommerceFields(
			{ productCommerce, inventory },
			{ productId: pid, downloadAsset },
			idempotencyKey(key),
			seeded.updatedAt.toISOString(),
		);
	}

	async function refusedOn(value: DownloadAsset, field: string): Promise<void> {
		const err = await edit(value).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err, `expected a refusal on ${field}`).toBeInstanceOf(InvalidProductFieldError);
		expect((err as InvalidProductFieldError).field).toBe(field);
		// Refused means nothing was written.
		expect((await productCommerce.getByProductId(PID))?.downloadAsset).toBeNull();
	}

	test("a well-formed descriptor is stored as given, and null clears it", async () => {
		const res = await edit(asset({ sha256: "a".repeat(64) }));
		expect(res.ok && res.product.downloadAsset).toEqual(asset({ sha256: "a".repeat(64) }));

		const cleared = await updateProductCommerceFields(
			{ productCommerce, inventory },
			{ productId: PID, downloadAsset: null },
			idempotencyKey("edit-2"),
			res.ok ? res.product.updatedAt.toISOString() : "",
		);
		expect(cleared.ok && cleared.product.downloadAsset).toBeNull();
	});

	test("a product with no descriptor reads null — absent is never an attached file", async () => {
		expect((await productCommerce.getByProductId(PID))?.downloadAsset).toBeNull();
	});

	describe("key: the server-minted dl/{productId}/{ulid} for THIS product", () => {
		test.each([
			["another product's key", `dl/prod-other/${ULID}`],
			["no prefix", ULID],
			["a different prefix", `media/${PID}/${ULID}`],
			["a filename-derived tail", `dl/${PID}/Field Guide.pdf`],
			["a traversal", `dl/${PID}/../prod-other/${ULID}`],
			["a nested path", `dl/${PID}/${ULID}/x`],
			["a lowercase ulid", `dl/${PID}/${ULID.toLowerCase()}`],
			["a ulid with a forbidden letter (U)", `dl/${PID}/01J9ZQ3V8K4M2N6P7R8S9T0VWU`],
			["a ulid past the timestamp range", `dl/${PID}/81J9ZQ3V8K4M2N6P7R8S9T0VWX`],
			["a short ulid", `dl/${PID}/${ULID.slice(1)}`],
			["an empty key", ""],
		])("refuses %s", async (_label, key) => {
			await refusedOn(asset({ key }), "downloadAsset.key");
		});

		test("isDownloadAssetKeyFor accepts exactly the minted shape", () => {
			expect(isDownloadAssetKeyFor(PID, `dl/${PID}/${ULID}`)).toBe(true);
			expect(isDownloadAssetKeyFor(productId("prod-other"), `dl/${PID}/${ULID}`)).toBe(false);
		});
	});

	describe("filename: bounded, and refused rather than stripped", () => {
		test("accepts unicode and up to 255 characters", async () => {
			expect((await edit(asset({ filename: "Guía de campo — 2ª ed.pdf" }))).ok).toBe(true);
			expect((await edit(asset({ filename: "a".repeat(255) }), "edit-2")).ok).toBe(true);
		});

		test.each([
			["empty", ""],
			["over 255 characters", "a".repeat(256)],
			["a CR", "guide\r.pdf"],
			["a LF", "guide\n.pdf"],
			["a CRLF header injection", 'guide.pdf"\r\nSet-Cookie: x=1'],
			["a NUL", "guide\u0000.pdf"],
			["a TAB", "guide\t.pdf"],
			["a DEL", "guide\u007f.pdf"],
			["a C1 control", `guide${String.fromCodePoint(0x85)}.pdf`],
			["a left-to-right mark", `guide${String.fromCodePoint(0x200e)}.pdf`],
			["a double quote", 'gu"ide.pdf'],
			["a backslash", "gu\\ide.pdf"],
			["a slash", "dir/guide.pdf"],
			["a right-to-left override", `invoice${String.fromCodePoint(0x202e)}fdp.exe`],
			["an isolate", `guide${String.fromCodePoint(0x2066)}.pdf`],
			["only whitespace", "   "],
			["leading whitespace", " guide.pdf"],
			["trailing whitespace", "guide.pdf "],
			["a dot", "."],
			["a dot-dot", ".."],
		])("refuses %s", async (_label, filename) => {
			await refusedOn(asset({ filename }), "downloadAsset.filename");
		});

		// Ill-formed UTF-16 cannot be stored on every dialect alike (Postgres's jsonb
		// cast rejects it, SQLite keeps it) and cannot be percent-encoded into a
		// header (`encodeURIComponent` throws), so it is refused here, by name.
		// Built from code units: a literal would not survive the formatter.
		const HIGH = String.fromCharCode(0xd800);
		const LOW = String.fromCharCode(0xdc00);
		test.each([
			["a lone high surrogate", `a${HIGH}.pdf`],
			["a lone low surrogate", `a${LOW}.pdf`],
			["a reversed pair", `a${LOW}${HIGH}.pdf`],
			["a trailing high surrogate", `guide.pdf${HIGH}`],
			["a line separator", `guide${String.fromCharCode(0x2028)}.pdf`],
			["a paragraph separator", `guide${String.fromCharCode(0x2029)}.pdf`],
		])("refuses %s", async (_label, filename) => {
			await refusedOn(asset({ filename }), "downloadAsset.filename");
		});

		test("accepts a well-formed surrogate pair (an emoji)", async () => {
			const book = String.fromCodePoint(0x1f4d8);
			expect((await edit(asset({ filename: `${book} guide.pdf` }))).ok).toBe(true);
		});
	});

	describe("contentType: a bare lowercase type/subtype, never an active-content type", () => {
		test.each([
			"application/pdf",
			"application/zip",
			"application/epub+zip",
			"audio/mpeg",
			"video/mp4",
			"image/png",
			"text/plain",
			"text/csv",
			"application/octet-stream",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		])("accepts %s", async (contentType) => {
			expect((await edit(asset({ contentType }))).ok).toBe(true);
		});

		test.each([
			["text/html", "text/html"],
			["image/svg+xml", "image/svg+xml"],
			["application/xhtml+xml", "application/xhtml+xml"],
			["any +xml subtype", "application/atom+xml"],
			["text/xml", "text/xml"],
			["application/xml", "application/xml"],
			["text/javascript", "text/javascript"],
			["application/javascript", "application/javascript"],
			["text/xsl", "text/xsl"],
			["multipart/x-mixed-replace", "multipart/x-mixed-replace"],
			["text/css (text/* is an allowlist)", "text/css"],
			["text/markdown (text/* is an allowlist)", "text/markdown"],
			["text/vtt (text/* is an allowlist)", "text/vtt"],
			["text/rtf (text/* is an allowlist)", "text/rtf"],
			["text/x-anything (text/* is an allowlist)", "text/x-component"],
			["uppercase", "Application/PDF"],
			["uppercase html", "TEXT/HTML"],
			["parameters", "text/plain; charset=utf-8"],
			["a CRLF", "application/pdf\r\nX: y"],
			["no subtype", "application"],
			["a wildcard", "application/*"],
			["empty", ""],
			["over-long", `application/${"x".repeat(200)}`],
		])("refuses %s", async (_label, contentType) => {
			await refusedOn(asset({ contentType }), "downloadAsset.contentType");
		});
	});

	// Every JavaScript MIME type essence the WHATWG MIME Sniffing standard lists.
	// A browser runs any of them as script, so each is refused — the `text/*` ones
	// by the text allowlist, the `application/*` ones by name.
	describe("contentType: every WHATWG JavaScript MIME type essence is refused", () => {
		test.each([
			"application/ecmascript",
			"application/javascript",
			"application/x-ecmascript",
			"application/x-javascript",
			"text/ecmascript",
			"text/javascript",
			"text/javascript1.0",
			"text/javascript1.1",
			"text/javascript1.2",
			"text/javascript1.3",
			"text/javascript1.4",
			"text/javascript1.5",
			"text/jscript",
			"text/livescript",
			"text/x-ecmascript",
			"text/x-javascript",
		])("refuses %s", async (contentType) => {
			await refusedOn(asset({ contentType }), "downloadAsset.contentType");
		});
	});

	describe("size: a non-negative safe integer (bytes)", () => {
		test("accepts 0 and MAX_SAFE_INTEGER", async () => {
			expect((await edit(asset({ size: 0 }))).ok).toBe(true);
			expect((await edit(asset({ size: Number.MAX_SAFE_INTEGER }), "edit-2")).ok).toBe(true);
		});

		test.each([
			["negative", -1],
			["fractional", 1.5],
			["NaN", Number.NaN],
			["Infinity", Number.POSITIVE_INFINITY],
			["past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
		])("refuses %s", async (_label, size) => {
			await refusedOn(asset({ size }), "downloadAsset.size");
		});
	});

	describe("sha256: optional; when present, 64 lowercase hex characters", () => {
		test("accepts absent and a lowercase digest", async () => {
			const absent = await edit(asset());
			expect(absent.ok && absent.product.downloadAsset).toEqual(asset());
			expect(
				absent.ok &&
					absent.product.downloadAsset !== null &&
					"sha256" in absent.product.downloadAsset,
			).toBe(false);
			expect((await edit(asset({ sha256: "0123456789abcdef".repeat(4) }), "edit-2")).ok).toBe(true);
		});

		test.each([
			["63 characters", "a".repeat(63)],
			["65 characters", "a".repeat(65)],
			["uppercase hex", "A".repeat(64)],
			["non-hex", "g".repeat(64)],
			["empty", ""],
		])("refuses %s", async (_label, sha256) => {
			await refusedOn(asset({ sha256 }), "downloadAsset.sha256");
		});
	});

	test("an edit that both makes the product physical and attaches a file is refused", async () => {
		const err = await updateProductCommerceFields(
			{ productCommerce, inventory },
			{ productId: PID, productKind: "physical", downloadAsset: asset() },
			idempotencyKey("edit-1"),
			seeded.updatedAt.toISOString(),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(InvalidProductFieldError);
		expect((err as InvalidProductFieldError).field).toBe("downloadAsset");
	});
});
