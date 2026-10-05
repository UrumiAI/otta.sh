/**
 * GET|HEAD /orders/<orderId>/download/<sku> — a paid digital download (issue
 * #376, increment 3).
 *
 * A thin shell over `lib/download-delivery.ts`, where the flow, the one-404
 * rule and the headers are documented and unit-tested: ask the plugin's
 * delivery gate in-process, then stream ONLY the key it answered from the
 * private `DOWNLOADS` bucket. The order id in the path is the capability
 * (ADR-0011 scope 2, the link the confirmation email carries); the account's
 * order page links here with the same id.
 *
 * Every answer is private: `Cache-Control: private, no-store` on the response
 * and, through `keepPrivate`, out of Astro's route cache, which ignores that
 * header (middleware.ts, "TWO CACHES"). A stored copy would serve a revoked
 * buyer.
 *
 * GET only (and HEAD): a download changes nothing, so there is no form, no
 * Origin check and no CSRF surface.
 */
import type { APIRoute } from "astro";
import { env } from "virtual:emdash/env";
import { routeDispatcher } from "../../../../lib/cart-actions.js";
import { downloadsBucketFrom, serveDownload } from "../../../../lib/download-delivery.js";
import { keepPrivate } from "../../../../lib/no-store.js";

export const prerender = false;

const serve =
	(method: "GET" | "HEAD"): APIRoute =>
	async (context) => {
		const response = await serveDownload(
			{ handler: routeDispatcher(context), bucket: downloadsBucketFrom(env) },
			{ method, url: context.url, headers: context.request.headers },
		);
		keepPrivate({ response, cache: context.cache });
		return response;
	};

export const GET: APIRoute = serve("GET");
export const HEAD: APIRoute = serve("HEAD");
