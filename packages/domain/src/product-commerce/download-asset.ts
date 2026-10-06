/**
 * The write-path rules for a digital product's download file (issue #376) — the
 * value checks `updateProductCommerceFields` runs on a `DownloadAsset` before
 * the store sees it. Pure: no IO, no clock.
 *
 * **Accept or refuse; never rewrite.** Every rule below refuses a value it does
 * not like rather than "cleaning" it. The descriptor is produced by our own
 * upload endpoint (download increment 4), which mints the key and owns the
 * coercions — it is where an untrusted browser's declared type is turned into
 * `application/octet-stream` and a filename is chosen. A value that reaches this
 * boundary in any other shape is a bug or a forgery, and silently repairing it
 * would hide which. It also keeps the stored descriptor byte-for-byte what was
 * submitted, so a re-submit is recognisably the same edit.
 *
 * The serving tier (increment 3) sanitizes again when it builds headers
 * (`Content-Disposition`, `Content-Type`), and adds `nosniff` and a sandboxing
 * CSP. These rules are the first layer, not the only one.
 */
import type { ProductId } from "../money/ids.js";
import type { DownloadAsset } from "../ports/product-commerce-store.js";
import { InvalidProductFieldError } from "./errors.js";

/** The longest filename accepted, in UTF-16 code units — the common filesystem
 *  limit, and far more than any merchant's real name for a file. */
export const MAX_DOWNLOAD_FILENAME_LENGTH = 255;

/** The bucket key's prefix. A separate namespace from anything else in the
 *  bucket, and the reason a key can be tied to exactly one product. */
const KEY_PREFIX = "dl/";

/**
 * A canonical ULID: 26 Crockford base-32 characters (no I, L, O or U), upper
 * case, the first one 0–7 because a 48-bit timestamp tops out there. EmDash's
 * own uploads mint the same shape, and lower case is refused rather than folded:
 * the server mints the key, so a lower-case one was not minted by it.
 */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Every character a filename may not carry. Each one is a way to break out of,
 * or lie inside, the `Content-Disposition` header and the buyer's file dialog:
 *  - C0 controls (CR and LF — header injection — NUL, TAB …), DEL and C1;
 *  - `"` and `\`, the quoting characters of the header's `filename=` form;
 *  - `/`, because a filename is a name and not a path (`\` is covered above);
 *  - the bidirectional controls — LRM/RLM (U+200E/F), ALM (U+061C), the
 *    embeddings and overrides (U+202A–U+202E) and the isolates (U+2066–U+2069) —
 *    with which `invoice` + U+202E + `fdp.exe` displays as `invoiceexe.pdf`;
 *  - the line and paragraph separators (U+2028/U+2029), line breaks by another
 *    name in a header or a file dialog.
 *
 * Code points rather than a regex character class, so the invisible ones are
 * named by number in the source instead of sitting in it as invisible text.
 */
function isForbiddenFilenameCodePoint(cp: number): boolean {
	return (
		cp <= 0x1f ||
		(cp >= 0x7f && cp <= 0x9f) ||
		cp === 0x22 || // "
		cp === 0x2f || // /
		cp === 0x5c || // \
		cp === 0x061c ||
		cp === 0x200e ||
		cp === 0x200f ||
		(cp >= 0x202a && cp <= 0x202e) ||
		(cp >= 0x2066 && cp <= 0x2069) ||
		cp === 0x2028 ||
		cp === 0x2029
	);
}

/**
 * True iff `value` is well-formed UTF-16 — no lone surrogate. Iterating a string
 * yields a valid pair as ONE code point above U+FFFF, so any element that is
 * itself in the surrogate range is a lone half. (`String.prototype.isWellFormed`
 * is the same test, but is ES2024 and this package targets ES2023.)
 *
 * Ill-formed text is refused by name rather than left to storage: Postgres's
 * jsonb cast rejects it (an unmapped storage error, not an input refusal) while
 * SQLite keeps it, and the serving tier's `encodeURIComponent` would throw on it
 * when it builds `Content-Disposition`.
 */
function isWellFormedUtf16(value: string): boolean {
	for (const ch of value) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp >= 0xd800 && cp <= 0xdfff) return false;
	}
	return true;
}

/**
 * A bare media type: lower-case `type/subtype` from RFC 6838's restricted-name
 * alphabet, each part at most 127 characters, and NO parameters. Parameters
 * (`; charset=…`) carry nothing a download needs and widen the header surface.
 */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The only `text/*` types accepted. `text/*` is an ALLOWLIST, not a denylist: the
 * family is where browsers keep their executable and renderable spellings —
 * `text/html`, `text/xml`, `text/xsl`, `text/css` and the long tail of JavaScript
 * aliases (`text/jscript`, `text/livescript`, `text/javascript1.0`–`1.5`, …) — and
 * a denylist would have to know every one of them. Plain text and CSV are the
 * text files merchants actually sell; anything else is uploaded as
 * `application/octet-stream`.
 */
const ALLOWED_TEXT_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/csv"]);

