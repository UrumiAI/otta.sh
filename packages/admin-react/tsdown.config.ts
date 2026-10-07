import { defineConfig } from "tsdown";

export default defineConfig({
	// Two entries, and they must stay two: `src/index.ts` is imported by the
	// site to build the descriptor and therefore lands in the Cloudflare Worker,
	// while `src/admin.tsx` is imported only by EmDash's generated admin
	// registry and lands in client assets. Merging them would pull React into
	// the Worker bundle for no benefit.
	entry: ["src/index.ts", "src/admin.tsx"],
	format: ["esm"],
	dts: true,
});
