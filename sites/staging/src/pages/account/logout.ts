/**
 * POST /account/logout — end the session (issue #306).
 *
 * The plugin revokes the session server-side (`storefront/account/logout`), so a
 * copied cookie stops working too; this endpoint then clears the cookie and goes
 * home. The cookie is cleared EVEN IF the revoke could not be dispatched: the
 * customer asked to be signed out of this browser, and that much is always in
 * our power.
 */
import { ACCOUNT_LOGOUT_ROUTE, type AccountLogoutResult } from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { clearSessionCookie, currentSessionToken } from "../../lib/account.js";
import { routeDispatcher } from "../../lib/cart-actions.js";
import { dispatchOttaRoute, isBusyResult } from "../../lib/otta-api.js";

export const POST: APIRoute = async (context) => {
	// CSRF: src/middleware.ts has already refused a cross-site POST (ADR-0006),
	// so a forged form cannot sign a customer out.
	const sessionToken = currentSessionToken(context.cookies);
	if (sessionToken !== undefined) {
		const result = await dispatchOttaRoute<AccountLogoutResult>(
			routeDispatcher(context),
			ACCOUNT_LOGOUT_ROUTE,
			{ sessionToken },
			context.url,
		);
		if (result === null || isBusyResult(result)) {
			console.error("[site-staging] logout: the session could not be revoked server-side");
		}
	}
	clearSessionCookie(context.cookies);
	// Home, which says "You're signed out" for this flag (QA2 A5).
	return context.redirect("/?signed-out=1", 303);
};
