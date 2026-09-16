/**
 * Single source of truth for the plugin's identity, capabilities, and
 * egress allowlist — imported by both the runtime (`plugin.ts`) and the
 * sandbox-clean guard test (DEVELOPMENT.md §5), so the two can never drift.
 *
 * `COMMERCE_SERVICE_BASE_URL` / `ALLOWED_HOSTS` are build-time
 * constants (matching the plan's manifest example,
 * `allowedHosts: [COMMERCE_SERVICE_HOST]`) — a real deploy pipeline pins
 * these to the merchant's commerce service before publishing the plugin
 * bundle. The sandbox test harness (`test/sandbox/harness.ts`) points them
 * at its ephemeral stub/live-service address by rewriting a COPY of this
 * file before bundling — `src/manifest.ts` itself is never mutated.
 */

import { type CommerceMode, resolveCommerceMode } from "./commerce/commerce-mode.js";
import type { PluginContext } from "./types.js";

export const OTTA_PLUGIN_ID = "otta";
export const OTTA_PLUGIN_VERSION = "0.1.0";

/**
 * The write-only plugin-kv key holding the machine write-gate token the service
 * enforces as `X-Service-Token` (ADR-0007). Admin-provisioned via the Settings
 * form's masked secret field, exactly like the admin `settings:internalToken`
 * (which it is DELIBERATELY distinct from — the two are different secrets: this
 * one unlocks the whole write surface, the internal token unlocks only the
 * `/admin` + `/internal` routes). Lives in this neutral module so BOTH the
 * storefront clients and the admin clients can read it without a storefront →
 * admin import edge. NEVER rendered back into a block.
 */
export const SERVICE_TOKEN_KEY = "settings:serviceToken";

/**
 * Read the service write-gate token from write-only plugin kv, for forwarding as
 * `X-Service-Token`. Returns `undefined` when unset OR empty (kept consistent
 * with the service gate, which treats an empty token as "gate open"), so a
 * missing token simply attaches no header.
 *
 * FAIL-CLOSED (review D3): a kv read that REJECTS is swallowed to `undefined`
 * — never propagated. An uncaught kv rejection escaping a fire-and-forget sync
 * hook or a storefront route handler is worse than a clean 401; and undefined ⇒
 * no header ⇒ a 401 if the service secret is set, matching the gate's own
 * fail-closed posture.
 */
