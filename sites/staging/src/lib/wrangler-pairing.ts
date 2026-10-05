/**
 * The `global_fetch_strictly_public` ⇔ D1-session pairing rule, and the BUILD-TIME
 * guard that enforces it on the wrangler config the build actually uses (issue
 * #375).
 *
 * ── Why a build guard and not only a test ────────────────────────────────────
 * The tracked `wrangler.jsonc` is a template, and the tests pin IT. A deployment
 * builds from its own gitignored `wrangler.local.jsonc` (astro.config.ts selects
 * it), which DEPLOYMENT.md §2.1 told every operator to make by copying the
 * template — so every deployment made before #375 still carries the flag in a
 * file no test sees. Pull #375 and D1 sessions come on beside it: the flag blocks
 * the request the D1 Sessions API makes to route queries (emdash #1273). EmDash
 * 0.38's hang guard turns that into a ~5 s stall on the first session query of
 * every new isolate, after which sessions are silently off for that isolate — and
 * a WRITE caught in that window (placing an order, a cart write, the Stripe
 * webhook settle) is rejected rather than re-run, i.e. a 500. Nothing fails at
 * deploy time. So the build refuses the pair instead, naming the file.
 *
 * Pure (text in, throw or not out) so it is unit-tested without a build:
 * `test/wrangler-pairing.test.ts`.
 */

/** The compatibility flag that breaks the D1 Sessions API. */
export const STRICTLY_PUBLIC_FLAG = "global_fetch_strictly_public";

/**
 * Whether a D1 `session` setting turns sessions on — EmDash's own test,
 * `isSessionEnabled` in `@emdash-cms/cloudflare` (`!!session && session !==
 * "disabled"`), so absent, `""` and `"disabled"` are all off.
 */
function isSessionOn(session: unknown): boolean {
	return !!session && session !== "disabled";
}

/** The pairing rule: the flag and any D1 session mode must never ship together. */
export function violatesPairing(flags: readonly string[], session: unknown): boolean {
	return isSessionOn(session) && flags.includes(STRICTLY_PUBLIC_FLAG);
}

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

/** The config's `compatibility_flags` — parsed, so the flag's name in a comment
 *  never counts. No key ⇒ no flags. */
export function wranglerCompatibilityFlags(wranglerText: string): string[] {
	const config = JSON.parse(jsoncToJson(wranglerText)) as { compatibility_flags?: unknown };
	const flags = config.compatibility_flags;
	return Array.isArray(flags)
		? flags.filter((flag): flag is string => typeof flag === "string")
		: [];
}

/**
 * Throw if the wrangler config the build uses carries the flag while D1 sessions
 * are on.
 *
 * @param wranglerText the selected config file's contents
 * @param fileName its name, for the message (`wrangler.local.jsonc` or the template)
 * @param d1Config the `config` of the D1 database descriptor (`{ session?: … }`)
 */
export function assertWranglerSessionPairing(
	wranglerText: string,
	fileName: string,
	d1Config: { session?: unknown } | undefined,
): void {
	const session = d1Config?.session;
	if (!violatesPairing(wranglerCompatibilityFlags(wranglerText), session)) return;
	throw new Error(
		`${fileName} sets the "${STRICTLY_PUBLIC_FLAG}" compatibility flag, but D1 sessions are on ` +
			`(session: ${JSON.stringify(session)}, sites/staging/src/emdash-options.ts). The flag ` +
			`blocks the D1 Sessions API (emdash issue #1273): every new isolate would stall ~5 s on ` +
			`its first query and could reject an in-flight write. The flag is no longer needed ` +
			`(issue #375). Delete "${STRICTLY_PUBLIC_FLAG}" from compatibility_flags in ${fileName}, ` +
			`then build again (DEPLOYMENT.md §2.4, "Upgrading an existing deployment").`,
	);
}
