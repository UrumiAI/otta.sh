import { defineConfig } from "tsdown";

export default defineConfig({
	// `subdivision-names` is its own entry (and package subpath) so the ~70 KB of
	// English names reach only what imports it — the storefront's region pick
	// list — never the plugin's sandbox bundle or the main entry.
	entry: ["src/index.ts", "src/pricing/subdivision-names.ts", "src/testing/index.ts"],
	format: ["esm"],
	dts: true,
});