/**
 * Outside `text/*`, the types a browser would treat as an active document — run
 * script from, or render with the site's origin — if the response were ever
 * opened inline. Refused here, coerced to `application/octet-stream` by the upload
 * endpoint. With them, every `+xml` subtype (XML can pull in XSLT and, as SVG or
 * XHTML, script) and any subtype naming a script language, so the WHATWG
 * JavaScript essences are refused in every spelling, not only those listed.
 */
const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"application/x-ecmascript",
	"multipart/x-mixed-replace",
]);
const SCRIPT_SUBTYPE = /javascript|ecmascript|jscript|livescript/;

/** True iff a (syntactically valid) media type may describe a download. */
function isSafeDownloadType(contentType: string): boolean {
	const [type = "", subtype = ""] = contentType.split("/");
	if (type === "text") return ALLOWED_TEXT_TYPES.has(contentType);
	if (ACTIVE_CONTENT_TYPES.has(contentType)) return false;
	return !subtype.endsWith("+xml") && !SCRIPT_SUBTYPE.test(subtype);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True iff `key` is exactly `dl/{productId}/{ulid}` for THIS product. */
export function isDownloadAssetKeyFor(productId: ProductId, key: string): boolean {
	const prefix = `${KEY_PREFIX}${productId}/`;
	return key.startsWith(prefix) && ULID.test(key.slice(prefix.length));
}

/**
 * Check a descriptor against every rule above and return a CANONICAL copy —
 * the five known fields and nothing else, `sha256` only when present — so a
 * stray property on the input can never ride into storage. Throws
 * `InvalidProductFieldError` naming the first sub-field that fails
 * (`downloadAsset.key`, `.filename`, `.contentType`, `.size`, `.sha256`).
 */
export function validateDownloadAsset(productId: ProductId, asset: DownloadAsset): DownloadAsset {
	if (typeof asset.key !== "string" || !isDownloadAssetKeyFor(productId, asset.key)) {
		throw new InvalidProductFieldError(
			"downloadAsset.key",
			`downloadAsset.key must be the server-minted dl/${productId}/{ulid} for this product`,
		);
	}
	requireFilename(asset.filename);
	requireContentType(asset.contentType);
	if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
		throw new InvalidProductFieldError(
			"downloadAsset.size",
			"downloadAsset.size must be a non-negative integer number of bytes",
		);
	}
	if (
		asset.sha256 !== undefined &&
		!(typeof asset.sha256 === "string" && SHA256_HEX.test(asset.sha256))
	) {
		throw new InvalidProductFieldError(
			"downloadAsset.sha256",
			"downloadAsset.sha256 must be 64 lowercase hex characters",
		);
	}
	return {
		key: asset.key,
		filename: asset.filename,
		contentType: asset.contentType,
		size: asset.size,
		...(asset.sha256 !== undefined ? { sha256: asset.sha256 } : {}),
	};
}

function requireFilename(filename: unknown): void {
	const field = "downloadAsset.filename";
	if (typeof filename !== "string" || filename.length === 0) {
		throw new InvalidProductFieldError(field, `${field} must not be empty`);
	}
	if (filename.length > MAX_DOWNLOAD_FILENAME_LENGTH) {
		throw new InvalidProductFieldError(
			field,
			`${field} must be at most ${String(MAX_DOWNLOAD_FILENAME_LENGTH)} characters`,
		);
	}
	if (!isWellFormedUtf16(filename)) {
		throw new InvalidProductFieldError(field, `${field} must be well-formed text`);
	}
	if ([...filename].some((ch) => isForbiddenFilenameCodePoint(ch.codePointAt(0) ?? 0))) {
		throw new InvalidProductFieldError(
			field,
			`${field} must not contain control, quote, slash, backslash or bidirectional-control characters`,
		);
	}
	if (filename.trim() !== filename || filename === "." || filename === "..") {
		throw new InvalidProductFieldError(
			field,
			`${field} must be a name, without leading or trailing spaces`,
		);
	}
}

function requireContentType(contentType: unknown): void {
	const field = "downloadAsset.contentType";
	if (typeof contentType !== "string" || !MEDIA_TYPE.test(contentType)) {
		throw new InvalidProductFieldError(
			field,
			`${field} must be a lowercase type/subtype with no parameters`,
		);
	}
	if (!isSafeDownloadType(contentType)) {
		throw new InvalidProductFieldError(
			field,
			`${field} must not be a type a browser runs as a page; upload it as application/octet-stream`,
		);
	}
}

// ── the upload side: coercions that always land inside the rules above ───────
//
// The validator above refuses and never rewrites. The upload endpoint (download
// increment 4) is the one place a browser's filename and declared type become a
// descriptor, so the coercions live HERE, beside the rules they must satisfy: a
// change to one is a change to the other, in one file and one test. Each is
// total — any input yields a value — and every value it yields passes
// `validateDownloadAsset`.

/** What the buyer saves the file as when the merchant's own name has nothing
 *  usable left in it. */
