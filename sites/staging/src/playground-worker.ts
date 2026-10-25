/**
 * Worker entry for the playground deploy (`wrangler.playground.jsonc`).
 *
 * The fetch and scheduled handlers are the storefront's. The named export is
 * what the Durable Object binding instantiates — without it Cloudflare cannot
 * build a per-visitor database and `/playground` never gets past "Setting up".
 */
export { EmDashPreviewDB } from "@emdash-cms/cloudflare/db/playground";
export { default } from "./worker.js";
