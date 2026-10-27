import { defineConfig, type UserConfig } from "tsdown";

/** Options both builds share. */
const shared = {
	// Two entries, and they must stay two: `src/index.ts` is imported by the
	// site to build the descriptor and therefore lands in the Cloudflare Worker,
	// while `src/admin.tsx` is imported only by EmDash's generated admin
	// registry and lands in client assets. Merging them would pull React into
	// the Worker bundle for no benefit.
	entry: ["src/index.ts", "src/admin.tsx"],
	format: ["esm"],
} satisfies UserConfig;

/**
 * Two builds, so the published files carry JS source maps but no declaration
 * maps (#510). The `.mjs.map` files embed their sources (`sourcesContent`) and
 * ship. A `.d.mts.map` points at the unshipped `../src`, and tsdown writes the
 * `//# sourceMappingURL` comment into the `.d.mts` whenever the build that emits
 * it has `sourcemap` on, so the declarations come from their own build with it
 * off. `scripts/pack-consume-types.mjs` fails on any dangling map reference.
 * The first build's `clean` empties dist once for both (tsdown cleans
 * before either builds), which is why the second may say `clean: false`.
 */
export default defineConfig([
	{ ...shared, sourcemap: true, dts: false },
	{ ...shared, clean: false, sourcemap: false, dts: { emitDtsOnly: true, sourcemap: false } },
]);