export const DOWNLOAD_FALLBACK_FILENAME = "download";

/** The type a download is served as when the declared one is not on the list. */
export const DOWNLOAD_FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** The longest extension kept whole when a long name is shortened. */
const MAX_KEPT_EXTENSION = 16;

/**
 * A browser's declared type as a download's stored type: the essence (no
 * parameters), lower-cased, kept when it is a well-formed type the validator
 * accepts and `application/octet-stream` otherwise — `text/html`, SVG, any
 * script type, a malformed value and a missing one alike. The client's type is
 * never trusted for anything a browser could render as a page; at worst a safe
 * file is served as opaque bytes, which every browser saves.
 */
export function downloadContentTypeFor(declared: unknown): string {
	if (typeof declared !== "string") return DOWNLOAD_FALLBACK_CONTENT_TYPE;
	const essence = (declared.split(";")[0] ?? "").trim().toLowerCase();
	return MEDIA_TYPE.test(essence) && isSafeDownloadType(essence)
		? essence
		: DOWNLOAD_FALLBACK_CONTENT_TYPE;
}

/**
 * A merchant's filename as a download's stored filename: only the last path
 * segment (either slash — a name, never a path), every character the validator
 * forbids removed (controls, quotes, slashes, bidi controls, line separators,
 * lone surrogates), NFC-normalized, trimmed, and shortened to
 * {@link MAX_DOWNLOAD_FILENAME_LENGTH} keeping a short extension. Nothing left,
 * or only `.`/`..`, is {@link DOWNLOAD_FALLBACK_FILENAME}.
 *
 * Characters are REMOVED rather than replaced: a replacement character would be
 * a visible lie about what the merchant typed, while removal leaves the readable
 * part of the name intact.
 */
export function sanitizeDownloadFilename(raw: unknown): string {
	if (typeof raw !== "string") return DOWNLOAD_FALLBACK_FILENAME;
	const segments = raw.split(/[/\\]/);
	let kept = "";
	for (const ch of segments[segments.length - 1] ?? "") {
		const cp = ch.codePointAt(0) ?? 0;
		if ((cp >= 0xd800 && cp <= 0xdfff) || isForbiddenFilenameCodePoint(cp)) continue;
		kept += ch;
	}
	const name = kept.normalize("NFC").trim();
	if (name === "" || name === "." || name === "..") return DOWNLOAD_FALLBACK_FILENAME;
	return name.length <= MAX_DOWNLOAD_FILENAME_LENGTH ? name : shortenFilename(name);
}

/** Cut a name to the limit, keeping its extension when it is short, and never
 *  splitting a surrogate pair or leaving trailing space at the cut. */
function shortenFilename(name: string): string {
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 && name.length - dot <= MAX_KEPT_EXTENSION + 1 ? name.slice(dot) : "";
	const budget = MAX_DOWNLOAD_FILENAME_LENGTH - extension.length;
	let stem = "";
	for (const ch of extension === "" ? name : name.slice(0, dot)) {
		if (stem.length + ch.length > budget) break;
		stem += ch;
	}
	stem = stem.trimEnd();
	return `${stem === "" ? DOWNLOAD_FALLBACK_FILENAME : stem}${extension}`;
}

/** Crockford base-32, the ULID alphabet (no I, L, O or U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The bytes of randomness a ULID carries (80 bits). */
export const DOWNLOAD_KEY_RANDOM_BYTES = 10;

/**
 * Mint a download's bucket key, `dl/{productId}/{ulid}`, from the upload's
 * clock and {@link DOWNLOAD_KEY_RANDOM_BYTES} bytes of randomness the caller
 * draws (pure: the domain neither reads a clock nor calls `crypto`). Nothing a
 * request carries reaches it but the product id, which the caller has already
 * resolved to a real product. A FRESH key per upload is what makes a replaced
 * file safe: the old object is never overwritten under a buyer mid-download,
 * and the descriptor's switch to the new key is the moment every link serves
 * the new bytes.
 *
 * Throws `RangeError` for a clock outside a ULID's 48-bit millisecond range or
 * the wrong amount of randomness, rather than mint a key the validator refuses
 * or a weaker one.
 */
export function mintDownloadAssetKey(
	productId: ProductId,
	nowMs: number,
	random: Uint8Array,
): string {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) {
		throw new RangeError("mintDownloadAssetKey: the clock must be a 48-bit millisecond count");
	}
	if (random.length !== DOWNLOAD_KEY_RANDOM_BYTES) {
		throw new RangeError(
			`mintDownloadAssetKey: exactly ${String(DOWNLOAD_KEY_RANDOM_BYTES)} random bytes are needed`,
		);
	}
	let time = "";
	let t = nowMs;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32]! + time;
		t = Math.floor(t / 32);
	}
	let entropy = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of random) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			entropy += CROCKFORD[(buffer >> bits) & 31]!;
		}
		buffer &= (1 << bits) - 1;
	}
	return `${KEY_PREFIX}${productId}/${time}${entropy}`;
}
