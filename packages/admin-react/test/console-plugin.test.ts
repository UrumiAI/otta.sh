/**
 * The console package's own contract — the half of ADR-0014's boundary that
 * lives here rather than in the site config.
 *
 * `sites/staging/test/site-config.test.ts` pins the DESCRIPTOR (native format,
 * zero capabilities, zero allowedHosts, both specifiers resolving into this
 * package). It cannot see what `createPlugin()` actually returns, and the
 * runtime reads `adminMode` from THAT, not from the descriptor. These tests
 * cover the difference, plus the one silent-failure mode the admin sidebar has.
 */
import { describe, expect, test } from "vitest";
import {
	OTTA_CONSOLE_ADMIN_ENTRY,
	OTTA_CONSOLE_ADMIN_PAGES,
	OTTA_CONSOLE_ENTRYPOINT,
	OTTA_CONSOLE_PACKAGE,
	OTTA_CONSOLE_PLUGIN_ID,
	OTTA_CONSOLE_PLUGIN_VERSION,
	createPlugin,
} from "../src/index.js";
import { OTTA_ADMIN_ROUTE } from "../src/console-api.js";
import { pages } from "../src/admin.js";

/** The cast in `admin.tsx` (EmDash types `pages` as elements, the router calls
 *  them as components) makes the export opaque; read it back as a plain map. */
const pageComponents = pages as unknown as Record<string, unknown>;

describe("createPlugin — the native entrypoint EmDash calls", () => {
	const plugin = createPlugin();

	test("identifies as otta-console, never as the Block Kit plugin", () => {
		// A React page under id `otta` would flip THAT plugin's adminMode to
		// "react" and hide its seven Block Kit screens from the sidebar
		// (ADR-0014 Decision 7). The id is the whole defence.
		expect(plugin.id).toBe(OTTA_CONSOLE_PLUGIN_ID);
		expect(plugin.id).not.toBe("otta");
		expect(plugin.version).toBe(OTTA_CONSOLE_PLUGIN_VERSION);
	});

	test("declares zero capabilities (ADR-0014 Decision 3)", () => {
		// `undefined` is not `[]`. The descriptor's pin says the same thing on
		// the site side; this one covers the object the runtime actually holds.
		expect(plugin.capabilities).toEqual([]);
	});

	test("declares no hooks, no routes and no storage — it has no server surface", () => {
		// The console is a browser page. Acquiring a route, a hook or a storage
		// collection is listed in ADR-0014 as a thing that REOPENS the decision.
		// `definePlugin` normalizes all three to empty containers rather than
		// leaving them undefined, so count the entries instead of matching a
		// shape — `toBeUndefined()` here would fail against an empty object and
		// pass against nothing real.
		expect(Object.keys(plugin.hooks ?? {})).toEqual([]);
		expect(Object.keys(plugin.routes ?? {})).toEqual([]);
		expect(Object.keys(plugin.storage ?? {})).toEqual([]);
	});

	test("admin.entry is what derives adminMode: 'react' — and it names this package", () => {
		// `descriptor.adminEntry` feeds the generated admin REGISTRY; it is
		// `plugin.admin.entry` that the manifest builder reads
		// (`hasAdminEntry = !!plugin.admin?.entry`). Both must be this package,
		// and they must agree.
		expect(plugin.admin?.entry).toBe(OTTA_CONSOLE_ADMIN_ENTRY);
		expect(OTTA_CONSOLE_ADMIN_ENTRY.startsWith(`${OTTA_CONSOLE_PACKAGE}/`)).toBe(true);
		expect(OTTA_CONSOLE_ENTRYPOINT).toBe(OTTA_CONSOLE_PACKAGE);
	});

	test("admin.pages is exactly the declared page list", () => {
		expect(plugin.admin?.pages).toEqual([...OTTA_CONSOLE_ADMIN_PAGES]);
	});
});

describe("the declared pages and the React components cannot drift", () => {
	test("every declared adminPage path has a component under the same key", () => {
		// THE SILENT FAILURE THIS EXISTS FOR. @emdash-cms/admin@0.31.1 builds the
		// sidebar with `if (!isBlocksMode && !resolvePluginPagePath(pluginPages,
		// page.path)) continue;` — a declared page with no matching component is
		// not an error, not a warning and not a broken link. The nav entry simply
		// is not there, and the only symptom is a console that looks like it
		// failed to install.
		for (const page of OTTA_CONSOLE_ADMIN_PAGES) {
			expect(pageComponents[page.path], `no component registered for ${page.path}`).toBeTypeOf(
				"function",
			);
		}
	});

	test("no component is registered for a path the console does not declare", () => {
		// The reverse gap is quieter still: a component nothing links to. It
		// would be reachable by URL and invisible in the nav.
		const declared = new Set(OTTA_CONSOLE_ADMIN_PAGES.map((page) => page.path));
		expect(Object.keys(pageComponents).toSorted()).toEqual([...declared].toSorted());
	});

	test("every page keeps a concrete path, not the root fallback", () => {
		// `resolvePluginPagePath` falls back to the FIRST page when the path is
		// "/", so a root-mounted page would resolve by accident and change meaning
		// the moment the page order changes. INC-19's landing page carried this pin
		// while it was the first entry; the rule was never about that page, so it
		// stays and now applies to every declared path.
		for (const page of OTTA_CONSOLE_ADMIN_PAGES) {
			expect(page.path).toMatch(/^\/.+/);
			expect(page.path).not.toBe("/");
		}
	});

	test("no page collides with a screen ADR-0014 keeps on Block Kit permanently", () => {
		// Decision 6: Tax, Shipping and Settings never migrate.
		const forbidden = ["/tax", "/shipping", "/settings"];
		for (const page of OTTA_CONSOLE_ADMIN_PAGES) {
			expect(forbidden).not.toContain(page.path);
		}
	});
});

describe("the console's only data path", () => {
	test("it targets the `otta` plugin's admin route, not its own id", () => {
		// ADR-0014 Decision 3, and the single fact the 2026-07-31 spike existed
		// to establish. `ctx.kv` is namespaced per plugin id, so a route on
		// `otta-console` would open onto an empty settings namespace and would
		// need the service token duplicated plus its own network:request
		// capability — the exact thing the empty capability set forbids.
		//
		// Read from `console-api.ts`, which is where the constant lives now that
		// INC-19's shell and its duplicate copy of it are gone.
		expect(OTTA_ADMIN_ROUTE).toBe("/_emdash/api/plugins/otta/admin");
		expect(OTTA_ADMIN_ROUTE).not.toContain(OTTA_CONSOLE_PLUGIN_ID);
	});
});
