/**
 * The build-time Stripe publishable key (ADR-0012 decision 4).
 *
 * Baked into the bundle by a Vite `define` in `astro.config.ts`, exactly like
 * `COMMERCE_SERVICE_URL`: shell env → `sites/staging/.env` → absent. Changing
 * it is a rebuild + redeploy. It is baked rather than read from wrangler `vars`
 * at runtime because `test/wrangler-config.test.ts` forbids any `vars` key
 * matching `/SECRET|KEY|TOKEN|PASSWORD/i` — a guard worth keeping — and a
 * publishable key matches it on `KEY`.
 *
 * ── Why this module throws ────────────────────────────────────────────────
 * "The key is absent" and "we read the wrong variable name" are
 * INDISTINGUISHABLE at runtime: both make `/checkout` say "Card payment isn't
 * set up on this store yet.", nothing errors, and no test fails. An earlier
 * draft of this feature's plan named the variable `STRIPE_PUBLISHABLE_KEY`;
 * implemented literally it would have shipped that message to every buyer while
 * a valid `pk_test_…` sat unread on disk.
 *
 * So: absence degrades QUIETLY (that is a real, supported state — a store that
 * has not connected Stripe), while a value that is PRESENT but does not look
 * like a publishable key THROWS AT BUILD, mirroring `resolveServiceUrl`'s
 * "throw early rather than bake garbage into the bundle". Between them, the
 * only way to reach the degraded path is to genuinely have no key.
 */

/** The provisioned variable name, pinned as data by `checkout-config.test.ts`.
 *  It is `STRIPE_PUBLIC_KEY` — NOT `STRIPE_PUBLISHABLE_KEY`, which appears
 *  nowhere in our provisioning. */
export const STRIPE_PUBLIC_KEY_VAR = "STRIPE_PUBLIC_KEY";

/** Stripe's own publishable-key shape. A secret key (`sk_…`) or a truncated
 *  paste fails this and takes the throwing branch. */
const PUBLISHABLE_KEY = /^pk_(test|live)_[A-Za-z0-9]+$/;

/**
 * Resolve the build-time key. `undefined` ⇒ genuinely unconfigured (never a
 * placeholder, which would half-boot Stripe.js into an unexplainable error).
 *
 * @throws when a value is present but malformed — the error names the VARIABLE
 * and never echoes the VALUE, so a mistyped secret key cannot leak into a build
 * log or CI transcript.
 */
export function resolveStripePublishableKey(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim();
	if (value.length === 0) return undefined;
	if (!PUBLISHABLE_KEY.test(value)) {
		throw new Error(
			`${STRIPE_PUBLIC_KEY_VAR} is set but is not a Stripe publishable key ` +
				`(expected pk_test_… or pk_live_…). Refusing to bake it: a malformed key ` +
				`is indistinguishable at runtime from no key at all, and would silently ` +
				`degrade every buyer to "card payment isn't set up".`,
		);
	}
	return value;
}

/**
 * Compile-time override hook — the same `typeof` guard `@otta-sh/plugin`'s
 * manifest uses, so the identifier is safe wherever no bundler defines it
 * (vitest, `astro check`). The define always bakes a STRING; an absent key
 * bakes `""`, which resolves to unconfigured.
 */
declare const __URUMI_STRIPE_PUBLIC_KEY__: string | undefined;

/** The key this build was compiled with, or `undefined` when the store has not
 *  connected Stripe. Pages branch on this: no key ⇒ render review + totals and
 *  say so, and create NO order. */
export const STRIPE_PUBLISHABLE_KEY: string | undefined =
	typeof __URUMI_STRIPE_PUBLIC_KEY__ === "string" && __URUMI_STRIPE_PUBLIC_KEY__.length > 0
		? __URUMI_STRIPE_PUBLIC_KEY__
		: undefined;
