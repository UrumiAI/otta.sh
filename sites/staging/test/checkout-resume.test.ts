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
import { describe, expect, test } from "vitest";
import { splitAstro, templateOf } from "./astro-source.js";
import { CHECKOUT_COOKIE_NAME, readCheckoutStash } from "../src/lib/checkout-cookie.js";
import { RESUME_PATH, resumeHref, resumeOutcome } from "../src/lib/checkout-resume.js";
import { reviewErrorToken } from "../src/lib/checkout-review.js";
import { GET as RESUME_GET } from "../src/pages/checkout/resume.js";
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
	opts: { cookies?: Record<string, string>; headers?: Record<string, string> } = {},
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
		request: new Request(full, { method: "GET", headers: opts.headers ?? {} }),
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
	test("with NO cookies at all it dispatches the order id alone, stashes the order's own intent and 303s to the pay page", async () => {
		const { context, calls, jar } = makeContext(`/checkout/resume?order=${ORDER_ID}`, RESUMED);

		const response = await RESUME_GET(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(calls).toEqual([
			{
				route: STOREFRONT_ORDER_RESUME_ROUTE,
				body: { orderId: ORDER_ID, locale: expect.any(String) },
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
