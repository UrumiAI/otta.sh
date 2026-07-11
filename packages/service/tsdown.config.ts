import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/app.ts", "src/worker.ts"],
	format: ["esm"],
	dts: true,
});
