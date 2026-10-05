/**
 * EmDash's PUBLIC media route never serves a key under `dl/` (issue #376,
 * increment 3) — defence in depth for paid downloads.
 *
 * Paid files live in the private `DOWNLOADS` bucket (`downloads-bucket.ts`),
 * never in `MEDIA`, and the build refuses a config that makes the two the same
 * bucket. What is left is a hand-made mistake: a `dl/…` object put into the
 * media bucket (`wrangler r2 object put` aimed at the wrong bucket). EmDash
 * serves every media key at `/_emdash/api/media/file/<key>` with no auth (it
 * holds back only `backups/`), and its image endpoint reads the same storage
 * through `/_image?href=…`. The middleware answers 404 for either before EmDash's
 * route runs.
 *
 * MATCHING IS DELIBERATELY WIDE. Astro `decodeURI`-decodes the pathname before
 * routing (`%66ile` is `file`, `%64l` is `dl`), and a key may be escaped further
 * (`dl%2F…`) or carry leading slashes. So the path is checked raw AND decoded,
 * the key raw AND fully decoded, with leading slashes stripped. A legitimate
 * media key never starts with `dl/` — EmDash mints ULID keys — so over-matching
 * costs nothing.
 */

const MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";

/** Astro's image endpoint; EmDash replaces it with one that reads media keys
 *  named by `href` straight from storage. */
const IMAGE_ENDPOINT = "/_image";

/** The prefix every download key carries (`dl/{productId}/{ulid}`). */
const DOWNLOAD_KEY_PREFIX = "dl/";

function decoded(text: string, decode: (s: string) => string): string[] {
	try {
		return [text, decode(text)];
	} catch {
		return [text];
	}
}

/** The media key a pathname names, raw and decoded, or none. */
function mediaKeys(pathname: string): string[] {
	return decoded(pathname, decodeURI)
		.filter((path) => path.startsWith(MEDIA_FILE_PREFIX))
		.flatMap((path) => decoded(path.slice(MEDIA_FILE_PREFIX.length), decodeURIComponent));
}

function isDownloadKey(key: string): boolean {
	return key.replace(/^\/+/, "").startsWith(DOWNLOAD_KEY_PREFIX);
}

/** Does this request ask EmDash's public media route (directly, or through the
 *  image endpoint's `href`) for a key under `dl/`? */
export function isPrivateDownloadMediaRequest(url: URL): boolean {
	const keys = mediaKeys(url.pathname);
	if (keys.length > 0) return keys.some(isDownloadKey);
	if (url.pathname !== IMAGE_ENDPOINT) return false;
	const href = url.searchParams.get("href");
	if (href === null) return false;
	let hrefPath: string;
	try {
		hrefPath = new URL(href, "http://same-site.invalid").pathname;
	} catch {
		return false;
	}
	return mediaKeys(hrefPath).some(isDownloadKey);
}
