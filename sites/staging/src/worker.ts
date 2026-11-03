// Worker entry (wrangler.jsonc `main`). The store's — Astro's fetch handler,
// EmDash's scheduled() handler with the orphaned-download sweep, and the
// PluginBridge class its binding resolves — lives in @urumi.ai/otta-store.
export { default, PluginBridge } from "@urumi.ai/otta-store/worker";
