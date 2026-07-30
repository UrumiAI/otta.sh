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
import { STOREFRONT_CHECKOUT_PLACE_ROUTE, type CheckoutSummaryRouteResult } from "@otta-sh/plugin";
import { checkoutEntryRedirect } from "../src/lib/checkout-redirect.js";
import {
	CHECKOUT_COOKIE_MAX_AGE_SECONDS,
	CHECKOUT_COOKIE_NAME,
	clearCheckoutCookie,
	readCheckoutStash,
	setCheckoutCookie,
	type CheckoutStash,
} from "../src/lib/checkout-cookie.js";
import { PAY_FALLBACK_LABEL, payButtonLabel } from "../src/lib/totals.js";
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

/** The exact cookie VALUE `setCheckoutCookie` writes for a given stash — the
 *  serialization under test, not a re-encoding of it. */
function written(stash: CheckoutStash): string {
	let value = "";
	setCheckoutCookie(
		{
			set: (_name, raw) => {
				value = raw;
			},
		},
		stash,
	);
	return value;
}

const PLACED = {
	ok: true,
	orderId: "order-1",
	state: "pending",
	alreadyPlaced: false,
	clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_abc" },
	// The order's OWN total, formatted by the plugin at place-time (§7). The
	// minor-unit `amount` rides on the route result and must NOT reach the cookie.
	total: { amount: 4000, currency: "USD", formatted: "$40.00" },
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

	test("the stash carries the ORDER's total, taken from the place reply", async () => {
		// From the reply that created the order — never re-quoted here and never
		// re-read on the pay page: the cart is still live, the charge is not.
		const { handler } = makeHandler();
		const { context, cookieOps } = makeContext(VALID_FORM, handler);

		await PLACE_POST(context);

		const raw = cookieOps.find((op) => op.op === "set" && op.name === CHECKOUT_COOKIE_NAME)!.value!;
		const stash = readCheckoutStash({ get: () => ({ value: raw }) });
		expect(stash?.total).toEqual({ currency: "USD", formatted: "$40.00" });
		// The button the buyer sees, end to end.
		expect(payButtonLabel(stash?.total?.formatted)).toBe("Pay $40.00");
		// PROJECTED, not spread: the minor-unit amount stays server-side.
		expect(raw).not.toContain("amount");
		expect(raw).not.toContain("4000");
	});

	test("a place reply with NO total still stashes a payable order", async () => {
		// The result TYPE promises a total; the dispatcher only asserts that shape
		// over parsed JSON. A missing one costs the button its amount — it must
		// never 500 an order whose stock is held and whose intent already exists.
		const { total: _dropped, ...noTotal } = PLACED;
		const { handler } = makeHandler(noTotal);
		const { context, cookieOps } = makeContext(VALID_FORM, handler);

		const response = await PLACE_POST(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		const raw = cookieOps.find((op) => op.op === "set" && op.name === CHECKOUT_COOKIE_NAME)!.value!;
		const stash = readCheckoutStash({ get: () => ({ value: raw }) });
		expect(stash?.clientSecret).toBe("pi_1_secret_abc");
		expect(stash?.total).toBeUndefined();
		expect(payButtonLabel(stash?.total?.formatted)).toBe(PAY_FALLBACK_LABEL);
	});

	test("the stash round-trips the orderId, the client secret and the total", () => {
		const raw = written({
			orderId: "order-1",
			clientSecret: "pi_1_secret_abc",
			total: { currency: "USD", formatted: "$40.00" },
		});
		expect(readCheckoutStash({ get: () => ({ value: raw }) })).toEqual({
			orderId: "order-1",
			clientSecret: "pi_1_secret_abc",
			total: { currency: "USD", formatted: "$40.00" },
		});
	});

	test("a malformed / absent stash reads as null rather than throwing", () => {
		expect(readCheckoutStash({ get: () => undefined })).toBeNull();
		expect(readCheckoutStash({ get: () => ({ value: "not json" }) })).toBeNull();
		expect(readCheckoutStash({ get: () => ({ value: '{"orderId":"o"}' }) })).toBeNull();
	});

	/**
	 * BACKWARD COMPATIBILITY — the widened stash meets cookies it did not write.
	 *
	 * A `urumi_checkout` cookie lives for 15 minutes, so a deploy that lands
	 * mid-checkout hands this reader an OLD-SHAPE stash whose order is real, whose
	 * client secret is live, and whose stock is held. Every case below must still
	 * yield a payable stash; the total is a label, and a label is never worth a
	 * payment.
	 */
	describe("the total is optional — an old or half-shaped stash still pays", () => {
		const OLD_SHAPE = '{"orderId":"order-1","clientSecret":"pi_1_secret_abc"}';

		test("a stash minted BEFORE the total shipped parses, with no total", () => {
			const stash = readCheckoutStash({ get: () => ({ value: OLD_SHAPE }) });
			expect(stash).toEqual({ orderId: "order-1", clientSecret: "pi_1_secret_abc" });
			expect(stash?.total).toBeUndefined();
			// …and that is exactly the case the button's fallback exists for.
			expect(payButtonLabel(stash?.total?.formatted)).toBe(PAY_FALLBACK_LABEL);
		});

		test.each([
			["a null total", '"total":null'],
			["a string total", '"total":"$40.00"'],
			["a total with no currency", '"total":{"formatted":"$40.00"}'],
			["a total with no formatted string", '"total":{"currency":"USD"}'],
			["a total with a blank currency", '"total":{"currency":"","formatted":"$40.00"}'],
			["a total with a blank string", '"total":{"currency":"USD","formatted":""}'],
			["a numeric formatted field", '"total":{"currency":"USD","formatted":4000}'],
			["a numeric currency", '"total":{"currency":123,"formatted":"$40.00"}'],
			// Not merely non-empty: the layout prints this as a currency chip, so it
			// must be ISO-4217's alpha shape or nothing.
			["a lowercase currency", '"total":{"currency":"usd","formatted":"$40.00"}'],
			["a currency symbol", '"total":{"currency":"$","formatted":"$40.00"}'],
			["an over-long currency", '"total":{"currency":"USDD","formatted":"$40.00"}'],
		])("%s is DROPPED, not fatal — the order stays payable", (_name, fragment) => {
			const raw = `{"orderId":"order-1","clientSecret":"pi_1_secret_abc",${fragment}}`;
			const stash = readCheckoutStash({ get: () => ({ value: raw }) });
			expect(stash).not.toBeNull();
			expect(stash!.clientSecret).toBe("pi_1_secret_abc");
			expect(stash!.total).toBeUndefined();
		});

		test("a NEW-shape stash yields the amount", () => {
			const raw = written({
				orderId: "order-1",
				clientSecret: "pi_1_secret_abc",
				total: { currency: "USD", formatted: "$40.00" },
			});
			const stash = readCheckoutStash({ get: () => ({ value: raw }) });
			expect(payButtonLabel(stash?.total?.formatted)).toBe("Pay $40.00");
			expect(stash?.total?.currency).toBe("USD");
		});

		test("writing without a total produces the OLD shape verbatim — no null key", () => {
			// Forward compatibility in the other direction: a reader that predates
			// this field must not meet `"total":null` where it expected nothing.
			expect(written({ orderId: "order-1", clientSecret: "pi_1_secret_abc" })).toBe(OLD_SHAPE);
		});
	});

	describe("what the cookie is allowed to carry", () => {
		test("the stash holds NO money number — only a code and a display string", () => {
			// The money rule, at the one place this site touches money at all:
			// minor units never leave the plugin, so nothing here can divide by 100.
			const raw = written({
				orderId: "order-1",
				clientSecret: "pi_1_secret_abc",
				total: { currency: "USD", formatted: "$40.00" },
			});
			const parsed = JSON.parse(raw) as { total: Record<string, unknown> };
			expect(Object.keys(parsed.total).toSorted()).toEqual(["currency", "formatted"]);
			expect(raw).not.toContain("4000");
		});

		test.each([
			["a euro amount", "EUR", "40,00 €"],
			[
				"an Arabic-script amount",
				"SAR",
				new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" }).format(40),
			],
		])("%s survives the real cookie encoding byte-exact", (_label, currency, formatted: string) => {
			// The plugin formats for a locale, so the label is NOT ASCII in general
			// — and it travels through a percent-encoding round trip (Astro's
			// serializer encodes on write, the browser's parser decodes on read)
			// before it reaches a payment button. A mangled figure on that button
			// is worse than none, so this asserts the exact string, not its shape.
			const raw = written({
				orderId: "order-1",
				clientSecret: "pi_1_secret_abc",
				total: { currency, formatted },
			});
			const overTheWire = decodeURIComponent(encodeURIComponent(raw));
			const stash = readCheckoutStash({ get: () => ({ value: overTheWire }) });
			expect(stash?.total).toEqual({ currency, formatted });
			expect(payButtonLabel(stash?.total?.formatted)).toBe(`Pay ${formatted}`);
		});

		test("the widened stash is still a SMALL cookie, measured as it goes on the wire", () => {
			// Measured ENCODED, because that is what ships: Astro's cookie serializer
			// percent-encodes the value by default, and JSON's braces, quotes, commas
			// and colons all encode to three characters each. A realistic USD stash is
			// 175 JSON characters but 237 encoded bytes — plus the name and attributes,
			// ~305 bytes of `Set-Cookie` — and an `ar-SA` amount, whose formatted
			// string is non-ASCII, reaches ~297 encoded. Counting `raw.length` would
			// have understated every one of those by a third or more.
			//
			// The bound is deliberately loose against the 4096-byte browser limit and
			// tight against growth: it is here to catch a future field that puts a
			// line list or an address back into a cookie that rides EVERY request
			// under `path=/`, not to police a formatted string's width.
			const encodedLength = (stash: CheckoutStash): number =>
				encodeURIComponent(written(stash)).length;
			const REAL = {
				orderId: "0195f0a1-2c3d-7e4f-8a9b-0c1d2e3f4a5b",
				clientSecret: "pi_3Q1abcDEFghiJKLM1n2o3p4q_secret_R5stuVWXyz6AbCdEfGhIjKlM",
			};

			expect(
				encodedLength({ ...REAL, total: { currency: "USD", formatted: "$40.00" } }),
			).toBeLessThan(1024);
			// The widest realistic label this can hold: a non-ASCII, right-to-left
			// amount, where each character costs three encoded characters per UTF-8
			// byte — six for Arabic script, and the bidi marks are not free either.
			expect(
				encodedLength({
					...REAL,
					total: {
						currency: "SAR",
						formatted: new Intl.NumberFormat("ar-SA", {
							style: "currency",
							currency: "SAR",
						}).format(40),
					},
				}),
			).toBeLessThan(1024);
		});
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
