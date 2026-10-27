import { defineConfig, type UserConfig } from "tsdown";

/** Options both builds share. */
const shared = {
	entry: ["src/index.ts"],
	format: ["esm"],
} satisfies UserConfig;

/**
 * Two builds, so the published files carry JS source maps but no declaration
 * maps (#510). The `.mjs.map` files embed their sources (`sourcesContent`) and
 * ship. A `.d.mts.map` points at the unshipped `../src`, and tsdown writes the
 * `//# sourceMappingURL` comment into the `.d.mts` whenever the build that emits
 * it has `sourcemap` on, so the declarations come from their own build with it
 * off. `scripts/pack-consume-types.mjs` fails on any dangling map reference.
 */
export default defineConfig([
	{ ...shared, sourcemap: true, dts: false },
	{ ...shared, clean: false, sourcemap: false, dts: { emitDtsOnly: true, sourcemap: false } },
]);
