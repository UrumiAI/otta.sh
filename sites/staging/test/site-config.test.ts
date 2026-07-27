/**
 * Site-config tests (plan §3.1): the trusted-registration surface of the
 * staging site. The descriptor builder and the emdash options are pure
 * modules precisely so this file can pin them:
 *  - the Urumi plugin descriptor is standard-format, entrypoint
 *    `@urumi/plugin/plugin`, capabilities EXACTLY the manifest's, and its
 *    allowedHosts is exactly the service URL's hostname (the egress gate
 *    that holds even in trusted mode — ADR-0006);
 *  - NO `sandboxed:` / `sandboxRunner:` keys (a LOADER-consuming sandbox
 *    runner is the Workers-Paid cost pivot this deployment avoids);
 *  - database/storage are d1(DB, session OFF — paired with wrangler's
 *    global_fetch_strictly_public flag) / r2(MEDIA);
 *  - Astro `security.checkOrigin` is never disabled BY US — note the emdash
 *    integration force-disables it platform-wide and substitutes a CSRF
 *    layer covering only /_emdash/api/* routes, so the real cart-endpoint
 *    CSRF pin is origin-guard.test.ts (see ADR-0006);
 *  - `vite.ssr.noExternal` contains "@urumi/plugin" UNCONDITIONALLY: if the
 *    plugin is externalized, the `__URUMI_COMMERCE_SERVICE_URL__` define
 *    silently never applies and every ctx.http call fails against
 *    allowedHosts at runtime.
 */
import { readFileSync } from "node:fs";
import {
	COMMERCE_SERVICE_BASE_URL,
	COUPONS_PAGE,
	ORDERS_PAGE,
	productDataWidget,
	PRODUCTS_PAGE,
	REPORTS_PAGE,
	SETTINGS_PAGE,
	SHIPPING_PAGE,
	TAX_PAGE,
	URUMI_PLUGIN_CAPABILITIES,
	URUMI_PLUGIN_ID,
} from "@urumi/plugin";
import { describe, expect, test } from "vitest";
import { buildEmdashOptions, COMMERCE_SERVICE_URL_PLACEHOLDER } from "../src/emdash-options.js";
import { urumiPluginDescriptor } from "../src/urumi-plugin-descriptor.js";

// Pin the env BEFORE astro.config is (dynamically) imported so the config
// module reads a deterministic service URL.
const SERVICE_URL = "https://svc.example.com";
process.env["COMMERCE_SERVICE_URL"] = SERVICE_URL;

describe("service-URL placeholder parity", () => {
	test("the site placeholder equals the plugin manifest's un-defined fallback", () => {
		// In this vitest run no __URUMI_COMMERCE_SERVICE_URL__ define exists,
		// so the plugin constant IS its placeholder — the two literals must
		// never diverge (a build without COMMERCE_SERVICE_URL must produce a
		// consistent allowlist + client base URL).
		expect(COMMERCE_SERVICE_URL_PLACEHOLDER).toBe(COMMERCE_SERVICE_BASE_URL);
	});
});

describe("urumiPluginDescriptor", () => {
	const descriptor = urumiPluginDescriptor(SERVICE_URL);

	test("is a standard-format descriptor for the @urumi/plugin default export", () => {
		expect(descriptor.id).toBe(URUMI_PLUGIN_ID);
		expect(descriptor.format).toBe("standard");
		expect(descriptor.entrypoint).toBe("@urumi/plugin/plugin");
	});

	test("capabilities are EXACTLY the manifest's (content:read, network:request)", () => {
		expect(descriptor.capabilities).toEqual([...URUMI_PLUGIN_CAPABILITIES]);
	});

	test("allowedHosts is exactly the service URL's hostname", () => {
		expect(descriptor.allowedHosts).toEqual(["svc.example.com"]);
	});

	test("registers the Product-data Block Kit field widget", () => {
		expect(descriptor.fieldWidgets).toEqual([productDataWidget]);
	});

	test("declares the plugin's admin pages (Reports + Settings + Orders + Products + Tax + Shipping + Coupons)", () => {
		// The plugin's exported admin.pages entries — the trusted descriptor must
		// carry ALL of them or the page never appears in the admin nav. All render
		// through the single `admin` dispatch route (em-dash resolves admin pages by
		// the literal `"admin"` key and fans out on the interaction's `page`). Tax/
		// Shipping/Coupons (admin-UX Increment 3) landed in prior slices but were
		// missing HERE until the Increment 3 closeout slice (#72/#73 gap-audit
		// finding) added them — each screen worked once opened directly, but was
		// unreachable from the admin nav.
		expect(descriptor.adminPages).toEqual([
			REPORTS_PAGE,
			SETTINGS_PAGE,
			ORDERS_PAGE,
			PRODUCTS_PAGE,
			TAX_PAGE,
			SHIPPING_PAGE,
			COUPONS_PAGE,
		]);
	});

	test("declares no storage collections (ctx.kv is always-available; the plugin declares no storage tables)", () => {
		// Phase 7's settings form uses ctx.kv, which em-dash provides
		// UNGATED (context.ts: "Always available") — no capability, no
		// storage declaration. Capabilities therefore stay exactly the two
		// in the manifest (pinned above).
		expect(descriptor.storage).toBeUndefined();
	});
});

