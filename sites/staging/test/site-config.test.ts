/**
 * Site-config tests (plan §3.1): the trusted-registration surface of the
 * staging site. The descriptor builder and the emdash options are pure
 * modules precisely so this file can pin them:
 *  - the Otta plugin descriptor is standard-format, entrypoint
 *    `@otta-sh/plugin/plugin`, capabilities EXACTLY the manifest's, and its
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
 *  - `vite.ssr.noExternal` contains "@otta-sh/plugin" UNCONDITIONALLY: if the
 *    plugin is externalized, the `__OTTA_COMMERCE_SERVICE_URL__` define
 *    silently never applies and every ctx.http call fails against
 *    allowedHosts at runtime. It also contains "@otta-sh/admin-react", whose
 *    workspace exports are TS/TSX source;
 *  - and, since INC-19, ADR-0014's SECOND descriptor `otta-console` — its own
 *    block below.
 */
import { readFileSync } from "node:fs";
import {
	COMMERCE_SERVICE_BASE_URL,
	COUPONS_PAGE,
	ORDERS_PAGE,
	PRODUCTS_PAGE,
	REPORTS_PAGE,
	SETTINGS_PAGE,
	SHIPPING_PAGE,
	TAX_PAGE,
	OTTA_PLUGIN_CAPABILITIES,
	OTTA_PLUGIN_ID,
} from "@otta-sh/plugin";
import {
	createPlugin as createConsolePlugin,
	OTTA_CONSOLE_ADMIN_PAGES,
} from "@otta-sh/admin-react";
import { describe, expect, test } from "vitest";
// `../e2e/registry.js`, NEVER `../e2e/harness.js`. The harness resolves and
// loopback-guards COMMERCE_SERVICE_URL / PG_CONNECTION_STRING at MODULE LOAD
// and imports `@playwright/test`. Importing it from here meant a set
// COMMERCE_SERVICE_URL — the site's ordinary BUILD-time variable, per
// sites/staging/README.md — threw before a single assertion and redded the
// whole unit suite. The registry is plain data with no imports at all.
import { MIGRATED_SCREENS } from "../e2e/registry.js";
import { buildEmdashOptions, COMMERCE_SERVICE_URL_PLACEHOLDER } from "../src/emdash-options.js";
import { ottaConsoleDescriptor } from "../src/otta-console-descriptor.js";
import { ottaPluginDescriptor } from "../src/otta-plugin-descriptor.js";

// Pin the env BEFORE astro.config is (dynamically) imported so the config
// module reads a deterministic service URL.
const SERVICE_URL = "https://svc.example.com";
process.env["COMMERCE_SERVICE_URL"] = SERVICE_URL;

describe("service-URL placeholder parity", () => {
	test("the site placeholder equals the plugin manifest's un-defined fallback", () => {
		// In this vitest run no __OTTA_COMMERCE_SERVICE_URL__ define exists,
		// so the plugin constant IS its placeholder — the two literals must
		// never diverge (a build without COMMERCE_SERVICE_URL must produce a
		// consistent allowlist + client base URL).
		expect(COMMERCE_SERVICE_URL_PLACEHOLDER).toBe(COMMERCE_SERVICE_BASE_URL);
	});
});

