/**
 * Which theme renders a request (src/themes/resolve.ts).
 *
 * Two halves:
 *
 *  1. THE RULES, against an injected reader: unknown, absent, malformed and
 *     throwing all land on Tempered; the `?theme=` override exists in dev only.
 *  2. THE ROUND TRIP, against the real host. The plugin's Settings "Store
 *     theme" radio saves the theme the way every Otta setting is saved — plugin
 *     kv, `ctx.kv.set("settings:storeTheme", id)` — and the site reads it with
 *     EmDash's `getPluginSetting("otta", "storeTheme")`. Those two only meet if
 *     EmDash's kv prefix (`plugin:<id>:`) and `getPluginSetting`'s options-row
 *     name (`plugin:<id>:settings:<key>`) agree. That is asserted here, not
 *     assumed: a real migrated database (better-sqlite3, the same harness as
 *     host-pin.test.ts), a real PluginManager, a real plugin route writing
 *     through the real `ctx.kv`, and this module's real read — inside EmDash's
 *     own request context, which is how `getDb()` finds the database at runtime.
 *
 * The manifest is widened by ONE test-only id (`fixture`) so a non-default
 * choice can be told apart from the fallback by an id no real theme will ever
 * take, whichever themes the build ships (Tempered alone, in this repo).
 */
import Database from "better-sqlite3";
import { createPluginManager, definePlugin, OptionsRepository, runWithContext } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("../src/themes/manifest.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/themes/manifest.js")>();
	const STORE_THEMES = [...real.STORE_THEMES, { id: "fixture", label: "Fixture" }];
	return {
		...real,
		STORE_THEMES,
		isThemeId: (value: unknown) =>
			typeof value === "string" && STORE_THEMES.some((theme) => theme.id === value),
	};
});

const {
	activeTheme,
	devThemeOverride,
	readStoredThemeId,
	resolveActiveThemeId,
	STORE_THEME_SETTING,
} = await import("../src/themes/resolve.js");

const url = (query = ""): URL => new URL(`http://shop.test/products${query}`);

describe("readStoredThemeId — anything unusable renders Tempered", () => {
	test("a stored, registered id is used", async () => {
		expect(await readStoredThemeId(async () => "fixture")).toBe("fixture");
	});

	test.each([
		["absent (never chosen)", undefined],
		["null", null],
		["empty", ""],
		["an id this build does not ship", "plinth-from-a-later-build"],
		// The five themes that moved out of this repo (2026-10-01): a store that
		// had one chosen renders Tempered until it is installed again.
		["a moved-out theme: plinth", "plinth"],
		["a moved-out theme: pressing", "pressing"],
		["a moved-out theme: batch", "batch"],
		["a moved-out theme: jumble", "jumble"],
		["a moved-out theme: counter", "counter"],
		["the wrong case", "Tempered"],
		["a number", 42],
		["an object", { id: "fixture" }],
	])("%s → tempered", async (_label, raw) => {
		expect(await readStoredThemeId(async () => raw)).toBe("tempered");
	});

	test("a read that THROWS renders Tempered — the theme is never why a page 500s", async () => {
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			await readStoredThemeId(async () => {
				throw new Error("D1 unreachable");
			}),
		).toBe("tempered");
		expect(
			await readStoredThemeId(() => {
				throw new Error("synchronous throw before any promise");
			}),
		).toBe("tempered");
		// Logged, not swallowed: a silent fallback is an outage nobody sees.
		expect(quiet).toHaveBeenCalledWith("[site-staging] store theme read threw:", expect.any(Error));
		quiet.mockRestore();
	});
});

describe("the `?theme=` override — dev only", () => {
	test("in dev, a registered id wins", () => {
		expect(devThemeOverride(url("?theme=fixture"), true)).toBe("fixture");
	});

	test("in dev, an unknown id is ignored", () => {
		expect(devThemeOverride(url("?theme=nope"), true)).toBeNull();
		expect(devThemeOverride(url(), true)).toBeNull();
	});

	test("outside dev it is ignored even for a registered id", () => {
		expect(devThemeOverride(url("?theme=fixture"), false)).toBeNull();
	});

	test("in dev the override short-circuits the stored setting (no read at all)", async () => {
		const read = vi.fn(async () => "tempered");
		expect(await resolveActiveThemeId({ url: url("?theme=fixture"), dev: true, read })).toBe(
			"fixture",
		);
		expect(read).not.toHaveBeenCalled();
	});

	test("in production the query string cannot change the theme", async () => {
		const read = vi.fn(async () => undefined);
		expect(await resolveActiveThemeId({ url: url("?theme=fixture"), dev: false, read })).toBe(
			"tempered",
		);
		expect(read).toHaveBeenCalledTimes(1);
	});

	test("the source gates it on import.meta.env.DEV, which a production build folds to false", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(new URL("../src/themes/resolve.ts", import.meta.url), "utf8");
		expect(source).toContain("dev: import.meta.env.DEV");
	});
});

describe("round trip — the plugin's kv write is the site's getPluginSetting read", () => {
	let db: Parameters<typeof runMigrations>[0];
	/** Invoke the fixture plugin's route, which writes the setting the way any
	 *  `otta` plugin code writing `settings:storeTheme` would. */
	let save: (theme: unknown) => Promise<void>;

	beforeAll(async () => {
		db = new Kysely({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
		}) as typeof db;
		await runMigrations(db);

		const manager = createPluginManager({ db });
		manager.register(
			definePlugin({
				// The REAL plugin id — the prefix under test is derived from it.
				id: "otta",
				version: "0.0.0-test",
				routes: {
					"write-theme": {
						handler: async (ctx) => {
							await ctx.kv.set(`settings:${STORE_THEME_SETTING}`, ctx.input);
							return { ok: true };
						},
					},
				},
			}),
		);
		await manager.activate("otta");
		save = async (theme) => {
			const result = await manager.invokeRoute("otta", "write-theme", {
				request: new Request("http://shop.test/_emdash/api/plugins/otta/write-theme"),
				body: theme,
			});
			expect(result.success, JSON.stringify(result.error)).toBe(true);
		};
	});

	afterAll(async () => {
		await db?.destroy();
	});

	/** This module's read, inside EmDash's request context (where getDb() looks). */
	const readInRequest = <T>(fn: () => Promise<T>): Promise<T> =>
		runWithContext({ editMode: false, db }, fn);

	test("before any save: nothing stored, Tempered renders", async () => {
		expect(await readInRequest(() => readStoredThemeId())).toBe("tempered");
	});

	test("a saved theme id is read back by the site", async () => {
		await save("fixture");
		expect(await readInRequest(() => readStoredThemeId())).toBe("fixture");
	});

	test("the options row is `plugin:otta:settings:storeTheme` — the name both sides derive", async () => {
		await save("fixture");
		expect(await new OptionsRepository(db).get("plugin:otta:settings:storeTheme")).toBe("fixture");
	});

	test("a saved id this build does not ship falls back to Tempered", async () => {
		await save("not-a-shipped-theme");
		expect(await readInRequest(() => readStoredThemeId())).toBe("tempered");
	});

	test("activeTheme reads once per request — memoized on Astro.locals", async () => {
		await save("fixture");
		const locals = {};
		const first = await readInRequest(() => activeTheme({ url: url(), locals }));
		await save("tempered");
		// Same request (same locals): the first answer stands.
		expect(await readInRequest(() => activeTheme({ url: url(), locals }))).toBe(first);
		expect(first).toBe("fixture");
		// A new request sees the new setting.
		expect(await readInRequest(() => activeTheme({ url: url(), locals: {} }))).toBe("tempered");
	});
});
