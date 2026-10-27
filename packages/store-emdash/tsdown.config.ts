import { defineConfig, type UserConfig } from "tsdown";

/** Options both builds share. */
const shared = {
	entry: ["src/index.ts"],
	format: ["esm"],
	// The host is a PEER, exactly as it is for @urumi.ai/otta-admin-react: this package
	// names EmDash's storage types and never executes its code, so the built
	// `.d.mts` must keep `import type … from "emdash"` as an external reference.
	// Left bundlable, tsdown's dts rollup walks the host's whole type graph
	// (astro, postcss, …) and fails — which is a build-time symptom of the same
	// rule `store-emdash-is-sandbox-clean` enforces: the host is not ours to inline.
	external: ["emdash"],
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
