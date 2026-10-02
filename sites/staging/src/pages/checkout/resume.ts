/**
 * GET /checkout/resume?order=<id> — "Complete payment" from the order page, on
 * any device (QA U-2). See `lib/checkout-resume.ts` for what authorises it (the
 * order id alone — the order page's own capability) and what it grants.
 *
 * A GET, and it has to be: the order page is `no-referrer`, so a form POST from
 * it sends `Origin: null` and the origin guard refuses it. The GET is safe to
 * repeat — the plugin replays the order's own checkout on its own key, so a
 * reload, a double click or a prefetch gets the same intent and creates nothing.
 * What it WRITES is the checkout stash, which is why a cross-site navigation is
 * sent to the order page instead (`isCrossSiteNavigation`).
 *
 * Then the ordinary pay step: `/checkout/pay` reads the stash and re-checks the
 * order with its unchanged guard (`lib/pay-guard.ts`).
 */
import { STOREFRONT_ORDER_RESUME_ROUTE, type OrderResumeRouteResult } from "@otta-sh/plugin";
import type { APIContext, APIRoute } from "astro";
import { routeDispatcher, seeOther, withoutReferrer } from "../../lib/cart-actions.js";
import { setCheckoutCookie } from "../../lib/checkout-cookie.js";
import { isCrossSiteNavigation, orderPathFor, resumeOutcome } from "../../lib/checkout-resume.js";
import { PRIVATE_NO_STORE } from "../../lib/no-store.js";
import { busyResponse, dispatchOttaRoute, isBusyResult } from "../../lib/otta-api.js";
import { SITE_LOCALE } from "../../lib/site-locale.js";

/** Every answer is private (it may set the stash, which holds a client secret)
 *  and sends no Referer: the next page must not learn this URL. */
export const GET: APIRoute = async (context) => {
	const response = await resume(context);
	return withoutReferrer(privateResponse(response));
};

function privateResponse(response: Response): Response {
	try {
		response.headers.set("Cache-Control", PRIVATE_NO_STORE);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		copy.headers.set("Cache-Control", PRIVATE_NO_STORE);
		return copy;
	}
}

async function resume(context: APIContext): Promise<Response> {
	const orderId = context.url.searchParams.get("order")?.trim() ?? "";
	if (orderId.length === 0) return seeOther(context, "/cart");
	const orderPath = orderPathFor(orderId);

	// Another site's link: the order page, where the buyer can press the button.
	if (isCrossSiteNavigation(context.request)) return context.redirect(orderPath, 303);

	const result = await dispatchOttaRoute<OrderResumeRouteResult>(
		routeDispatcher(context),
		STOREFRONT_ORDER_RESUME_ROUTE,
		{ orderId, locale: SITE_LOCALE },
		context.url,
	);
	if (isBusyResult(result)) return busyResponse(orderPath);

	const outcome = resumeOutcome(orderId, result);
	if (outcome.kind === "order") return context.redirect(outcome.path, 303);
	setCheckoutCookie(context.cookies, outcome.stash);
	return context.redirect("/checkout/pay", 303);
}
