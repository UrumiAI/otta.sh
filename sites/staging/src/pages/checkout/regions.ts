/**
 * GET /checkout/regions?country=US — one country's state/province options
 * (`[{ code, label }]`, named and sorted for the site's locale), for the
 * checkout's optional region script (ADR-0034). The same list the page renders
 * server-side (lib/regions.ts); an unknown country, or one without
 * subdivisions, is `[]`. Public, fixed data: no cookie read, cacheable.
 */
import type { APIRoute } from "astro";
import { regionChoice } from "../../lib/regions.js";
import { SITE_LOCALE } from "../../lib/site-locale.js";

export const GET: APIRoute = ({ url }) => {
	const { options } = regionChoice(
		(url.searchParams.get("country") ?? "").slice(0, 8),
		"",
		SITE_LOCALE,
	);
	return new Response(JSON.stringify(options), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=86400",
		},
	});
};
