import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	// The host is a PEER, exactly as it is for @otta-sh/admin-react: this package
	// names EmDash's storage types and never executes its code, so the built
	// `.d.mts` must keep `import type … from "emdash"` as an external reference.
	// Left bundlable, tsdown's dts rollup walks the host's whole type graph
	// (astro, postcss, …) and fails — which is a build-time symptom of the same
	// rule `store-emdash-is-sandbox-clean` enforces: the host is not ours to inline.
	external: ["emdash"],
});
