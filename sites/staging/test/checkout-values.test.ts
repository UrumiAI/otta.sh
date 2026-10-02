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
import { ORDER_ADDRESS_MAX_LENGTHS, STOREFRONT_CHECKOUT_PLACE_ROUTE } from "@otta-sh/plugin";
import { afterEach, describe, expect, test, vi } from "vitest";
import { splitAstro, templateOf } from "./astro-source.js";
import { viewSources } from "./theme-views.js";
import {
	CHECKOUT_DRAFT_COOKIE,
	CHECKOUT_DRAFT_MAX_AGE_SECONDS,
	fieldErrorCopy,
	readCheckoutDraft,
	shownFieldErrors,
	writeCheckoutDraft,
	type CheckoutDraft,
} from "../src/lib/checkout-draft.js";

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
		return route === STOREFRONT_CHECKOUT_PLACE_ROUTE
			? { success: true, data: reply }
			: { success: false };
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

	test("a draft too large for a cookie is not written at all — never a truncated one", () => {
		const sets: CookieSet[] = [];
		const huge = "一".repeat(200);
		writeCheckoutDraft(
			{ set: (name, value, options) => sets.push({ name, value, options: { ...options } }) },
			{
				values: { name: huge, line1: huge, line2: huge, city: huge, email: "a@b.co" },
				errors: {},
			},
		);
		for (const set of sets) expect(encodeURIComponent(set.value).length).toBeLessThan(4000);
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
		expect(fieldErrorCopy("line1", "too_long")).toBe(
			`Too long — use at most ${ORDER_ADDRESS_MAX_LENGTHS.line1} characters.`,
		);
		expect(fieldErrorCopy("country", "invalid")).toBe("Choose a country from the list.");
		expect(fieldErrorCopy("region", "invalid")).toBe(
			"Use a state/province code, e.g. CA — or leave it blank.",
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

	test("Enter in a field with the APPLIED code still in the coupon box places the order", async () => {
		const h = harness(
			{ ...FULL, couponCode: "SAVE10", intent: "apply-coupon", coupon: "SAVE10" },
			PLACED,
		);
		const response = await PLACE_POST(h.context);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(h.calls).toHaveLength(1);
	});

	test("a cross-site Apply is refused like any other place POST", async () => {
		const h = harness({ ...FULL, intent: "apply-coupon", coupon: "X" }, PLACED);
		(h.context.request.headers as Headers).set("origin", "https://evil.example");
		const response = await PLACE_POST(h.context);
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
		// Enter in a details field submits through Apply (the form's first submit
		// button), which falls through to a place when the coupon is unchanged — so
		// a changed but un-updated delivery must not be placed at the old price.
		const h = harness(
			{
				...ZONED,
				intent: "apply-coupon",
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

describe("Enter in a details field (the coupon box's Apply is the form's default button)", () => {
	test("the Apply button comes before Continue to payment in the page, so it IS the default button", () => {
		for (const view of viewSources("checkout")) {
			const body = templateOf(view.source);
			const apply = body.indexOf('value="apply-coupon"');
			const cont = body.indexOf("Continue to payment");
			expect(apply, view.file).toBeGreaterThan(-1);
			expect(apply, view.file).toBeLessThan(cont);
		}
	});

	test("with the APPLIED code still in the box, Enter places the order (pinned above too)", async () => {
		const h = harness(
			{ ...FULL, couponCode: "SAVE10", intent: "apply-coupon", coupon: "SAVE10" },
			PLACED,
		);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout/pay");
	});

	test("with a DIFFERENT code typed in the box, Enter applies that code first and places nothing", async () => {
		const h = harness(
			{ ...FULL, couponCode: "SAVE10", intent: "apply-coupon", coupon: "SAVE20" },
			PLACED,
		);
		expect((await PLACE_POST(h.context)).headers.get("location")).toBe("/checkout?coupon=SAVE20");
		expect(h.calls).toHaveLength(0);
	});
});

// ── the page reads it back; the view prints it ──────────────────────────────

describe("/checkout reads the draft back", () => {
	const page = splitAstro(read("pages/checkout/index.astro")).frontmatter;

	test("the draft is read, and ignored once the cart is an order", () => {
		expect(page).toMatch(
			/const draft = locked === null \? readCheckoutDraft\(Astro\.cookies\) : null;/,
		);
	});

	test("typed values win over the account's email; the fields get the draft's values", () => {
		expect(page).toMatch(/emailValue: draft\?\.values\.email \?\? accountEmail \?\? ""/);
		expect(page).toMatch(/addressValues: draftAddressValues\(draft\)/);
		expect(page).toMatch(/fieldErrors: shownFieldErrors\(draft, shownError\)/);
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

		test("the country select and the region input are filled from the draft too", () => {
			expect(body).toMatch(/selected=\{option\.code === addressValues\.country\}/);
			const region = /<input[^>]*name="region"[^>]*autocomplete="address-level1"[^>]*>/g;
			const typed = [...body.matchAll(region)]
				.map((m) => m[0])
				.find((m) => !m.includes("delivery-region"));
			expect(typed).toContain("value={addressValues.region}");
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
