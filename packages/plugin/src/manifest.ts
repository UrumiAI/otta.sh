/**
 * Single source of truth for the plugin's identity, capabilities, and
 * egress allowlist — imported by both the runtime (`plugin.ts`) and the
 * sandbox-clean guard test (DEVELOPMENT.md §5), so the two can never drift.
 *
 * `COMMERCE_SERVICE_BASE_URL` / `ALLOWED_HOSTS` are plain build-time
 * constants (matching the plan's manifest example,
 * `allowedHosts: [COMMERCE_SERVICE_HOST]`) — a real deploy pipeline pins
 * these to the merchant's commerce service before publishing the plugin
 * bundle. The sandbox test harness (`test/sandbox/harness.ts`) points them
 * at its ephemeral stub/live-service address by rewriting a COPY of this
 * file before bundling — `src/manifest.ts` itself is never mutated.
 */

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
 * No `storage`/`kv`/db capability — the plugin holds no commercial state.
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

export const COMMERCE_SERVICE_BASE_URL = resolveCommerceServiceBaseUrl(
	typeof __OTTA_COMMERCE_SERVICE_URL__ === "string" ? __OTTA_COMMERCE_SERVICE_URL__ : undefined,
);

/** The plugin's egress allowlist — the host's `ctx.http.fetch` rejects any
 *  host not in this list (plan §5). Must stay in sync with
 *  `COMMERCE_SERVICE_BASE_URL`'s host. */
export const ALLOWED_HOSTS: string[] = [new URL(COMMERCE_SERVICE_BASE_URL).hostname];
