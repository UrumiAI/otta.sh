/**
 * The gates the e2e harness owes even when nothing is running.
 *
 * Every test here is server-free and browser-free, so `pnpm test:e2e` is
 * meaningful (and green) on a bare checkout, and so the three things this
 * increment exists to hold — §0.4's viewport, §0.3's port, and ADR-0006
 * Decision 1's sandbox suites — are asserted rather than described.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ADMIN_BASE_PATH,
	BLOCK_KIT_SIDEBAR_LINK,
	CONSOLE_PLUGIN_ID,
	DEV_BYPASS_PATH,
	E2E_BASE_URL,
	E2E_PG_CONNECTION_STRING,
	E2E_SERVICE_URL,
	E2E_VIEWPORT,
	MIGRATED_SCREENS,
	NEVER_MIGRATED_PATHS,
	assertLoopbackUrl,
	consoleScreenUrl,
	expect,
	test,
} from "./harness.js";

const repoRoot = new URL("../../../", import.meta.url);
const sandboxTestDir = new URL("packages/plugin/test/", repoRoot);
const e2eDir = new URL("sites/staging/e2e/", repoRoot);

/**
 * Every file the e2e surface consists of, discovered rather than listed.
 *
 * An allowlist of filenames only guards the files that existed when it was
 * written; INC-19 and INC-20 both add specs here, and neither should have to
 * remember to enrol them. Globbing means a new file is guarded the moment it
 * lands.
 */
function e2eSurfaceFiles(): Array<{ label: string; source: string }> {
	const rootPath = fileURLToPath(repoRoot);
	const paths = readdirSync(e2eDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name))
		// `parentPath` (not `name`) is what makes this correct once anyone adds a
		// subdirectory: `name` is only the basename.
		.map((entry) => join(entry.parentPath, entry.name));
	paths.push(join(rootPath, "playwright.config.ts"));
	return paths.map((path) => ({
		label: relative(rootPath, path),
		source: readFileSync(path, "utf8"),
	}));
}

