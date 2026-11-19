import { defineConfig, type UserConfig } from "tsdown";

/**
 * Options both builds share. `src/trusted.ts` is the opt-in entrypoint a site's
 * Otta descriptor names (`@urumi.ai/otta-mcp/trusted`). `@urumi.ai/otta-plugin` is
 * a PEER and stays external: the site's one copy of the plugin is the one this
 * wraps, never a second copy bundled in here.
 */
const shared = {
	entry: ["src/index.ts", "src/trusted.ts"],
	format: ["esm"],
} satisfies UserConfig;

/**
 * Two builds, so the published files carry JS source maps but no declaration
 * maps (#510), as in every Otta package. `dts.build` because `src/` imports the
 * plugin's VALUES from a workspace package whose `exports` point at TypeScript
 * source: project mode consumes the plugin's emitted declarations instead of
 * compiling its sources as this package's own. `neverBundle` keeps the
 * declarations importing `@urumi.ai/otta-*` rather than inlining copies of their
 * branded types.
 */
export default defineConfig([
	{ ...shared, sourcemap: true, dts: false },
	{
		...shared,
		clean: false,
		sourcemap: false,
		dts: { build: true, emitDtsOnly: true, sourcemap: false },
		deps: { dts: { neverBundle: [/^@urumi\.ai\/otta-/] } },
	},
]);
