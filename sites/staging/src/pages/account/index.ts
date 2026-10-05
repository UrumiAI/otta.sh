/**
 * GET /account — the account has no page of its own; its home is the order list.
 *
 * The header's "Account" link already points at /account/orders, but /account is
 * the address a shopper types or trims a URL back to, and it was a 404. It
 * redirects rather than rendering anything, so there is still exactly one page
 * per thing: signed out, /account/orders sends the shopper on to sign-in itself.
 * `/account/` reaches this route too (the site does not enforce trailing slashes).
 */
import type { APIRoute } from "astro";
import { ACCOUNT_HOME_PATH } from "../../lib/account.js";

export const GET: APIRoute = (context) => context.redirect(ACCOUNT_HOME_PATH, 303);
