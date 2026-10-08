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
 * A URL, not a hostname. There is no default x402 facilitator (ADR-0028
 * Decision 8: the deployer picks it), so an absent value grants no host rather
 * than guessing one. (No email URL: email goes through `ctx.email`, ADR-0031.)
 */
export interface InProcessEgressUrls {
	/** The x402 facilitator's URL. Nothing calls it between ADR-0028 increments 2
	 *  and 6; increment 6's `/verify` and `/settle` client uses it as a base URL. */
	facilitatorUrl?: string | undefined;
}

/** A URL's hostname, or `undefined` for anything unparseable — including an
 *  empty define, a bare hostname with no scheme, and outright garbage. Never
 *  throws: this runs at module load, where a throw takes the whole plugin down —
 *  the descriptor never registers and every route 500s — and an ungrantable host
 *  must degrade to "no egress for that provider" — a refused fetch — not to a boot
 *  failure and not to a widened gate. */
function hostnameOf(url: string | undefined): string | undefined {
	if (url === undefined || url.length === 0) return undefined;
	try {
		const { hostname } = new URL(url);
		return hostname.length > 0 ? hostname : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The plugin's egress allowlist — the host's `ctx.http.fetch` rejects any host
 * not in this list (plan §5) — as a pure function so it is testable without a
 * bundler.
 *
 * There is ONE list now (INC-D3a): the commerce service is gone, and the calls
 * it used to make are the plugin's own — Stripe's API and the x402
 * facilitator. No service host appears here at all; that is the fold-in,
 * visible in one line. The constant part is Stripe's API host; the facilitator
 * comes from the deployment's egress URL. No email host: email goes through
 * `ctx.email` (ADR-0031), never `ctx.http`.
 *
 * The result is a SET: duplicates collapse, and order is insertion order so the
 * list is stable across builds.
 */
export function resolveAllowedHosts(egress: InProcessEgressUrls = {}): string[] {
	const hosts = new Set<string>([STRIPE_API_HOST]);
	const facilitator = hostnameOf(egress.facilitatorUrl);
	if (facilitator !== undefined) hosts.add(facilitator);
	return [...hosts];
}

/**
 * Compile-time override hook for the deployment-supplied egress URL: a
 * Vite `define` a deploying site bakes into the plugin bundle, behind a `typeof`
 * guard so the undeclared global is safe in the plain tsdown dist, this
 * package's vitest run and the sandbox harness.
 *
 * A URL, never a secret — the credential that rides it lives in
 * write-only kv (`payment-secrets.ts`), which is what keeps
 * `wrangler-config.test.ts`'s /SECRET|KEY|TOKEN|PASSWORD/i ban on `vars` intact
 * and unroutable-around.
 */
declare const __OTTA_X402_FACILITATOR_URL__: string | undefined;

/** The raw defines, before resolution. Not exported: every consumer must see
 *  {@link IN_PROCESS_EGRESS_URLS}, which agrees with `ALLOWED_HOSTS` by
 *  construction. */
const BAKED_EGRESS_URLS: InProcessEgressUrls = {
	facilitatorUrl:
		typeof __OTTA_X402_FACILITATOR_URL__ === "string" ? __OTTA_X402_FACILITATOR_URL__ : undefined,
};

/**
 * The egress URLs a CONSUMER may use, resolved by the SAME predicate the
 * allowlist is (review round 2, A3).
 *
 * `resolveAllowedHosts` funnels every URL through {@link hostnameOf} and grants
 * NOTHING for one that does not parse — a bare hostname, an empty define,
 * outright garbage. A resolver that passed the string through verbatim would
 * hand a consumer exactly such a URL and reproduce the symptom this function
 * exists to make impossible: a client is built and every call is refused by the
 * gate. So one that yields no host is
 * dropped — unconfigured, which every consumer already handles.
 *
 * Resolving once, here, makes "a consumer never holds a URL whose host is not
 * granted" true by construction rather than by every caller remembering.
 */
export function resolveInProcessEgress(egress: InProcessEgressUrls = {}): InProcessEgressUrls {
	/** The URL, or `undefined` when `resolveAllowedHosts` would grant no host for
	 *  it — the two decisions made by one predicate, so they cannot disagree. */
	const grantable = (url: string | undefined): string | undefined =>
		hostnameOf(url) === undefined ? undefined : url;
	const facilitatorUrl = grantable(egress.facilitatorUrl);
	return facilitatorUrl !== undefined ? { facilitatorUrl } : {};
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
