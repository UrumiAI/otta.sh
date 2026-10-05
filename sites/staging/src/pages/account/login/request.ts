/**
 * POST /account/login/request — ask the plugin to email a magic link
 * (issue #306, ADR-0004), then 303 back to the login page's GENERIC notice.
 *
 * The notice is the same whatever the plugin knows about the address: a new
 * address, a known one and a throttled one all land on `?sent=1`. The plugin
 * answers identically for all three, and this endpoint must not add a
 * difference of its own.
 *
 * The one variation is about THIS BROWSER, not the address (QA U-12): once it
 * has itself asked more than the cap's worth of links inside the window, it
 * lands on `?sent=many`, which says a new link may not have been sent. The
 * count is a cookie of timestamps (`recordLoginRequest`), decided before and
 * regardless of the plugin's answer — so it reads the same for every address
 * and cannot say which ones are throttled or have accounts. The only other outcomes are about the FORM (an
 * implausible address, refused before any dispatch) or an outage (the plugin
 * could not be reached), and neither says anything about an account.
 */
import { ACCOUNT_LOGIN_REQUEST_ROUTE, type AccountLoginRequestResult } from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { routeDispatcher, seeOther, SERVICE_UNAVAILABLE } from "../../../lib/cart-actions.js";
import { recordLoginRequest } from "../../../lib/account.js";
import { isPlausibleEmail } from "../../../lib/email.js";
import {
	busyResponse,
	dispatchOttaRoute,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../../lib/otta-api.js";

const LOGIN_PATH = "/account/login";

export const POST: APIRoute = async (context) => {
	// CSRF: a cross-site POST never gets here — src/middleware.ts refuses it
	// first (lib/origin-guard.ts, ADR-0006):
	// without it a cross-site form could make a shopper's browser mail links on
	// anyone's behalf.

	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();
	const raw = form.get("email");
	// Trim only, never lowercase — the address is the customer's own identifier.
	const email = typeof raw === "string" ? raw.trim() : "";
	if (!isPlausibleEmail(email)) return seeOther(context, LOGIN_PATH, "INVALID_EMAIL");

	const result = await dispatchOttaRoute<AccountLoginRequestResult>(
		routeDispatcher(context),
		ACCOUNT_LOGIN_REQUEST_ROUTE,
		{ email },
		context.url,
	);
	// Busy: nothing was issued, so asking again is safe — the 503 says so.
	if (isBusyResult(result)) return busyResponse(LOGIN_PATH);
	if (result === null || !result.ok) return seeOther(context, LOGIN_PATH, SERVICE_UNAVAILABLE);

	// Counted only once the request really reached the plugin: a refused form, a
	// busy store or an outage sent nothing and is not "another link".
	const sent = new URL(LOGIN_PATH, context.url);
	sent.searchParams.set("sent", recordLoginRequest(context.cookies, Date.now()));
	return context.redirect(sent.pathname + sent.search, 303);
};
