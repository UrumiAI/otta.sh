import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/pg.ts", "src/testing.ts"],
	format: ["esm"],
	dts: true,
});
