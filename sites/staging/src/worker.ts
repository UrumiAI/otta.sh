// Worker entry: Astro's fetch handler plus EmDash's scheduled() handler,
// which the Cron Trigger in wrangler.jsonc drives. PluginBridge is the
// sandbox Durable Object — re-exported so its binding resolves; with no
// LOADER binding configured it is never exercised (ADR-0006: no sandbox
// runner on this deployment).
export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
