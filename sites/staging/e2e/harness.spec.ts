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
	CONSOLE_SHELL,
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
		// `adminMode` to "react" and make its other six Block Kit pages VANISH
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
		// `/plugins/$pluginId/$`. The `/orders` literal stays even though nothing
		// serves it yet: it is INC-20's target, and this is the assertion that
		// would catch the prefix moving out from under it first.
		expect(CONSOLE_PLUGIN_ID).toBe("otta-console");
		expect(consoleScreenUrl("/orders")).toBe(`${ADMIN_BASE_PATH}/plugins/otta-console/orders`);
		expect(consoleScreenUrl("/orders")).not.toContain("/plugins/otta/");
		expect(consoleScreenUrl(CONSOLE_SHELL.path)).toBe(
			`${ADMIN_BASE_PATH}/plugins/otta-console/console`,
		);

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

	test("the INC-19 shell is described like a screen but is not registered as one", () => {
		// The shell is a React page that never existed on Block Kit, so it is not
		// a migration and does not belong in the registry — but it is still a
		// React page needing a gate, which is why it exists as its own constant
		// with its own spec file. The same well-formedness rules apply to it.
		expect(CONSOLE_SHELL.path).toMatch(/^\//);
		expect(CONSOLE_SHELL.increment).toMatch(/^INC-\d\d$/);
		expect(NEVER_MIGRATED_PATHS).not.toContain(CONSOLE_SHELL.path);
		expect(MIGRATED_SCREENS.map((screen) => screen.path)).not.toContain(CONSOLE_SHELL.path);
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

	test("all 18 suites are present", () => {
		expect(sandboxFiles).toHaveLength(18);
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
