/**
 * Site-config tests (plan §3.1): the trusted-registration surface of the
 * staging site. The descriptor builder and the emdash options are pure
 * modules precisely so this file can pin them:
 *  - the Otta plugin descriptor is standard-format, entrypoint
 *    `@otta-sh/plugin/plugin`, capabilities EXACTLY the manifest's, and its
 *    allowedHosts is exactly the in-process egress list — Stripe's API host
 *    plus whichever of the email/facilitator hosts the deployment supplied
 *    (the egress gate that holds even in trusted mode — ADR-0006);
 *  - NO `sandboxed:` / `sandboxRunner:` keys (a LOADER-consuming sandbox
 *    runner is the Workers-Paid cost pivot this deployment avoids);
 *  - database/storage are d1(DB, session OFF — paired with wrangler's
 *    global_fetch_strictly_public flag) / r2(MEDIA);
 *  - Astro `security.checkOrigin` is never disabled BY US — note the emdash
 *    integration force-disables it platform-wide and substitutes a CSRF
 *    layer covering only /_emdash/api/* routes, so the real cart-endpoint
 *    CSRF pin is origin-guard.test.ts (see ADR-0006);
 *  - `vite.ssr.noExternal` contains "@otta-sh/plugin" UNCONDITIONALLY: if the
 *    plugin is externalized the `__OTTA_EMAIL_API_URL__` /
 *    `__OTTA_X402_FACILITATOR_URL__` defines silently never apply and every
 *    ctx.http call fails against allowedHosts at runtime. It also contains
 *    "@otta-sh/admin-react", whose workspace exports are TS/TSX source;
 *  - and, since INC-19, ADR-0014's SECOND descriptor `otta-console` — its own
 *    block below.
 */
