/**
 * The private downloads bucket (issue #376), and the BUILD-TIME guard that keeps
 * it apart from the public media bucket on the wrangler config the build
 * actually uses.
 *
 * ── Why two buckets ──────────────────────────────────────────────────────────
 * EmDash serves every key in the `MEDIA` bucket at
 * `/_emdash/api/media/file/<key>`, unauthenticated, by design (only `backups/`
 * is held back). A paid file there would be public to anyone who learned its
 * key, and the key is exactly what the download gate answers an entitled buyer
 * — who keeps it after a refund. So paid files live in a SECOND bucket, bound as
 * `DOWNLOADS`, that nothing but the site's download endpoint
 * (`pages/orders/[orderId]/download/[sku].ts`) ever reads, and only after
 * re-running the gate. The middleware's `dl/` media deny (`media-deny.ts`) is
 * the backstop for a file put in the wrong bucket by hand.
 *
 * ── Why a build guard and not only a test ────────────────────────────────────
 * The tracked `wrangler.jsonc` is a template, and `wrangler-config.test.ts` pins
 * IT. A deployment builds from its own gitignored `wrangler.local.jsonc`
 * (astro.config.ts selects it), which no test sees. A local file that names the
 * media bucket for `DOWNLOADS` would deploy cleanly and publish every paid file.
 * So the build refuses that pair, naming the file and the env.
 *
 * WHAT IT CANNOT SEE. Public access (an r2.dev URL) and custom domains are
 * bucket SETTINGS, made in the dashboard or with `wrangler r2 bucket
 * dev-url|domain`, not wrangler config. DEPLOYMENT.md §2.1 says never to turn
 * either on for the downloads bucket; no build can check it.
 *
 * A missing `DOWNLOADS` binding is NOT a build error: downloads are then off.
 * The order pages draw no download link, and the endpoint answers 404.
 *
 * Pure (text in, throw or not out), so it is unit-tested without a build:
 * `test/downloads-bucket-guard.test.ts`.
 */

/** The private bucket's binding name — the one the endpoint reads. */
export const DOWNLOADS_BINDING = "DOWNLOADS";

/** EmDash's public media bucket (`src/emdash-options.ts`). */
export const MEDIA_BINDING = "MEDIA";

/**
 * JSONC → JSON: drops `//` and block comments OUTSIDE strings (a URL in a string
 * keeps its `//`), then trailing commas. Enough for a wrangler config; anything
 * wrangler itself would reject may throw here too.
 */
function jsoncToJson(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** One `r2_buckets` entry, as far as the guard reads it. */
export interface R2BucketEntry {
	binding?: unknown;
	bucket_name?: unknown;
	preview_bucket_name?: unknown;
}

/** Parse the config's text — a leading UTF-8 BOM stripped (JSON.parse rejects
 *  it) — wrapping a parse error so it names the file. */
function parseWrangler(wranglerText: string, fileName: string): Record<string, unknown> {
	const text = wranglerText.startsWith("﻿") ? wranglerText.slice(1) : wranglerText;
	try {
		const parsed: unknown = JSON.parse(jsoncToJson(text));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		throw new Error(
			`${fileName} could not be parsed as JSONC while checking its r2_buckets ` +
				`(${error instanceof Error ? error.message : String(error)}).`,
			{ cause: error },
		);
	}
}

function bucketEntries(value: unknown): R2BucketEntry[] {
	return Array.isArray(value)
		? value.filter((entry): entry is R2BucketEntry => typeof entry === "object" && entry !== null)
		: [];
}

/**
 * Every place the config declares R2 buckets: the top level, and each
 * `env.<name>` block. Wrangler does not inherit `r2_buckets` into an env, so an
 * env deployed with `--env <name>` has exactly its own list — each is checked
 * on its own.
 */
export function r2BucketScopes(
	wranglerText: string,
	fileName: string,
): { scope: string; buckets: R2BucketEntry[] }[] {
	const config = parseWrangler(wranglerText, fileName);
	const scopes = [{ scope: "", buckets: bucketEntries(config["r2_buckets"]) }];
	const env = config["env"];
	if (typeof env === "object" && env !== null) {
		for (const [name, block] of Object.entries(env as Record<string, unknown>)) {
			const buckets =
				typeof block === "object" && block !== null
					? bucketEntries((block as Record<string, unknown>)["r2_buckets"])
					: [];
			scopes.push({ scope: `env.${name}`, buckets });
		}
	}
	return scopes;
}

/** The real and preview bucket names EVERY entry bound as `binding` would
 *  reach — not just the first: wrangler does not reject a duplicate binding, so
 *  a second `DOWNLOADS` (or `MEDIA`) entry must not hide from the check. */
function bucketNames(buckets: readonly R2BucketEntry[], binding: string): string[] {
	return buckets
		.filter((entry) => entry.binding === binding)
		.flatMap((entry) => [entry.bucket_name, entry.preview_bucket_name])
		.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Throw if the wrangler config the build uses points `DOWNLOADS` at a bucket
 * `MEDIA` also names — real or preview, at the top level or in any env block. A
 * file that does not parse throws too, naming the file.
 *
 * @param wranglerText the selected config file's contents
 * @param fileName its name, for the message (`wrangler.local.jsonc` or the template)
 */
export function assertDownloadsBucketPrivate(wranglerText: string, fileName: string): void {
	for (const { scope, buckets } of r2BucketScopes(wranglerText, fileName)) {
		const media = bucketNames(buckets, MEDIA_BINDING);
		const shared = bucketNames(buckets, DOWNLOADS_BINDING).find((name) => media.includes(name));
		if (shared === undefined) continue;
		const where = scope === "" ? fileName : `${fileName} (${scope})`;
		throw new Error(
			`${where} binds "${DOWNLOADS_BINDING}" to the R2 bucket "${shared}", which ` +
				`"${MEDIA_BINDING}" also uses. EmDash serves every key in the media bucket ` +
				`publicly at /_emdash/api/media/file/<key>, so paid downloads would be ` +
				`readable by anyone who learns a key. Create a separate private bucket ` +
				`(wrangler r2 bucket create <name>), set it as "${DOWNLOADS_BINDING}"'s ` +
				`bucket_name in ${fileName}, then build again (DEPLOYMENT.md §2.1).`,
		);
	}
}