describe("ottaPluginDescriptor", () => {
	const descriptor = ottaPluginDescriptor(SERVICE_URL);

	test("is a standard-format descriptor for the @otta-sh/plugin default export", () => {
		expect(descriptor.id).toBe(OTTA_PLUGIN_ID);
		expect(descriptor.format).toBe("standard");
		expect(descriptor.entrypoint).toBe("@otta-sh/plugin/plugin");
	});

	test("capabilities are EXACTLY the manifest's (content:read, network:request)", () => {
		expect(descriptor.capabilities).toEqual([...OTTA_PLUGIN_CAPABILITIES]);
	});

	test("allowedHosts is exactly the service URL's hostname", () => {
		expect(descriptor.allowedHosts).toEqual(["svc.example.com"]);
	});

	test("registers NO field widget — the CMS is not a commerce editor (PR 1b)", () => {
		// The inverse of the assertion this replaced. The descriptor used to
		// register a "Product data" Block Kit widget bound to the products
		// collection's `commerce` json field, which made the content document a
		// second writer of `product_commerce`'s columns; every publish reverted
		// the admin console's edits. Commercial fields now have one home. A
		// re-added widget fails here, and the seed's own guard
		// (`seed.test.ts`) fails on the binding side.
		expect(descriptor.fieldWidgets).toBeUndefined();
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

	test("declares NO adminEntry and NO componentsEntry, and stays standard format (ADR-0014)", () => {
		// ADR-0014 widens ADR-0006 Decision 2 by exactly one thing — React admin
		// pages, on a SECOND descriptor, in a SEPARATE package. This descriptor
		// is not it, and `format: "standard"` is what keeps EmDash's build-time
		// throw aimed at it: a standard-format descriptor declaring `adminEntry`
		// fails `astro build` outright ("Standard plugins use Block Kit for admin
		// UI, not React components"). That throw is evaluated PER DESCRIPTOR, so
		// the moment `otta-console` exists it says nothing whatever about `otta`
		// — which is why these three facts are asserted here instead of being
		// left to the build to notice.
		expect(descriptor.format).toBe("standard");
		expect(descriptor).not.toHaveProperty("adminEntry");
		expect(descriptor).not.toHaveProperty("componentsEntry");
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

	test("registers the Otta plugin FIRST, trusted, unchanged", () => {
		// The `toHaveLength(1)` that used to live here moved into the
		// otta-console block below, where the whole registered SET is pinned.
		// It moved rather than being deleted: the 2026-07-31 spike registered a
		// second descriptor and this was the one and only existing assertion
		// that broke — the test doing its job. Length now has a home that says
		// which second entry is allowed, instead of forbidding all of them.
		expect(options.plugins?.[0]).toEqual(ottaPluginDescriptor(SERVICE_URL));
	});
});

/**
 * ADR-0014's second descriptor, pinned BEFORE any React ships.
 *
 * The ADR is explicit that prose enforced nothing here: `plugin-is-sandbox-
 * clean` forbids DB/Node/HTTP-client imports but not `react`, and this file
 * pinned `format` and `fieldWidgets` while asserting nothing about
 * `adminEntry`. The real gates were EmDash's build-time throw and the 18
 * sandbox suites, and neither covers a native descriptor. So the boundary is
 * mechanised here first, and INC-19 lands a descriptor that has to satisfy it.
 */
const OTTA_CONSOLE_PLUGIN_ID = "otta-console";

/** The package ADR-0014 Decision 2 confines the React code to. BOTH of the
 *  descriptor's module specifiers have to resolve into it — see below. */
const OTTA_CONSOLE_PACKAGE = "@otta-sh/admin-react";

/**
 * ADR-0014's hard pins on `otta-console`, as a function — so the gate itself is
 * testable, and so INC-19 cannot "satisfy" it by importing whatever the
 * implementation happens to export.
 *
 * `format` is asserted as a DECLARED OWN KEY, not merely as a value. EmDash
 * defaults `format` to `"native"` when unset (`PluginDescriptor.format`,
 * emdash 0.31.1), and the 2026-07-31 spike leaned on exactly that: its
 * descriptor carried no `format` key and a comment reading "native is the
 * default". That shape is indistinguishable from a descriptor that lost its
 * format in a refactor, and it leaves the single most consequential property of
 * the whole arrangement implicit — `native` is what lifts the `adminEntry`
 * throw and what makes full runtime access the declared contract. It fails this
 * gate. Same reasoning for `capabilities` and `allowedHosts`: `undefined` is
 * not `[]`, and "we asked for nothing" has to be written down.
 *
 * `entrypoint` and `adminEntry` are pinned to the console PACKAGE because the
 * empty capability set is not, on its own, the boundary ADR-0014 describes.
 * Decision 2 puts the React code in a separate package; a descriptor declaring
 * `adminEntry: "@otta-sh/plugin/admin"` satisfies every other pin here while
 * making `@otta-sh/plugin` the thing EmDash statically imports React from —
 * the exact inversion Decision 1 refuses, arriving through the site config
 * rather than through an import depcruise can see. Both ends are closed: this
 * pin, and `plugin-is-sandbox-clean` now forbidding `@otta-sh/admin-react`.
 */
function assertOttaConsoleContract(descriptor: unknown): void {
	expect(descriptor).toBeTypeOf("object");
	expect(descriptor).not.toBeNull();
	const d = descriptor as Record<string, unknown>;

	expect(d["id"]).toBe(OTTA_CONSOLE_PLUGIN_ID);

	expect(Object.hasOwn(d, "format"), "`format` must be declared literally").toBe(true);
	expect(d["format"]).toBe("native");

	expect(Object.hasOwn(d, "capabilities"), "`capabilities: []` must be declared").toBe(true);
	expect(d["capabilities"]).toEqual([]);

	expect(Object.hasOwn(d, "allowedHosts"), "`allowedHosts: []` must be declared").toBe(true);
	expect(d["allowedHosts"]).toEqual([]);

	// Both module specifiers must name the console package — exactly, or as a
	// subpath export of it. `startsWith` alone would admit a lookalike package
	// (`@otta-sh/admin-react-shim`), hence the boundary character.
	for (const key of ["entrypoint", "adminEntry"] as const) {
		expect(Object.hasOwn(d, key), `\`${key}\` must be declared`).toBe(true);
		const specifier = d[key];
		expect(specifier, `\`${key}\` must be a module specifier`).toBeTypeOf("string");
		expect(
			specifier === OTTA_CONSOLE_PACKAGE ||
				String(specifier).startsWith(`${OTTA_CONSOLE_PACKAGE}/`),
			`\`${key}\` must resolve into ${OTTA_CONSOLE_PACKAGE}, got ${String(specifier)}`,
		).toBe(true);
	}
}

describe("ottaConsoleDescriptor (ADR-0014's second descriptor)", () => {
	const options = buildEmdashOptions(SERVICE_URL);
	const consoleEntries = options.plugins.filter((p) => p.id === OTTA_CONSOLE_PLUGIN_ID);

	test("plugins[] is EXACTLY [otta, otta-console] — never a third id", () => {
		// INC-18 wrote this as "either [otta] OR [otta, otta-console]" so the
		// gate could land before the descriptor did. INC-19 landed the
		// descriptor, so the one-entry arm is retired: a `plugins: []` that has
		// lost the console is now a failure, not a legal earlier state. The
		// third-id half is ADR-0014's own reopening clause — "Any third-party
		// plugin entering plugins[] — ADR-0006's original consequence stands
		// unchanged: a multi-tenant or marketplace deployment must not inherit
		// any of this."
		expect(options.plugins.map((p) => p.id)).toEqual([OTTA_PLUGIN_ID, OTTA_CONSOLE_PLUGIN_ID]);
	});

	test("the console is registered exactly once and satisfies the contract", () => {
		// The length tie is the vacuity guard, and it still is one: it cannot be
		// satisfied by registering a second descriptor under some other id, or by
		// an id typo silently emptying the filter.
		expect(consoleEntries).toHaveLength(options.plugins.length - 1);
		expect(consoleEntries).toHaveLength(1);
		for (const entry of consoleEntries) assertOttaConsoleContract(entry);
	});

	test("the registered entry is the descriptor builder's output, unmodified", () => {
		// So the pins below (which read `ottaConsoleDescriptor()` directly) are
		// pins on what is actually registered, not on a builder the site config
		// stopped calling.
		expect(consoleEntries[0]).toEqual(ottaConsoleDescriptor());
	});

	test("declares no hooks, no routes, no storage and no settings surface", () => {
		// ADR-0014, "what would reopen this decision": "otta-console acquiring a
		// capability, an allowedHost, a route, or a hook." The empty
		// capabilities/allowedHosts arrays are pinned in the contract above; the
		// remaining server-side surfaces are pinned here, on the descriptor,
		// where adding one would be a one-line change.
		const descriptor = ottaConsoleDescriptor();
		expect(descriptor.storage).toBeUndefined();
		expect(descriptor.settingsSchema).toBeUndefined();
		expect(descriptor.fieldWidgets).toBeUndefined();
		expect(descriptor.componentsEntry).toBeUndefined();
		expect(descriptor.options).toBeUndefined();
	});

	test("the descriptor's adminPages cannot drift from what createPlugin() reports", () => {
		// `descriptor.adminPages` is INERT for a native descriptor — the runtime
		// manifest reads `plugin.admin.pages` off the ResolvedPlugin that
		// `createPlugin()` returns, and only the standard-format branch of
		// EmDash's virtual-module generator forwards the descriptor's copy. It is
		// declared anyway (both descriptors describe their nav in the same
		// place), so it needs this pin: a redundancy that can disagree with the
		// thing that actually renders is worse than no redundancy at all.
		expect(ottaConsoleDescriptor().adminPages).toEqual(createConsolePlugin().admin?.pages);
	});

	test("the console never claims a screen ADR-0014 keeps on Block Kit permanently", () => {
		// Decision 6: Tax, Shipping and Settings never migrate. The Block Kit
		// descriptor keeps all seven of its pages either way (pinned above), so
		// the failure this catches is a console page shadowing one of them in the
		// nav rather than replacing it.
		const consolePaths = (ottaConsoleDescriptor().adminPages ?? []).map((page) => page.path);
		expect(consolePaths).not.toContain(TAX_PAGE.path);
		expect(consolePaths).not.toContain(SHIPPING_PAGE.path);
		expect(consolePaths).not.toContain(SETTINGS_PAGE.path);
	});

	test("still declares no sandboxed / sandboxRunner keys with the console registered", () => {
		// ADR-0014 Decision 4: registration is unchanged IN KIND. Both
		// descriptors go in `plugins: []`; the Worker-Loader / Workers-Paid cost
		// pivot ADR-0006 exists to avoid stays avoided.
		expect(options).not.toHaveProperty("sandboxed");
		expect(options).not.toHaveProperty("sandboxRunner");
	});
});

/**
 * THE COVERAGE LINK — the console's page list and its Playwright gate, tied
 * together mechanically.
 *
 * Without this, the console's two halves are only related by intent. The console
 * declares its pages in `@otta-sh/admin-react`; the Playwright coverage gate
 * reads `MIGRATED_SCREENS` in `sites/staging/e2e/`. Nothing made adding to the
 * first require adding to the second, so INC-20 could ship an Orders page,
 * generate NO smoke spec for it, and see every gate go green — the precise
 * failure `console-screens.spec.ts` was written to make impossible, arriving
 * through the one door it does not watch.
 *
 * THE ESCAPE HATCH IS GONE, and that is a tightening. The gated set used to be
 * `MIGRATED_SCREENS` PLUS the console shell, because the shell was a React page
 * that replaced no Block Kit screen and so did not belong in a registry counting
 * migrations. ADR-0015 removed that page, and with it the only page this check
 * had to admit by name. Every page the console serves is now a migrated screen,
 * so the registry alone is the gate and a new console page has exactly one way
 * to pass: be registered, and therefore get a generated smoke spec.
 *
 * It lives here rather than in the e2e surface because this file already
 * imports both sides, and because `pnpm test` is the gate hardest to skip.
 */
function assertEveryConsolePageIsGated(pages: readonly { path: string }[]): void {
	const gated = MIGRATED_SCREENS.map((screen) => screen.path);
	for (const page of pages) {
		expect(
			gated,
			`console page ${page.path} has NO Playwright gate — add it to MIGRATED_SCREENS in ` +
				`sites/staging/e2e/registry.ts, which is what generates its smoke spec`,
		).toContain(page.path);
	}
}

describe("every page the console serves has a Playwright gate", () => {
	test("the RUNTIME page list is fully gated", () => {
		// `createPlugin().admin.pages` rather than the exported constant: that is
		// the list the admin manifest reads and the sidebar renders from, so it is
		// the list that can strand a real page.
		assertEveryConsolePageIsGated(createConsolePlugin().admin?.pages ?? []);
	});

	test("the declared page list is fully gated too", () => {
		assertEveryConsolePageIsGated(OTTA_CONSOLE_ADMIN_PAGES);
	});

	test("NEGATIVE CONTROL: an ungated page fails, and says which", () => {
		// A SENTINEL path, not `/orders`. `/orders` is the real-world case — it is
		// INC-20's target and the exact mistake this guard exists to catch — but
		// using it as the fixture would mean that the moment INC-20 legitimately
		// gates `/orders`, this control stops throwing and quietly passes for the
		// wrong reason. Verified: with `/orders` planted in the page list AND in
		// MIGRATED_SCREENS, the `/orders` version of this test failed. A control
		// that the change it guards can defuse is not a control.
		//
		// And the sentinel goes in ALONE, not spread onto the real page list. If
		// the shipped list itself contains something ungated, a spread makes this
		// control throw on THAT page instead — still red, but pointing at the
		// wrong thing and asserting nothing about the sentinel. The control has
		// to be independent of whatever the console currently ships; the
		// tests above are what cover the real list.
		const ungated = { path: "/__never_a_real_screen__" };
		expect(() => assertEveryConsolePageIsGated([ungated])).toThrow(/__never_a_real_screen__/);
	});

	test("NEGATIVE CONTROL: the guard is not vacuous", () => {
		// If the shipped page list were empty, every assertion above would pass
		// over nothing and report green forever.
		expect(OTTA_CONSOLE_ADMIN_PAGES.length).toBeGreaterThan(0);
		expect(createConsolePlugin().admin?.pages ?? []).not.toHaveLength(0);
	});
});

describe("the otta-console gate rejects the near-miss shapes", () => {
	// Negative controls. Without these the pins above are unverified until
	// INC-19, which is precisely when a too-loose pin would be discovered too
	// late to matter.

	/** What INC-19 has to produce. */
	const compliant = {
		id: "otta-console",
		version: "0.0.1",
		entrypoint: "@otta-sh/admin-react",
		format: "native",
		adminEntry: "@otta-sh/admin-react/admin",
		capabilities: [],
		allowedHosts: [],
	};

	/**
	 * The 2026-07-31 spike's descriptor, transcribed from
	 * `packages/console-react/src/index.ts` in the spike worktree. Kept as a
	 * fixture rather than paraphrased: it is verified-working code and therefore
	 * the shape most likely to be copied wholesale into INC-19 — and it must not
	 * pass, because it never declares `format`.
	 */
	const spikeShape = {
		id: "otta-console",
		version: "0.0.1",
		entrypoint: "@otta-sh/console-react",
		adminEntry: "@otta-sh/console-react/admin",
		adminPages: [{ path: "/orders", label: "Orders (React)", icon: "list" }],
		capabilities: [],
		allowedHosts: [],
		// NOTE: no `format` key — the spike's comment reads "native is the
		// default". True, and not good enough.
	};

	const withoutKey = (key: string): Record<string, unknown> => {
		const copy: Record<string, unknown> = { ...compliant };
		delete copy[key];
		return copy;
	};

	test("accepts the compliant shape (positive control)", () => {
		expect(() => assertOttaConsoleContract(compliant)).not.toThrow();
	});

	test("REJECTS the spike's shape: `format` omitted, native inherited from the default", () => {
		expect(() => assertOttaConsoleContract(spikeShape)).toThrow();
	});

	test.each([
		["format is standard", { ...compliant, format: "standard" }],
		["format is omitted", withoutKey("format")],
		["capabilities are non-empty", { ...compliant, capabilities: ["network:request"] }],
		["capabilities are omitted", withoutKey("capabilities")],
		["allowedHosts are non-empty", { ...compliant, allowedHosts: ["svc.example.com"] }],
		["allowedHosts are omitted", withoutKey("allowedHosts")],
		["the id is the Block Kit plugin's", { ...compliant, id: OTTA_PLUGIN_ID }],
		// Reviewer A's mutation, pinned. Everything else about this descriptor is
		// impeccable — native, zero capabilities, zero allowedHosts — and it still
		// makes @otta-sh/plugin the module EmDash statically imports React from,
		// which is ADR-0014 Decision 1 inverted via the site config.
		[
			"adminEntry points into @otta-sh/plugin",
			{ ...compliant, adminEntry: "@otta-sh/plugin/admin" },
		],
		["entrypoint points into @otta-sh/plugin", { ...compliant, entrypoint: "@otta-sh/plugin" }],
		["adminEntry is omitted", withoutKey("adminEntry")],
		["entrypoint is omitted", withoutKey("entrypoint")],
		// A lookalike package name must not slip past a prefix check.
		[
			"entrypoint names a lookalike package",
			{ ...compliant, entrypoint: "@otta-sh/admin-react-shim" },
		],
	])("rejects a descriptor where %s", (_why, shape) => {
		expect(() => assertOttaConsoleContract(shape)).toThrow();
	});
});

describe("astro.config", () => {
	// Both tests here dynamically import astro.config.js, which pulls in the
	// Cloudflare adapter and the EmDash integration: measured at 2-6.6s on a
	// loaded machine, against vitest's 5000ms default. The generous timeout is
	// for that import cost, not for anything the assertions do.
	const CONFIG_IMPORT_TIMEOUT_MS = 30_000;

	test(
		"output:'server', checkOrigin not disabled, plugin never externalized, define applied",
		async () => {
			const config = (await import("../astro.config.js")).default;

			expect(config.output).toBe("server");

			// Our config must never explicitly disable checkOrigin. (The emdash
			// integration disables it anyway and substitutes its own /_emdash-only
			// CSRF layer — which is exactly why the /cart/* endpoints carry their
			// own origin guard, pinned by origin-guard.test.ts.)
			expect(config.security?.checkOrigin).not.toBe(false);

			const noExternal = config.vite?.ssr?.noExternal;
			const noExternalList = Array.isArray(noExternal) ? noExternal : [noExternal];
			expect(noExternalList).toContain("@otta-sh/plugin");
			// @otta-sh/admin-react for a different reason: its workspace exports
			// point at TS/TSX source, so externalizing it hands raw TSX to the
			// runtime. No define rides on it.
			expect(noExternalList).toContain("@otta-sh/admin-react");

			const define = config.vite?.define as Record<string, string>;
			expect(JSON.parse(define["__OTTA_COMMERCE_SERVICE_URL__"] ?? "null")).toBe(SERVICE_URL);
		},
		CONFIG_IMPORT_TIMEOUT_MS,
	);

	test(
		"the Stripe publishable key rides a SECOND build-time define (ADR-0012 decision 4)",
		async () => {
			// Baked, not read from wrangler `vars` at runtime: wrangler-config.test.ts
			// forbids any vars key matching /SECRET|KEY|TOKEN|PASSWORD/i, and
			// STRIPE_PUBLIC_KEY matches on KEY. Keep the guard; bake the key.
			const config = (await import("../astro.config.js")).default;
			const define = config.vite?.define as Record<string, string>;
			expect(Object.keys(define)).toContain("__OTTA_STRIPE_PUBLIC_KEY__");
			// Whatever this machine's env holds, the baked value is a STRING (an
			// absent key bakes "", which the config module treats as unconfigured) —
			// never `undefined`, which would leave the identifier undeclared.
			expect(typeof JSON.parse(define["__OTTA_STRIPE_PUBLIC_KEY__"] ?? "null")).toBe("string");
		},
		CONFIG_IMPORT_TIMEOUT_MS,
	);
});
