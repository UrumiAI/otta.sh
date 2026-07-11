import { defineConfig } from "tsdown";

export default defineConfig({
	// `src/plugin.ts` is the standard-format descriptor entrypoint
	// (`@urumi/plugin/plugin` — default-exports the {hooks, routes} object
	// for em-dash's `plugins: []` / `adaptSandboxEntry`).
	entry: ["src/index.ts", "src/plugin.ts", "src/sandbox-entry.ts"],
	format: ["esm"],
	dts: true,
});
