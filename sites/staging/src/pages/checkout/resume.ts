/**
 * GET /checkout/resume?order=<id> — "Complete payment" from the order page, on
 * any device (QA U-2) — and POST /checkout/resume, the email page's form. See
 * `lib/checkout-resume.ts` for what authorises it: the order id plus a second
 * factor (this browser's cart or owning session, sent from its cookies; else the
 * order's email, asked for on `/checkout/resume/email`).
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
import { currentSessionToken } from "../../lib/account.js";
import {
	currentCartId,
	routeDispatcher,
	seeOther,
	withoutReferrer,
} from "../../lib/cart-actions.js";
import { setCheckoutCookie } from "../../lib/checkout-cookie.js";
import {
	isCrossSiteNavigation,
	orderPathFor,
	readResumeClientKey,
	resumeEmailPath,
	resumeOutcome,
} from "../../lib/checkout-resume.js";
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
import { PRIVATE_NO_STORE } from "../../lib/no-store.js";
import {
	busyResponse,
	dispatchOttaRoute,
	formString,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../lib/otta-api.js";
import { SITE_LOCALE } from "../../lib/site-locale.js";

/** Every answer is private (it may set the stash, which holds a client secret)
 *  and sends no Referer: the next page must not learn this URL. */
export const GET: APIRoute = async (context) =>
	withoutReferrer(privateResponse(await resumeFromLink(context)));

/** The email page's form: the order's email as the second factor. */
export const POST: APIRoute = async (context) =>
	withoutReferrer(privateResponse(await resumeWithEmail(context)));

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

/** The proof this browser already holds: its cart cookie and its session. The
 *  PLUGIN decides whether either is this order's. */
function cookieProof(context: APIContext): { cartId?: string; sessionToken?: string } {
	const cartId = currentCartId(context);
	const sessionToken = currentSessionToken(context.cookies);
	return {
		...(cartId !== undefined ? { cartId } : {}),
		...(sessionToken !== undefined ? { sessionToken } : {}),
	};
}

async function resumeFromLink(context: APIContext): Promise<Response> {
	const orderId = context.url.searchParams.get("order")?.trim() ?? "";
	if (orderId.length === 0) return seeOther(context, "/cart");

	// Another site's link: the order page, where the buyer can press the button.
	if (isCrossSiteNavigation(context.request)) return context.redirect(orderPathFor(orderId), 303);

	return dispatchResume(context, orderId, cookieProof(context));
}

async function resumeWithEmail(context: APIContext): Promise<Response> {
	// CSRF FIRST: a cross-site form must not spend this order's guesses.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;
	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();
	const orderId = formString(form.get("order")) ?? "";
	if (orderId.length === 0) return seeOther(context, "/cart");
	const email = formString(form.get("email"));
	if (email === undefined) {
		return context.redirect(resumeEmailPath(orderId, "EMAIL_MISMATCH"), 303);
	}
	const raw = form.get("email");
	// This browser's resume key: the per-device guess window's key (issue #364).
	const clientKey = readResumeClientKey(context.cookies);
	return dispatchResume(context, orderId, {
		...cookieProof(context),
		email: typeof raw === "string" ? raw : email,
		...(clientKey !== undefined ? { clientKey } : {}),
	});
}

async function dispatchResume(
	context: APIContext,
	orderId: string,
	proof: { cartId?: string; sessionToken?: string; email?: string; clientKey?: string },
): Promise<Response> {
	const result = await dispatchOttaRoute<OrderResumeRouteResult>(
		routeDispatcher(context),
		STOREFRONT_ORDER_RESUME_ROUTE,
		{ orderId, ...proof, locale: SITE_LOCALE },
		context.url,
	);
	if (isBusyResult(result)) return busyResponse(orderPathFor(orderId));

	const outcome = resumeOutcome(orderId, result);
	if (outcome.kind === "order") return context.redirect(outcome.path, 303);
	setCheckoutCookie(context.cookies, outcome.stash);
	return context.redirect("/checkout/pay", 303);
}