export async function serviceTokenFromKv(ctx: PluginContext): Promise<string | undefined> {
	try {
		const token = await ctx.kv.get<string>(SERVICE_TOKEN_KEY);
		// `KV.get` contracts to `T | null`, but guard `undefined` too so this reads
		// byte-identically to the sandbox-harness copy — and never hits
		// `undefined.length` if kv ever diverges from its typed contract.
		return token !== null && token !== undefined && token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Sandbox-clean guard (DEVELOPMENT.md §5, plan §5): EXACTLY these two
 * capabilities, nothing else.
 *  - `content:read` — the minimum capability `content:afterSave` /
 *    `content:afterDelete` require to register (em-dash
 *    `HOOK_REQUIRED_CAPABILITY`); the plugin never calls `ctx.content` (the
 *    hook event already carries what it needs) and never declares
 *    `content:write` — it never writes CMS content.
 *  - `network:request` — `ctx.http.fetch`, host-restricted via
 *    `allowedHosts`. No `network:request:unrestricted`.
 * No `storage`/`kv`/db CAPABILITY — and not because the plugin holds no
 * commercial state: it holds all of it. `ctx.storage` is where commerce truth
 * lives (ADR-0018), and the host builds it on an always-available path with no
 * capability string in its vocabulary to declare, which is why owning that state
 * widens nothing here.
 */
export const OTTA_PLUGIN_CAPABILITIES = ["content:read", "network:request"] as const;

/**
 * Compile-time override hook (site deploy, plan D4): a deploying site
 * (e.g. `sites/staging`) injects the real commerce-service URL into the
 * plugin bundle via Vite `define: { __OTTA_COMMERCE_SERVICE_URL__: ... }`.
 * This stays sandbox-clean — no runtime env/IO read; the `typeof` guard
 * makes the undeclared global safe wherever no bundler defines it (tsdown
 * dist, vitest, the sandbox test harness — which replaces this whole
 * file's COPY before bundling anyway).
 */
declare const __OTTA_COMMERCE_SERVICE_URL__: string | undefined;

/** Placeholder production value — a real deploy pipeline pins this via the
 *  compile-time define above. */
const COMMERCE_SERVICE_BASE_URL_PLACEHOLDER = "https://commerce.otta.internal";

/** Pure resolution (unit-tested without a bundler in the loop): a
 *  non-empty compile-time override wins; anything else keeps the
 *  placeholder. */
export function resolveCommerceServiceBaseUrl(override: string | undefined): string {
	return override !== undefined && override.length > 0
		? override
		: COMMERCE_SERVICE_BASE_URL_PLACEHOLDER;
}

/**
 * TRANSITIONAL (work order 02 D6): used only in `"http"` mode, and DELETED at
 * INC-D3b along with `HttpCommerceClient`, the four admin HTTP clients,
 * `__OTTA_COMMERCE_MODE__` and `resolveCommerceMode`. In `"in-process"` mode it
 * is unused — nothing constructs an HTTP client — and `ALLOWED_HOSTS` below
 * stops deriving from it.
 */
export const COMMERCE_SERVICE_BASE_URL = resolveCommerceServiceBaseUrl(
	typeof __OTTA_COMMERCE_SERVICE_URL__ === "string" ? __OTTA_COMMERCE_SERVICE_URL__ : undefined,
);

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
 * The deployment-supplied halves of the in-process allowlist.
 *
 * Both are URLs, not hostnames, because that is the shape the values already
 * have: the service derives its email host from `EMAIL_API_URL`
 * (`service/src/index.ts:74`). Neither has a sensible default — there is no
 * canonical email provider, and the service has NO facilitator-URL env var at
 * all today (`service/src/x402-wiring.ts` only ever builds the offline
 * `createTestFacilitator`) — so an absent value grants no host rather than
 * guessing one.
 */
export interface InProcessEgressUrls {
	/** Where `HttpEmailSender` posts; the in-process equivalent of
	 *  `EMAIL_API_URL`. */
	emailApiUrl?: string | undefined;
	/** The x402 facilitator's base URL, for the day a real
	 *  `HTTPFacilitatorClient` replaces the offline test facilitator. */
	facilitatorUrl?: string | undefined;
}

/** A URL's hostname, or `undefined` for anything unparseable — including an
 *  empty define, a bare hostname with no scheme, and outright garbage. Never
 *  throws: this runs at module load, where a throw takes the whole plugin down
 *  (see `commerce-mode.ts`'s note on blast radius), and an ungrantable host must
 *  degrade to "no egress for that provider" — a refused fetch — not to a boot
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
 * not in this list (plan §5) — resolved PER MODE, as a pure function so both
 * arms are testable without a bundler.
 *
 * `"http"` (TRANSITIONAL, work order 02 D6 — the default, and what every
 * existing build, every vitest run and the sandbox harness resolve to): exactly
 * the one host derived from `COMMERCE_SERVICE_BASE_URL`, byte-identical to what
 * it has always been. The email and facilitator URLs are IGNORED on this arm
 * even when supplied: in http mode the SERVICE makes those calls, so granting
 * the plugin egress it does not use would widen the gate for nothing.
 *
 * `"in-process"` (INC-C3, the end state): the commerce service is gone, and the
 * calls it used to make are the plugin's own — Stripe's API, the email
 * provider's API, the x402 facilitator. The service host disappears from the
 * list entirely; that is the fold-in, visible in one line.
 *
 * The result is a SET: duplicates collapse, and order is insertion order so the
 * list is stable across builds.
 */
export function resolveAllowedHosts(
	mode: CommerceMode,
	serviceBaseUrl: string,
	egress: InProcessEgressUrls = {},
): string[] {
	if (mode !== "in-process") return [new URL(serviceBaseUrl).hostname];
	const hosts = new Set<string>([STRIPE_API_HOST]);
	for (const url of [egress.emailApiUrl, egress.facilitatorUrl]) {
		const host = hostnameOf(url);
		if (host !== undefined) hosts.add(host);
	}
	return [...hosts];
}

/**
 * Compile-time override hooks for the two deployment-supplied egress URLs,
 * exactly the shape `__OTTA_COMMERCE_SERVICE_URL__` already uses: a Vite
 * `define` a deploying site bakes into the plugin bundle, behind a `typeof`
 * guard so the undeclared global is safe in the plain tsdown dist, this
 * package's vitest run and the sandbox harness.
 *
 * These are URLs, never secrets — the credentials that ride them live in
 * write-only kv (`payment-secrets.ts`), which is what keeps
 * `wrangler-config.test.ts`'s /SECRET|KEY|TOKEN|PASSWORD/i ban on `vars` intact
 * and unroutable-around.
 */
declare const __OTTA_EMAIL_API_URL__: string | undefined;
declare const __OTTA_X402_FACILITATOR_URL__: string | undefined;

/** The in-process egress URLs this bundle was built for. Absent defines ⇒ no
 *  host granted for that provider (fail-closed). */
export const IN_PROCESS_EGRESS_URLS: InProcessEgressUrls = {
	emailApiUrl: typeof __OTTA_EMAIL_API_URL__ === "string" ? __OTTA_EMAIL_API_URL__ : undefined,
	facilitatorUrl:
		typeof __OTTA_X402_FACILITATOR_URL__ === "string" ? __OTTA_X402_FACILITATOR_URL__ : undefined,
};

/**
 * The resolved allowlist for THIS bundle.
 *
 * Still a module-load `string[]`, not a function, and deliberately so: the
 * descriptor in `plugin.ts`, `sandbox-entry.ts`'s `createHttpAccess`, the three
 * `sync/hooks.ts` defaults and both guard suites all consume it as a VALUE.
 * Turning it into a function would have rippled through the descriptor shape,
 * which INC-A6 must not touch. The mode is a build-time constant, so resolving
 * it at module load loses nothing.
 *
 * At INC-D3a the `"http"` arm and `COMMERCE_SERVICE_BASE_URL` are deleted
 * outright and only the in-process branch survives.
 */
export const ALLOWED_HOSTS: string[] = resolveAllowedHosts(
	resolveCommerceMode(),
	COMMERCE_SERVICE_BASE_URL,
	IN_PROCESS_EGRESS_URLS,
);
