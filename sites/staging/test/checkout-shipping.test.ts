/**
 * Issue #305 — the review page's delivery and coupon round trip.
 *
 * The plugin derives the shipping zone from the country/region; the site's job
 * is to COLLECT them (a country `<select>`, never free text that matches no
 * zone), remember the buyer's delivery method and coupon between renders with
 * no client JS, and send exactly those choices with the order. What each group
 * protects:
 *  - `/checkout/update` is origin-guarded like every other POST, and drops
 *    anything malformed rather than bouncing the buyer off the page;
 *  - the selection cookie carries four short fields and nothing else;
 *  - `/checkout/place` forwards the method and coupon, and never a zone;
 *  - the page renders the delivery form first and never a payable-looking
 *    button while delivery is unpriced;
 *  - every new place/summary token has shopper copy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";
import { STOREFRONT_CHECKOUT_PLACE_ROUTE } from "@otta-sh/plugin";
import {
	CHECKOUT_SELECTION_COOKIE_NAME,
	normalizeSelection,
	readCheckoutSelection,
	summaryInputFor,
} from "../src/lib/checkout-selection.js";
import { countryName, countryOptions, isCountryCode } from "../src/lib/countries.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { POST as NEW_CART_POST } from "../src/pages/checkout/new-cart.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";
import { POST as UPDATE_POST } from "../src/pages/checkout/update.js";

vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
}));

const SITE = "http://localhost:4321";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERIC = cartErrorMessage("SOMETHING_NOBODY_MAPPED");

interface CookieOp {
	op: "set" | "delete";
	name: string;
	value?: string;
	options?: Record<string, unknown>;
}

function makeContext(
	urlPath: string,
	form: Record<string, string>,
	opts: { origin?: string; handler?: unknown } = {},
) {
	const url = new URL(urlPath, SITE);
	const request = new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: opts.origin ?? SITE,
		},
		body: new URLSearchParams(form).toString(),
	});
	const store = new Map<string, string>([["otta_cart", "cart-existing"]]);
	const cookieOps: CookieOp[] = [];
	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined),
			set: (name: string, value: string, options: Record<string, unknown>) => {
				cookieOps.push({ op: "set", name, value, options });
				store.set(name, value);
			},
			delete: (name: string, options: Record<string, unknown>) => {
				cookieOps.push({ op: "delete", name, options });
				store.delete(name);
			},
		},
		locals: { emdash: { handlePublicPluginApiRoute: opts.handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	return { context, cookieOps };
}

describe("the selection cookie", () => {
	test("keeps a country code, region, method id and coupon — upper-casing the country", () => {
		expect(
			normalizeSelection({
				country: " us ",
				region: "CA",
				shippingMethodId: "m-flat",
				couponCode: " SAVE5 ",
			}),
		).toEqual({ country: "US", region: "CA", shippingMethodId: "m-flat", couponCode: "SAVE5" });
	});

	test("drops anything the plugin would refuse, rather than bouncing the buyer off the page", () => {
		expect(
			normalizeSelection({
				country: "United States",
				region: "x".repeat(121),
				shippingMethodId: "m flat",
				couponCode: "C".repeat(201),
			}),
		).toEqual({});
		// A region without a country means nothing to zone matching.
		expect(normalizeSelection({ region: "CA" })).toEqual({});
	});

	test("a malformed cookie reads as an empty selection, never a throw", () => {
		for (const value of ["", "not json", "[1]", "null"]) {
			expect(readCheckoutSelection({ get: () => ({ value }) })).toEqual({});
		}
	});

	test("the summary input is only what was chosen, with the country/region as the address", () => {
		expect(summaryInputFor({})).toEqual({});
		expect(
			summaryInputFor({ country: "US", region: "CA", shippingMethodId: "m", couponCode: "C" }),
		).toEqual({
			shippingAddress: { country: "US", region: "CA" },
			shippingMethodId: "m",
			couponCode: "C",
		});
	});
});

describe("POST /checkout/update", () => {
	test("a cross-origin POST is 403 and writes no cookie", async () => {
		const { context, cookieOps } = makeContext(
			"/checkout/update",
			{ country: "US" },
			{ origin: "https://evil.example" },
		);
		const res = await UPDATE_POST(context);
		expect(res.status).toBe(403);
		expect(cookieOps).toEqual([]);
	});

	test("stores the selection in a first-party, http-only cookie scoped to /checkout and 303s back", async () => {
		const { context, cookieOps } = makeContext("/checkout/update", {
			country: "us",
			region: "CA",
			shippingMethodId: "m-west",
			couponCode: "SAVE5",
		});
		const res = await UPDATE_POST(context);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/checkout");
		expect(cookieOps).toHaveLength(1);
		const op = cookieOps[0]!;
		expect(op.name).toBe(CHECKOUT_SELECTION_COOKIE_NAME);
		expect(JSON.parse(op.value!)).toEqual({
			country: "US",
			region: "CA",
			shippingMethodId: "m-west",
			couponCode: "SAVE5",
		});
		expect(op.options).toMatchObject({
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/checkout",
		});
	});

	test("'Remove coupon' clears the coupon and keeps the delivery choice", async () => {
		const { context, cookieOps } = makeContext("/checkout/update", {
			country: "US",
			shippingMethodId: "m-us",
			couponCode: "SAVE5",
			action: "remove-coupon",
		});
		await UPDATE_POST(context);
		expect(JSON.parse(cookieOps[0]!.value!)).toEqual({ country: "US", shippingMethodId: "m-us" });
	});
});

describe("POST /checkout/place sends the delivery method and coupon — never a zone", () => {
	test("forwards the address with its country/region, the method and the coupon", async () => {
		const bodies: Record<string, unknown>[] = [];
		const handler = async (_id: string, _m: string, routePath: string, request: Request) => {
			if (routePath.replace(/^\//, "") === STOREFRONT_CHECKOUT_PLACE_ROUTE) {
				bodies.push((await request.json()) as Record<string, unknown>);
			}
			return { success: true, data: { ok: false, reason: "SHIPPING_METHOD_NOT_AVAILABLE" } };
		};
		const { context } = makeContext(
			"/checkout/place",
			{
				email: "buyer@example.com",
				idempotencyKey: "checkout:cart-existing",
				name: "A Buyer",
				line1: "1 Test St",
				city: "Testville",
				postalCode: "12345",
				country: "US",
				region: "CA",
				shippingMethodId: "m-west",
				couponCode: "SAVE5",
				shippingZoneId: "z-cheap",
			},
			{ handler },
		);

		const res = await PLACE_POST(context);

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			shippingAddress: { country: "US", region: "CA", postalCode: "12345" },
			shippingMethodId: "m-west",
			couponCode: "SAVE5",
		});
		expect(bodies[0]).not.toHaveProperty("shippingZoneId");
		// A shipping refusal comes back to the review page as its own token.
		expect(res.headers.get("location")).toBe("/checkout?error=SHIPPING_METHOD_NOT_AVAILABLE");
	});
});

test("starting a new cart forgets the delivery selection too", async () => {
	const { context, cookieOps } = makeContext("/checkout/new-cart", {});
	await NEW_CART_POST(context);
	expect(cookieOps).toContainEqual({
		op: "delete",
		name: CHECKOUT_SELECTION_COOKIE_NAME,
		options: { path: "/checkout" },
	});
});

describe("every new shipping/coupon token has shopper copy", () => {
	test.each([
		"SHIPPING_ADDRESS_REQUIRED",
		"SHIPPING_UNAVAILABLE_FOR_ADDRESS",
		"SHIPPING_METHOD_REQUIRED",
		"SHIPPING_METHOD_NOT_AVAILABLE",
		"SHIPPING_METHOD_NOT_IN_ZONE",
		"SHIPPING_METHOD_NOT_FOUND",
		"SHIPPING_RATE_NOT_FOUND",
		"COUPON_NOT_FOUND",
		"COUPON_NOT_ACTIVE",
		"COUPON_MIN_SUBTOTAL",
		"COUPON_EXHAUSTED",
		"COUPON_MAX_PER_CUSTOMER",
		"COUPON_CURRENCY_MISMATCH",
	])("%s", (token) => {
		const copy = cartErrorMessage(token);
		expect(copy).not.toBe(GENERIC);
		expect(copy).not.toContain(token);
	});
});

describe("the country list", () => {
	test("offers every ISO code, by name, sorted — the value is the code zones match on", () => {
		const options = countryOptions();
		expect(options.length).toBeGreaterThan(240);
		expect(options).toContainEqual({ code: "US", name: "United States" });
		expect(options).toContainEqual({ code: "GB", name: "United Kingdom" });
		const names = options.map((o) => o.name);
		expect(names).toEqual(names.toSorted((a, b) => a.localeCompare(b, "en")));
		expect(isCountryCode("US")).toBe(true);
		expect(isCountryCode("United States")).toBe(false);
		expect(countryName("FR")).toBe("France");
	});
});

describe("the review page source", () => {
	const page = readFileSync(path.resolve(HERE, "../src/pages/checkout/index.astro"), "utf8");

	test("renders the delivery form FIRST, posting to /checkout/update, with a country select", () => {
		const update = page.indexOf('action="/checkout/update"');
		const place = page.indexOf('action="/checkout/place"');
		expect(update).toBeGreaterThan(-1);
		expect(update).toBeLessThan(place);
		expect(page).toMatch(/<select name="country"/);
		expect(page).toContain('type="radio"');
		expect(page).toContain('name="shippingMethodId"');
		expect(page).toContain('name="couponCode"');
	});

	test("feeds the summary the stored selection and never sends a zone", () => {
		expect(page).toContain("summaryInputFor(selection)");
		expect(page).not.toMatch(/shippingZoneId/);
	});

	test("never offers 'Continue to payment' while delivery is unpriced", () => {
		expect(page).toContain("shippingReady");
		expect(page).toMatch(/paymentConfigured && !shippingReady/);
	});

	test("the place form's address block has no free-text country field any more", () => {
		const placeForm = page.slice(page.indexOf('action="/checkout/place"'));
		expect(placeForm).not.toMatch(/<input type="text" name="country"/);
	});
});
