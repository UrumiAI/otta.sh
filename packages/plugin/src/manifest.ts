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

export const URUMI_PLUGIN_ID = "urumi";
export const URUMI_PLUGIN_VERSION = "0.1.0";

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
export const URUMI_PLUGIN_CAPABILITIES = ["content:read", "network:request"] as const;

/** Placeholder production value — a real deploy pipeline templates this. */
export const COMMERCE_SERVICE_BASE_URL = "https://commerce.urumi.internal";

/** The plugin's egress allowlist — the host's `ctx.http.fetch` rejects any
 *  host not in this list (plan §5). Must stay in sync with
 *  `COMMERCE_SERVICE_BASE_URL`'s host. */
export const ALLOWED_HOSTS: string[] = [new URL(COMMERCE_SERVICE_BASE_URL).hostname];
