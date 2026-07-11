/**
 * Site-config tests (plan §3.1): the trusted-registration surface of the
 * staging site. The descriptor builder and the emdash options are pure
 * modules precisely so this file can pin them:
 *  - the Urumi plugin descriptor is standard-format, entrypoint
 *    `@urumi/plugin/plugin`, capabilities EXACTLY the manifest's, and its
 *    allowedHosts is exactly the service URL's hostname (the egress gate
 *    that holds even in trusted mode — ADR-0004);
 *  - NO `sandboxed:` / `sandboxRunner:` keys (a LOADER-consuming sandbox
 *    runner is the Workers-Paid cost pivot this deployment avoids);
 *  - database/storage are d1(DB, session:"auto") / r2(MEDIA);
 *  - Astro `security.checkOrigin` is never disabled BY US — note the emdash
 *    integration force-disables it platform-wide and substitutes a CSRF
 *    layer covering only /_emdash/api/* routes, so the real cart-endpoint
 *    CSRF pin is origin-guard.test.ts (see ADR-0004);
 *  - `vite.ssr.noExternal` contains "@urumi/plugin" UNCONDITIONALLY: if the
 *    plugin is externalized, the `__URUMI_COMMERCE_SERVICE_URL__` define
 *    silently never applies and every ctx.http call fails against
 *    allowedHosts at runtime.
 */
import {
	COMMERCE_SERVICE_BASE_URL,
	productDataWidget,
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

	test("declares no storage collections (the plugin holds no state)", () => {
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

	test("database is D1 binding DB with session:'auto' (read replicas)", () => {
		expect(options.database).toMatchObject({
			entrypoint: "@emdash-cms/cloudflare/db/d1",
			config: { binding: "DB", session: "auto" },
		});
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
});
