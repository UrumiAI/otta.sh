/**
 * QA U-1 — a refused checkout keeps what the buyer typed.
 *
 * Every refusal from `POST /checkout/place` (INVALID_EMAIL, INVALID_SHIPPING_ADDRESS,
 * a refused coupon, PAYMENT_INTENT_FAILED, the per-field bounds and region codes
 * added for U-6, a stale page) used to 303 to a blank form: the redirect may carry
 * no personal data (a home address in a query string lands in history, Referers
 * and access logs), so nothing came back. Applying a coupon — a GET form — lost
 * everything typed below it the same way.
 *
 * Now the typed values ride a short-lived first-party DRAFT cookie
 * (`otta_checkout_draft`: httpOnly, Secure, SameSite=Strict, `Path=/checkout`,
 * 15 minutes) that the review reads back into the form, with the field each
 * error identifies marked beside that field. The URL still carries only the
 * error token and the non-personal selection; the draft carries only the
 * buyer's own typed fields — never the idempotency key, a client secret or
 * anything else the form echoes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIContext } from "astro";
import {
	ORDER_ADDRESS_MAX_LENGTHS,
	STOREFRONT_CHECKOUT_PLACE_ROUTE,
	STOREFRONT_ORDER_ABANDON_ROUTE,
} from "@otta-sh/plugin";
import { afterEach, describe, expect, test, vi } from "vitest";
import { splitAstro, templateOf } from "./astro-source.js";
import { viewSources } from "./theme-views.js";
import { serve } from "./helpers/serve.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import {
	CHECKOUT_DRAFT_COOKIE,
	CHECKOUT_DRAFT_MAX_AGE_SECONDS,
	checkoutDraftFits,
	fieldErrorCopy,
	readCheckoutDraft,
	shownFieldErrors,
	writeCheckoutDraft,
	type CheckoutDraft,
} from "../src/lib/checkout-draft.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

const stripeKey = vi.hoisted(() => ({ value: "pk_test_fake" as string | undefined }));
vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	get STRIPE_PUBLISHABLE_KEY() {
		return stripeKey.value;
	},
}));

const { POST: PLACE_POST } = await import("../src/pages/checkout/place.js");
const { POST: NEW_CART_POST } = await import("../src/pages/checkout/new-cart.js");
const { onRequest } = await import("../src/middleware.js");

afterEach(() => {
	stripeKey.value = "pk_test_fake";
});

const SITE = "http://localhost:4321";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

interface CookieSet {
	name: string;
	value: string;
	options: Record<string, unknown>;
}

function harness(
	form: Record<string, string>,
	reply: unknown,
	opts: { url?: string; cookies?: Record<string, string> } = {},
) {
	const calls: Array<Record<string, unknown>> = [];
	const handler = async (_id: string, _m: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		const body = (await request.json()) as Record<string, unknown>;
		calls.push(body);
		if (route === STOREFRONT_CHECKOUT_PLACE_ROUTE) return { success: true, data: reply };
		// Start a new cart first stops the cart's unpaid order (QA2 X4) and clears
		// nothing unless that is confirmed; here there was nothing to cancel.
		if (route === STOREFRONT_ORDER_ABANDON_ROUTE) {
			return { success: true, data: { ok: true, cancelled: false } };
		}
		return { success: false };
	};
	const url = new URL(opts.url ?? "/checkout/place", SITE);
	const jar = new Map<string, string>(
		Object.entries({ otta_cart: "cart-existing", ...opts.cookies }),
	);
	const sets: CookieSet[] = [];
	const deletes: string[] = [];
	const context = {
		request: new Request(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE },
			body: new URLSearchParams(form).toString(),
		}),
		url,
		cookies: {
			get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
			set: (name: string, value: string, options: Record<string, unknown>) => {
				sets.push({ name, value, options });
				jar.set(name, value);
			},
			delete: (name: string) => {
				deletes.push(name);
				jar.delete(name);
			},
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	const draft = (): CheckoutDraft | null =>
		readCheckoutDraft({ get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined) });
	return { context, calls, sets, deletes, draft };
}

const KEY = "checkout:cart-existing";
const ADDRESS = {
	name: "Ada Lovelace",
	line1: "12 Analytical Row",
	line2: "Flat 3",
	city: "London",
	postalCode: "N1 9GU",
	country: "GB",
	phone: "+44 20 7946 0000",
};
const FULL = { email: "ada@example.com", idempotencyKey: KEY, ...ADDRESS };

const PLACED = {
	ok: true,
	orderId: "order-1",
	state: "pending",
	alreadyPlaced: false,
	clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_abc" },
	total: { amount: 4000, currency: "USD", formatted: "$40.00" },
};

function expectNoPersonalDataIn(location: string): void {
	for (const value of ["ada", "Lovelace", "Analytical", "London", "N1", "7946"]) {
		expect(location, value).not.toContain(value);
	}
}

// ── the draft cookie ────────────────────────────────────────────────────────

describe("the draft cookie", () => {
	test("is httpOnly, Secure, SameSite=Strict, scoped to /checkout and lives as long as a hold", () => {
		const sets: CookieSet[] = [];
		writeCheckoutDraft(
			{ set: (name, value, options) => sets.push({ name, value, options: { ...options } }) },
			{ values: { email: "a@b.co" }, errors: {} },
		);
		expect(sets).toHaveLength(1);
		expect(sets[0]!.name).toBe(CHECKOUT_DRAFT_COOKIE);
		expect(sets[0]!.options).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "strict",
			path: "/checkout",
			maxAge: CHECKOUT_DRAFT_MAX_AGE_SECONDS,
		});
		expect(CHECKOUT_DRAFT_MAX_AGE_SECONDS).toBe(900);
	});

	test("round-trips only the typed fields, and drops anything else a cookie might hold", () => {
		const jar = new Map<string, string>();
		writeCheckoutDraft(
			{ set: (name, value) => jar.set(name, value) },
			{
				values: { email: "a@b.co", name: "A", region: "CA" },
				errors: { region: "invalid" },
				error: "SHIPPING_REGION_CODE_REQUIRED",
				coupon: "SAVE10",
			},
		);
		const tampered = JSON.parse(jar.get(CHECKOUT_DRAFT_COOKIE)!) as Record<string, unknown>;
		(tampered["values"] as Record<string, unknown>)["idempotencyKey"] = "checkout:x";
		(tampered["values"] as Record<string, unknown>)["name"] = 42;
		(tampered["errors"] as Record<string, unknown>)["email"] = "<script>";
		jar.set(CHECKOUT_DRAFT_COOKIE, JSON.stringify(tampered));
		expect(readCheckoutDraft({ get: (n) => ({ value: jar.get(n)! }) })).toEqual({
			values: { email: "a@b.co", region: "CA" },
			errors: { region: "invalid" },
			error: "SHIPPING_REGION_CODE_REQUIRED",
			coupon: "SAVE10",
		});
	});

	test("an absent or malformed cookie is no draft", () => {
		expect(readCheckoutDraft({ get: () => undefined })).toBeNull();
		expect(readCheckoutDraft({ get: () => ({ value: "{nope" }) })).toBeNull();
		expect(readCheckoutDraft({ get: () => ({ value: "[]" }) })).toBeNull();
	});

	test("a draft too large for a cookie is not written at all — never one with a field dropped", () => {
		const sets: CookieSet[] = [];
		// Fits only if line 2 were dropped — and it must not be.
		const huge = "\u4e00".repeat(150);
		writeCheckoutDraft(
			{ set: (name, value, options) => sets.push({ name, value, options: { ...options } }) },
			{
				values: { name: huge, line1: huge, line2: huge, city: "London", email: "a@b.co" },
				errors: {},
			},
		);
		// Never a shortened draft: an address line silently dropped would be
		// placed without it. Too large ⇒ nothing written at all.
		expect(sets).toHaveLength(0);
	});
});

describe("field errors — shown only for the error the URL names", () => {
	const draft: CheckoutDraft = {
		values: {},
		errors: { email: "invalid", line1: "too_long", city: "missing" },
		error: "INVALID_EMAIL",
	};

	test("the draft's errors are shown when the URL carries the same token", () => {
		expect(shownFieldErrors(draft, "INVALID_EMAIL")).toEqual({
			email: fieldErrorCopy("email", "invalid"),
			line1: fieldErrorCopy("line1", "too_long"),
			city: fieldErrorCopy("city", "missing"),
		});
	});

	test("issue #382: a required address's blank field says only to fill it in", () => {
		const missing = {
			values: { email: "a@b.co" },
			errors: { name: "missing" as const },
			error: "MISSING_SHIPPING_ADDRESS",
		};
		expect(
			shownFieldErrors(missing, "MISSING_SHIPPING_ADDRESS", { addressRequired: true }),
		).toEqual({ name: "Fill this in." });
	});

	test("a stale draft (another token, or none) marks no field", () => {
		expect(shownFieldErrors(draft, null)).toEqual({});
		expect(shownFieldErrors(draft, "PAYMENT_INTENT_FAILED")).toEqual({});
		expect(shownFieldErrors(null, "INVALID_EMAIL")).toEqual({});
	});

	test("the copy is plain and specific", () => {
		expect(fieldErrorCopy("email", "invalid")).toBe(
			"Enter an email address like name@example.com.",
		);
		expect(fieldErrorCopy("city", "missing")).toBe(
			"Fill this in, or leave the whole address blank.",
		);
		// When the address is REQUIRED (the page passes this for an India Stripe
		// account — issue #382) "leave the whole address blank" is not an option.
		expect(fieldErrorCopy("city", "missing", { addressRequired: true })).toBe("Fill this in.");
		expect(fieldErrorCopy("line1", "too_long")).toBe(
			`Too long — use at most ${ORDER_ADDRESS_MAX_LENGTHS.line1} characters.`,
		);
		expect(fieldErrorCopy("country", "invalid")).toBe("Choose a country from the list.");
		expect(fieldErrorCopy("region", "invalid")).toBe(
			"Choose a state/province from the list — or leave it blank.",
		);
	});
});

// ── place.ts: every refusal keeps the values ────────────────────────────────

describe("POST /checkout/place — a refusal keeps every typed value", () => {
	test("INVALID_EMAIL keeps the email AND the address, marks the email, and the URL carries none of it", async () => {
		const h = harness({ ...FULL, email: "ada@" }, PLACED);
		const response = await PLACE_POST(h.context);
		const location = response.headers.get("location")!;
		expect(location).toContain("error=INVALID_EMAIL");
		expectNoPersonalDataIn(location);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()).toEqual({
			values: { email: "ada@", ...ADDRESS },
			errors: { email: "invalid" },
			error: "INVALID_EMAIL",
		});
	});

	test("a PARTIAL address names exactly the blank fields", async () => {
		const h = harness({ ...FULL, city: "", postalCode: "  " }, PLACED);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toContain("error=INVALID_SHIPPING_ADDRESS");
		const draft = h.draft()!;
		expect(draft.errors).toEqual({ city: "missing", postalCode: "missing" });
		expect(draft.values).toMatchObject({ name: "Ada Lovelace", line1: "12 Analytical Row" });
		expect(draft.error).toBe("INVALID_SHIPPING_ADDRESS");
	});

	test("an over-long field is named as too long, and its value comes back to be shortened", async () => {
		const long = "x".repeat(ORDER_ADDRESS_MAX_LENGTHS.line1 + 1);
		const h = harness({ ...FULL, line1: long }, PLACED);
		await PLACE_POST(h.context);
		expect(h.draft()!.errors).toEqual({ line1: "too_long" });
		expect(h.draft()!.values.line1).toBe(long);
	});

	test("a country that is not a code is named on the country", async () => {
		const h = harness({ ...FULL, country: "Britain" }, PLACED);
		await PLACE_POST(h.context);
		expect(h.draft()!.errors).toEqual({ country: "invalid" });
	});

	test("a region that is not a code is named on the region", async () => {
		const h = harness({ ...FULL, region: "Illinois" }, PLACED);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toContain("error=SHIPPING_REGION_CODE_REQUIRED");
		expect(h.draft()!.errors).toEqual({ region: "invalid" });
		expect(h.draft()!.values.region).toBe("Illinois");
	});

	test("the plugin's region refusal is named on the region too", async () => {
		const h = harness(
			{ ...FULL, region: "ZZ" },
			{
				ok: false,
				reason: "SHIPPING_REGION_CODE_REQUIRED",
			},
		);
		await PLACE_POST(h.context);
		expect(h.draft()!.errors).toEqual({ region: "invalid" });
	});

	test("the plugin's MISSING_SHIPPING_ADDRESS names the required fields left blank", async () => {
		const h = harness(
			{ email: "ada@example.com", idempotencyKey: KEY },
			{
				ok: false,
				reason: "MISSING_SHIPPING_ADDRESS",
			},
		);
		await PLACE_POST(h.context);
		expect(h.draft()!.errors).toEqual({
			name: "missing",
			line1: "missing",
			city: "missing",
			postalCode: "missing",
			country: "missing",
		});
	});

	test("PAYMENT_INTENT_FAILED keeps every value and marks no field", async () => {
		const h = harness(FULL, { ok: false, reason: "PAYMENT_INTENT_FAILED" });
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toContain("error=PAYMENT_INTENT_FAILED");
		expect(h.draft()).toEqual({
			values: { email: "ada@example.com", ...ADDRESS },
			errors: {},
			error: "PAYMENT_INTENT_FAILED",
		});
	});

	test("a coupon refused at place comes back as the typed code, to be fixed beside the coupon field", async () => {
		const h = harness({ ...FULL, couponCode: "SAVE10" }, { ok: false, reason: "COUPON_NOT_FOUND" });
		const response = await PLACE_POST(h.context);
		const location = response.headers.get("location")!;
		expect(location).toContain("error=COUPON_NOT_FOUND");
		expect(location).not.toContain("SAVE10");
		expect(h.draft()).toMatchObject({ coupon: "SAVE10", error: "COUPON_NOT_FOUND" });
		expect(h.draft()!.values).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });
	});

	test("a stale page keeps the values too", async () => {
		const h = harness({ ...FULL, idempotencyKey: "checkout:another-cart" }, PLACED);
		await PLACE_POST(h.context);
		expect(h.draft()!.values.email).toBe("ada@example.com");
		expect(h.draft()!.error).toBe("CHECKOUT_STALE");
	});

	test("no publishable key keeps the values (and still creates nothing)", async () => {
		stripeKey.value = undefined;
		const h = harness(FULL, PLACED);
		await PLACE_POST(h.context);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values.email).toBe("ada@example.com");
	});

	test("the draft never holds the key, the hidden selection or anything not typed by the buyer", async () => {
		const h = harness(
			{ ...FULL, email: "bad", couponCode: "SAVE10", shippingMethodId: "m1", addressMode: "x" },
			PLACED,
		);
		await PLACE_POST(h.context);
		const raw = h.sets.find((s) => s.name === CHECKOUT_DRAFT_COOKIE)!.value;
		expect(raw).not.toContain("checkout:cart-existing");
		expect(raw).not.toContain("m1");
		expect(raw).not.toContain("addressMode");
	});

	test("a SUCCESSFUL place clears the draft", async () => {
		const h = harness(FULL, PLACED, {
			cookies: {
				[CHECKOUT_DRAFT_COOKIE]: JSON.stringify({ values: { email: "old@x.co" }, errors: {} }),
			},
		});
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(h.deletes).toContain(CHECKOUT_DRAFT_COOKIE);
		expect(h.draft()).toBeNull();
	});

	test("Start a new cart clears the draft", async () => {
		const h = harness({}, PLACED, {
			url: "/checkout/new-cart",
			cookies: {
				[CHECKOUT_DRAFT_COOKIE]: JSON.stringify({ values: { email: "old@x.co" }, errors: {} }),
			},
		});
		await NEW_CART_POST(h.context);
		expect(h.deletes).toContain(CHECKOUT_DRAFT_COOKIE);
	});
});

describe("applying a coupon keeps every typed value", () => {
	test("Apply posts the details form: the draft is kept, the coupon goes in the URL, nothing is placed", async () => {
		const h = harness({ ...FULL, intent: "apply-coupon", coupon: " SAVE10 " }, PLACED);
		const response = await PLACE_POST(h.context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout?coupon=SAVE10");
		expect(h.calls).toHaveLength(0);
		expect(h.draft()).toEqual({ values: { email: "ada@example.com", ...ADDRESS }, errors: {} });
	});

	test("Apply works before the email is filled in — it is not a place", async () => {
		const h = harness(
			{ email: "", idempotencyKey: KEY, intent: "apply-coupon", coupon: "SAVE10" },
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe("/checkout?coupon=SAVE10");
		expect(h.calls).toHaveLength(0);
	});

	test("Apply keeps the priced destination and method", async () => {
		const h = harness(
			{
				...FULL,
				addressMode: "zoned",
				country: "US",
				region: "CA",
				shippingMethodId: "m1",
				intent: "apply-coupon",
				coupon: "SAVE10",
			},
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe(
			"/checkout?coupon=SAVE10&country=US&region=CA&method=m1",
		);
	});

	test("Remove coupon is the same post, with no code", async () => {
		const h = harness({ ...FULL, couponCode: "SAVE10", intent: "remove-coupon" }, PLACED);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe("/checkout");
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values.email).toBe("ada@example.com");
	});

	test("an explicit Apply NEVER places: the applied code again re-renders with 'already applied', and no order is created", async () => {
		// Review round 1: the box is prefilled with the applied code, so clicking
		// Apply on it used to fall through to a place.
		const h = harness(
			{ ...FULL, couponCode: "SAVE10", intent: "apply-coupon", coupon: "SAVE10" },
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe(
			"/checkout?coupon=SAVE10&error=COUPON_ALREADY_APPLIED",
		);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values.email).toBe("ada@example.com");
		expect(cartErrorMessage("COUPON_ALREADY_APPLIED")).toBe("That code is already applied.");
	});

	test("a cross-site Apply is refused like any other place POST", async () => {
		const h = harness({ ...FULL, intent: "apply-coupon", coupon: "X" }, PLACED);
		(h.context.request.headers as Headers).set("origin", "https://evil.example");
		const response = await serve(onRequest, h.context, PLACE_POST);
		expect(response.status).toBe(403);
		expect(h.sets).toHaveLength(0);
	});
});

describe("updating the delivery keeps every typed value", () => {
	const ZONED = {
		...FULL,
		addressMode: "zoned",
		country: "US",
		region: "CA",
		shippingMethodId: "m1",
		couponCode: "SAVE10",
		fromCountry: "US",
		fromRegion: "CA",
	};

	test("Update delivery posts the details form: the draft is kept, the new delivery goes in the URL, nothing is placed", async () => {
		const h = harness(
			{
				...ZONED,
				intent: "update-delivery",
				deliveryCountry: "us",
				deliveryRegion: "ny",
				deliveryMethod: "m2",
			},
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			"/checkout?coupon=SAVE10&country=US&region=ny&method=m2&fromCountry=US&fromRegion=CA",
		);
		expectNoPersonalDataIn(response.headers.get("location")!);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });
	});

	test("it works before the email is filled in — it is not a place", async () => {
		const h = harness(
			{ ...ZONED, email: "", intent: "update-delivery", deliveryCountry: "DE", deliveryRegion: "" },
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe(
			"/checkout?coupon=SAVE10&country=DE&fromCountry=US&fromRegion=CA",
		);
		expect(h.calls).toHaveLength(0);
	});

	test("a submit whose delivery fields DIFFER from the priced ones re-prices instead of placing (Enter in the region box)", async () => {
		// Enter in a details field submits through the hidden first button
		// (intent=enter), which places only when nothing on the page is pending —
		// so a changed but un-updated delivery must not be placed at the old price.
		const h = harness(
			{
				...ZONED,
				intent: "enter",
				coupon: "SAVE10",
				deliveryCountry: "US",
				deliveryRegion: "NY",
				deliveryMethod: "m1",
			},
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe(
			"/checkout?coupon=SAVE10&country=US&region=NY&method=m1&fromCountry=US&fromRegion=CA",
		);
		expect(h.calls).toHaveLength(0);
	});

	test("a submit whose delivery fields MATCH the priced ones places the order", async () => {
		const h = harness(
			{ ...ZONED, deliveryCountry: "US", deliveryRegion: "us-ca", deliveryMethod: "m1" },
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(h.calls).toHaveLength(1);
	});
});

describe("the state/province pick list: a changed country is a round trip, never a stale region", () => {
	/** The address block of a page WITHOUT the delivery block: its own country
	 *  select, Update, and the list's country echoed as `regionCountry`. */
	const OWN = { ...FULL, country: "US", region: "CA", regionCountry: "US" };

	test("Update posts the details form: every typed value is kept in the draft, nothing is placed, no error", async () => {
		const h = harness({ ...OWN, intent: "update-address", couponCode: "SAVE10" }, PLACED);
		const response = await PLACE_POST(h.context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout?coupon=SAVE10");
		expectNoPersonalDataIn(response.headers.get("location")!);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values).toEqual({
			email: "ada@example.com",
			...ADDRESS,
			country: "US",
			region: "CA",
		});
		expect(h.draft()!.errors).toEqual({});
	});

	test("Update works before the email is filled in — it is not a place", async () => {
		const h = harness({ ...OWN, email: "", intent: "update-address" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout");
		expect(h.calls).toHaveLength(0);
	});

	test("Update after changing the country keeps everything typed EXCEPT the old country's region", async () => {
		const h = harness({ ...OWN, country: "IN", intent: "update-address" }, PLACED);
		await PLACE_POST(h.context);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values).toMatchObject({
			country: "IN",
			name: ADDRESS.name,
			city: ADDRESS.city,
		});
		expect(h.draft()!.values.region).toBeUndefined();
	});

	test("a code that exists in BOTH countries is still dropped: it was picked from the other list", async () => {
		// SG-01 and FR-01 are both real; "01" picked for Singapore is not Ain.
		const h = harness(
			{ ...OWN, country: "FR", region: "01", regionCountry: "SG", intent: "update-address" },
			PLACED,
		);
		await PLACE_POST(h.context);
		expect(h.draft()!.values.region).toBeUndefined();
	});

	test("placing after a country change comes back with the new list instead of placing", async () => {
		const h = harness({ ...OWN, country: "IN" }, PLACED);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe("/checkout?error=REGION_LIST_UPDATED");
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values).toMatchObject({ email: "ada@example.com", country: "IN" });
		expect(h.draft()!.values.region).toBeUndefined();
	});

	test("the first choice of a country, region left blank, places — a blank optional region is never re-asked or marked", async () => {
		const h = harness({ ...FULL, country: "US", regionCountry: "" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
		expect(h.calls).toHaveLength(1);
		const address = h.calls[0]!["shippingAddress"] as Record<string, string>;
		expect(address["country"]).toBe("US");
		expect(address["region"]).toBeUndefined();
	});

	test("a region the plugin REQUIRES (SHIPPING_REGION_CODE_REQUIRED) comes back with the field marked", async () => {
		const h = harness(
			{ ...FULL, country: "US", regionCountry: "" },
			{
				ok: false,
				error: "SHIPPING_REGION_CODE_REQUIRED",
			},
		);
		const location = (await PLACE_POST(h.context)).headers.get("location")!;
		expect(location).toContain("error=SHIPPING_REGION_CODE_REQUIRED");
		expect(h.draft()!.errors).toEqual({ region: "invalid" });
		expect(h.draft()!.values.country).toBe("US");
	});

	test("a region posted for ANOTHER country with a list of its own is re-asked, never dropped and placed", async () => {
		const h = harness({ ...OWN, country: "IN" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe(
			"/checkout?error=REGION_LIST_UPDATED",
		);
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.values.region).toBeUndefined();
		expect(h.draft()!.errors).toEqual({ region: "invalid" });
	});

	test("a stale region for a country WITHOUT subdivisions is dropped and the order placed — nothing to pick", async () => {
		const h = harness({ ...OWN, country: "AQ" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
		expect(h.calls).toHaveLength(1);
		const address = h.calls[0]!["shippingAddress"] as Record<string, string>;
		expect(address["country"]).toBe("AQ");
		expect(address["region"]).toBeUndefined();
	});

	test("the re-ask comes AFTER the other checks: a bad email and a stale region are marked in ONE round trip", async () => {
		const h = harness({ ...OWN, country: "IN", email: "ada@", city: "" }, PLACED);
		const location = (await PLACE_POST(h.context)).headers.get("location")!;
		expect(location).toContain("error=INVALID_EMAIL");
		expect(h.calls).toHaveLength(0);
		expect(h.draft()!.errors).toEqual({ email: "invalid", city: "missing", region: "invalid" });
		expect(h.draft()!.values.region).toBeUndefined();
	});

	test("a partial address and a stale region are marked together too", async () => {
		const h = harness({ ...OWN, country: "IN", city: "" }, PLACED);
		const location = (await PLACE_POST(h.context)).headers.get("location")!;
		expect(location).toContain("error=INVALID_SHIPPING_ADDRESS");
		expect(h.draft()!.errors).toEqual({ city: "missing", region: "invalid" });
	});

	test("an address too long for the draft cookie is never re-asked: the order can still be placed", async () => {
		// The draft would not be saved (over the cookie budget), so a re-ask would
		// come back EMPTY and every later submit would be re-asked again (review R2-1).
		const long = {
			name: "Ł".repeat(ORDER_ADDRESS_MAX_LENGTHS.name),
			line1: "Ł".repeat(ORDER_ADDRESS_MAX_LENGTHS.line1),
			line2: "Ł".repeat(ORDER_ADDRESS_MAX_LENGTHS.line2),
			city: "Ł".repeat(ORDER_ADDRESS_MAX_LENGTHS.city),
		};
		// A region picked for the US, then India chosen: the case that re-asks.
		const form = { ...FULL, ...long, country: "IN", region: "CA", regionCountry: "US" };
		const { idempotencyKey: _key, regionCountry: _list, ...values } = form;
		expect(checkoutDraftFits({ values, errors: {} })).toBe(false);
		for (const attempt of [1, 2]) {
			const h = harness(form, PLACED);
			expect((await PLACE_POST(h.context)).headers.get("location"), `attempt ${attempt}`).toBe(
				"/checkout/pay",
			);
			const address = h.calls[0]!["shippingAddress"] as Record<string, string>;
			expect(address["country"]).toBe("IN");
			expect(address["region"]).toBeUndefined();
		}
	});

	test("an unchanged country places with the picked code, exactly as a typed one was sent", async () => {
		const h = harness(OWN, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
		const address = h.calls[0]!["shippingAddress"] as Record<string, string>;
		expect(address).toMatchObject({ country: "US", region: "CA" });
	});

	test("a form without regionCountry (a theme still printing a typed region) behaves as before", async () => {
		const h = harness({ ...FULL, country: "US", region: "us-ca" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
		const address = h.calls[0]!["shippingAddress"] as Record<string, string>;
		expect(address["region"]).toBe("us-ca");
	});

	test("applying a coupon after a country change does not carry the old region into the draft", async () => {
		const h = harness({ ...OWN, country: "IN", intent: "apply-coupon", coupon: "SAVE10" }, PLACED);
		await PLACE_POST(h.context);
		expect(h.draft()!.values.region).toBeUndefined();
	});

	test("the delivery block: a region picked for the old country never rides the new destination", async () => {
		const h = harness(
			{
				...FULL,
				addressMode: "zoned",
				country: "US",
				region: "CA",
				fromCountry: "US",
				fromRegion: "CA",
				intent: "update-delivery",
				deliveryCountry: "CA",
				deliveryRegion: "CA",
				deliveryRegionCountry: "US",
			},
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		// Canada has no "CA" subdivision anyway, but the rule does not depend on
		// that: the list was rendered for the US.
		expect(response.headers.get("location")).toBe(
			"/checkout?country=CA&fromCountry=US&fromRegion=CA",
		);
		expect(h.calls).toHaveLength(0);
	});

	test("the delivery block: the same country keeps its picked region", async () => {
		const h = harness(
			{
				...FULL,
				addressMode: "zoned",
				country: "US",
				fromCountry: "US",
				fromRegion: "",
				intent: "update-delivery",
				deliveryCountry: "US",
				deliveryRegion: "NY",
				deliveryRegionCountry: "US",
			},
			PLACED,
		);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe(
			"/checkout?country=US&region=NY&fromCountry=US",
		);
	});
});

describe("Enter in a details field — its own hidden default button (intent=enter)", () => {
	test.each(viewSources("checkout").map((v) => [v.file, v] as const))(
		"%s: a hidden intent=enter submit comes BEFORE Apply, out of the tab order and hidden from assistive tech",
		(_file, view) => {
			const body = templateOf(view.source);
			const enter = /<button[^>]*value="enter"[^>]*>/.exec(body)?.[0] ?? "";
			expect(enter, "no enter button").not.toBe("");
			expect(enter).toContain('form="checkout-place"');
			expect(enter).toContain('name="intent"');
			expect(enter).toContain('tabindex="-1"');
			expect(enter).toContain('aria-hidden="true"');
			expect(enter).toContain('class="u-sr-only"');
			const enterAt = body.indexOf(enter);
			// It precedes EVERY submit control the place form owns — those carrying
			// form="checkout-place" and those inside <form id="checkout-place"> — so it
			// is the form's default button whatever is added later.
			const owned: number[] = [];
			for (const m of body.matchAll(/<button\b[^>]*>/g)) {
				const tag = m[0];
				if (tag === enter) continue;
				if (/type="(button|reset)"/.test(tag)) continue;
				if (tag.includes('form="checkout-place"')) owned.push(m.index ?? -1);
			}
			const place = /<form[^>]*id="checkout-place"[^>]*>[\s\S]*?<\/form>/.exec(body);
			expect(place, "no place form").not.toBeNull();
			const placeAt = place!.index;
			for (const m of place![0].matchAll(/<button\b[^>]*>/g)) {
				if (!/type="(button|reset)"/.test(m[0])) owned.push(placeAt + (m.index ?? 0));
			}
			expect(owned.length, "no other submit control found").toBeGreaterThan(2);
			for (const at of owned) expect(enterAt, `a submit at ${at}`).toBeLessThan(at);
			// Rendered under the SAME condition as the place form itself.
			expect(body).toMatch(
				/locked === null && !ended && \(\s*<button\s+type="submit"\s+class="u-sr-only"[^>]*value="enter"/,
			);
			expect(body).toMatch(
				/locked === null && !ended && \(\s*<form method="POST" action="\/checkout\/place"[^>]*id="checkout-place"/,
			);
		},
	);

	test("Enter in a details field, nothing pending, places the order", async () => {
		const h = harness({ ...FULL, couponCode: "SAVE10", intent: "enter", coupon: "SAVE10" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
		expect(h.calls).toHaveLength(1);
	});

	test("Enter with a DIFFERENT code in the box applies it and places nothing", async () => {
		const h = harness({ ...FULL, couponCode: "SAVE10", intent: "enter", coupon: "SAVE20" }, PLACED);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout?coupon=SAVE20");
		expect(h.calls).toHaveLength(0);
	});

	test("Enter with the REFUSED code still in the box is not an apply again — it places, without it", async () => {
		// The refused code is put back for correcting; the form echoes it as
		// `refusedCoupon`, so Enter does not loop on the same refusal.
		const h = harness(
			{ ...FULL, intent: "enter", coupon: "BOGUS", refusedCoupon: "BOGUS" },
			PLACED,
		);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
		expect(h.calls[0]).not.toHaveProperty("couponCode");
	});

	test("an explicit Apply of the refused code does try it again", async () => {
		const h = harness(
			{ ...FULL, intent: "apply-coupon", coupon: "BOGUS", refusedCoupon: "BOGUS" },
			PLACED,
		);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout?coupon=BOGUS");
		expect(h.calls).toHaveLength(0);
	});
});

describe("/checkout reads the draft back", () => {
	const page = splitAstro(read("pages/checkout/index.astro")).frontmatter;

	test("the draft is read, and ignored once the cart is an order", () => {
		expect(page).toMatch(
			/const draft = locked === null \? readCheckoutDraft\(Astro\.cookies\) : null;/,
		);
	});

	test("typed values win over the account's email; the fields get the draft's values", () => {
		expect(page).toMatch(/emailValue: draft\?\.values\.email \?\? accountEmail \?\? ""/);
		expect(page).toMatch(/const addressValues = draftAddressValues\(draft\);/);
		expect(page).toMatch(/^\taddressValues,$/m);
		expect(page).toMatch(
			/fieldErrors: shownFieldErrors\(draft, shownError, \{\s*addressRequired: summary\.paymentAccountNeedsAddress,?\s*\}\)/,
		);
	});

	test("a coupon refused at place comes back into the coupon field, with its error beside it", () => {
		expect(page).toMatch(/placeCouponError/);
	});
});

describe.each(viewSources("checkout").map((v) => [v.file, v] as const))(
	"%s prints the kept values and the field errors",
	(_file, view) => {
		const body = templateOf(view.source);

		test.each(["name", "line1", "line2", "city", "postalCode", "phone"])(
			"the %s input is filled from addressValues and described by its error",
			(field) => {
				const input = new RegExp(`<input[^>]*name="${field}"[^>]*>`).exec(body)?.[0] ?? "";
				expect(input, field).toContain(`value={addressValues.${field}}`);
				expect(input, field).toContain(`aria-invalid={fieldErrors.${field} !== undefined}`);
				expect(body).toContain(`fieldErrors.${field} !== undefined && (`);
			},
		);

		test("the email input carries its error too", () => {
			const input = /<input[^>]*name="email"[^>]*>/.exec(body)?.[0] ?? "";
			expect(input).toContain("value={emailValue}");
			expect(input).toContain("aria-invalid={fieldErrors.email !== undefined}");
		});

		test("the country select and the region pick list are filled from the draft too", () => {
			expect(body).toMatch(/selected=\{option\.code === addressValues\.country\}/);
			// The region is the page's pick list for the draft's country, its
			// stored/typed code preselected (lib/regions.ts reads `us-ca` as CA).
			const region = /<select[^>]*name="region"[^>]*>[\s\S]*?<\/select>/.exec(body)?.[0] ?? "";
			expect(region).toContain('autocomplete="address-level1"');
			expect(region).toContain("aria-invalid={fieldErrors.region !== undefined}");
			expect(region).toMatch(/selected=\{option\.code === addressRegions\.selected\}/);
		});

		test("the refused code rides as a hidden refusedCoupon, from the page's model", () => {
			expect(body).toMatch(
				/<input[^>]*type="hidden"[^>]*name="refusedCoupon"[^>]*form="checkout-place"[^>]*value=\{refusedCouponCode\}/,
			);
		});

		test("Apply and Remove coupon submit the DETAILS form, without browser validation", () => {
			expect(body).toMatch(
				/<form method="POST" action="\/checkout\/place" class="checkout-details" id="checkout-place"/,
			);
			expect(body).toMatch(
				/<input[^>]*name="coupon"[^>]*form="checkout-place"|<input[^>]*form="checkout-place"[^>]*name="coupon"/,
			);
			expect(body).toMatch(
				/<button[^>]*form="checkout-place"[^>]*name="intent"[^>]*value="apply-coupon"[^>]*formnovalidate/,
			);
			expect(body).toMatch(
				/<button[^>]*form="checkout-place"[^>]*name="intent"[^>]*value="remove-coupon"[^>]*formnovalidate/,
			);
			// No GET form for the coupon any more: applying it must not drop the details.
			expect(body).not.toMatch(/<form[^>]*method="GET"[^>]*class="checkout-coupon"/);
		});
	},
);
