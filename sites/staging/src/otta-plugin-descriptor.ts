/**
 * The Otta plugin's TRUSTED (in-process) registration descriptor —
 * ADR-0006. A hand-written standard-format `PluginDescriptor`: em-dash's
 * integration generates `import def from "@otta-sh/plugin/plugin";
 * adaptSandboxEntry(def, {...this descriptor})` at build time, so the
 * plugin's `{hooks, routes}` default export runs in the host worker — but
 * `capabilities` and `allowedHosts` are STILL enforced by the
 * PluginContextFactory (`createHttpAccess` gates every `ctx.http.fetch` by
 * hostname), which is what keeps DEVELOPMENT.md §5's "only via ctx.http +
 * allowedHosts" true in trusted mode.
 *
 * Pure module (no IO) so the site-config test can pin every field.
 */
import type { PluginDescriptor } from "emdash";
import {
	COUPONS_PAGE,
	REPORTS_PAGE,
	SETTINGS_PAGE,
	SHIPPING_PAGE,
	TAX_PAGE,
	OTTA_PLUGIN_CAPABILITIES,
	OTTA_PLUGIN_ID,
	OTTA_PLUGIN_VERSION,
} from "@otta-sh/plugin";

export function ottaPluginDescriptor(serviceUrl: string): PluginDescriptor {
	return {
		id: OTTA_PLUGIN_ID,
		version: OTTA_PLUGIN_VERSION,
		format: "standard",
		entrypoint: "@otta-sh/plugin/plugin",
		// EXACTLY the manifest's two capabilities — never more (the
		// sandbox-clean contract, pinned by the plugin's own guard test).
		capabilities: [...OTTA_PLUGIN_CAPABILITIES],
		// The egress allowlist: only the commerce service's host.
		allowedHosts: [new URL(serviceUrl).hostname],
		// NO `fieldWidgets` — deliberate, and pinned by site-config.test.ts.
		// Commercial fields have exactly one home, `product_commerce`, edited
		// only from the admin's Pricing & inventory page ("one home per field",
		// PR 1b). The old "Product data" Block Kit widget wrote the same columns
		// into the CMS content document, making the content the second writer,
		// and every publish reverted the console's edits. Re-declaring a field
		// widget here would recreate that.
		// Phase 7's admin pages — the plugin's exported `admin.pages` entries;
		// without them here neither page appears in the admin nav. All are
		// rendered by the single `admin` dispatch route (which em-dash resolves
		// by the literal `"admin"` key): Reports on `page:"/reports"`, Settings on
		// `page:"/settings"`, and (admin-UX Increment 3) Tax on
		// `page:"/tax"`, Shipping on `page:"/shipping"`, Coupons on
		// `page:"/coupons"` — landed in prior slices but never added HERE (the
		// #72/#73 gap-audit finding this Increment 3 closeout slice fixes: the
		// three screens existed and worked, but were unreachable from the admin
		// nav because this descriptor never listed them).
		//
		// NEITHER ORDERS NOR PRICING & INVENTORY IS HERE ANY MORE (INC-R2/INC-R3,
		// ADR-0015). Both Block Kit screens were retired once the React console's
		// write path moved off them; `/orders` and `/products` are served by the
		// `otta-console` descriptor alone. The Settings form's
		// admin token is a masked, write-only secret persisted to ctx.kv
		// (webhook-notifier pattern) — no new capability: account/reports/
		// products/tax/shipping/coupons routes are network:request proxies and
		// ctx.kv is always-available.
		adminPages: [REPORTS_PAGE, SETTINGS_PAGE, TAX_PAGE, SHIPPING_PAGE, COUPONS_PAGE],
	};
}