describe("buildEmdashOptions", () => {
	const options = buildEmdashOptions(SERVICE_URL);

	test("has NO sandboxed / sandboxRunner / marketplace keys (Workers-Paid trap)", () => {
		expect(options).not.toHaveProperty("sandboxed");
		expect(options).not.toHaveProperty("sandboxRunner");
		expect(options).not.toHaveProperty("marketplace");
	});

	test("database is D1 binding DB with session OFF (required by global_fetch_strictly_public)", () => {
		expect(options.database).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/db/d1",
			config: { binding: "DB" },
		});
		// NOT session:"auto": read-replica sessions are incompatible with the
		// wrangler.jsonc `global_fetch_strictly_public` flag (every SSR
		// request hangs, silently — em-dash cloudflare.mdx:121-130, #1273).
		const d1Config = (options.database as { config?: { session?: unknown } }).config;
		expect(d1Config?.session).toBeUndefined();
	});

	test("PAIRING INVARIANT: global_fetch_strictly_public (wrangler) ⇒ D1 session OFF", () => {
		// The flag is required (Worker→*.workers.dev subrequests are stubbed
		// 404 without it) and deadlocks D1 sessions when combined — the two
		// halves must only ever change TOGETHER.
		const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		const flagPresent = wrangler.includes('"global_fetch_strictly_public"');
		expect(flagPresent).toBe(true);
		const d1Config = (options.database as { config?: { session?: unknown } }).config;
		if (flagPresent) {
			expect(d1Config?.session).toBeUndefined();
		}
	});

	test("storage is R2 binding MEDIA", () => {
		expect(options.storage).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/storage/r2",
			config: { binding: "MEDIA" },
		});
	});

	test("registers exactly the Urumi plugin, trusted", () => {
		expect(options.plugins).toHaveLength(1);
		expect(options.plugins?.[0]).toEqual(urumiPluginDescriptor(SERVICE_URL));
	});
});

describe("astro.config", () => {
	test("output:'server', checkOrigin not disabled, plugin never externalized, define applied", async () => {
		const config = (await import("../astro.config.js")).default;

		expect(config.output).toBe("server");

		// Our config must never explicitly disable checkOrigin. (The emdash
		// integration disables it anyway and substitutes its own /_emdash-only
		// CSRF layer — which is exactly why the /cart/* endpoints carry their
		// own origin guard, pinned by origin-guard.test.ts.)
		expect(config.security?.checkOrigin).not.toBe(false);

		const noExternal = config.vite?.ssr?.noExternal;
		expect(Array.isArray(noExternal) ? noExternal : [noExternal]).toContain("@urumi/plugin");

		const define = config.vite?.define as Record<string, string>;
		expect(JSON.parse(define["__URUMI_COMMERCE_SERVICE_URL__"] ?? "null")).toBe(SERVICE_URL);
	});

	test("the Stripe publishable key rides a SECOND build-time define (ADR-0012 decision 4)", async () => {
		// Baked, not read from wrangler `vars` at runtime: wrangler-config.test.ts
		// forbids any vars key matching /SECRET|KEY|TOKEN|PASSWORD/i, and
		// STRIPE_PUBLIC_KEY matches on KEY. Keep the guard; bake the key.
		const config = (await import("../astro.config.js")).default;
		const define = config.vite?.define as Record<string, string>;
		expect(Object.keys(define)).toContain("__URUMI_STRIPE_PUBLIC_KEY__");
		// Whatever this machine's env holds, the baked value is a STRING (an
		// absent key bakes "", which the config module treats as unconfigured) —
		// never `undefined`, which would leave the identifier undeclared.
		expect(typeof JSON.parse(define["__URUMI_STRIPE_PUBLIC_KEY__"] ?? "null")).toBe("string");
	});
});
