/**
 * C6/C7 (storefront-checkout plan §3) — the site's checkout endpoints and the
 * `GET /checkout` entry guard, driven through the `cart-add.test.ts`
 * mock-dispatcher pattern.
 *
 * What each group is really protecting:
 *  - **6a** `rejectCrossOrigin()` is the FIRST statement, so a forged
 *    cross-site POST cannot create an order (emdash force-disables Astro's
 *    `security.checkOrigin` and its replacement layer covers only
 *    `/_emdash/api/*` — ADR-0006). Asserted as "the dispatcher was never
 *    called", not merely "the status was 403".
 *  - **6b** the `buyerRef` guard nothing upstream provides: the service accepts
 *    `"asdf"` happily, and the resulting order can never be claimed (ADR-0004)
 *    nor emailed (ADR-0005), and is immutable.
 *  - **6d** the cookie's exact attribute set, and the `path=/` justification:
 *    a `path=/checkout` cookie is not sent to — and so cannot be cleared by —
 *    `/orders/<id>`, which is where the spent client secret must die.
 *  - **6e** `alreadyPlaced` is a redirect, not an error: the buyer's order may
 *    already be PAID.
 *  - **The `GET /checkout` entry guard** — the MORE COMMON empty-cart path (a
 *    buyer landing on /checkout with no cart), distinct from the place-time
 *    race in 6f. §1.7: "303 to /cart — never render an empty checkout with a
 *    payable-looking button."
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";
import { STOREFRONT_CHECKOUT_PLACE_ROUTE, type CheckoutSummaryRouteResult } from "@urumi/plugin";
import { checkoutEntryRedirect } from "../src/lib/checkout-redirect.js";
import {
	CHECKOUT_COOKIE_MAX_AGE_SECONDS,
	CHECKOUT_COOKIE_NAME,
	clearCheckoutCookie,
	readCheckoutStash,
	setCheckoutCookie,
} from "../src/lib/checkout-cookie.js";
import { POST as NEW_CART_POST } from "../src/pages/checkout/new-cart.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";

/**
 * The publishable key is a BUILD-TIME constant (a Vite define), so under vitest
 * — which has no define — it is always `undefined`. Stub it so the endpoint's
 * normal path is reachable, and flip it back for the one case that is ABOUT its
 * absence. The getter is deliberate: it is re-read per access, so a test can
 * change the value without re-importing the endpoint. (`vi.mock` is hoisted
 * above the imports above by vitest.)
 */
const stripeKey = vi.hoisted(() => ({ value: "pk_test_fake" as string | undefined }));
vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	get STRIPE_PUBLISHABLE_KEY() {
		return stripeKey.value;
	},
}));

afterEach(() => {
	stripeKey.value = "pk_test_fake";
});

const SITE = "http://localhost:4321";
const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const PLACED = {
	ok: true,
	orderId: "order-1",
	state: "pending",
	alreadyPlaced: false,
	clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_abc" },
};

function makeHandler(placeResult: unknown = PLACED): {
	handler: unknown;
	calls: HandlerCall[];
} {
	const calls: HandlerCall[] = [];
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		calls.push({ route, body: (await request.json()) as Record<string, unknown> });
		if (route === STOREFRONT_CHECKOUT_PLACE_ROUTE) return { success: true, data: placeResult };
		return { success: false };
	};
	return { handler, calls };
}

function makeContext(
	form: Record<string, string>,
	handler: unknown,
	opts: { origin?: string | null; cartCookie?: string | undefined; url?: string } = {},
): { context: APIContext; cookieOps: CookieOp[] } {
	const url = new URL(opts.url ?? "/checkout/place", SITE);
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

	const cookieStore = new Map<string, string>();
	const cartCookie = "cartCookie" in opts ? opts.cartCookie : "cart-existing";
	if (cartCookie !== undefined) cookieStore.set("urumi_cart", cartCookie);
	const cookieOps: CookieOp[] = [];

	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => {
				const value = cookieStore.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string, options: Record<string, unknown>) => {
				cookieOps.push({ op: "set", name, value, options });
				cookieStore.set(name, value);
			},
			delete: (name: string, options: Record<string, unknown>) => {
				cookieOps.push({ op: "delete", name, options });
				cookieStore.delete(name);
			},
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;

	return { context, cookieOps };
}

const VALID_FORM = {
	email: "buyer@example.com",
	idempotencyKey: "checkout:cart-existing",
};

