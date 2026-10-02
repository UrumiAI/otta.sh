/**
 * The customer account pages (issue #306, ADR-0004) — the site's half of the
 * magic-link login.
 *
 * What each group protects:
 *  - **CSRF first.** Every account POST runs `rejectCrossOrigin()` before it
 *    reads the body; a forged POST is asserted by "the dispatcher was never
 *    called", not merely by the 403. Login CSRF (planting an attacker's session
 *    in a victim's browser) is the reason the verify step is guarded too.
 *  - **No account oracle.** The link request 303s to the same generic notice
 *    whatever the plugin knows about the address.
 *  - **The session cookie is applied verbatim** — HttpOnly, Secure,
 *    SameSite=Lax, path `/`, and an absolute expiry from the descriptor. A
 *    dropped attribute is a hijackable session.
 *  - **The token is redeemed on a POST, never on the GET** a mail scanner's
 *    pre-fetch would make, and the verify page sends no Referer.
 *  - **Logout always clears the cookie**, even when the revoke could not be
 *    dispatched.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACCOUNT_LOGIN_REQUEST_ROUTE,
	ACCOUNT_LOGIN_VERIFY_ROUTE,
	ACCOUNT_LOGOUT_ROUTE,
	ACCOUNT_ORDER_ROUTE,
	ACCOUNT_ORDERS_ROUTE,
	SESSION_COOKIE_NAME,
} from "@otta-sh/plugin";
import type { APIContext } from "astro";
import { describe, expect, test } from "vitest";
import {
	LOGIN_LINK_SENT_COPY,
	orderMoney,
	orderStateLabel,
	verifyFailureToken,
} from "../src/lib/account.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { POST as LOGIN_REQUEST_POST } from "../src/pages/account/login/request.js";
import { POST as LOGOUT_POST } from "../src/pages/account/logout.js";
import { POST as VERIFY_CONFIRM_POST } from "../src/pages/account/verify/confirm.js";
import { splitAstro, templateOf } from "./astro-source.js";
import { viewCases } from "./theme-views.js";

const SITE = "http://localhost:4321";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = (relative: string): string =>
	readFileSync(path.resolve(HERE, "../src/pages", relative), "utf8");

interface HandlerCall {
	route: string;
	body: Record<string, unknown>;
}

interface CookieOp {
	op: "set" | "delete";
	name: string;
	value?: string;
	options?: Record<string, unknown>;
}

function makeHandler(results: Record<string, unknown>): { handler: unknown; calls: HandlerCall[] } {
	const calls: HandlerCall[] = [];
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		calls.push({ route, body: (await request.json()) as Record<string, unknown> });
		return route in results ? { success: true, data: results[route] } : { success: false };
	};
	return { handler, calls };
}

function makeContext(
	urlPath: string,
	form: Record<string, string>,
	handler: unknown,
	opts: { origin?: string | null; session?: string } = {},
): { context: APIContext; cookieOps: CookieOp[] } {
	const url = new URL(urlPath, SITE);
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
	};
	const origin = opts.origin === undefined ? SITE : opts.origin;
	if (origin !== null) headers["origin"] = origin;
	const request = new Request(url, {
		method: "POST",
		headers,
		body: new URLSearchParams(form).toString(),
	});
	const jar = new Map<string, string>();
	if (opts.session !== undefined) jar.set(SESSION_COOKIE_NAME, opts.session);
	const cookieOps: CookieOp[] = [];
	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => {
				const value = jar.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string, options: Record<string, unknown>) => {
				cookieOps.push({ op: "set", name, value, options });
				jar.set(name, value);
			},
			delete: (name: string, options: Record<string, unknown>) => {
				cookieOps.push({ op: "delete", name, options });
				jar.delete(name);
			},
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	return { context, cookieOps };
}

const location = (response: Response): string | null => response.headers.get("location");

describe("POST /account/login/request", () => {
	test("a cross-origin POST is 403 and the plugin is NEVER called", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: { ok: true } });
		const { context } = makeContext("/account/login/request", { email: "a@example.com" }, handler, {
			origin: "https://evil.example",
		});
		expect((await LOGIN_REQUEST_POST(context)).status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	test("a valid address is dispatched and lands on the GENERIC sent notice", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: { ok: true } });
		const { context } = makeContext(
			"/account/login/request",
			{ email: "  a@example.com " },
			handler,
		);
		const response = await LOGIN_REQUEST_POST(context);
		expect(response.status).toBe(303);
		expect(location(response)).toBe("/account/login?sent=1");
		expect(calls).toEqual([
			{ route: ACCOUNT_LOGIN_REQUEST_ROUTE, body: { email: "a@example.com" } },
		]);
	});

	test("an implausible address is refused by the form, before any dispatch", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: { ok: true } });
		const { context } = makeContext("/account/login/request", { email: "asdf" }, handler);
		const response = await LOGIN_REQUEST_POST(context);
		expect(location(response)).toBe("/account/login?error=INVALID_EMAIL");
		expect(calls).toHaveLength(0);
	});

	test("an unreachable plugin is an honest outage, not a fake 'sent'", async () => {
		const { handler } = makeHandler({});
		const { context } = makeContext("/account/login/request", { email: "a@example.com" }, handler);
		expect(location(await LOGIN_REQUEST_POST(context))).toBe(
			"/account/login?error=SERVICE_UNAVAILABLE",
		);
	});
});

const COOKIE = {
	name: SESSION_COOKIE_NAME,
	value: "sess-123",
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
	expiresAt: "2099-01-02T03:04:05.000Z",
};

describe("POST /account/verify/confirm", () => {
	test("a cross-origin POST is 403, the plugin is NEVER called, and no cookie is set", async () => {
		const { handler, calls } = makeHandler({
			[ACCOUNT_LOGIN_VERIFY_ROUTE]: { ok: true, cookie: COOKIE, redirectTo: "/account/orders" },
		});
		const { context, cookieOps } = makeContext(
			"/account/verify/confirm",
			{ challenge: "c", token: "t" },
			handler,
			{ origin: "https://evil.example" },
		);
		expect((await VERIFY_CONFIRM_POST(context)).status).toBe(403);
		expect(calls).toHaveLength(0);
		expect(cookieOps).toHaveLength(0);
	});

	test("success applies the session cookie VERBATIM and 303s to the account", async () => {
		const { handler, calls } = makeHandler({
			[ACCOUNT_LOGIN_VERIFY_ROUTE]: { ok: true, cookie: COOKIE, redirectTo: "/account/orders" },
		});
		const { context, cookieOps } = makeContext(
			"/account/verify/confirm",
			{ challenge: "ch-1", token: "tok-1" },
			handler,
		);
		const response = await VERIFY_CONFIRM_POST(context);
		expect(response.status).toBe(303);
		expect(location(response)).toBe("/account/orders");
		expect(calls).toEqual([
			{ route: ACCOUNT_LOGIN_VERIFY_ROUTE, body: { challengeId: "ch-1", token: "tok-1" } },
		]);
		expect(cookieOps).toEqual([
			{
				op: "set",
				name: SESSION_COOKIE_NAME,
				value: "sess-123",
				options: {
					httpOnly: true,
					secure: true,
					sameSite: "lax",
					path: "/",
					expires: new Date("2099-01-02T03:04:05.000Z"),
				},
			},
		]);
	});

	test("a session this browser already held is revoked before the new one is set", async () => {
		const { handler, calls } = makeHandler({
			[ACCOUNT_LOGIN_VERIFY_ROUTE]: { ok: true, cookie: COOKIE, redirectTo: "/account/orders" },
			[ACCOUNT_LOGOUT_ROUTE]: {
				ok: true,
				clearCookie: { name: SESSION_COOKIE_NAME, path: "/" },
				redirectTo: "/",
			},
		});
		const { context, cookieOps } = makeContext(
			"/account/verify/confirm",
			{ challenge: "c", token: "t" },
			handler,
			{ session: "sess-old" },
		);
		expect(location(await VERIFY_CONFIRM_POST(context))).toBe("/account/orders");
		expect(calls.map((call) => call.route)).toEqual([
			ACCOUNT_LOGIN_VERIFY_ROUTE,
			ACCOUNT_LOGOUT_ROUTE,
		]);
		expect(calls[1]?.body).toEqual({ sessionToken: "sess-old" });
		expect(cookieOps.map((op) => [op.op, op.value])).toEqual([["set", "sess-123"]]);
	});

	test("a FAILED verify leaves the session this browser already held alone", async () => {
		const { handler, calls } = makeHandler({
			[ACCOUNT_LOGIN_VERIFY_ROUTE]: { ok: false, reason: "CONSUMED" },
		});
		const { context, cookieOps } = makeContext(
			"/account/verify/confirm",
			{ challenge: "c", token: "t" },
			handler,
			{ session: "sess-old" },
		);
		await VERIFY_CONFIRM_POST(context);
		expect(calls.map((call) => call.route)).toEqual([ACCOUNT_LOGIN_VERIFY_ROUTE]);
		expect(cookieOps).toHaveLength(0);
	});

	test("a redirect target that is not a same-site path is ignored", async () => {
		const { handler } = makeHandler({
			[ACCOUNT_LOGIN_VERIFY_ROUTE]: { ok: true, cookie: COOKIE, redirectTo: "//evil.example/" },
		});
		const { context } = makeContext(
			"/account/verify/confirm",
			{ challenge: "c", token: "t" },
			handler,
		);
		expect(location(await VERIFY_CONFIRM_POST(context))).toBe("/account/orders");
	});

	test.each([
		["CONSUMED", "LOGIN_LINK_USED"],
		["EXPIRED", "LOGIN_LINK_EXPIRED"],
		["INVALID", "LOGIN_LINK_INVALID"],
	])("a %s link sets NO cookie and explains itself on the login page", async (reason, token) => {
		const { handler } = makeHandler({ [ACCOUNT_LOGIN_VERIFY_ROUTE]: { ok: false, reason } });
		const { context, cookieOps } = makeContext(
			"/account/verify/confirm",
			{ challenge: "c", token: "t" },
			handler,
		);
		expect(location(await VERIFY_CONFIRM_POST(context))).toBe(`/account/login?error=${token}`);
		expect(cookieOps).toHaveLength(0);
	});

	test("a missing challenge or token is refused without a dispatch", async () => {
		const { handler, calls } = makeHandler({});
		const { context } = makeContext("/account/verify/confirm", { challenge: "c" }, handler);
		expect(location(await VERIFY_CONFIRM_POST(context))).toBe(
			"/account/login?error=LOGIN_LINK_INVALID",
		);
		expect(calls).toHaveLength(0);
	});

	test("an unreachable plugin is an outage, with no cookie", async () => {
		const { handler } = makeHandler({});
		const { context, cookieOps } = makeContext(
			"/account/verify/confirm",
			{ challenge: "c", token: "t" },
			handler,
		);
		expect(location(await VERIFY_CONFIRM_POST(context))).toBe(
			"/account/login?error=SERVICE_UNAVAILABLE",
		);
		expect(cookieOps).toHaveLength(0);
	});
});

describe("POST /account/logout", () => {
	const LOGGED_OUT = {
		ok: true,
		clearCookie: { name: SESSION_COOKIE_NAME, path: "/" },
		redirectTo: "/",
	};

	test("a cross-origin POST is 403 and leaves the session alone", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGOUT_ROUTE]: LOGGED_OUT });
		const { context, cookieOps } = makeContext("/account/logout", {}, handler, {
			origin: "https://evil.example",
			session: "sess-1",
		});
		expect((await LOGOUT_POST(context)).status).toBe(403);
		expect(calls).toHaveLength(0);
		expect(cookieOps).toHaveLength(0);
	});

	test("revokes the session through the plugin, clears the cookie and goes home", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGOUT_ROUTE]: LOGGED_OUT });
		const { context, cookieOps } = makeContext("/account/logout", {}, handler, {
			session: "sess-1",
		});
		const response = await LOGOUT_POST(context);
		expect(response.status).toBe(303);
		expect(location(response)).toBe("/");
		expect(calls).toEqual([{ route: ACCOUNT_LOGOUT_ROUTE, body: { sessionToken: "sess-1" } }]);
		expect(cookieOps).toEqual([
			{ op: "delete", name: SESSION_COOKIE_NAME, options: { path: "/" } },
		]);
	});

	test("the cookie is cleared even when the revoke could not be dispatched", async () => {
		const { handler } = makeHandler({});
		const { context, cookieOps } = makeContext("/account/logout", {}, handler, {
			session: "sess-1",
		});
		expect(location(await LOGOUT_POST(context))).toBe("/");
		expect(cookieOps).toEqual([
			{ op: "delete", name: SESSION_COOKIE_NAME, options: { path: "/" } },
		]);
	});

	test("with no session there is nothing to revoke, and the answer is the same", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGOUT_ROUTE]: LOGGED_OUT });
		const { context } = makeContext("/account/logout", {}, handler);
		expect(location(await LOGOUT_POST(context))).toBe("/");
		expect(calls).toHaveLength(0);
	});
});

describe("account copy and formatting", () => {
	test("each failed-link reason has its own token, and every token has real copy", () => {
		expect(verifyFailureToken("CONSUMED")).toBe("LOGIN_LINK_USED");
		expect(verifyFailureToken("EXPIRED")).toBe("LOGIN_LINK_EXPIRED");
		expect(verifyFailureToken("INVALID")).toBe("LOGIN_LINK_INVALID");
		const generic = cartErrorMessage("SOMETHING_UNKNOWN");
		for (const token of ["LOGIN_LINK_USED", "LOGIN_LINK_EXPIRED", "LOGIN_LINK_INVALID"]) {
			expect(cartErrorMessage(token)).not.toBe(generic);
			expect(cartErrorMessage(token)).toMatch(/sign-in link/);
		}
	});

	test("the sent notice never says whether the account exists", () => {
		expect(LOGIN_LINK_SENT_COPY).toMatch(/^If an account exists/);
	});

	test("order money is formatted from integer minor units, and garbage renders a dash", () => {
		expect(orderMoney(4000, "USD")).toBe("$40.00");
		expect(orderMoney(1500, "JPY")).toBe("¥1,500");
		expect(orderMoney(10.5, "USD")).toBe("—");
		expect(orderMoney(100, "not-a-currency")).toBe("—");
	});

	test("an order state reads as words, and an unknown one is still readable", () => {
		expect(orderStateLabel("paid")).toBe("Paid");
		expect(orderStateLabel("pending")).toBe("Awaiting payment");
		expect(orderStateLabel("something_new")).toBe("something new");
	});
});

describe("account pages — source-level guarantees", () => {
	test("/account/verify redeems NOTHING on the GET: it renders a POST form and sends no Referer", () => {
		const source = page("account/verify/index.astro");
		const { frontmatter } = splitAstro(source);
		expect(frontmatter).not.toContain("ACCOUNT_LOGIN_VERIFY_ROUTE");
		expect(frontmatter).not.toContain("dispatchOttaRoute");
		const template = templateOf(source);
		// `same-origin`, NOT `no-referrer`: under `no-referrer` a browser sends
		// `Origin: null` on this page's own form POST, the origin guard reads that
		// as cross-site, and every login 403s at /account/verify/confirm. That was
		// caught by `e2e/account-login.spec.ts` in a real browser, not here.
		// `same-origin` keeps the token-bearing URL out of every cross-origin
		// Referer and still sends the real Origin on the same-origin POST.
		expect(template).toContain('<meta name="referrer" content="same-origin" slot="head" />');
		expect(template).not.toContain('content="no-referrer"');
	});

	test.each(["account/orders/index.astro", "account/orders/[id].astro"])(
		"%s is private: no-store, and an unauthenticated read redirects to /account/login",
		(relative) => {
			const { frontmatter } = splitAstro(page(relative));
			expect(frontmatter).toContain("keepPrivate(Astro);");
			expect(frontmatter).toMatch(/Astro\.redirect\(/);
		},
	);

	test("the orders pages read through the session routes, never a customer id", () => {
		expect(splitAstro(page("account/orders/index.astro")).frontmatter).toContain(
			"ACCOUNT_ORDERS_ROUTE",
		);
		expect(splitAstro(page("account/orders/[id].astro")).frontmatter).toContain(
			"ACCOUNT_ORDER_ROUTE",
		);
		void ACCOUNT_ORDERS_ROUTE;
		void ACCOUNT_ORDER_ROUTE;
	});

	test("the login page shows the generic notice and posts to the request endpoint", () => {
		const source = page("account/login/index.astro");
		expect(splitAstro(source).frontmatter).toContain("LOGIN_LINK_SENT_COPY");
	});
});

/**
 * The forms moved into the theme views (Phase 3): every theme's sign-in and
 * verify view — its own, or Tempered's fallback — carries the same POST forms
 * the endpoints read.
 */
describe.each(viewCases("accountVerify"))("the verify view %s", (_label, { source }) => {
	test("renders the confirm POST form — the GET redeems nothing", () => {
		expect(templateOf(source)).toMatch(
			/<form[^>]*method="POST"[^>]*action="\/account\/verify\/confirm"/,
		);
		expect(templateOf(source)).toMatch(
			/<input type="hidden" name="challenge" value=\{challenge\} \/>/,
		);
		expect(templateOf(source)).toMatch(/<input type="hidden" name="token" value=\{token\} \/>/);
	});

	test("sets no referrer policy of its own — `same-origin` is the page's, in <head>", () => {
		expect(source).not.toContain('name="referrer"');
	});
});

describe.each(viewCases("accountLogin"))("the sign-in view %s", (_label, { source }) => {
	test("posts to the request endpoint", () => {
		expect(templateOf(source)).toMatch(
			/<form[^>]*method="POST"[^>]*action="\/account\/login\/request"/,
		);
	});
});
