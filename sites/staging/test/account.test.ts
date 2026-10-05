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
	ACCOUNT_ME_ROUTE,
	ACCOUNT_ORDER_ROUTE,
	ACCOUNT_ORDERS_ROUTE,
	LOGIN_LINK_MAX_ACTIVE,
	LOGIN_LINK_TTL_MS,
	SESSION_COOKIE_NAME,
} from "@otta-sh/plugin";
import type { APIContext } from "astro";
import { describe, expect, test } from "vitest";
import {
	ACCOUNT_HOME_PATH,
	checkoutEmailNote,
	LOGIN_LINK_CAP,
	LOGIN_LINK_MANY_COPY,
	LOGIN_LINK_WINDOW_MS,
	LOGIN_LINK_SENT_COPY,
	LOGIN_REQUESTS_COOKIE_NAME,
	accountOrderStatus,
	orderMoney,
	orderPlacedOn,
	orderRefundedNote,
	sessionOwnsOrder,
	signedInEmail,
	verifyFailureToken,
} from "../src/lib/account.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { GET as ACCOUNT_INDEX_GET } from "../src/pages/account/index.js";
import { keepPrivate } from "../src/lib/no-store.js";
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
	opts: { origin?: string | null; session?: string; cookies?: Map<string, string> } = {},
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
	// A caller-supplied jar persists across requests — one browser, several POSTs.
	const jar = opts.cookies ?? new Map<string, string>();
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

	/* QA U-12: past the per-address cap the plugin sends nothing and answers exactly
	   as it does for a sent link (ADR-0004 — the throttle must not be an oracle), so
	   the page said "on its way" for a link that never left. The page cannot ask the
	   plugin, and must not: it counts THIS BROWSER's own requests instead, which says
	   nothing about any address or account. */
	test("past the cap, this browser's request lands on the honest 'many' notice — whatever the address", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: { ok: true } });
		const browser = new Map<string, string>();
		const ask = async (email: string): Promise<string | null> => {
			const { context } = makeContext("/account/login/request", { email }, handler, {
				cookies: browser,
			});
			return location(await LOGIN_REQUEST_POST(context));
		};
		for (let n = 0; n < LOGIN_LINK_CAP; n++) {
			expect(await ask("a@example.com")).toBe("/account/login?sent=1");
		}
		// A different address changes nothing: the count is the browser's, not the
		// address's, so the notice cannot tell anyone which addresses are throttled.
		expect(await ask("b@example.com")).toBe("/account/login?sent=many");
		expect(await ask("a@example.com")).toBe("/account/login?sent=many");
		// Every request still reaches the plugin, which alone decides what is sent.
		expect(calls).toHaveLength(LOGIN_LINK_CAP + 2);
	});

	test("the count is a short-lived, HttpOnly cookie on the sign-in path, holding only timestamps", async () => {
		const { handler } = makeHandler({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: { ok: true } });
		const { context, cookieOps } = makeContext(
			"/account/login/request",
			{ email: "a@example.com" },
			handler,
		);
		await LOGIN_REQUEST_POST(context);
		expect(cookieOps).toHaveLength(1);
		expect(cookieOps[0]).toMatchObject({
			op: "set",
			name: LOGIN_REQUESTS_COOKIE_NAME,
			options: {
				httpOnly: true,
				secure: true,
				sameSite: "lax",
				path: "/account/login",
				maxAge: 15 * 60,
			},
		});
		expect(cookieOps[0]?.value).toMatch(/^\d+$/);
		expect(cookieOps[0]?.value).not.toContain("example.com");
	});

	test("requests older than the window no longer count", async () => {
		const { handler } = makeHandler({ [ACCOUNT_LOGIN_REQUEST_ROUTE]: { ok: true } });
		const stale = String(Date.now() - 16 * 60 * 1000);
		const browser = new Map([[LOGIN_REQUESTS_COOKIE_NAME, [stale, stale, stale].join(".")]]);
		const { context } = makeContext("/account/login/request", { email: "a@example.com" }, handler, {
			cookies: browser,
		});
		expect(location(await LOGIN_REQUEST_POST(context))).toBe("/account/login?sent=1");
	});

	test("an outage or a refused form is not counted", async () => {
		const browser = new Map<string, string>();
		const { handler } = makeHandler({});
		for (let n = 0; n < LOGIN_LINK_CAP + 1; n++) {
			const { context } = makeContext(
				"/account/login/request",
				{ email: n % 2 === 0 ? "a@example.com" : "nope" },
				handler,
				{ cookies: browser },
			);
			await LOGIN_REQUEST_POST(context);
		}
		expect(browser.has(LOGIN_REQUESTS_COOKIE_NAME)).toBe(false);
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
		// Home, with the one-line "You're signed out" notice (QA2 A5).
		expect(location(response)).toBe("/?signed-out=1");
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
		expect(location(await LOGOUT_POST(context))).toBe("/?signed-out=1");
		expect(cookieOps).toEqual([
			{ op: "delete", name: SESSION_COOKIE_NAME, options: { path: "/" } },
		]);
	});

	test("with no session there is nothing to revoke, and the answer is the same", async () => {
		const { handler, calls } = makeHandler({ [ACCOUNT_LOGOUT_ROUTE]: LOGGED_OUT });
		const { context } = makeContext("/account/logout", {}, handler);
		expect(location(await LOGOUT_POST(context))).toBe("/?signed-out=1");
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

	test("the cap and window the copy names ARE the store's (no drift)", () => {
		expect(LOGIN_LINK_CAP).toBe(LOGIN_LINK_MAX_ACTIVE);
		expect(LOGIN_LINK_WINDOW_MS).toBe(LOGIN_LINK_TTL_MS);
		const minutes = `${String(LOGIN_LINK_TTL_MS / 60_000)} minutes`;
		for (const copy of [LOGIN_LINK_SENT_COPY, LOGIN_LINK_MANY_COPY]) {
			expect(copy).toContain(`at most ${String(LOGIN_LINK_MAX_ACTIVE)} links`);
			expect(copy).toContain(minutes);
		}
	});

	test("the 'many' notice is honest about the cap and, like the sent notice, about nothing else", () => {
		expect(LOGIN_LINK_MANY_COPY).toMatch(/at most 3 links/);
		expect(LOGIN_LINK_MANY_COPY).toMatch(/may not have sent a new one/);
		expect(LOGIN_LINK_MANY_COPY).not.toMatch(/^check your inbox/i);
		expect(LOGIN_LINK_MANY_COPY).not.toMatch(/account exists|if an account|no account/i);
		// The ordinary notice states the cap too: it is true for every address, and
		// it is the only honest thing to say to a shopper whose link never arrives.
		expect(LOGIN_LINK_SENT_COPY).toMatch(/at most 3 links/);
	});

	test("the sent notice never says whether the account exists", () => {
		// One constant for every address, and no hedge on existence: a new address
		// is sent a link too, and the sign-in page says so.
		expect(LOGIN_LINK_SENT_COPY).toMatch(/^A sign-in link is on its way\./);
		// The view leads the notice with "Check your inbox." — never say it twice.
		expect(LOGIN_LINK_SENT_COPY).not.toMatch(/^check your inbox/i);
		expect(LOGIN_LINK_SENT_COPY).not.toMatch(/account exists|if an account|no account/i);
	});

	test("order money is formatted from integer minor units, and garbage renders a dash", () => {
		expect(orderMoney(4000, "USD")).toBe("$40.00");
		expect(orderMoney(1500, "JPY")).toBe("¥1,500");
		expect(orderMoney(10.5, "USD")).toBe("—");
		expect(orderMoney(100, "not-a-currency")).toBe("—");
	});

	test("an order state reads as words, and an unknown one is still readable", () => {
		expect(accountOrderStatus({ state: "paid", holdExpiresAt: HELD }, NOW)).toBe("Paid");
		expect(accountOrderStatus({ state: "shipped", holdExpiresAt: HELD }, NOW)).toBe("Shipped");
		expect(accountOrderStatus({ state: "something_new", holdExpiresAt: HELD }, NOW)).toBe(
			"something new",
		);
	});
});

