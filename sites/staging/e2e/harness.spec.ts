/**
 * The gates the e2e harness owes even when nothing is running.
 *
 * Every test here is server-free and browser-free, so `pnpm test:e2e` is
 * meaningful (and green) on a bare checkout, and so the three things this
 * increment exists to hold — §0.4's viewport, §0.3's port, and ADR-0006
 * Decision 1's sandbox suites — are asserted rather than described.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	ADMIN_BASE_PATH,
	CONSOLE_PLUGIN_ID,
	DEV_BYPASS_PATH,
	E2E_PG_CONNECTION_STRING,
	E2E_VIEWPORT,
	MIGRATED_SCREENS,
	NEVER_MIGRATED_PATHS,
	consoleScreenUrl,
	expect,
	test,
} from "./harness.js";

const repoRoot = new URL("../../../", import.meta.url);
const sandboxTestDir = new URL("packages/plugin/test/", repoRoot);

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
		for (const file of ["playwright.config.ts", "sites/staging/e2e/harness.ts"]) {
			const source = readFileSync(fileURLToPath(new URL(file, repoRoot)), "utf8");
			expect(source, `${file} names port ${prodPort}`).not.toMatch(namesProdPort);
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

	test("console screens are addressed under the second descriptor id, never under `otta`", () => {
		// A React page served under id `otta` would flip that plugin's
		// `adminMode` to "react" and make its other six Block Kit pages VANISH
		// from the sidebar (ADR-0014 Decision 7). The url builder is the one
		// place that could get this wrong for every screen at once.
		expect(CONSOLE_PLUGIN_ID).toBe("otta-console");
		expect(consoleScreenUrl("/orders")).toBe(`${ADMIN_BASE_PATH}/plugins/otta-console/orders`);
		expect(consoleScreenUrl("/orders")).not.toContain("/plugins/otta/");
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
