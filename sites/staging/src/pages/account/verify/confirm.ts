/**
 * POST /account/verify/confirm — redeem the magic link (issue #306, ADR-0004).
 *
 * The emailed link lands on GET /account/verify, which only renders a button;
 * the token is redeemed HERE, on the POST that button makes. A mail scanner that
 * pre-fetches every link in a message would otherwise burn the single-use token
 * before the customer ever clicked it.
 *
 * On success the plugin returns a session-cookie DESCRIPTOR (it cannot set
 * cookies itself — ADR-0003) and this endpoint applies it verbatim: HttpOnly,
 * Secure, SameSite=Lax, path `/`. Verifying also claims the customer's earlier
 * guest orders (ADR-0004), which is why the landing page is the order list.
 */
import {
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	ACCOUNT_LOGOUT_ROUTE,
	type AccountLoginVerifyResult,
	type AccountLogoutResult,
} from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import {
	ACCOUNT_HOME_PATH,
	applySessionCookie,
	currentSessionToken,
	verifyFailureToken,
} from "../../../lib/account.js";
import { routeDispatcher, seeOther, SERVICE_UNAVAILABLE } from "../../../lib/cart-actions.js";
import { rejectCrossOrigin } from "../../../lib/origin-guard.js";
import {
	busyResponse,
	dispatchOttaRoute,
	formString,
	isBusyResult,
	notAFormResponse,
	readFormBody,
} from "../../../lib/otta-api.js";

const LOGIN_PATH = "/account/login";

/** Only a same-site absolute path survives as a landing page. */
function sameSitePath(target: string): string {
	return target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/\\")
		? target
		: ACCOUNT_HOME_PATH;
}

export const POST: APIRoute = async (context) => {
	// CSRF FIRST. Here it also stops LOGIN CSRF: a cross-site form carrying the
	// attacker's own link would otherwise sign the victim into the attacker's
	// account.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();
	const challengeId = formString(form.get("challenge"));
	const token = formString(form.get("token"));
	if (challengeId === undefined || token === undefined) {
		return seeOther(context, LOGIN_PATH, "LOGIN_LINK_INVALID");
	}

	const result = await dispatchOttaRoute<AccountLoginVerifyResult>(
		routeDispatcher(context),
		ACCOUNT_LOGIN_VERIFY_ROUTE,
		{ challengeId, token },
		context.url,
	);
	if (result === null) return seeOther(context, LOGIN_PATH, SERVICE_UNAVAILABLE);
	// Busy: the challenge was NOT consumed (a busy step writes nothing), so the
	// emailed link still works — the 503 invites another click. The way back is
	// the login page, never this URL: it must not carry the one-time token.
	if (isBusyResult(result)) return busyResponse(LOGIN_PATH);
	if (!result.ok) {
		return seeOther(
			context,
			LOGIN_PATH,
			"reason" in result ? verifyFailureToken(result.reason) : SERVICE_UNAVAILABLE,
		);
	}

	// The browser may already hold a session, perhaps another account's. The new
	// cookie overwrites it here, so revoke the old one server-side too, rather
	// than leave a live bearer token nobody will ever sign out of. This happens
	// only AFTER a successful verify: a failed link must not sign anyone out.
	const previous = currentSessionToken(context.cookies);
	if (previous !== undefined && previous !== result.cookie.value) {
		await dispatchOttaRoute<AccountLogoutResult>(
			routeDispatcher(context),
			ACCOUNT_LOGOUT_ROUTE,
			{ sessionToken: previous },
			context.url,
		);
	}
	applySessionCookie(context.cookies, result.cookie);
	return context.redirect(sameSitePath(result.redirectTo), 303);
};
