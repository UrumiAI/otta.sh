/**
 * A second, in-test theme for the suites that exercise the theme SYSTEM's
 * per-request machinery — the admin preview and the chrome's bag read — which
 * need a shipped id other than the default (and, for the bag, one whose chrome
 * opts into `cartLines`). This repo ships Tempered only, so the fixture is
 * spliced into the manifest and the registry with `vi.mock`, never on disk:
 *
 *   vi.mock("../src/themes/manifest.js", async (real) =>
 *     (await import("./helpers/fixture-theme.js")).withFixtureManifest(await real()));
 *   vi.mock("../src/themes/registry.js", async (real) =>
 *     (await import("./helpers/fixture-theme.js")).withFixtureRegistry(await real()));
 *
 * The fixture renders with Tempered's components; only its id and its chrome
 * opt-in are its own, which is all those mechanisms read.
 */
import type { ThemeModule } from "../../src/themes/contract.js";
import type * as Manifest from "../../src/themes/manifest.js";
import type { ThemeId } from "../../src/themes/manifest.js";
import type * as Registry from "../../src/themes/registry.js";

/**
 * Not a real theme id: an id this build never ships. Typed as a `ThemeId` so
 * the suites can hand it to the APIs that take one — the mocks below make it
 * one for the duration of the suite.
 */
export const FIXTURE_THEME_ID = "fixture-bag" as ThemeId;

export function withFixtureManifest(real: typeof Manifest): typeof Manifest {
	const STORE_THEMES = [
		...real.STORE_THEMES,
		{
			id: FIXTURE_THEME_ID,
			label: "Fixture",
			description: "An in-test theme whose chrome draws the bag.",
			preview: `/theme-previews/${FIXTURE_THEME_ID}.webp`,
		},
	];
	return {
		...real,
		STORE_THEMES: STORE_THEMES as unknown as typeof real.STORE_THEMES,
		isThemeId: ((value: unknown) =>
			typeof value === "string" &&
			STORE_THEMES.some((theme) => theme.id === value)) as typeof real.isThemeId,
	};
}

export function withFixtureRegistry(real: typeof Registry): typeof Registry {
	const fixture: ThemeModule = {
		...real.THEMES.tempered,
		id: FIXTURE_THEME_ID,
		chrome: { cartLines: true },
	};
	const THEMES = { ...real.THEMES, [FIXTURE_THEME_ID]: fixture } as typeof real.THEMES;
	return {
		...real,
		THEMES,
		themeFor: (id) => THEMES[id] ?? real.themeFor(id),
	};
}
