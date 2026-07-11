/**
 * Urumi staging storefront + admin — EmDash on Cloudflare Workers.
 *
 * Modeled on em-dash's `templates/starter-cloudflare/astro.config.mjs`
 * (no Access / Images / Stream / sandbox), plus the trusted Urumi plugin
 * descriptor (ADR-0004) and the build-time commerce-service URL:
 *
 *   COMMERCE_SERVICE_URL=https://<service host> pnpm build
 *
 * The URL is baked in at BUILD time (define + allowedHosts); changing it
 * means rebuild + redeploy (see README).
 */
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { buildEmdashOptions, resolveServiceUrl } from "./src/emdash-options.js";

const serviceUrl = resolveServiceUrl(process.env.COMMERCE_SERVICE_URL);

export default defineConfig({
	output: "server",
	// NOT `cloudflare({ imageService: "cloudflare" })` — that's the paid
	// image resizing product; Astro's built-in service is fine for staging.
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [react(), emdash(buildEmdashOptions(serviceUrl))],
	// `security.checkOrigin` stays at its default (true) — it is the CSRF
	// protection for the /cart/* POST endpoints. Never disable it.
	vite: {
		// Bake the service URL into the @urumi/plugin bundle (manifest.ts
		// reads this compile-time global; falls back to its placeholder).
		define: {
			__URUMI_COMMERCE_SERVICE_URL__: JSON.stringify(serviceUrl),
		},
		ssr: {
			// UNCONDITIONAL: if @urumi/plugin is ever externalized the define
			// above silently never applies and every ctx.http call fails the
			// allowedHosts check at runtime. (It is also consumed as TS
			// source via its workspace `"."`/`"./plugin"` exports, which
			// requires bundling anyway.)
			noExternal: ["@urumi/plugin"],
		},
	},
	devToolbar: { enabled: false },
});