import { readFileSync } from "node:fs";
import {
	COMMERCE_STORAGE_COLLECTIONS,
	COMMERCE_STORAGE_COLLECTION_NAMES,
	PAYMENT_SECRET_KEYS,
	STRIPE_API_HOST,
	COUPONS_PAGE,
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
// `../e2e/registry.js`, NEVER `../e2e/harness.js`. The harness loopback-guards
// its addresses at MODULE LOAD and imports `@playwright/test`, which threw
// before a single assertion and redded the whole unit suite. The registry is
// plain data with no imports at all.
import { MIGRATED_SCREENS } from "../e2e/registry.js";
import { buildEmdashOptions } from "../src/emdash-options.js";
import { ottaConsoleDescriptor } from "../src/otta-console-descriptor.js";
import { ottaPluginDescriptor } from "../src/otta-plugin-descriptor.js";
import { readFile } from "node:fs/promises";

describe("ottaPluginDescriptor", () => {
	const descriptor = ottaPluginDescriptor();

	test("is a standard-format descriptor for the @otta-sh/plugin default export", () => {
		expect(descriptor.id).toBe(OTTA_PLUGIN_ID);
		expect(descriptor.format).toBe("standard");
		expect(descriptor.entrypoint).toBe("@otta-sh/plugin/plugin");
	});

	test("capabilities are EXACTLY the manifest's (content:read, network:request)", () => {
		expect(descriptor.capabilities).toEqual([...OTTA_PLUGIN_CAPABILITIES]);
	});

	test("allowedHosts is exactly the in-process egress list (Stripe alone, unconfigured)", () => {
		// INC-D3a: there is no commerce service and no service host. With no
		// email/facilitator URL supplied the list is the Stripe API host alone —
		// see the exact-set block below for the configured cases.
		expect(descriptor.allowedHosts).toEqual([STRIPE_API_HOST]);
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

	test("declares the plugin's admin pages (Reports + Settings + Tax + Shipping + Coupons)", () => {
		// The plugin's exported admin.pages entries — the trusted descriptor must
		// carry ALL of them or the page never appears in the admin nav. All render
		// through the single `admin` dispatch route (em-dash resolves admin pages by
		// the literal `"admin"` key and fans out on the interaction's `page`). Tax/
		// Shipping/Coupons (admin-UX Increment 3) landed in prior slices but were
		// missing HERE until the Increment 3 closeout slice (#72/#73 gap-audit
		// finding) added them — each screen worked once opened directly, but was
		// unreachable from the admin nav.
		//
		// ORDERS AND PRICING & INVENTORY ARE BOTH ABSENT (INC-R2/INC-R3,
		// ADR-0015): each Block Kit screen was retired once the React console's
		// write path moved off it, taking the list from seven entries to FIVE.
		// `/orders` and `/products` are now served only by the `otta-console`
		// descriptor.
		expect(descriptor.adminPages).toEqual([
			REPORTS_PAGE,
			SETTINGS_PAGE,
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

	test("declares the commerce storage layout — the plugin holds commerce truth", () => {
		// INC-D3a: there is one shape, unconditionally. Commerce truth lives on
		// `ctx.storage`, and `ctx.storage` hands a plugin only the collections its
		// DESCRIPTOR declared — so this key is never absent. The exact layout is
		// pinned in the block below.
		expect(descriptor.storage).toEqual(COMMERCE_STORAGE_COLLECTIONS);
	});
});

/**
 * INC-D1 — the descriptor's `storage` declaration, EXACTLY.
 *
 * This is the half of the fold-in the allowlist block below cannot see. Commerce
 * truth lives on `ctx.storage`, and `ctx.storage` hands a plugin ONLY the
 * collections its DESCRIPTOR declared — `collectionOf` throws "storage collection
 * '<name>' is not declared" for anything else. So the descriptor is not
 * documentation here; it is the schema.
 *
 * AND THE INDEX LISTS ARE PART OF IT. A declared index is a READ CONTRACT: the
 * host validates every `where`/`orderBy` field against this declaration and
 * REFUSES an undeclared one at runtime (`storage-query.ts`: "Add '<field>' to
 * storage.<collection>.indexes"). A descriptor that named all 36 collections but
 * dropped one index would not be slower — `orders` would stop being listable by
 * state, and it would fail in production, not in the build. That is why every
 * assertion below compares the WHOLE map or the WHOLE index list, never a subset.
 *
 * NOTHING HERE IS TRANSCRIBED. The expected value is `COMMERCE_STORAGE_COLLECTIONS`
 * itself — the union `@otta-sh/plugin` assembles from the twelve per-adapter
 * declarations — rather than a hand-copied snapshot that would rot.
 *
 * AND BE HONEST ABOUT WHAT THAT COSTS (review round 3, B4). `commerceStorage()`
 * returns that import BY REFERENCE, so every `toEqual` below is comparing an
 * object with itself and CANNOT detect the adapters and the descriptor drifting
 * apart — no assertion phrased this way ever could, because there is only one
 * value. What these cases are is a REGRESSION GUARD in one direction: the day
 * someone replaces the spread with a literal list, or drops a collection on the
 * way through, or lets the in-process arm stop declaring storage at all, these
 * stop passing. That is worth having; it is just not drift detection, and the
 * previous wording claimed it was.
 */
describe("ottaPluginDescriptor storage, EXACTLY (INC-D1)", () => {
	const inProcess = ottaPluginDescriptor();

	test("the descriptor declares the commerce storage layout, whole", () => {
		expect(inProcess.storage).toEqual(COMMERCE_STORAGE_COLLECTIONS);
	});

	test("the declared collection set is EXACTLY the adapters' — no extras, none missing", () => {
		// Sorted on both sides: a missing collection and a leaked extra are both
		// failures, and key order in the spread is not a contract.
		expect(Object.keys(inProcess.storage ?? {}).toSorted()).toEqual(
			[...COMMERCE_STORAGE_COLLECTION_NAMES].toSorted(),
		);
	});

	test("every collection's index AND uniqueIndex list matches the adapter's, entry for entry", () => {
		// Per collection rather than one deep-equal, so a failure names the
		// collection that drifted instead of printing a 32-entry diff.
		for (const [name, declared] of Object.entries(COMMERCE_STORAGE_COLLECTIONS)) {
			const actual = (inProcess.storage ?? {})[name];
			expect(actual, `collection '${name}' is not declared by the descriptor`).toBeDefined();
			expect(actual?.indexes, `indexes drifted on '${name}'`).toEqual(declared.indexes);
			expect(actual?.uniqueIndexes, `uniqueIndexes drifted on '${name}'`).toEqual(
				declared.uniqueIndexes,
			);
		}
	});

	test("COMPOSITE index declarations survive into the descriptor as arrays", () => {
		// The one shape a naive `string[]` typing would silently flatten or drop.
		// `orders` declares `["state","createdAt"]` and `order_sku_index` declares
		// `["sku","createdAt"]`; a flattened composite is a DIFFERENT index, and the
		// list query that needs it would fail at runtime with no build-time signal.
		const orders = (inProcess.storage ?? {})["orders"]?.indexes ?? [];
		expect(orders.some((entry) => Array.isArray(entry))).toBe(true);
		expect(orders).toContainEqual(["state", "createdAt"]);
		expect((inProcess.storage ?? {})["order_sku_index"]?.indexes).toContainEqual([
			"sku",
			"createdAt",
		]);
	});

	test("the declaration is NOT VACUOUS — it is the whole 36-collection layout", () => {
		// Without this, every assertion above passes over an empty object if the
		// import ever resolves to `{}`.
		expect(Object.keys(inProcess.storage ?? {}).length).toBe(
			COMMERCE_STORAGE_COLLECTION_NAMES.length,
		);
		expect(COMMERCE_STORAGE_COLLECTION_NAMES.length).toBeGreaterThan(20);
	});

	test("declaring storage buys NO new capability — still EXACTLY the manifest's two", () => {
		// `ctx.storage` is ungated in em-dash's vocabulary: there is no "storage"
		// capability string to ask for, and the gate is the declaration itself. The
		// sandbox-clean contract (`capabilities` are exactly the manifest's) must
		// therefore survive the fold-in untouched — this is the assertion that would
		// catch someone "fixing" a storage error by widening capabilities.
		expect(inProcess.capabilities).toEqual([...OTTA_PLUGIN_CAPABILITIES]);
	});

	test("the descriptor stays standard format with NO React entry", () => {
		// A `format: "standard"` descriptor that declares `adminEntry` THROWS at
		// build time ("Standard plugins use Block Kit for admin UI, not React
		// components"). Folding the service in changes the transport, not the admin
		// UI kit, and nothing about `storage` may be taken as licence to move.
		expect(inProcess.format).toBe("standard");
		expect(inProcess).not.toHaveProperty("adminEntry");
		expect(inProcess).not.toHaveProperty("componentsEntry");
		expect(inProcess.fieldWidgets).toBeUndefined();
	});

	test("the descriptor keeps the same five Block Kit admin pages", () => {
		expect(inProcess.adminPages).toEqual([
			REPORTS_PAGE,
			SETTINGS_PAGE,
			TAX_PAGE,
			SHIPPING_PAGE,
			COUPONS_PAGE,
		]);
	});
});

/**
 * INC-C3 — the descriptor's egress allowlist, as an EXACT SET.
 *
 * `allowedHosts` is the one ADR-0006 gate that still holds in trusted mode
 * (`createHttpAccess` rejects by hostname), so both directions of drift matter
 * and both are failures here: a MISSING host silently breaks a payment or an
 * email at runtime with no build-time signal, and an EXTRA host widens the gate
 * ADR-0006 exists to keep minimal. Every assertion below therefore compares the
 * whole sorted array — never `toContain`, which would pass for either mistake.
 *
 * The email and facilitator hosts are DEPLOYMENT-SUPPLIED, not constants: there
 * is no canonical email provider and no default facilitator, so the descriptor
 * takes them as input and grants NOTHING when they are absent — see the
 * fail-closed cases. Stripe's API host is the one constant.
 */
/** Order-insensitive EXACT comparison: `toEqual` on both sides sorted catches a
 *  missing host AND a leaked extra one, which `toContain` cannot. */
const sorted = (hosts: readonly string[] | undefined): string[] => [...(hosts ?? [])].toSorted();

describe("ottaPluginDescriptor allowedHosts, EXACTLY", () => {
	const EMAIL = "https://api.email.example.com/v1/send";
	const FACILITATOR = "https://facilitator.example.com";

	test("EXACTLY Stripe + email + facilitator when both are supplied", () => {
		const hosts = ottaPluginDescriptor({
			egress: { emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR },
		}).allowedHosts;
		expect(sorted(hosts)).toEqual(
			sorted([STRIPE_API_HOST, "api.email.example.com", "facilitator.example.com"]),
		);
	});

	test("with nothing configured: EXACTLY the Stripe API host", () => {
		expect(ottaPluginDescriptor().allowedHosts).toEqual([STRIPE_API_HOST]);
	});

	test("FAIL-CLOSED: an unparseable egress URL grants nothing and never throws", () => {
		const options = { egress: { emailApiUrl: "not a url", facilitatorUrl: "" } };
		expect(() => ottaPluginDescriptor(options)).not.toThrow();
		expect(ottaPluginDescriptor(options).allowedHosts).toEqual([STRIPE_API_HOST]);
	});

	test("INC-D3a: no commerce-service host can reach the allowlist at all", () => {
		// The descriptor no longer takes a service URL — there is no parameter a
		// service host could arrive through, and no mode on which one would be
		// granted. This is the pin that the retirement actually happened rather
		// than the http arm merely going unused.
		for (const hosts of [
			ottaPluginDescriptor().allowedHosts,
			ottaPluginDescriptor({ egress: { emailApiUrl: EMAIL, facilitatorUrl: FACILITATOR } })
				.allowedHosts,
		]) {
			expect(hosts).not.toContain("commerce.otta.internal");
			expect(hosts).not.toContain("svc.example.com");
		}
	});
});

/**
 * INC-C3 — the payment/email secrets are kv keys, NOT wrangler vars.
 *
 * `wrangler-config.test.ts` forbids any `vars` key matching
 * /SECRET|KEY|TOKEN|PASSWORD/i. The fold-in must not route around that by
 * baking a secret into a build-time define either: every one of these is
 * operator-provisioned into write-only plugin kv through the Settings form.
 */
describe("payment/email secrets never leave kv for the site's build surface", () => {
	test("no payment secret name appears in astro.config.ts as a define", async () => {
		const config = await readFile(new URL("../astro.config.ts", import.meta.url), "utf8");
		for (const key of PAYMENT_SECRET_KEYS) {
			const name = key.slice("settings:".length);
			expect(config).not.toContain(name);
		}
	});

	test("no payment secret name appears in wrangler.jsonc", async () => {
		const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		for (const key of PAYMENT_SECRET_KEYS) {
			expect(wrangler).not.toContain(key);
		}
	});
});

describe("buildEmdashOptions", () => {
	const options = buildEmdashOptions();

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

	/**
	 * INC-D1 review round 3, B1 — the egress URLs reach the DESCRIPTOR, not only the
	 * bundle's defines.
	 *
	 * `manifest.ts` resolves `__OTTA_EMAIL_API_URL__` / `__OTTA_X402_FACILITATOR_URL__`
	 * from Vite defines to decide whether the bundle builds an `EmailSender` and a
	 * facilitator client at all. `allowedHosts` decides whether those calls are
	 * permitted. Before this parameter existed the second half was unreachable: the
	 * descriptor structurally could not allowlist either host, so the first build to
	 * set an egress define would ship a sender aimed at a host the gate refuses —
	 * every send failing, rows rescheduling to `failed`, and the sweep leg reporting
	 * `count: 0` instead of the honest `skipped`.
	 */
	test("threads the in-process egress URLs into the registered descriptor's allowlist", () => {
		const hosts = buildEmdashOptions({
			emailApiUrl: "https://api.email.example.com/v1/send",
			facilitatorUrl: "https://facilitator.example.com",
		}).plugins[0]?.allowedHosts;
		expect(sorted(hosts)).toEqual(
			sorted([STRIPE_API_HOST, "api.email.example.com", "facilitator.example.com"]),
		);
	});

	test("with no egress configured the allowlist is EXACTLY Stripe — fail-closed, unchanged", () => {
		// Staging today supplies neither URL, so this is the list it actually ships.
		expect(buildEmdashOptions().plugins[0]?.allowedHosts).toEqual([STRIPE_API_HOST]);
	});

	test("registers the Otta plugin FIRST, trusted, unchanged", () => {
		// The `toHaveLength(1)` that used to live here moved into the
		// otta-console block below, where the whole registered SET is pinned.
		// It moved rather than being deleted: the 2026-07-31 spike registered a
		// second descriptor and this was the one and only existing assertion
		// that broke — the test doing its job. Length now has a home that says
		// which second entry is allowed, instead of forbidding all of them.
		expect(options.plugins?.[0]).toEqual(ottaPluginDescriptor());
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
	const options = buildEmdashOptions();
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
		// descriptor keeps every page it still declares either way (pinned above), so
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
		"output:'server', checkOrigin not disabled, plugin never externalized",
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

			// INC-D3a: `__OTTA_COMMERCE_SERVICE_URL__` is GONE. There is no commerce
			// service, so there is no URL to bake — and a build that reintroduced
			// one would be reintroducing the transport this increment retired.
			const define = config.vite?.define as Record<string, string>;
			expect(Object.keys(define)).not.toContain("__OTTA_COMMERCE_SERVICE_URL__");
			expect(Object.keys(define)).not.toContain("__OTTA_COMMERCE_MODE__");
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

	test(
		"the two in-process egress URLs ride build-time defines, ALWAYS as strings",
		async () => {
			// INC-D3a retired the commerce-mode define along with the transport it
			// selected; these two are what is left of the build-time surface the
			// plugin bundle reads. Both must be PRESENT: an absent define leaves the
			// identifier undeclared in the worker bundle, and `""` is what both the
			// `typeof` guard and `hostnameOf` read as "this provider is unconfigured".
			const config = (await import("../astro.config.js")).default;
			const define = config.vite?.define as Record<string, string>;
			for (const name of ["__OTTA_EMAIL_API_URL__", "__OTTA_X402_FACILITATOR_URL__"]) {
				expect(Object.keys(define)).toContain(name);
				expect(typeof JSON.parse(define[name] ?? "null")).toBe("string");
			}
		},
		CONFIG_IMPORT_TIMEOUT_MS,
	);

	/**
	 * THE LOAD-BEARING ONE — the baked egress defines and the REGISTERED
	 * descriptor's allowlist must come from ONE decision.
	 *
	 * INC-D3a removed the transport half of this (there is one transport now, and
	 * no mode to disagree about), but the egress half is unchanged and is the
	 * reason this test still exists. The two values are consumed in two different
	 * places: the plugin BUNDLE reads `__OTTA_EMAIL_API_URL__` /
	 * `__OTTA_X402_FACILITATOR_URL__` as Vite defines to decide whether to build an
	 * `EmailSender` and a facilitator client at all, while the DESCRIPTOR's
	 * `allowedHosts` — the one ADR-0006 gate that still bites in trusted mode — is
	 * built in Node at config time, where those defines do not exist.
	 *
	 * Feed only the defines and the bundle holds a sender aimed at a host the gate
	 * refuses: every send fails, rows reschedule and park `failed`, and the sweep
	 * leg reports `count: 0` instead of the honest `skipped`. Hence one named
	 * const, both consumers, and hence this test.
	 */
	test(
		"the baked egress URLs and the REGISTERED descriptor cannot disagree",
		async () => {
			// THE TIE IS PINNED IN THE SOURCE, NOT BY REBUILDING THE VALUE (review
			// round 3, A3). `config.integrations` cannot answer this: `emdash()`
			// captures its options in a closure and hands Astro back `{name, hooks}`,
			// so the registered descriptor is not reachable from here, and rebuilding
			// it from the baked values compares two values derived from ONE input —
			// green no matter what the config actually registers, including for the
			// precise mistake this const exists to prevent: `emdash(buildEmdashOptions())`
			// with the egress argument dropped.
			//
			// So read the source and require that ONE NAMED CONST feeds both consumers.
			// Same technique this file already uses for the wrangler pairing invariant.
			const source = await readFile(new URL("../astro.config.ts", import.meta.url), "utf8");
			const registration = /emdash\(\s*buildEmdashOptions\(([^)]*)\)/.exec(source);
			expect(registration?.[1], "the config must register via buildEmdashOptions(...)").toBeTypeOf(
				"string",
			);
			const args = (registration?.[1] ?? "").split(",").map((a) => a.trim());
			// Argument 1 is the egress const, and it must be the same one the two
			// egress defines are baked from (review round 3, B1). An omitted argument
			// fails here as `undefined`.
			const egressDefine =
				/__OTTA_EMAIL_API_URL__:\s*JSON\.stringify\(([A-Za-z_$][\w$]*)\.emailApiUrl/.exec(source);
			expect(
				egressDefine?.[1],
				"__OTTA_EMAIL_API_URL__ must be baked from a named const",
			).toBeTypeOf("string");
			expect(
				args[0],
				"buildEmdashOptions must be passed the same egress const the defines bake",
			).toBe(egressDefine?.[1]);
			// BOTH egress defines, not just the email one: a future edit that split the
			// facilitator URL onto a second const would leave its host un-allowlisted
			// while this test stayed green (review round 4).
			const facilitatorDefine =
				/__OTTA_X402_FACILITATOR_URL__:\s*JSON\.stringify\(([A-Za-z_$][\w$]*)\.facilitatorUrl/.exec(
					source,
				);
			expect(
				facilitatorDefine?.[1],
				"__OTTA_X402_FACILITATOR_URL__ must be baked from a named const",
			).toBeTypeOf("string");
			expect(
				facilitatorDefine?.[1],
				"both egress defines must come from the SAME const buildEmdashOptions is passed",
			).toBe(args[0]);

			// And the registered descriptor is the single in-process shape: storage
			// declared, Stripe allowlisted, no service host anywhere.
			const registered = buildEmdashOptions().plugins[0];
			expect(registered).toEqual(ottaPluginDescriptor());
			expect(registered?.storage).toEqual(COMMERCE_STORAGE_COLLECTIONS);
			expect(registered?.allowedHosts).toContain(STRIPE_API_HOST);
		},
		CONFIG_IMPORT_TIMEOUT_MS,
	);
});
