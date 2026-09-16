/**
 * The ADMIN composition root (work order 02, INC-B10b-i) — the console's twin of
 * `make-commerce-client.ts`, built to the same shape on purpose so the two
 * cut-overs read alike and are deleted alike.
 *
 * Every admin console route obtains its clients from here rather than
 * constructing them, which is what makes the tier a ONE-LINE change instead of a
 * diff spread across six route files with six chances to miss one.
 *
 * WHAT IS ROUTED THROUGH HERE TODAY: products, orders, rules and — since
 * INC-B10c-ii — reporting + settings. That is the WHOLE admin surface: no
 * console route constructs a commerce client of its own any more, which is the
 * property that makes the tier one line instead of a diff across six files.
 *
 * NO ADMIN AUTH IN THE IN-PROCESS BRANCH, deliberately (ADR-0014 D3). The
 * console routes are already gated by EmDash's own admin auth and CSRF; the
 * `X-Internal-Token` / `X-Service-Token` pair authenticates a caller TO THE
 * SERVICE, and in-process there is no service to authenticate to. The tokens are
 * therefore read only on the http branch, and the in-process client takes no
 * token parameter at all — there is nothing for it to check them against, and a
 * check it could not fail would be theatre.
 *
 * ⚠ THE MODE BRANCH BELOW IS TRANSITIONAL AND IS DELETED AT INC-D3b, together
 * with `__OTTA_COMMERCE_MODE__`, `resolveCommerceMode`, and the admin HTTP
 * clients. It buys exactly one thing: the ability to run
 * `adminOrdersProductsClientContract` against BOTH implementations and prove them
 * behaviourally identical before the HTTP one is removed. **It is not permanent
 * architecture and nothing may be designed around it.**
 */

import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { type CommerceMode, resolveCommerceMode } from "../commerce/commerce-mode.js";
import type { PluginContext } from "../types.js";
import { AdminOrdersClient, type AdminOrdersSurface } from "./admin-orders-client.js";
import { AdminProductsClient, type AdminProductsSurface } from "./admin-products-client.js";
import { AdminRulesClient, type AdminRulesSurface } from "./admin-rules-client.js";
import { InProcessAdminOrdersClient } from "./in-process-admin-orders-client.js";
import { InProcessAdminProductsClient } from "./in-process-admin-products-client.js";
import { InProcessAdminRulesClient } from "./in-process-admin-rules-client.js";
import { InProcessReportingSettingsClient } from "./in-process-reporting-settings-client.js";
import { ReportingSettingsClient, type ReportingSettingsSurface } from "./reporting-client.js";
import { type AdminTokens, readAdminTokens } from "./scaffold/tokens.js";

/**
 * The admin surfaces a console route may ask for.
 *
 * EVERY MEMBER IS NON-OPTIONAL, because every one of them now has both tiers.
 * There is no longer a surface a route can ask for and not get, and the day a new
 * one is added it belongs here on BOTH branches or on neither — a stub on one
 * branch would answer "no revenue" where the honest answer is "not wired yet".
 */
export interface AdminClients {
	products: AdminProductsSurface;
	orders: AdminOrdersSurface;
	rules: AdminRulesSurface;
	/** Reports (revenue, orders-by-status, top products, low stock) AND the
	 *  operational settings tier — one surface because one client serves both on
	 *  either tier. */
	reporting: ReportingSettingsSurface;
}

/**
 * Pure in the mode (unit-testable without a bundler in the loop, the same seam
 * `makeCommerceClientFor` uses).
 *
 * Async because the http branch needs the admin + write-gate tokens from
 * write-only kv. The in-process branch reads NO token and the signature stays
 * `Promise`-shaped so the call sites do not change again when the branch goes.
 *
 * A CALLER THAT ALREADY HOLDS THE TOKENS PASSES THEM. Without the parameter a
 * route that had already read them would read write-only kv a second time — two
 * `readAdminTokens`, four `ctx.kv.get`s, per render — for one request's worth of
 * tokens. The parameter is optional so a route with nothing to share stays a
 * one-argument call, and it goes when the http branch does.
 *
 * The in-process client constructs every commerce adapter over `ctx.storage`, so
 * a context with no document store fails HERE, at construction, naming what is
 * missing — never several frames later inside a console render.
 */
export async function makeAdminClientsFor(
	ctx: PluginContext,
	mode: CommerceMode,
	tokens?: AdminTokens,
): Promise<AdminClients> {
	if (mode === "in-process") {
		return {
			products: new InProcessAdminProductsClient(ctx),
			orders: new InProcessAdminOrdersClient(ctx),
			rules: new InProcessAdminRulesClient(ctx),
			reporting: new InProcessReportingSettingsClient(ctx),
		};
	}

	const resolved = tokens ?? (await readAdminTokens(ctx));
	return {
		products: new AdminProductsClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			// "undefined ⇒ attach no header", the rule that keeps the wire
			// byte-identical to a deployment with the secret unset.
			...(resolved.adminToken !== undefined ? { adminToken: resolved.adminToken } : {}),
			...(resolved.serviceToken !== undefined ? { serviceToken: resolved.serviceToken } : {}),
		}),
		orders: new AdminOrdersClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(resolved.adminToken !== undefined ? { adminToken: resolved.adminToken } : {}),
			...(resolved.serviceToken !== undefined ? { serviceToken: resolved.serviceToken } : {}),
		}),
		rules: new AdminRulesClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(resolved.adminToken !== undefined ? { adminToken: resolved.adminToken } : {}),
			...(resolved.serviceToken !== undefined ? { serviceToken: resolved.serviceToken } : {}),
		}),
		reporting: new ReportingSettingsClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(resolved.adminToken !== undefined ? { adminToken: resolved.adminToken } : {}),
			...(resolved.serviceToken !== undefined ? { serviceToken: resolved.serviceToken } : {}),
		}),
	};
}

/** One set per invocation, matching the request-scoped lifecycle the console
 *  routes already had: a token can be re-provisioned between requests, and a
 *  client is cheap. `tokens` is this request's already-read pair, when the
 *  caller has one. */
export function makeAdminClients(ctx: PluginContext, tokens?: AdminTokens): Promise<AdminClients> {
	return makeAdminClientsFor(ctx, resolveCommerceMode(), tokens);
}
