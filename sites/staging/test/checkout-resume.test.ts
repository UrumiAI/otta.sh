/**
 * QA U-2 — "Complete payment" on the order page, on ANY device.
 *
 * It used to link to `/checkout`, which rebuilds the payment step from the CART
 * cookie: on another device (or once that cookie or the stash was gone) it was a
 * dead end, and where it did work the locked review showed an EMPTY, EDITABLE
 * email the replayed order silently ignored. Back from the pay page landed on the
 * same stale form, under whatever `?error=` its URL still carried.
 *
 * What these cases hold:
 *  - the order page's resume is a PAGE-OWNED path (`/checkout/resume?order=…`),
 *    handed to the theme as `resumeHref`, never a hard-coded `/checkout`;
 *  - the resume endpoint needs NO cookie at all: the order id is the whole
 *    credential, the same one the order page itself reads with — and it stashes
 *    the order's OWN intent and goes to the pay page, whose guard is unchanged;
 *  - the email the order was placed with is SHOWN, read-only, as a hint, and is
 *    never an input on a resumed or locked checkout;
 *  - a locked review shows no stale place-time error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIContext } from "astro";
import { STOREFRONT_ORDER_RESUME_ROUTE } from "@otta-sh/plugin";
import { describe, expect, test, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

import { splitAstro, templateOf } from "./astro-source.js";
import { CHECKOUT_COOKIE_NAME, readCheckoutStash } from "../src/lib/checkout-cookie.js";
import {
	RESUME_EMAIL_PATH,
	RESUME_PATH,
	ensureResumeClientKey,
	RESUME_CLIENT_COOKIE_NAME,
	resumeEmailPath,
	resumeHref,
	resumeOutcome,
} from "../src/lib/checkout-resume.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { reviewErrorToken } from "../src/lib/checkout-review.js";
import { GET as RESUME_GET, POST as RESUME_POST } from "../src/pages/checkout/resume.js";
import { onRequest } from "../src/middleware.js";
import { serve } from "./helpers/serve.js";
import { viewSources } from "./theme-views.js";

const SITE = "http://localhost:4321";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

const ORDER_ID = "6f1c2a64-0d1e-4c55-9d7e-2f1a3b4c5d6e";
const HINT = "b•••@e•••.com";

const RESUMED = {
	ok: true,
	orderId: ORDER_ID,
	clientAction: { kind: "stripe_client_secret", clientSecret: "pi_9_secret_xyz" },
	total: { amount: 4000, currency: "USD", formatted: "$40.00" },
	buyerRefHint: HINT,
};

interface Call {
	route: string;
	body: Record<string, unknown>;
}

function makeContext(
	url: string,
	reply: unknown,
	opts: {
		cookies?: Record<string, string>;
		headers?: Record<string, string>;
		form?: Record<string, string>;
	} = {},
): {
	context: APIContext;
	calls: Call[];
	jar: Map<string, string>;
} {
	const calls: Call[] = [];
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		calls.push({ route, body: (await request.json()) as Record<string, unknown> });
		return reply === "BUSY"
			? { success: true, data: { ok: false, error: "BUSY", retryable: true } }
			: { success: true, data: reply };
	};
	const full = new URL(url, SITE);
	const jar = new Map<string, string>(Object.entries(opts.cookies ?? {}));
	const context = {
		request:
			opts.form === undefined
				? new Request(full, { method: "GET", headers: opts.headers ?? {} })
				: new Request(full, {
						method: "POST",
						headers: {
							"content-type": "application/x-www-form-urlencoded",
							origin: SITE,
							...opts.headers,
						},
						body: new URLSearchParams(opts.form).toString(),
					}),
		url: full,
		cookies: {
			get: (name: string) => {
				const value = jar.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => {
				jar.set(name, value);
			},
			delete: (name: string) => {
				jar.delete(name);
			},
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	return { context, calls, jar };
}

describe("resumeHref — the page-owned path", () => {
	test("names the order, encoded, under /checkout/resume", () => {
		expect(RESUME_PATH).toBe("/checkout/resume");
		expect(resumeHref(ORDER_ID)).toBe(`/checkout/resume?order=${ORDER_ID}`);
		expect(resumeHref("a/b?c")).toBe("/checkout/resume?order=a%2Fb%3Fc");
	});
});

describe("resumeOutcome", () => {
	test("a resumed intent becomes the stash the pay page mounts — the order's own secret, total and email hint", () => {
		expect(resumeOutcome(ORDER_ID, RESUMED as never)).toEqual({
			kind: "pay",
			stash: {
				orderId: ORDER_ID,
				clientSecret: "pi_9_secret_xyz",
				total: { currency: "USD", formatted: "$40.00" },
				emailHint: HINT,
			},
		});
	});

	test("PROOF_REQUIRED asks for the email; EMAIL_MISMATCH and THROTTLED say why", () => {
		expect(resumeOutcome(ORDER_ID, { ok: false, reason: "PROOF_REQUIRED" } as never)).toEqual({
			kind: "order",
			path: `/checkout/resume/email?order=${ORDER_ID}`,
		});
		for (const reason of ["EMAIL_MISMATCH", "THROTTLED"]) {
			expect(resumeOutcome(ORDER_ID, { ok: false, reason } as never)).toEqual({
				kind: "order",
				path: `/checkout/resume/email?order=${ORDER_ID}&error=${reason}`,
			});
		}
	});

	test.each([["ORDER_NOT_PAYABLE"], ["ORDER_NOT_FOUND"], ["RESERVATION_LOST"]])(
		"%s goes to the order page, which states the order's truth",
		(reason) => {
			expect(resumeOutcome(ORDER_ID, { ok: false, reason } as never)).toEqual({
				kind: "order",
				path: `/orders/${ORDER_ID}`,
			});
		},
	);

	test("a failed intent goes to the order page WITH the reason, so it can say so", () => {
		expect(
			resumeOutcome(ORDER_ID, { ok: false, reason: "PAYMENT_INTENT_FAILED" } as never),
		).toEqual({ kind: "order", path: `/orders/${ORDER_ID}?error=PAYMENT_INTENT_FAILED` });
	});

	test("an unanswerable dispatch is SERVICE_UNAVAILABLE on the order page, never a pay form", () => {
		expect(resumeOutcome(ORDER_ID, null)).toEqual({
			kind: "order",
			path: `/orders/${ORDER_ID}?error=SERVICE_UNAVAILABLE`,
		});
	});

	test("a reply with no client secret never becomes a stash", () => {
		expect(
			resumeOutcome(ORDER_ID, {
				...RESUMED,
				clientAction: { kind: "stripe_client_secret", clientSecret: "" },
			} as never).kind,
		).toBe("order");
	});
});

describe("GET /checkout/resume — any device", () => {
	test("the cart and session cookies ride along as the proof; a resumed intent is stashed and the pay page follows", async () => {
		const { context, calls, jar } = makeContext(`/checkout/resume?order=${ORDER_ID}`, RESUMED, {
			cookies: { otta_cart: "cart-1", otta_session: "sess-1" },
		});

		const response = await RESUME_GET(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(calls).toEqual([
			{
				route: STOREFRONT_ORDER_RESUME_ROUTE,
				body: {
					orderId: ORDER_ID,
					cartId: "cart-1",
					sessionToken: "sess-1",
					locale: expect.any(String),
				},
			},
		]);
		const stash = readCheckoutStash({
			get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
		});
		expect(stash).toEqual({
			orderId: ORDER_ID,
			clientSecret: "pi_9_secret_xyz",
			total: { currency: "USD", formatted: "$40.00" },
			emailHint: HINT,
		});
	});

	test("the response is private and no-store, and sends no Referer onward", async () => {
		const { context } = makeContext(`/checkout/resume?order=${ORDER_ID}`, RESUMED);
		const response = await RESUME_GET(context);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});

	test("an order that cannot be paid goes to its order page and stashes NOTHING", async () => {
		const { context, jar } = makeContext(`/checkout/resume?order=${ORDER_ID}`, {
			ok: false,
			reason: "ORDER_NOT_PAYABLE",
		});
		const response = await RESUME_GET(context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`/orders/${ORDER_ID}`);
		expect(jar.has(CHECKOUT_COOKIE_NAME)).toBe(false);
	});

	test("a cross-site navigation never reaches the plugin: it lands on the order page, which offers the button", async () => {
		const { context, calls, jar } = makeContext(`/checkout/resume?order=${ORDER_ID}`, RESUMED, {
			headers: { "sec-fetch-site": "cross-site" },
		});
		const response = await RESUME_GET(context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`/orders/${ORDER_ID}`);
		expect(calls).toHaveLength(0);
		expect(jar.has(CHECKOUT_COOKIE_NAME)).toBe(false);
	});

	test("ANY device — no cookies — is asked for the order's email on our own page, and stashes nothing", async () => {
		const { context, calls, jar } = makeContext(`/checkout/resume?order=${ORDER_ID}`, {
			ok: false,
			reason: "PROOF_REQUIRED",
		});
		const response = await RESUME_GET(context);
		expect(calls[0]!.body).toEqual({ orderId: ORDER_ID, locale: expect.any(String) });
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(resumeEmailPath(ORDER_ID));
		expect(jar.has(CHECKOUT_COOKIE_NAME)).toBe(false);
	});

	test("a same-origin click and a typed URL both resume", async () => {
		for (const site of ["same-origin", "none"]) {
			const { context, calls } = makeContext(`/checkout/resume?order=${ORDER_ID}`, RESUMED, {
				headers: { "sec-fetch-site": site },
			});
			const response = await RESUME_GET(context);
			expect(response.headers.get("location"), site).toBe("/checkout/pay");
			expect(calls, site).toHaveLength(1);
		}
	});

	test("BUSY is a 503 with Retry-After that links back to the order", async () => {
		const { context, jar } = makeContext(`/checkout/resume?order=${ORDER_ID}`, "BUSY");
		const response = await RESUME_GET(context);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).not.toBeNull();
		expect(await response.text()).toContain(`/orders/${ORDER_ID}`);
		expect(jar.has(CHECKOUT_COOKIE_NAME)).toBe(false);
	});

	test("no order named is no resume: back to the cart, nothing dispatched", async () => {
		const { context, calls } = makeContext("/checkout/resume", RESUMED);
		const response = await RESUME_GET(context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/cart");
		expect(calls).toHaveLength(0);
	});
});

describe("POST /checkout/resume — the order's email as the proof", () => {
	const RESUME_POST_URL = "/checkout/resume";

	test("this browser's resume key rides along as `clientKey`, the per-device guess window's key (issue #364)", async () => {
		const { context, calls } = makeContext(RESUME_POST_URL, RESUMED, {
			form: { order: ORDER_ID, email: "buyer@example.com" },
			cookies: { [RESUME_CLIENT_COOKIE_NAME]: "3f0c9a1e-6b1d-4f52-9a0e-1c2d3e4f5a6b" },
		});
		await RESUME_POST(context);
		expect(calls[0]!.body["clientKey"]).toBe("3f0c9a1e-6b1d-4f52-9a0e-1c2d3e4f5a6b");
		// A value this site did not write is not forwarded.
		const forged = makeContext(RESUME_POST_URL, RESUMED, {
			form: { order: ORDER_ID, email: "buyer@example.com" },
			cookies: { [RESUME_CLIENT_COOKIE_NAME]: "not a key" },
		});
		await RESUME_POST(forged.context);
		expect(forged.calls[0]!.body).not.toHaveProperty("clientKey");
	});

	test("the email page's resume key is minted once per browser and then kept", () => {
		const jar = new Map<string, string>();
		const options: unknown[] = [];
		const cookies = {
			get: (name: string) => {
				const value = jar.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string, opts: unknown) => {
				jar.set(name, value);
				options.push(opts);
			},
		};
		const first = ensureResumeClientKey(cookies);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(ensureResumeClientKey(cookies)).toBe(first);
		expect(options).toEqual([
			expect.objectContaining({
				httpOnly: true,
				secure: true,
				sameSite: "strict",
				path: "/checkout",
			}),
		]);
	});

	test("the email (and the order) go to the plugin; a match stashes and goes to pay", async () => {
		const { context, calls, jar } = makeContext(RESUME_POST_URL, RESUMED, {
			form: { order: ORDER_ID, email: " Buyer@Example.com " },
		});
		const response = await RESUME_POST(context);
		expect(calls[0]!.body).toEqual({
			orderId: ORDER_ID,
			email: " Buyer@Example.com ",
			locale: expect.any(String),
		});
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(jar.has(CHECKOUT_COOKIE_NAME)).toBe(true);
	});

	test.each([["EMAIL_MISMATCH"], ["THROTTLED"]])(
		"%s goes back to the email page with ONE generic token — the email is never in the URL",
		async (reason) => {
			const { context, jar } = makeContext(
				RESUME_POST_URL,
				{ ok: false, reason },
				{
					form: { order: ORDER_ID, email: "guess@example.com" },
				},
			);
			const response = await RESUME_POST(context);
			expect(response.status).toBe(303);
			const location = response.headers.get("location")!;
			expect(location).toBe(resumeEmailPath(ORDER_ID, reason));
			expect(location).not.toContain("guess");
			expect(jar.has(CHECKOUT_COOKIE_NAME)).toBe(false);
		},
	);

	test("a blank email is the same generic mismatch, without a dispatch", async () => {
		const { context, calls } = makeContext(RESUME_POST_URL, RESUMED, {
			form: { order: ORDER_ID, email: "  " },
		});
		const response = await RESUME_POST(context);
		expect(calls).toHaveLength(0);
		expect(response.headers.get("location")).toBe(resumeEmailPath(ORDER_ID, "EMAIL_MISMATCH"));
	});

	test("a cross-site POST is refused before anything is read or dispatched", async () => {
		const { context, calls } = makeContext(RESUME_POST_URL, RESUMED, {
			form: { order: ORDER_ID, email: "buyer@example.com" },
			headers: { origin: "https://evil.example" },
		});
		const response = await serve(onRequest, context, RESUME_POST);
		expect(response.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	test("the copy: one sentence for a wrong email, one for too many tries", () => {
		expect(cartErrorMessage("EMAIL_MISMATCH")).toBe("That email doesn't match this order.");
		expect(cartErrorMessage("THROTTLED")).toBe(
			"Too many tries for this order. Try again in up to 15 minutes, or start a new checkout.",
		);
	});
});

describe("the email page (/checkout/resume/email)", () => {
	const source = read("pages/checkout/resume/email.astro");
	const front = splitAstro(source).frontmatter;
	const body = templateOf(source);

	test("is private and no-store, and its path is the lib's", () => {
		expect(RESUME_EMAIL_PATH).toBe("/checkout/resume/email");
		expect(front).toMatch(/keepPrivate\(Astro\);/);
	});

	test("posts the order and the email to the resume endpoint — from our own page", () => {
		expect(body).toMatch(/<form method="POST" action="\/checkout\/resume"/);
		expect(body).toMatch(/<input type="hidden" name="order" value=\{orderId\}/);
		const email = /<input[^>]*name="email"[^>]*>/.exec(body)?.[0] ?? "";
		expect(email).toContain('type="email"');
		expect(email).toContain("required");
		expect(email).toContain("maxlength={BUYER_REF_MAX}");
	});

	test("shows only the resume page's own errors, as copy, and never echoes an email", () => {
		expect(front).toMatch(/RESUME_EMAIL_ERRORS\.has\(error\)/);
		expect(body).not.toMatch(/value=\{email/);
	});
});

describe("the order page hands the theme a resume PATH, and the theme uses it", () => {
	const page = splitAstro(read("pages/orders/[orderId].astro")).frontmatter;

	test("the page builds resumeHref from the order id, only when it may resume", () => {
		expect(page).toMatch(
			/resumeHref:\s*canResume && order !== null \? resumeHref\(order\.id\) : null/,
		);
	});

	test.each(viewSources("order").map((v) => [v.file, v] as const))(
		"%s links Complete payment to the model's resumeHref, never to /checkout",
		(_file, view) => {
			const body = templateOf(view.source);
			expect(body).toMatch(/href=\{resumeHref\}/);
			expect(body).not.toMatch(/href="\/checkout"[^>]*>\s*Complete payment/);
		},
	);
});

describe("a LOCKED review offers no email input and no stale error", () => {
	test.each(viewSources("checkout").map((v) => [v.file, v] as const))(
		"%s: the locked review's way on is a link to the resume path, outside any place form",
		(_file, view) => {
			const body = templateOf(view.source);
			expect(body).toMatch(/href=\{locked\.resumeHref\}/);
			// The place form (with its email input) is only for an UNLOCKED cart.
			expect(body).toMatch(
				/locked === null && !ended && \(\s*<form method="POST" action="\/checkout\/place"/,
			);
		},
	);

	test("place-time errors are not shown over a cart that is already an order", () => {
		for (const token of [
			"INVALID_EMAIL",
			"INVALID_SHIPPING_ADDRESS",
			"CHECKOUT_STALE",
			"COUPON_NOT_FOUND",
		]) {
			expect(reviewErrorToken(token, true), token).toBeNull();
			expect(reviewErrorToken(token, false), token).toBe(token);
		}
		expect(reviewErrorToken(null, true)).toBeNull();
		expect(reviewErrorToken(null, false)).toBeNull();
	});

	test("the page decides it: errorMessage reads reviewErrorToken with the lock", () => {
		const page = splitAstro(read("pages/checkout/index.astro")).frontmatter;
		expect(page).toMatch(/reviewErrorToken\(error, locked !== null\)/);
		expect(page).toMatch(/resumeHref: resumeHref\(locked\.id\)/);
	});
});

describe("the pay page shows the order's email, read-only", () => {
	test("the page passes the stash's hint into the model", () => {
		const page = splitAstro(read("pages/checkout/pay.astro")).frontmatter;
		expect(page).toMatch(/emailHint: stash\.emailHint \?\? null/);
	});

	test.each(viewSources("pay").map((v) => [v.file, v] as const))(
		"%s prints the hint as text, never as an input",
		(_file, view) => {
			const body = templateOf(view.source);
			expect(body).toMatch(/\{emailHint\}/);
			expect(body).not.toMatch(/<input[^>]*name="email"/);
		},
	);
});

describe("the pay guard is unchanged", () => {
	const page = splitAstro(read("pages/checkout/pay.astro")).frontmatter;

	test("no stash is still a redirect, and the order read still goes through payPageRedirect", () => {
		expect(page).toMatch(/if \(stash === null\) return Astro\.redirect\("\/checkout", 303\);/);
		expect(page).toMatch(/payPageRedirect\(orderPath, orderRead, new Date\(\)\)/);
		expect(page).toMatch(/if \(refuseTo !== null\) return Astro\.redirect\(refuseTo, 303\);/);
	});
});
