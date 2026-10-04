/**
 * Every form endpoint answers a body that is not a form with a 400 — never the
 * host's 500 (QA U-6).
 *
 * `request.formData()` THROWS on a JSON body, a body with no Content-Type, a
 * truncated multipart body or no body at all. Each endpoint awaited it bare, so
 * a curl, a bot or a broken client turned into an unhandled exception: a 500 in
 * the logs and in monitoring for what is the caller's mistake. The shared
 * `readFormBody` answers `null` for all of those and the endpoint returns 400
 * BEFORE dispatching anything.
 *
 * The cross-origin guard still runs FIRST (asserted elsewhere per endpoint):
 * these requests are same-origin, so they reach the body.
 */
import type { APIContext, APIRoute } from "astro";
import { describe, expect, test, vi } from "vitest";

const { getEmDashEntry } = vi.hoisted(() => ({ getEmDashEntry: vi.fn() }));
vi.mock("emdash", () => ({ getEmDashEntry }));
// Under vitest the publishable key (a build-time define) is undefined; stub it
// so /checkout/place reaches the body read instead of the no-key redirect.
vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
}));

import { POST as LOGIN_REQUEST_POST } from "../src/pages/account/login/request.js";
import { POST as LOGOUT_POST } from "../src/pages/account/logout.js";
import { POST as VERIFY_CONFIRM_POST } from "../src/pages/account/verify/confirm.js";
import { POST as CART_ADD_POST } from "../src/pages/cart/add.js";
import { POST as CART_REMOVE_POST } from "../src/pages/cart/remove.js";
import { POST as CART_UPDATE_POST } from "../src/pages/cart/update.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";

const SITE = "http://localhost:4321";

interface BadBody {
	label: string;
	headers: Record<string, string>;
	body?: string;
}

const BAD_BODIES: BadBody[] = [
	{
		label: "a JSON body",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sku: "OTTA-TEE" }),
	},
	{ label: "no body at all", headers: {} },
	{ label: "a urlencoded body with NO Content-Type", headers: {}, body: "sku=OTTA-TEE&qty=1" },
	{
		label: "a truncated multipart body",
		headers: { "content-type": "multipart/form-data; boundary=XyZ" },
		body: '--XyZ\r\nContent-Disposition: form-data; name="sku"\r\n\r\nOTTA',
	},
];

const ENDPOINTS: Array<[string, APIRoute]> = [
	["/cart/add", CART_ADD_POST],
	["/cart/update", CART_UPDATE_POST],
	["/cart/remove", CART_REMOVE_POST],
	["/checkout/place", PLACE_POST],
	["/account/login/request", LOGIN_REQUEST_POST],
	["/account/verify/confirm", VERIFY_CONFIRM_POST],
];

function makeContext(
	pathname: string,
	bad: BadBody,
): { context: APIContext; dispatched: string[] } {
	const url = new URL(pathname, SITE);
	const dispatched: string[] = [];
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, ...bad.headers },
		...(bad.body !== undefined ? { body: bad.body } : {}),
	});
	const context = {
		request,
		url,
		cookies: {
			// A live cart and session, so no endpoint can bail out early for lack
			// of one — the body is the only thing wrong with these requests.
			get: (name: string) =>
				name === "otta_cart" || name === "otta_session" ? { value: "cookie-1" } : undefined,
			set: () => {},
			delete: () => {},
		},
		locals: {
			emdash: {
				handlePublicPluginApiRoute: async (_id: string, _method: string, route: string) => {
					dispatched.push(route);
					return { success: true, data: { ok: true } };
				},
			},
		},
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	return { context, dispatched };
}

describe("a body that is not a form is a 400 — never a 500, never a dispatch", () => {
	for (const [pathname, post] of ENDPOINTS) {
		test.each(BAD_BODIES)(`POST ${pathname} with $label`, async (bad) => {
			const { context, dispatched } = makeContext(pathname, bad);

			const response = await post(context);

			expect(response.status).toBe(400);
			expect(dispatched).toEqual([]);
		});
	}

	test.each(BAD_BODIES)(
		"POST /account/logout with $label still signs out — it never reads the body",
		async (bad) => {
			const { context } = makeContext("/account/logout", bad);

			const response = await LOGOUT_POST(context);

			expect(response.status).toBe(303);
			expect(response.headers.get("location")).toBe("/");
		},
	);
});
