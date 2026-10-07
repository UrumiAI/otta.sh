/**
 * The site's Stripe-webhook EDGE TOKEN, read at RUNTIME from a Worker secret.
 *
 * ── Why this is not a build-time define ───────────────────────────────────
 * `stripe-config.ts` bakes the Stripe *publishable* key in with a Vite
 * `define`, and that is right for a publishable key: it is public, it is
 * needed in client JS, and rotating it is a deploy anyway. This value is the
 * opposite on every count. It is a SHARED SECRET, it must never enter a
 * bundle, and it has to be rotatable with `wrangler secret put` alone. It is
 * also barred from wrangler `vars` by `test/wrangler-config.test.ts`, which
 * forbids any `vars` key matching /SECRET|KEY|TOKEN|PASSWORD/i — a guard
 * worth keeping, and one this name trips on TOKEN. So: a Worker secret.
 *
 * ── Why `virtual:emdash/env` and not `locals.runtime.env` ─────────────────
 * The obvious read — `context.locals.runtime.env.OTTA_WH_TOKEN` — does not
 * exist on this stack. Astro 6+ removed `locals.runtime.env`, and accessing it
 * THROWS rather than returning `undefined`, so even optional chaining does not
 * save it (emdash #1736); `@astrojs/cloudflare`'s `Runtime` type here carries
 * only `cfContext`. EmDash's answer is this virtual module, which re-exports
 * Cloudflare's own `env` from `cloudflare:workers` under the Cloudflare
 * adapter and `undefined` under any other adapter — which is why every read
 * below tolerates an absent `env` object rather than assuming one.
 *
 * ── Provisioning ──────────────────────────────────────────────────────────
 *   wrangler secret put OTTA_WH_TOKEN
 * and set the SAME value on the plugin side, in Otta's admin settings, which
 * stores it at the kv key `settings:otta-wh-token`. The two halves are one
 * shared secret; provisioning only one of them is a misconfiguration:
 *   - site set, plugin unset  ⇒ the plugin's gate passes everything through
 *     (by design) and the token buys nothing — but nothing breaks, since the
 *     Stripe HMAC is the real trust anchor;
 *   - site unset, plugin set  ⇒ every delivery 401s. This is the dangerous
 *     direction, and the reason the endpoint's response replays the plugin's
 *     401 rather than swallowing it: Stripe's dashboard shows the failures.
 */
import { env } from "virtual:emdash/env";

/** The provisioned secret's name, pinned as data by `stripe-webhook.test.ts`
 *  so a rename cannot silently degrade the endpoint to "no token attached". */
export const OTTA_WH_TOKEN_VAR = "OTTA_WH_TOKEN";

/**
 * The edge token, or `undefined` when this deploy has none.
 *
 * Read PER CALL, never memoized at module load: under the Cloudflare adapter
 * the module graph outlives a request, and a `wrangler secret put` should take
 * effect on the next isolate rather than on the next deploy.
 *
 * A blank or whitespace-only value folds to `undefined` — "provisioned to
 * nothing" is not a token, and sending it as a header would be strictly worse
 * than sending none: the plugin's gate treats an ABSENT header and a PRESENT
 * wrong one differently, and only the first degrades gracefully.
 */
export function webhookEdgeToken(): string | undefined {
	const raw = env?.[OTTA_WH_TOKEN_VAR];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
