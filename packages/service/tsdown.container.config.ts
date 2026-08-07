/**
 * The CONTAINER build of the Node entry — a single self-contained
 * `dist/container/index.mjs` with no `node_modules` at runtime.
 *
 * Why a second config instead of a flag on `tsdown.config.ts`: that one
 * produces the PUBLISHED artifact, whose `dist/index.mjs` deliberately
 * externalizes its dependencies so npm consumers dedupe them. Running that
 * artifact from a checkout is exactly what issue #44 reports — the workspace
 * `exports` maps of `@otta-sh/domain` / `@otta-sh/store-postgres` point at
 * TypeScript SOURCE, so the externalized bare imports resolve to `.ts` files
 * and Node dies with ERR_MODULE_NOT_FOUND on their internal `.js` specifiers.
 *
 * Bundling everything sidesteps that (it does not fix #44 — the published
 * artifact is unchanged) and buys the image two things: the runtime stage
 * needs no `pnpm install` at all, and nothing native is ever reachable.
 * The latter is only true because `src/index.ts` imports the sqlite-free
 * `@otta-sh/store-postgres/pg` subpath; through the `.` barrel this build
 * would pull in the `better-sqlite3` addon and fail. Every remaining
 * dependency (`hono`, `@hono/node-server`, `kysely`, `pg`, `zod`) is pure
 * JavaScript — the Stripe adapter talks to the REST API over `fetch` rather
 * than carrying the SDK — so the whole graph is bundleable.
 */
import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist/container",
	format: ["esm"],
	platform: "node",
	// Inline EVERYTHING, workspace packages and npm dependencies alike.
	noExternal: [/.*/],
	// `pg` require()s its optional native client inside a try/catch. It is not
	// installed and must stay unresolved: bundling the attempt is what turns a
	// caught "module not found" into a build-time failure.
	external: ["pg-native"],
	// Types are the published build's job; a container never imports this.
	dts: false,
	sourcemap: true,
});
