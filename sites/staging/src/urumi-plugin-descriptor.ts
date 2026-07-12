/**
 * The Urumi plugin's TRUSTED (in-process) registration descriptor —
 * ADR-0006. A hand-written standard-format `PluginDescriptor`: em-dash's
 * integration generates `import def from "@urumi/plugin/plugin";
 * adaptSandboxEntry(def, {...this descriptor})` at build time, so the
 * plugin's `{hooks, routes}` default export runs in the host worker — but
 * `capabilities` and `allowedHosts` are STILL enforced by the
 * PluginContextFactory (`createHttpAccess` gates every `ctx.http.fetch` by
 * hostname), which is what keeps DEVELOPMENT.md §5's "only via ctx.http +
 * allowedHosts" true in trusted mode.
 *
 * Pure module (no IO) so the site-config test can pin every field.
 */
import type { FieldWidgetConfig, PluginDescriptor } from "emdash";
import {
	productDataWidget,
	REPORTS_PAGE,
	SETTINGS_PAGE,
	URUMI_PLUGIN_CAPABILITIES,
	URUMI_PLUGIN_ID,
	URUMI_PLUGIN_VERSION,
} from "@urumi/plugin";

export function urumiPluginDescriptor(serviceUrl: string): PluginDescriptor {
	return {
		id: URUMI_PLUGIN_ID,
		version: URUMI_PLUGIN_VERSION,
		format: "standard",
		entrypoint: "@urumi/plugin/plugin",
		// EXACTLY the manifest's two capabilities — never more (the
		// sandbox-clean contract, pinned by the plugin's own guard test).
		capabilities: [...URUMI_PLUGIN_CAPABILITIES],
		// The egress allowlist: only the commerce service's host.
		allowedHosts: [new URL(serviceUrl).hostname],
		// The Block Kit "Product data" panel on json fields. The plugin's
		// local Block Kit types deliberately MIRROR em-dash's (types.ts:
		// "does not depend on the emdash package at runtime") but are
		// slightly looser on optional element labels, so the nominal cast is
		// needed; the runtime shape is pinned by the plugin's own
		// product-data-widget sandbox test.
		fieldWidgets: [productDataWidget as unknown as FieldWidgetConfig],
		// Phase 7's admin pages — the plugin's exported `admin.pages` entries;
		// without them here neither page appears in the admin nav. Both are
		// rendered by the single `admin` dispatch route (which em-dash resolves
		// by the literal `"admin"` key): Reports on `page:"/reports"`, Settings on
		// `page:"/settings"`. The Settings form's admin token is a masked,
		// write-only secret persisted to ctx.kv (webhook-notifier pattern) — no
		// new capability: account/reports routes are network:request proxies and
		// ctx.kv is always-available.
		adminPages: [REPORTS_PAGE, SETTINGS_PAGE],
	};
}
