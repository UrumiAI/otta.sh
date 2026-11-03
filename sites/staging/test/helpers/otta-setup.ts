/**
 * Runs the `otta()` integration's `astro:config:setup` hook the way Astro would
 * and returns what it registered (ADR-0045). The site config no longer spells
 * out `output`, the Vite defines or the EmDash registration itself: `otta()`
 * contributes them with `updateConfig`, so a test that pins them reads them
 * HERE, from the real hook, instead of from the config object.
 */
import type { AstroIntegration, AstroUserConfig } from "astro";
import { OTTA_INTEGRATION_NAME } from "../../../store/src/integration.js";

export interface OttaSetup {
	/** Every `updateConfig` call, merged shallowly in order (vite one level deeper). */
	config: AstroUserConfig & { vite: NonNullable<AstroUserConfig["vite"]> };
	/** The integrations otta() added, by name. */
	integrationNames: string[];
	routes: { pattern: string; entrypoint: string }[];
	middleware: { entrypoint: string; order: string }[];
}

/** The site's root: the directory above `test/`. */
export const SITE_ROOT = new URL("../../", import.meta.url);

const noop = (): void => {};

export function ottaIntegrationOf(config: AstroUserConfig): AstroIntegration {
	const found = (config.integrations ?? [])
		.flat()
		.find((i) => (i as AstroIntegration | undefined)?.name === OTTA_INTEGRATION_NAME);
	if (found === undefined) throw new Error("the site config registers no otta() integration");
	return found as AstroIntegration;
}

export async function runOttaSetup(
	config: AstroUserConfig,
	command: "dev" | "build" = "dev",
): Promise<OttaSetup> {
	const setup = ottaIntegrationOf(config).hooks["astro:config:setup"];
	if (setup === undefined) throw new Error("otta() has no astro:config:setup hook");
	const merged: OttaSetup["config"] = { vite: {} };
	const routes: OttaSetup["routes"] = [];
	const middleware: OttaSetup["middleware"] = [];
	await (setup as (options: unknown) => unknown)({
		config: { root: SITE_ROOT, vite: {} },
		command,
		isRestart: false,
		updateConfig: (update: AstroUserConfig) => {
			Object.assign(merged, { ...update, vite: { ...merged.vite, ...update.vite } });
			return merged;
		},
		injectRoute: (route: { pattern: string; entrypoint: string }) => routes.push(route),
		addMiddleware: (entry: { entrypoint: string; order: string }) => middleware.push(entry),
		logger: { info: noop, warn: noop, error: noop, debug: noop, fork: () => ({}) },
	});
	return {
		config: merged,
		integrationNames: (merged.integrations ?? [])
			.flat()
			.map((i) => (i as AstroIntegration | undefined)?.name ?? ""),
		routes,
		middleware,
	};
}