describe("6a — CSRF: rejectCrossOrigin is the FIRST statement", () => {
	test("a cross-origin POST /checkout/place is 403 and the plugin dispatcher is NEVER called", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext(VALID_FORM, handler, { origin: "https://evil.example" });

		const response = await PLACE_POST(context);

		expect(response.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	test("a cross-origin POST /checkout/new-cart is 403 and clears NOTHING", async () => {
		const { handler, calls } = makeHandler();
		const { context, cookieOps } = makeContext({}, handler, {
			origin: "https://evil.example",
			url: "/checkout/new-cart",
		});

		const response = await NEW_CART_POST(context);

		expect(response.status).toBe(403);
		expect(calls).toHaveLength(0);
		expect(cookieOps).toHaveLength(0);
	});

	test("an ABSENT Origin is allowed (curl / server-to-server carries no ambient cookie)", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext(VALID_FORM, handler, { origin: null });

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		expect(calls).toHaveLength(1);
	});
});

describe("6a — /checkout/new-cart clears BOTH cookies", () => {
	test("the same-origin POST deletes urumi_cart AND urumi_checkout, then 303s to /products", async () => {
		const { handler } = makeHandler();
		const { context, cookieOps } = makeContext({}, handler, { url: "/checkout/new-cart" });

		const response = await NEW_CART_POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/products");
		// BOTH — the narrower "clears the cart cookie" reading strands a spent
		// client secret in the browser for the rest of the hold TTL.
		const deleted = cookieOps.filter((op) => op.op === "delete").map((op) => op.name);
		expect(deleted).toContain("urumi_cart");
		expect(deleted).toContain(CHECKOUT_COOKIE_NAME);
	});
});

describe("6b — email validation happens on the SITE, before any dispatch", () => {
	test.each([
		[""],
		["   "],
		["asdf"],
		["jo@"],
		["a@b"],
		["a b@c.com"],
		["a@b."],
		["a@.com"],
		[`${"a".repeat(315)}@b.com`],
	])(
		"a malformed email (%p) redirects with ?error=INVALID_EMAIL and NEVER dispatches",
		async (email) => {
			const { handler, calls } = makeHandler();
			const { context } = makeContext({ ...VALID_FORM, email }, handler);

			const response = await PLACE_POST(context);

			expect(response.status).toBe(303);
			const location = response.headers.get("location")!;
			expect(location).toContain("/checkout");
			expect(location).toContain("error=INVALID_EMAIL");
			expect(calls).toHaveLength(0);
		},
	);

	test.each([["a@b.co"], ["A.B+tag@Example.co.uk"], ["  padded@example.com  "]])(
		"a valid email (%p) dispatches with buyerRef TRIMMED but otherwise VERBATIM — never lowercased",
		async (email) => {
			const { handler, calls } = makeHandler();
			const { context } = makeContext({ ...VALID_FORM, email }, handler);

			await PLACE_POST(context);

			expect(calls).toHaveLength(1);
			expect(calls[0]!.body["buyerRef"]).toBe(email.trim());
		},
	);

	test("the redirect on a bad email carries NO personal data in its query string", async () => {
		const { handler } = makeHandler();
		const { context } = makeContext(
			{
				...VALID_FORM,
				email: "not-an-email",
				name: "A Buyer",
				line1: "1 Private Road",
				city: "Townsville",
				postalCode: "12345",
				country: "Testland",
			},
			handler,
		);

		const location = (await PLACE_POST(context)).headers.get("location")!;

		// Deliberate deviation from the plan's "other form values preserved":
		// echoing a home address through a redirect puts it in browser history,
		// the Referer of every subresource and Cloudflare's access logs — the
		// very exposure ADR-0012 §6 argues against for the client secret.
		expect(location).not.toContain("Private");
		expect(location).not.toContain("not-an-email");
		expect(location).not.toContain("Townsville");
	});
});

describe("no publishable key ⇒ NO ORDER (§1.7)", () => {
	test("an unconfigured store redirects with STRIPE_NOT_CONFIGURED and creates nothing", async () => {
		stripeKey.value = undefined;
		const { handler, calls } = makeHandler();
		const { context, cookieOps } = makeContext(VALID_FORM, handler);

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("error=STRIPE_NOT_CONFIGURED");
		// The server-side half of the review page's hidden button: an order would
		// hold stock for 15 minutes against a payment that cannot happen.
		expect(calls).toHaveLength(0);
		expect(cookieOps).toHaveLength(0);
	});
});

describe("6b — the idempotency key comes from the FORM, never invented", () => {
	test("a missing idempotencyKey is a 400 and never dispatches", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext({ email: "a@b.co" }, handler);

		const response = await PLACE_POST(context);

		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	test("the form's key is forwarded VERBATIM", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext(
			{ ...VALID_FORM, idempotencyKey: "checkout:cart-existing" },
			handler,
		);

		await PLACE_POST(context);

		expect(calls[0]!.body["idempotencyKey"]).toBe("checkout:cart-existing");
	});
});

describe("6c — no cart cookie", () => {
	test("POST /checkout/place with no cart cookie 303s to /cart without dispatching", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext(VALID_FORM, handler, { cartCookie: undefined });

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/cart");
		expect(calls).toHaveLength(0);
	});
});

