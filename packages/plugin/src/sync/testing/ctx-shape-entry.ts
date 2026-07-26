import { createSandboxWorker } from "../../sandbox-entry.js";
import type { SandboxedPlugin } from "../../types.js";

/**
 * A characterization fixture for the sandbox bridge's CONTEXT SHAPE, booted by
 * `test/sandbox/harness.ts` via its `entry` option and served through the exact
 * production `createSandboxWorker`. Its single hook reports the keys our bridge
 * puts on `ctx`.
 *
 * DEFENSE-IN-DEPTH ONLY — read the test's name. This pins OUR harness, not
 * production: in trusted mode em-dash really does hand a `content:write` plugin
 * a write-capable `ctx.content`. The real bound on that capability is
 * compile-time — the plugin's own `PluginContext` (`src/types.ts`) declares
 * exactly `{http, kv}`, so any `ctx.content…` reference is a `pnpm typecheck`
 * error, which no aliasing can dodge.
 *
 * Never part of any production bundle: not reachable from `index.ts`,
 * `plugin.ts` or the default sandbox entry, and not a tsdown build entry.
 */
const ctxShapePlugin: SandboxedPlugin = {
	hooks: {
		"content:beforeSave": { handler: (_event, ctx) => Object.keys(ctx).sort() },
	},
};

export default createSandboxWorker(ctxShapePlugin);
