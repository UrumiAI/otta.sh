/**
 * Single source of truth for the plugin's identity, capabilities, and
 * egress allowlist — imported by both the runtime (`plugin.ts`) and the
 * sandbox-clean guard test (DEVELOPMENT.md §5), so the two can never drift.
 *
 * `ALLOWED_HOSTS` is a build-time constant: the plugin's own egress, resolved
 * once at module load from the deployment-supplied egress defines. The sandbox
 * test harness (`test/sandbox/harness.ts`) rewrites a COPY of this file before
 * bundling — `src/manifest.ts` itself is never mutated.
 */

export const OTTA_PLUGIN_ID = "otta";
export const OTTA_PLUGIN_VERSION = "0.1.0";

/**
 * Sandbox-clean guard (DEVELOPMENT.md §5, plan §5): EXACTLY these three
 * capabilities, nothing else.
 *  - `content:read` — the minimum capability `content:afterSave` /
 *    `content:afterDelete` require to register (em-dash
 *    `HOOK_REQUIRED_CAPABILITY`). The hooks never call `ctx.content` (the event
 *    already carries what they need); the one reader is the `product-orphans`
 *    sweep leg, which asks `ctx.content.get` whether a commerce row's CMS
 *    document still exists (issue #374). Never `content:write` — the plugin
 *    never writes CMS content.
 *  - `network:request` — `ctx.http.fetch`, host-restricted via
 *    `allowedHosts`. No `network:request:unrestricted`.
 *  - `email:send` — `ctx.email`, the host's email pipeline (ADR-0031). EmDash
 *    owns email providers; the plugin grants itself no email host and holds no
 *    email credential. Not `hooks.email-transport:register` (or its deprecated
 *    alias `email:provide`): otta delivers nothing itself.
 * No `storage`/`kv`/db CAPABILITY — and not because the plugin holds no
 * commercial state: it holds all of it. `ctx.storage` is where commerce truth
 * lives (ADR-0018), and the host builds it on an always-available path with no
 * capability string in its vocabulary to declare, which is why owning that state
 * widens nothing here.
 */
export const OTTA_PLUGIN_CAPABILITIES = ["content:read", "network:request", "email:send"] as const;

/**
 * Stripe's SERVER-SIDE API host — the one egress the in-process plugin always
 * makes itself (`paymentIntents.create`, refunds), and the only host in the
 * in-process allowlist that is a constant rather than deployment-supplied.
 *
 * NOT the Stripe.js CDN host. Stripe.js and `stripe.confirmPayment()` run in
 * the BUYER'S BROWSER and never pass through the plugin, which is why
 * `sandbox-clean-guard.test.ts` pins that host's absence — and pins it by
 * forbidding the literal ANYWHERE in this package's source, which is why this
 * comment does not spell it. `api.stripe.com` is a different thing: it is real
 * plugin egress the moment the payment gateway is folded in, and granting it
 * does not grant the other.
 */
export const STRIPE_API_HOST = "api.stripe.com";

/**
 * The deployment-supplied half of the in-process allowlist.
 *
 * EMPTY TODAY: operator-supplied egress plugs in here (a field, resolved by
 * {@link resolveAllowedHosts} and baked through {@link BAKED_EGRESS_URLS}).
 * There is no email URL — email goes through `ctx.email` (ADR-0031) — and an
 * absent value always grants no host rather than guessing one.
 */
export interface InProcessEgressUrls {
	// Operator-supplied egress hosts plug in here.
}

/**
 * The plugin's egress allowlist — the host's `ctx.http.fetch` rejects any host
 * not in this list (plan §5) — as a pure function so it is testable without a
 * bundler.
 *
 * There is ONE list now (INC-D3a): the commerce service is gone, and the call
 * it used to make is the plugin's own — Stripe's API. No service host appears
 * here at all; that is the fold-in, visible in one line. The constant part is
 * Stripe's API host; anything else comes from the deployment's egress
 * ({@link InProcessEgressUrls}, none today). No email host: email goes through
 * `ctx.email` (ADR-0031), never `ctx.http`.
 *
 * The result is a SET: duplicates collapse, and order is insertion order so the
 * list is stable across builds.
 */
export function resolveAllowedHosts(_egress: InProcessEgressUrls = {}): string[] {
	const hosts = new Set<string>([STRIPE_API_HOST]);
	return [...hosts];
}

/** The raw defines, before resolution — none today (see
 *  {@link InProcessEgressUrls}). Not exported: every consumer must see
 *  {@link IN_PROCESS_EGRESS_URLS}, which agrees with `ALLOWED_HOSTS` by
 *  construction. A deployment-supplied value is a Vite `define` behind a
 *  `typeof` guard, so the undeclared global is safe in the plain tsdown dist,
 *  this package's vitest run and the sandbox harness — and it is never a
 *  secret: credentials live in write-only kv (`payment-secrets.ts`). */
const BAKED_EGRESS_URLS: InProcessEgressUrls = {};

/**
 * The egress URLs a CONSUMER may use, resolved by the SAME rules the allowlist
 * is (review round 2, A3): a value that would grant no host is dropped —
 * unconfigured, which every consumer already handles — so "a consumer never
 * holds a URL whose host is not granted" is true by construction rather than
 * by every caller remembering. No URL is deployment-supplied today, so this
 * resolves to `{}`.
 */
export function resolveInProcessEgress(_egress: InProcessEgressUrls = {}): InProcessEgressUrls {
	return {};
}

/** The in-process egress URLs this bundle may actually use. Absent or
 *  unparseable define ⇒ that provider is unconfigured (fail-closed). */
export const IN_PROCESS_EGRESS_URLS: InProcessEgressUrls =
	resolveInProcessEgress(BAKED_EGRESS_URLS);

/**
 * The resolved allowlist for THIS bundle.
 *
 * Still a module-load `string[]`, not a function, and deliberately so: the
 * descriptor in `plugin.ts`, `sandbox-entry.ts`'s `createHttpAccess`, the three
 * `sync/hooks.ts` defaults and both guard suites all consume it as a VALUE.
 * Turning it into a function would have rippled through the descriptor shape,
 * which INC-A6 must not touch. The egress URLs are build-time defines, so
 * resolving at module load loses nothing.
 */
export const ALLOWED_HOSTS: string[] = resolveAllowedHosts(BAKED_EGRESS_URLS);