/* QA U-5: an unpaid, a declined and an expired order all read "Awaiting payment".
   Each now says what the order page says about it, in a list-sized phrase. */
const NOW = new Date("2026-10-02T12:00:00.000Z");
const HELD = "2026-10-02T12:10:00.000Z";
const LAPSED = "2026-10-02T11:50:00.000Z";

describe("accountOrderStatus — the list says what the order page says", () => {
	test("a pending order that can still be paid is awaiting payment (a declined card leaves it so — ADR-0022)", () => {
		expect(accountOrderStatus({ state: "pending", holdExpiresAt: HELD }, NOW)).toBe(
			"Awaiting payment",
		);
	});

	test("a pending order past its hold is NOT awaiting payment: the pay page refuses it", () => {
		expect(accountOrderStatus({ state: "pending", holdExpiresAt: LAPSED }, NOW)).toBe(
			"Payment not completed — time ran out",
		);
	});

	test("expired and failed orders say the payment did not complete, and how", () => {
		expect(accountOrderStatus({ state: "expired", holdExpiresAt: LAPSED }, NOW)).toBe(
			"Payment not completed — expired",
		);
		expect(accountOrderStatus({ state: "failed", holdExpiresAt: LAPSED }, NOW)).toBe(
			"Payment didn't go through",
		);
	});

	test("no two of the unpaid outcomes read alike", () => {
		const labels = [
			accountOrderStatus({ state: "pending", holdExpiresAt: HELD }, NOW),
			accountOrderStatus({ state: "pending", holdExpiresAt: LAPSED }, NOW),
			accountOrderStatus({ state: "expired", holdExpiresAt: LAPSED }, NOW),
			accountOrderStatus({ state: "failed", holdExpiresAt: LAPSED }, NOW),
			accountOrderStatus({ state: "cancelled", holdExpiresAt: LAPSED }, NOW),
		];
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe("orderRefundedNote — a refunded figure only where the ledger shows one", () => {
	test("recorded refunds read as their own figure beside the paid total", () => {
		expect(orderRefundedNote(500, "USD")).toBe("Refunded $5.00");
	});

	test("nothing on the ledger (or a refund made outside Otta) shows no figure", () => {
		expect(orderRefundedNote(0, "USD")).toBeNull();
	});
});

describe("orderPlacedOn — the list dates each order", () => {
	test("a calendar date in words, named in UTC like every other server-rendered time, with the instant for <time>", () => {
		expect(orderPlacedOn("2026-10-02T16:49:45.000Z")).toEqual({
			text: "Oct 2, 2026",
			iso: "2026-10-02T16:49:45.000Z",
		});
	});

	test("an unreadable date renders nothing rather than a wrong one", () => {
		expect(orderPlacedOn("not a date")).toBeNull();
		expect(orderPlacedOn("")).toBeNull();
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

	// Redeeming the link is the step that creates a new address's account, so it
	// must not fall back to members-only wording one click after the sign-in page.
	test("the heading matches the sign-in page's", () => {
		expect(templateOf(source)).toMatch(/<h1[^>]*>\s*Sign in or create an account\s*<\/h1>/);
	});
});

describe.each(viewCases("accountLogin"))("the sign-in view %s", (_label, { source }) => {
	test("posts to the request endpoint", () => {
		expect(templateOf(source)).toMatch(
			/<form[^>]*method="POST"[^>]*action="\/account\/login\/request"/,
		);
	});

	// The magic link is also the sign-up: a new address gets an account when its
	// link is redeemed. A heading that says only "Sign in" reads as members-only.
	test("the heading offers sign-up as well as sign-in", () => {
		expect(templateOf(source)).toMatch(/<h1[^>]*>\s*Sign in or create an account\s*<\/h1>/);
	});
});

describe.each(viewCases("order"))("the order view %s", (_label, { source }) => {
	// The confirmation is where a shopper next looks for their order; sign-in is
	// where it joins their order list, findable after this tab closes.
	test("the keep-this-link line links to sign-in, from the model", () => {
		expect(templateOf(source)).toMatch(
			/<p class="order-keep">[\s\S]*?<a href=\{accountSignInHref\}>[^<]+<\/a>[\s\S]*?<\/p>/,
		);
	});
});

describe("the order page", () => {
	test("hands the view the sign-in page, not a path of the theme's own", () => {
		expect(splitAstro(page("orders/[orderId].astro")).frontmatter).toMatch(
			/accountSignInHref: ACCOUNT_LOGIN_PATH\b/,
		);
	});
});

/** A cookie jar holding only the session (or nothing). */
function sessionJar(session?: string): { get(name: string): { value: string } | undefined } {
	return {
		get: (name: string) =>
			name === SESSION_COOKIE_NAME && session !== undefined ? { value: session } : undefined,
	};
}

// The pages that greet a signed-in shopper ask the plugin who the session is —
// never the cookie itself, which is only a bearer, and never a stored email.
describe("signedInEmail — who the session is", () => {
	const url = new URL("/account/login", SITE);

	test("no session cookie: signed out, and nothing is dispatched", async () => {
		const { handler, calls } = makeHandler({});
		expect(await signedInEmail(handler as never, sessionJar(), url)).toBeNull();
		expect(calls).toEqual([]);
	});

	test("a live session: the plugin's answer, asked with the cookie's bearer", async () => {
		const { handler, calls } = makeHandler({
			[ACCOUNT_ME_ROUTE]: { ok: true, email: "ada@example.com" },
		});
		expect(await signedInEmail(handler as never, sessionJar("sess-1"), url)).toBe(
			"ada@example.com",
		);
		expect(calls).toEqual([{ route: ACCOUNT_ME_ROUTE, body: { sessionToken: "sess-1" } }]);
	});

	test("a session the plugin no longer honours, or an unreachable plugin: signed out", async () => {
		const stale = makeHandler({ [ACCOUNT_ME_ROUTE]: { ok: false, redirectTo: "/account/login" } });
		expect(await signedInEmail(stale.handler as never, sessionJar("sess-old"), url)).toBeNull();
		const dead = makeHandler({});
		expect(await signedInEmail(dead.handler as never, sessionJar("sess-1"), url)).toBeNull();
	});
});

describe("sessionOwnsOrder — may the order page point at the shopper's list", () => {
	const url = new URL("/orders/ord-1", SITE);

	test("no session: no, and nothing is dispatched", async () => {
		const { handler, calls } = makeHandler({});
		expect(await sessionOwnsOrder(handler as never, sessionJar(), "ord-1", url)).toBe(false);
		expect(calls).toEqual([]);
	});

	test("the session's own order: yes — asked through the session route, never a customer id", async () => {
		const { handler, calls } = makeHandler({
			[ACCOUNT_ORDER_ROUTE]: { ok: true, order: { id: "ord-1" } },
		});
		expect(await sessionOwnsOrder(handler as never, sessionJar("sess-1"), "ord-1", url)).toBe(true);
		expect(calls).toEqual([
			{ route: ACCOUNT_ORDER_ROUTE, body: { sessionToken: "sess-1", orderId: "ord-1" } },
		]);
	});

	test("someone else's order, or a stale session: no", async () => {
		const foreign = makeHandler({ [ACCOUNT_ORDER_ROUTE]: { ok: false, error: "NOT_FOUND" } });
		expect(
			await sessionOwnsOrder(foreign.handler as never, sessionJar("sess-1"), "ord-1", url),
		).toBe(false);
		const stale = makeHandler({
			[ACCOUNT_ORDER_ROUTE]: { ok: false, redirectTo: "/account/login" },
		});
		expect(await sessionOwnsOrder(stale.handler as never, sessionJar("s"), "ord-1", url)).toBe(
			false,
		);
	});
});

describe("checkout's email note", () => {
	test("signed out, it says the order joins the account at a later sign-in", () => {
		expect(checkoutEmailNote(null)).toMatch(/sign in later/);
	});

	// Checkout carries no client JS, so the note cannot react to typing: it says up
	// front what a different email means, beside the prefilled account address.
	test("signed in, it names the account and says a different email stays out of it", () => {
		const note = checkoutEmailNote("ada@example.com");
		expect(note).toContain("ada@example.com");
		expect(note).toMatch(/different email/i);
		expect(note).toMatch(/won't appear in your account/);
	});
});

describe("GET /account", () => {
	test("is the account's home: a redirect to Your orders, not a 404", async () => {
		const response = await ACCOUNT_INDEX_GET({
			redirect: (target: string, status = 302) =>
				new Response(null, { status, headers: { location: target } }),
		} as unknown as APIContext);
		expect(response.status).toBe(303);
		expect(location(response)).toBe(ACCOUNT_HOME_PATH);
		expect(ACCOUNT_HOME_PATH).toBe("/account/orders");
	});
});

describe("signed-in surfaces — source-level guarantees", () => {
	test("the order page points an owner at Your orders, decided by the page", () => {
		expect(splitAstro(page("orders/[orderId].astro")).frontmatter).toMatch(
			/accountOrdersHref: ownsOrder \? ACCOUNT_HOME_PATH : null/,
		);
	});

	// The page reloads itself every ~4 s while a payment confirms; the ownership read
	// is one more dispatch per hop and changes nothing a polling page shows. It is
	// asked once the poll has stopped (or never ran).
	test("the order page asks about ownership only when it is not polling", () => {
		expect(splitAstro(page("orders/[orderId].astro")).frontmatter).toMatch(
			/const ownsOrder =\s*order !== null &&\s*!shouldPoll &&\s*\(await sessionOwnsOrder\(/,
		);
	});

	// A page that renders for ONE signed-in shopper must never be stored and replayed
	// to another: an account's email in a prefilled field, or "your orders" for an
	// order someone else then opens. Whenever the request carries a session, the
	// response is private and out of the route cache. Both pages are private for
	// EVERY request, set once at the top — so a signed-in render is too, and a
	// second, session-gated call would change nothing (issue #364 removed it).
	test.each(["orders/[orderId].astro", "checkout/index.astro"])(
		"%s keeps every render private, a signed-in one included — set once, unconditionally",
		(relative) => {
			const { frontmatter } = splitAstro(page(relative));
			expect(frontmatter).toMatch(/^keepPrivate\(Astro\);$/m);
			expect(frontmatter.match(/keepPrivate\(/g)).toHaveLength(1);
		},
	);

	test("the sign-in page asks who the session is, and hands over the orders path", () => {
		const { frontmatter } = splitAstro(page("account/login/index.astro"));
		expect(frontmatter).toContain("signedInEmail(");
		expect(frontmatter).toMatch(/ordersHref: ACCOUNT_HOME_PATH/);
	});

	test("checkout prefills the account's email and states the note the page chose", () => {
		const { frontmatter } = splitAstro(page("checkout/index.astro"));
		expect(frontmatter).toContain("signedInEmail(");
		expect(frontmatter).toMatch(/emailNote: checkoutEmailNote\(accountEmail\)/);
	});
});

describe.each(viewCases("order"))(
	"the order view %s, for the order's owner",
	(_label, { source }) => {
		test("the keep-this-link line links straight to Your orders, from the model", () => {
			expect(templateOf(source)).toMatch(
				/accountOrdersHref !== null \?[\s\S]*?<p class="order-keep">[\s\S]*?<a href=\{accountOrdersHref\}>your orders<\/a>[\s\S]*?<\/p>/,
			);
		});
	},
);

describe.each(viewCases("accountLogin"))("the sign-in view %s, signed in", (_label, { source }) => {
	test("says who is signed in, above the form, with Your orders and a sign-out POST", () => {
		const template = templateOf(source);
		const banner = template.indexOf("You're signed in as");
		expect(banner).toBeGreaterThan(-1);
		expect(banner).toBeLessThan(template.indexOf('action="/account/login/request"'));
		expect(template).toMatch(/<a href=\{signedIn\.ordersHref\}>View your orders<\/a>/);
		expect(template).toMatch(/<form[^>]*method="POST"[^>]*action="\/account\/logout"/);
	});
});

describe.each(viewCases("checkout"))("the checkout view %s, signed in", (_label, { source }) => {
	test("the email field carries the page's value and note", () => {
		const template = templateOf(source);
		expect(template).toMatch(/name="email"[\s\S]*?value=\{emailValue\}/);
		expect(template).toMatch(/id="email-note">\s*\{emailNote\}\s*<\/span>/);
	});
});

describe("the sign-in page's caching", () => {
	// Always private (it can greet a signed-in shopper), set ONCE through keepPrivate
	// — never a second, hand-written Cache-Control beside it.
	test("calls keepPrivate unconditionally and sets no Cache-Control of its own", () => {
		const { frontmatter } = splitAstro(page("account/login/index.astro"));
		expect(frontmatter).toMatch(/^keepPrivate\(Astro\);$/m);
		expect(frontmatter.match(/keepPrivate\(/g)).toHaveLength(1);
		expect(frontmatter).not.toContain('headers.set("Cache-Control"');
	});
});

describe("keepPrivate — a per-shopper response is never stored", () => {
	test("sets private, no-store and opts out of the route cache", () => {
		const headers = new Headers();
		const cacheCalls: unknown[] = [];
		keepPrivate({ response: { headers }, cache: { set: (options) => cacheCalls.push(options) } });
		expect(headers.get("Cache-Control")).toBe("private, no-store");
		expect(cacheCalls).toEqual([false]);
	});
});