test.describe("harness configuration", () => {
	test("the resolved viewport is 1440x2200 (§0.4)", () => {
		// Read back from the RESOLVED project config, not from the constant: a
		// `use: { viewport: … }` override in playwright.config.ts, a device
		// preset (Desktop Chrome is 1280x720), or a stray `--viewport` would all
		// silently invalidate every comparison against `audit/shots/`.
		expect(test.info().project.use.viewport).toEqual({ width: 1440, height: 2200 });
		expect(E2E_VIEWPORT).toEqual({ width: 1440, height: 2200 });
	});

	test("nothing in the e2e surface names port 5432 (§0.3 — that port is PRODUCTION)", () => {
		// Port 5432 on localhost is an SSH tunnel to prod Azure Postgres; the
		// local test database is 127.0.0.1:55432. A stray one reaching a
		// Playwright webServer command points a boot script at production.
		// The pattern is BUILT rather than written literally so this guard does
		// not itself put the forbidden token in the tree, and so `:55432` cannot
		// register as a hit (hence the trailing digit boundary).
		const prodPort = 5432;
		const namesProdPort = new RegExp(`:${prodPort}(?!\\d)`);
		const surface = e2eSurfaceFiles();
		// Discovered, not listed — so the specs INC-19 and INC-20 add are covered
		// the moment they land.
		expect(surface.length, "the e2e surface came back empty — the glob is broken").toBeGreaterThan(
			3,
		);
		for (const { label, source } of surface) {
			expect(source, `${label} names port ${prodPort}`).not.toMatch(namesProdPort);
		}
		// harness.ts owns the one connection string the harness can hand to a
		// boot command, so its DEFAULT is pinned to the local test container...
		const harness = readFileSync(
			fileURLToPath(new URL("sites/staging/e2e/harness.ts", repoRoot)),
			"utf8",
		);
		expect(harness, "the default e2e database is no longer the local test one").toContain(":55432");
		// ...and the RESOLVED value is checked too, so an inherited
		// PG_CONNECTION_STRING cannot aim a boot at production either.
		expect(E2E_PG_CONNECTION_STRING, "PG_CONNECTION_STRING names production").not.toMatch(
			namesProdPort,
		);
	});

	test("every resolved e2e endpoint is loopback (§0.3 — no remote host, ever)", () => {
		// The port guard above only covers Postgres. `COMMERCE_SERVICE_URL` and
		// `OTTA_E2E_BASE_URL` are ordinary deployment variables that a shell used
		// for deploying already exports; inherited, they would point the stack
		// boot and the dev-bypass POST at real infrastructure. Same treatment.
		for (const [label, url] of [
			["OTTA_E2E_BASE_URL", E2E_BASE_URL],
			["COMMERCE_SERVICE_URL", E2E_SERVICE_URL],
			["PG_CONNECTION_STRING", E2E_PG_CONNECTION_STRING],
		] as const) {
			expect(() => assertLoopbackUrl(url, label), `${label} is not loopback`).not.toThrow();
		}
		// Negative control: the guard is not vacuous.
		expect(() => assertLoopbackUrl("https://otta.example.com", "probe")).toThrow(/loopback/);
		expect(() => assertLoopbackUrl("postgres://u:p@db.prod.internal:55432/otta", "probe")).toThrow(
			/loopback/,
		);
		// And a value it cannot parse is a refusal, not a pass — with a message
		// that says which variable and what shape, rather than `Invalid URL`.
		// libpq's keyword form is the realistic way this happens: psql and most
		// tooling accept `host=… port=… dbname=…`, so an inherited
		// PG_CONNECTION_STRING can easily be in it.
		// (The fixture names no port at all: this file is itself swept by the
		// port guard above, and a realistic keyword-form string would carry the
		// forbidden one.)
		expect(() =>
			assertLoopbackUrl("host=db.prod.internal dbname=otta", "PG_CONNECTION_STRING"),
		).toThrow(/PG_CONNECTION_STRING must be a URL this guard can parse/);
	});

	test("console screens are addressed under the second descriptor id, never under `otta`", () => {
		// A React page served under id `otta` would flip that plugin's
		// `adminMode` to "react" and make its five Block Kit pages VANISH
		// from the sidebar (ADR-0014 Decision 7). The url builder is the one
		// place that could get this wrong for every screen at once.
		//
		// The literal below is deliberate duplication of `consoleScreenUrl`'s
		// output — that is what makes it a pin rather than a restatement. It is
		// the ONLY other place the URL shape is written down: the builder and
		// the sidebar selector both live in harness.ts, so a change to the prefix
		// happens in one place and is re-pinned here.
		//
		// INC-18 derived this shape from reading EmDash; INC-19 loaded a real
		// console page at it and it held — `@emdash-cms/admin@0.31.1` emits
		// `to: /plugins/${pluginId}${page.path}` in the sidebar and routes
		// `/plugins/$pluginId/$`. INC-20 then MIGRATED `/orders`, so the literal
		// below is no longer a placeholder for a future target: it is the live
		// address of the console's Orders screen. The second assertion — that it
		// is NOT under `/plugins/otta/` — became load-bearing rather than
		// hypothetical while a Block Kit screen served the same path at that other
		// id; ADR-0015 has since retired that screen, and the assertion stays
		// because the id, not the path, is what keeps the two descriptors apart.
		expect(CONSOLE_PLUGIN_ID).toBe("otta-console");
		expect(consoleScreenUrl("/orders")).toBe(`${ADMIN_BASE_PATH}/plugins/otta-console/orders`);
		expect(consoleScreenUrl("/orders")).not.toContain("/plugins/otta/");
		expect(consoleScreenUrl("/products")).toBe(`${ADMIN_BASE_PATH}/plugins/otta-console/products`);

		// The sidebar selector must not match the console's own links, or the
		// "Block Kit screens are still there" assertion passes vacuously.
		expect(BLOCK_KIT_SIDEBAR_LINK).toContain("/plugins/otta/");
		expect(consoleScreenUrl("/orders")).not.toMatch(/\/plugins\/otta\//);
	});

	test("authentication is a dev-bypass URL", () => {
		expect(DEV_BYPASS_PATH).toMatch(/^\/_emdash\/api\/(auth|setup)\/dev-bypass/);
	});
});

test.describe("the migrated-screen registry is the coverage gate", () => {
	test("every entry is well-formed and uniquely addressed", () => {
		const paths = MIGRATED_SCREENS.map((screen) => screen.path);
		expect(new Set(paths).size, "two screens share a path").toBe(paths.length);
		for (const screen of MIGRATED_SCREENS) {
			expect(screen.path, `${screen.name}: path must be descriptor-relative`).toMatch(/^\//);
			expect(screen.increment, `${screen.name}: name the increment`).toMatch(/^INC-\d\d$/);
			expect(screen.name.length).toBeGreaterThan(0);
		}
	});

	test("no screen ADR-0014 keeps on Block Kit permanently is registered", () => {
		// Decision 6: Tax, Shipping and Settings never migrate. Registering one
		// here would be the first visible step of migrating it.
		for (const screen of MIGRATED_SCREENS) {
			expect(NEVER_MIGRATED_PATHS, `${screen.name} may not migrate (ADR-0014 D6)`).not.toContain(
				screen.path,
			);
		}
	});

	test("the registry is never empty", () => {
		// Narrow on purpose, and named for what it checks. The two gates above are
		// both `for` loops over this list, so an empty registry would make each of
		// them pass over nothing; this refuses that.
		//
		// It does NOT check the inventory relationship — that every page the
		// console serves is registered here. That pin lives in
		// `site-config.test.ts`, which is the end that can see the descriptor.
		// INC-19's shell was the one React page deliberately kept out of this
		// registry (it replaced no Block Kit screen, so counting it would have made
		// "migrated" mean "React"); ADR-0015 removed that page, and with it the only
		// reason a console page could legitimately be absent.
		expect(MIGRATED_SCREENS.length).toBeGreaterThan(0);
	});
});

test.describe("this gate is ADDITIVE — ADR-0006 Decision 1 is untouched", () => {
	// ADR-0014, verbatim: the 18 sandbox suites remain the contract gate, and
	// "None is deleted, skipped, weakened or made conditional by this amendment
	// or by any migration increment under it." Playwright covers React screens
	// ONLY. Asserting it here, in the additive gate itself, is what stops a
	// later increment from deleting a Block Kit suite and calling a smoke spec
	// its replacement.
	const sandboxFiles = readdirSync(sandboxTestDir)
		.filter((name) => name.endsWith(".sandbox.test.ts"))
		.toSorted();

	/** The ONLY skip-shaped constructs allowed, and why. Both are the
	 *  pre-existing, documented Postgres gate: those two suites need a real
	 *  database and un-skip under PG_CONNECTION_STRING. */
	const ALLOWED_SKIPS: Readonly<Record<string, readonly string[]>> = {
		"account-routes.sandbox.test.ts": ["describe.skipIf"],
		"download-route.sandbox.test.ts": ["describe.skipIf"],
	};

	/**
	 * THE 18, BY NAME — ADR-0006 Decision 1's contract gate as it stood when
	 * ADR-0014 reaffirmed it.
	 *
	 * NAMED RATHER THAN COUNTED, and the change is a strengthening. A
	 * `toHaveLength(18)` fails identically for the thing it exists to catch (a
	 * suite deleted) and for a thing that is fine (a suite added) — and the
	 * obvious fix for the second, bumping the number, is indistinguishable from
	 * the obvious fix for the first. That is a control a future increment can
	 * defuse by accident. A named list cannot be satisfied by deleting one file
	 * and adding another, which is precisely the swap "18 files exist" would
	 * wave through.
	 *
	 * INC-20 is the increment that made this concrete: it ADDS
	 * `orders-console-route.sandbox.test.ts`, because the React console's data
	 * path is a new branch on the plugin's admin route and "a change that only
	 * works trusted is still broken" applies to it exactly as to the other
	 * eighteen. Adding to the gate is always allowed. Removing from it reopens
	 * the ADR.
	 *
	 * INC-R2 is the first increment to REPLACE a name rather than add one, and it
	 * did so under a record that authorises exactly that: ADR-0015 retires the
	 * Block Kit Orders screen, so `orders-page.sandbox.test.ts` has no subject
	 * left to test. Its BEHAVIOURAL half — above all the three refusals that make
	 * a refund safe — moved onto the extracted write path and is gated here as
	 * `orders-actions.sandbox.test.ts`. The list is a swap, not a deletion, and
	 * ADR-0015 is where the swap is argued.
	 *
	 * INC-R3 IS THE SECOND SWAP, under the same record and for the same reason:
	 * the Block Kit Pricing & inventory screen is retired, so
	 * `products-page.sandbox.test.ts` becomes `products-actions.sandbox.test.ts`,
	 * carrying the stale-watermark refusal, the money validation and the
	 * content-derived idempotency keys onto the extracted write path. ADR-0015
	 * bounds the deletions to exactly these two suites; the count stays 18.
	 */
	const ADR_0006_SUITES: readonly string[] = [
		"account-routes.sandbox.test.ts",
		"admin-route-dispatch.sandbox.test.ts",
		"admin-scaffold-list-detail.sandbox.test.ts",
		"admin-scaffold-render-state.sandbox.test.ts",
		"cart-routes.sandbox.test.ts",
		"coupons-page.sandbox.test.ts",
		"download-route.sandbox.test.ts",
		"orders-actions.sandbox.test.ts",
		"products-actions.sandbox.test.ts",
		"publish-atomicity.sandbox.test.ts",
		"reports-widget.sandbox.test.ts",
		"settings-widget.sandbox.test.ts",
		"shipping-page.sandbox.test.ts",
		"storefront-checkout.sandbox.test.ts",
		"storefront-pdp.sandbox.test.ts",
		"storefront-plp.sandbox.test.ts",
		"sync-hooks.sandbox.test.ts",
		"tax-page.sandbox.test.ts",
	];

	test("all 18 ADR-0006 suites are present, by name", () => {
		expect(ADR_0006_SUITES).toHaveLength(18);
		for (const name of ADR_0006_SUITES) {
			expect(sandboxFiles, `${name} was removed from the contract gate`).toContain(name);
		}
	});

	test("the gate only ever GROWS", () => {
		// Every file the glob finds is checked for weakening below, added ones
		// included — so a new suite joins the gate rather than sitting beside it.
		expect(sandboxFiles.length).toBeGreaterThanOrEqual(ADR_0006_SUITES.length);
	});

	test("none is skipped, todo'd or `.only`d beyond the documented Postgres gate", () => {
		for (const name of sandboxFiles) {
			const source = readFileSync(new URL(name, sandboxTestDir), "utf8");
			const found = [...source.matchAll(/\b(?:describe|test|it)\.(?:skip|todo|only)(?:If)?\b/g)]
				.map((match) => match[0])
				.toSorted();
			expect(found, `${name} weakens the ADR-0006 Decision 1 contract gate`).toEqual([
				...(ALLOWED_SKIPS[name] ?? []),
			]);
		}
	});
});
