/**
 * POST /account/login/request — ask the plugin to email a magic link
 * (issue #306, ADR-0004), then 303 back to the login page's GENERIC notice.
 *
 * The notice is the same whatever the plugin knows about the address: a new
 * address, a known one and a throttled one all land on `?sent=1`. The plugin
 * answers identically for all three, and this endpoint must not add a
 * difference of its own. The only other outcomes are about the FORM (an
 * implausible address, refused before any dispatch) or an outage (the plugin
 * could not be reached), and neither says anything about an account.
 */
import { ACCOUNT_LOGIN_REQUEST_ROUTE, type AccountLoginRequestResult } from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { routeDispatcher, seeOther, SERVICE_UNAVAILABLE } from "../../../lib/cart-actions.js";
import { isPlausibleEmail } from "../../../lib/email.js";
import { rejectCrossOrigin } from "../../../lib/origin-guard.js";
import {
	busyResponse,
	dispatchOttaRoute,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../../lib/otta-api.js";

const LOGIN_PATH = "/account/login";

export const POST: APIRoute = async (context) => {
	// CSRF FIRST — emdash disables Astro's checkOrigin and guards only
	// /_emdash/api/* (ADR-0006); without this a cross-site form could make a
	// shopper's browser mail links on anyone's behalf.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

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

	const sent = new URL(LOGIN_PATH, context.url);
	sent.searchParams.set("sent", "1");
	return context.redirect(sent.pathname + sent.search, 303);
};