describe("6d — the urumi_checkout stash and its deletion", () => {
	test("a successful place sets urumi_checkout with the EXACT attribute set and 303s to /checkout/pay", async () => {
		const { handler } = makeHandler();
		const { context, cookieOps } = makeContext(VALID_FORM, handler);

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout/pay");

		const set = cookieOps.find((op) => op.op === "set" && op.name === CHECKOUT_COOKIE_NAME);
		expect(set).toBeDefined();
		expect(set!.options).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			// path=/ (not /checkout) so /orders/<id> can DELETE it — a
			// path=/checkout cookie is never sent to the confirmation page.
			path: "/",
			maxAge: CHECKOUT_COOKIE_MAX_AGE_SECONDS,
		});
		expect(CHECKOUT_COOKIE_MAX_AGE_SECONDS).toBe(900);
	});

	test("the stash round-trips the orderId and client secret", () => {
		const ops: CookieOp[] = [];
		setCheckoutCookie(
			{
				set: (name, value, options) => {
					ops.push({ op: "set", name, value, options: { ...options } });
				},
			},
			{ orderId: "order-1", clientSecret: "pi_1_secret_abc" },
		);
		const raw = ops[0]!.value!;
		expect(readCheckoutStash({ get: () => ({ value: raw }) })).toEqual({
			orderId: "order-1",
			clientSecret: "pi_1_secret_abc",
		});
	});

	test("a malformed / absent stash reads as null rather than throwing", () => {
		expect(readCheckoutStash({ get: () => undefined })).toBeNull();
		expect(readCheckoutStash({ get: () => ({ value: "not json" }) })).toBeNull();
		expect(readCheckoutStash({ get: () => ({ value: '{"orderId":"o"}' }) })).toBeNull();
	});

	test("clearCheckoutCookie deletes the SAME name at the SAME path the setter used", () => {
		const ops: CookieOp[] = [];
		clearCheckoutCookie({
			delete: (name, options) => {
				ops.push({ op: "delete", name, options: { ...options } });
			},
		});
		expect(ops).toEqual([{ op: "delete", name: CHECKOUT_COOKIE_NAME, options: { path: "/" } }]);
	});

	test("the confirmation page actually CALLS the deletion (the path=/ choice is otherwise unjustified)", () => {
		const source = readFileSync(path.resolve(HERE, "../src/pages/orders/[orderId].astro"), "utf8");
		expect(source).toContain("clearCheckoutCookie");
	});
});

describe("6e — alreadyPlaced is a redirect, not an error", () => {
	test("a replay whose order left pending 303s straight to /orders/<id> with no error token", async () => {
		const { handler } = makeHandler({
			ok: true,
			orderId: "order-9",
			state: "paid",
			alreadyPlaced: true,
			clientAction: { kind: "none" },
		});
		const { context, cookieOps } = makeContext(VALID_FORM, handler);

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/orders/order-9");
		expect(response.headers.get("location")).not.toContain("error=");
		// Nothing to pay: no client secret is stashed.
		expect(cookieOps.some((op) => op.op === "set" && op.name === CHECKOUT_COOKIE_NAME)).toBe(false);
	});
});

describe("6f — every place-time failure becomes ?error=<TOKEN> on /checkout", () => {
	test.each([
		["RESERVATION_LOST"],
		["CART_CHECKED_OUT"],
		["CART_EMPTY"],
		["CART_NOT_FOUND"],
		["PRODUCT_NOT_PRICED"],
		["CURRENCY_MISMATCH"],
		["PAYMENT_INTENT_FAILED"],
		["INVALID_SHIPPING_ADDRESS"],
	])("%s", async (reason) => {
		const { handler } = makeHandler({ ok: false, reason });
		const { context } = makeContext(VALID_FORM, handler);

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		const location = response.headers.get("location")!;
		expect(location.startsWith("/checkout")).toBe(true);
		expect(location).toContain(`error=${reason}`);
	});

	test("a dead dispatcher (service down) becomes SERVICE_UNAVAILABLE, never a crash", async () => {
		const { context } = makeContext(VALID_FORM, undefined);
		const response = await PLACE_POST(context);
		expect(response.headers.get("location")).toContain("error=SERVICE_UNAVAILABLE");
	});

	test("a RENDER_FAILED route error becomes its own token", async () => {
		const { handler } = makeHandler({ ok: false, error: "RENDER_FAILED" });
		const { context } = makeContext(VALID_FORM, handler);
		const response = await PLACE_POST(context);
		expect(response.headers.get("location")).toContain("error=RENDER_FAILED");
	});
});

