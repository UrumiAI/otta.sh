/**
 * The `global_fetch_strictly_public` ⇔ D1-session pairing rule (issue #375): the
 * flag blocks the request the D1 Sessions API makes to route queries (emdash
 * #1273), so it must never ship beside a session mode. site-config.test.ts
 * applies it to the tracked `wrangler.jsonc`.
 *
 * A build-time guard once applied it to a deployment's own gitignored
 * `wrangler.local.jsonc` too, for copies made before #375 that still carried the
 * flag. It was removed in #455: no live store depends on it any more.
 *
 * Pure (text in, value out): `test/wrangler-pairing.test.ts`.
 */

import { parseWrangler } from "./wrangler-jsonc.js";

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

/** The string entries of a `compatibility_flags` value; anything else ⇒ none. */
function stringFlags(flags: unknown): string[] {
	return Array.isArray(flags)
		? flags.filter((flag): flag is string => typeof flag === "string")
		: [];
}

/** Parse for the flag checks: the shared reader, typed to what they read. */
function parseWranglerFlags(wranglerText: string, fileName: string): WranglerShape {
	return parseWrangler(wranglerText, fileName, "its compatibility_flags") as WranglerShape;
}

interface WranglerShape {
	compatibility_flags?: unknown;
}

/** The TOP-LEVEL `compatibility_flags` — parsed, so the flag's name in a comment
 *  never counts. No key ⇒ no flags. */
export function wranglerCompatibilityFlags(
	wranglerText: string,
	fileName = "wrangler config",
): string[] {
	return stringFlags(parseWranglerFlags(wranglerText, fileName).compatibility_flags);
}
