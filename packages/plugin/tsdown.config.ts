import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/sandbox-entry.ts"],
	format: ["esm"],
	dts: true,
});