describe("the optional ship-to (ADR-0009 slice c)", () => {
	const ADDRESS = {
		name: "A Buyer",
		line1: "1 Test St",
		city: "Testville",
		postalCode: "12345",
		country: "Testland",
	};

	test("a fully-filled address is forwarded to the plugin route", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext({ ...VALID_FORM, ...ADDRESS }, handler);

		await PLACE_POST(context);

		expect(calls[0]!.body["shippingAddress"]).toEqual(ADDRESS);
	});

	test("an entirely EMPTY address block is omitted, not sent as blanks (capture stays optional this slice)", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext(
			{ ...VALID_FORM, name: "", line1: "", city: "", postalCode: "", country: "" },
			handler,
		);

		await PLACE_POST(context);

		expect(calls[0]!.body).not.toHaveProperty("shippingAddress");
	});

	test("a PARTIALLY-filled address is a validation reject, not a silently truncated snapshot", async () => {
		const { handler, calls } = makeHandler();
		const { context } = makeContext(
			{ ...VALID_FORM, name: "A Buyer", line1: "1 Test St" },
			handler,
		);

		const response = await PLACE_POST(context);

		expect(response.headers.get("location")).toContain("error=INVALID_SHIPPING_ADDRESS");
		expect(calls).toHaveLength(0);
	});
});

/**
 * The `GET /checkout` entry guard. `.astro` pages have no render harness here
 * (plan §7.3 / issue #40), so the page's ONE decision — "may this buyer see a
 * checkout page at all?" — lives in a pure module the page calls, and is
 * asserted directly.
 */
describe("GET /checkout entry guard (§1.7)", () => {
	test("NO cart cookie → 303 /cart, and the summary route is never even reached", () => {
		expect(checkoutEntryRedirect(undefined, null)).toEqual({ path: "/cart" });
		expect(checkoutEntryRedirect("", null)).toEqual({ path: "/cart" });
	});

	test("an EMPTY cart (summary answers CART_EMPTY) → 303 /cart — never an empty checkout with a payable-looking button", () => {
		expect(checkoutEntryRedirect("cart-1", { ok: false, reason: "CART_EMPTY" })).toEqual({
			path: "/cart",
			error: "CART_EMPTY",
		});
	});

	test.each([["CART_NOT_FOUND"], ["PRODUCT_NOT_PRICED"], ["CURRENCY_MISMATCH"]])(
		"a %s summary → 303 /cart carrying the token, so the cart page explains it",
		(reason) => {
			expect(
				checkoutEntryRedirect("cart-1", {
					ok: false,
					reason,
				} as CheckoutSummaryRouteResult),
			).toEqual({ path: "/cart", error: reason });
		},
	);

	test("a dead dispatcher → 303 /cart with SERVICE_UNAVAILABLE (never a half-rendered checkout)", () => {
		expect(checkoutEntryRedirect("cart-1", null)).toEqual({
			path: "/cart",
			error: "SERVICE_UNAVAILABLE",
		});
	});

	test("a route-level error token is carried through as itself", () => {
		expect(checkoutEntryRedirect("cart-1", { ok: false, error: "RENDER_FAILED" })).toEqual({
			path: "/cart",
			error: "RENDER_FAILED",
		});
	});

	test("a healthy summary renders the page — no redirect", () => {
		expect(
			checkoutEntryRedirect("cart-1", {
				ok: true,
				cartId: "cart-1",
				currency: "USD",
				lines: [],
				totals: {} as never,
				idempotencyKey: "checkout:cart-1",
				hasUnpricedLines: false,
			}),
		).toBeNull();
	});

	test("the checkout page actually CALLS the guard and 303s on it", () => {
		const source = readFileSync(path.resolve(HERE, "../src/pages/checkout/index.astro"), "utf8");
		expect(source).toContain("checkoutEntryRedirect");
		expect(source).toContain("303");
	});
});
