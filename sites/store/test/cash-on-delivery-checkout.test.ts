/**
 * ADR-0044 at checkout — the site's half of cash on delivery:
 *
 *  - decision C1: COD is offered (the review) and accepted (`/checkout/place`)
 *    only where the site's per-IP write limit runs (`RATE_LIMIT_WRITES`), and a
 *    COD place carries the client's network key (`clientKey`);
 *  - decision D: only for a cart with something to deliver, and only with a full
 *    delivery address and a phone — refused here with the fields marked;
 *  - the review's button says "Continue to payment" only where card is offered,
 *    and with a choice follows the checked radio by CSS alone (review finding 9).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STOREFRONT_CHECKOUT_PLACE_ROUTE, type CheckoutSummaryView } from "@urumi.ai/otta-plugin";
import type { APIContext } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { env } from "./helpers/virtual-emdash-env.js";

const offered = vi.hoisted(() => ({ methods: ["stripe", "cod"] as string[] }));
vi.mock("../src/lib/stripe-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/stripe-config.js")>()),
	readCheckoutPaymentConfig: async () => ({
		state: "ok",
		methods: offered.methods,
		codInstructions: null,
	}),
}));

import { CHECKOUT_DRAFT_COOKIE, readCheckoutDraft } from "../src/lib/checkout-draft.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { countryOptions } from "../src/lib/countries.js";
import { COD_ATTEST_HEADER, COD_ATTEST_VALUE } from "@urumi.ai/otta-plugin";
import { codPlaceHeaders, hasWriteLimit, refuseCodAttestHeader } from "../src/lib/rate-limit.js";
import { regionChoice } from "../src/lib/regions.js";
import { checkoutMethodsFor } from "../src/lib/stripe-config.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";
import type { CheckoutModel } from "../src/themes/contract.js";
import CheckoutView from "../src/themes/tempered/CheckoutView.astro";

const SITE = "http://localhost:4321";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const LIMITER = { limit: async () => ({ success: true }) };

afterEach(() => {
	delete env["RATE_LIMIT_WRITES"];
	offered.methods = ["stripe", "cod"];
});

describe("the write-limit precondition (decision C1)", () => {
	test("hasWriteLimit is the RATE_LIMIT_WRITES binding — and does not fail open", () => {
		expect(hasWriteLimit(undefined)).toBe(false);
		expect(hasWriteLimit({})).toBe(false);
		expect(hasWriteLimit({ RATE_LIMIT_WRITES: "not a binding" })).toBe(false);
		expect(hasWriteLimit({ RATE_LIMIT_AUTH: LIMITER })).toBe(false);
		expect(hasWriteLimit({ RATE_LIMIT_WRITES: LIMITER })).toBe(true);
	});

	test("codPlaceHeaders: the attestation and the client's address, only with the binding (ADR-0044 §7)", () => {
		const v4 = new Headers({ "cf-connecting-ip": "203.0.113.7" });
		expect(codPlaceHeaders({ RATE_LIMIT_WRITES: LIMITER }, v4)).toEqual({
			[COD_ATTEST_HEADER]: COD_ATTEST_VALUE,
			"cf-connecting-ip": "203.0.113.7",
		});
		const pseudo = new Headers({
			"cf-connecting-ip": "240.0.0.1",
			"cf-connecting-ipv6": "2001:db8:1:2:3:4:5:6",
		});
		expect(codPlaceHeaders({ RATE_LIMIT_WRITES: LIMITER }, pseudo)).toMatchObject({
			"cf-connecting-ipv6": "2001:db8:1:2:3:4:5:6",
		});
		expect(codPlaceHeaders({}, v4)).toBeNull();
		expect(codPlaceHeaders({ RATE_LIMIT_WRITES: LIMITER }, new Headers())).toBeNull();
	});

	test("the middleware refuses ANY incoming request that carries the attestation header", async () => {
		for (const route of [
			"/_emdash/api/plugins/otta/storefront/checkout/place",
			"/checkout/place",
			"/",
		]) {
			const refused = refuseCodAttestHeader(
				new Request(new URL(route, SITE), {
					method: "POST",
					headers: { [COD_ATTEST_HEADER]: COD_ATTEST_VALUE },
				}),
			);
			expect(refused?.status, route).toBe(400);
		}
		expect(refuseCodAttestHeader(new Request(new URL("/", SITE)))).toBeNull();
	});
});

describe("checkoutMethodsFor — which methods THIS checkout offers", () => {
	test("COD needs the write limit AND a cart that ships; card is untouched", () => {
		const both = ["stripe", "cod"] as const;
		expect(checkoutMethodsFor(both, { writeLimit: true, ships: true })).toEqual({
			methods: ["stripe", "cod"],
			codWithheld: null,
		});
		expect(checkoutMethodsFor(both, { writeLimit: false, ships: true })).toEqual({
			methods: ["stripe"],
			codWithheld: "no-write-limit",
		});
		expect(checkoutMethodsFor(["cod"], { writeLimit: true, ships: false })).toEqual({
			methods: [],
			codWithheld: "nothing-ships",
		});
		expect(checkoutMethodsFor(["stripe"], { writeLimit: false, ships: false })).toEqual({
			methods: ["stripe"],
			codWithheld: null,
		});
	});

	test("the review page filters by the binding and the summary's requiresShipping", () => {
		const page = readFileSync(path.join(SRC, "pages/checkout/index.astro"), "utf8");
		expect(page).toContain('import { env } from "virtual:emdash/env";');
		expect(page).toMatch(
			/checkoutMethodsFor\(paymentConfig\.methods, \{\s*writeLimit: hasWriteLimit\(env\),\s*ships: summary\.requiresShipping,/,
		);
		expect(page).toContain("const paymentConfigured = offered.methods.length > 0;");
	});
});

interface Call {
	route: string;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

const COD_PLACED = {
	ok: true,
	orderId: "order-1",
	state: "awaiting_payment",
	alreadyPlaced: false,
	clientAction: { kind: "offline" },
	total: { amount: 4000, currency: "USD", formatted: "$40.00" },
};

const ADDRESS = {
	name: "Ada Lovelace",
	line1: "1 Road",
	city: "Pune",
	postalCode: "411001",
	country: "IN",
};

async function place(
	form: Record<string, string>,
	opts: { placeResult?: unknown; ip?: string | null } = {},
): Promise<{ response: Response; calls: Call[]; cookies: Map<string, string> }> {
	const calls: Call[] = [];
	const handler = async (_id: string, _method: string, routePath: string, request: Request) => {
		const route = routePath.replace(/^\//, "");
		calls.push({
			route,
			body: (await request.json()) as Record<string, unknown>,
			headers: Object.fromEntries(request.headers.entries()),
		});
		return route === STOREFRONT_CHECKOUT_PLACE_ROUTE
			? { success: true, data: opts.placeResult ?? COD_PLACED }
			: { success: false };
	};
	const url = new URL("/checkout/place", SITE);
	const headers: Record<string, string> = {
		origin: SITE,
		"content-type": "application/x-www-form-urlencoded",
	};
	const ip = opts.ip === undefined ? "203.0.113.7" : opts.ip;
	if (ip !== null) headers["cf-connecting-ip"] = ip;
	const cookies = new Map<string, string>([["otta_cart", "cart-1"]]);
	const context = {
		request: new Request(url, {
			method: "POST",
			headers,
			body: new URLSearchParams({
				email: "buyer@example.com",
				idempotencyKey: "checkout:cart-1",
				...form,
			}).toString(),
		}),
		url,
		cookies: {
			get: (name: string) => {
				const value = cookies.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => void cookies.set(name, value),
			delete: (name: string) => void cookies.delete(name),
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	const response = await PLACE_POST(context);
	return { response, calls, cookies };
}

const placeCalls = (calls: Call[]): Call[] =>
	calls.filter((call) => call.route === STOREFRONT_CHECKOUT_PLACE_ROUTE);

function landed(response: Response): URL {
	return new URL(response.headers.get("location") ?? "", SITE);
}

function draftOf(cookies: Map<string, string>) {
	return readCheckoutDraft({
		get: (name: string) =>
			name === CHECKOUT_DRAFT_COOKIE ? { value: cookies.get(name) ?? "" } : undefined,
	});
}

describe("/checkout/place — cash on delivery", () => {
	test("without the RATE_LIMIT_WRITES binding COD is refused PAYMENT_METHOD_UNAVAILABLE — nothing is placed", async () => {
		const { response, calls, cookies } = await place({
			paymentMethod: "cod",
			...ADDRESS,
			phone: "+91 98765 43210",
		});
		expect(response.status).toBe(303);
		expect(landed(response).searchParams.get("error")).toBe("PAYMENT_METHOD_UNAVAILABLE");
		expect(placeCalls(calls)).toHaveLength(0);
		// The choice comes back with what was typed.
		expect(draftOf(cookies)?.method).toBe("cod");
	});

	test("with the binding but no client address to key, COD is refused too", async () => {
		env["RATE_LIMIT_WRITES"] = LIMITER;
		const { response, calls } = await place(
			{ paymentMethod: "cod", ...ADDRESS, phone: "+91 98765 43210" },
			{ ip: null },
		);
		expect(landed(response).searchParams.get("error")).toBe("PAYMENT_METHOD_UNAVAILABLE");
		expect(placeCalls(calls)).toHaveLength(0);
	});

	test("with the binding, COD places with the client's network key and lands on the order", async () => {
		env["RATE_LIMIT_WRITES"] = LIMITER;
		const { response, calls } = await place({
			paymentMethod: "cod",
			...ADDRESS,
			phone: "+91 98765 43210",
		});
		const [call] = placeCalls(calls);
		expect(call?.body).toMatchObject({
			paymentMethod: "cod",
			shippingAddress: { ...ADDRESS, phone: "+91 98765 43210" },
		});
		// The proof rides the in-process request's HEADERS, never the body.
		expect(call?.body).not.toHaveProperty("clientKey");
		expect(call?.headers).toMatchObject({
			[COD_ATTEST_HEADER]: COD_ATTEST_VALUE,
			"cf-connecting-ip": "203.0.113.7",
		});
		expect(response.headers.get("location")).toBe("/orders/order-1");
	});

	test("a card place never carries a client key", async () => {
		env["RATE_LIMIT_WRITES"] = LIMITER;
		const { calls } = await place(
			{ paymentMethod: "stripe" },
			{
				placeResult: {
					...COD_PLACED,
					state: "pending",
					clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_x" },
				},
			},
		);
		const [call] = placeCalls(calls);
		expect(call?.body["paymentMethod"]).toBe("stripe");
		expect(call?.body).not.toHaveProperty("clientKey");
		expect(call?.headers).not.toHaveProperty(COD_ATTEST_HEADER);
	});

	test("COD with no address is MISSING_SHIPPING_ADDRESS, every blank field and the phone marked", async () => {
		env["RATE_LIMIT_WRITES"] = LIMITER;
		const { response, calls, cookies } = await place({ paymentMethod: "cod" });
		expect(landed(response).searchParams.get("error")).toBe("MISSING_SHIPPING_ADDRESS");
		expect(placeCalls(calls)).toHaveLength(0);
		const draft = draftOf(cookies);
		expect(draft?.method).toBe("cod");
		expect(draft?.errors).toMatchObject({
			name: "missing",
			line1: "missing",
			city: "missing",
			postalCode: "missing",
			country: "missing",
			phone: "missing",
		});
	});

	test("COD with an address but no phone is SHIPPING_PHONE_REQUIRED, the phone marked, the delivery option kept", async () => {
		env["RATE_LIMIT_WRITES"] = LIMITER;
		const { response, calls, cookies } = await place({
			paymentMethod: "cod",
			...ADDRESS,
			shippingMethodId: "std",
		});
		const url = landed(response);
		expect(url.searchParams.get("error")).toBe("SHIPPING_PHONE_REQUIRED");
		expect(url.searchParams.get("method")).toBe("std");
		expect(placeCalls(calls)).toHaveLength(0);
		expect(draftOf(cookies)?.errors).toEqual({ phone: "missing" });
	});

	test("the plugin's own SHIPPING_PHONE_REQUIRED marks the phone too", async () => {
		env["RATE_LIMIT_WRITES"] = LIMITER;
		const { response, cookies } = await place(
			{ paymentMethod: "cod", ...ADDRESS, phone: "+91 98765 43210" },
			{ placeResult: { ok: false, reason: "SHIPPING_PHONE_REQUIRED" } },
		);
		expect(landed(response).searchParams.get("error")).toBe("SHIPPING_PHONE_REQUIRED");
		expect(draftOf(cookies)?.errors).toEqual({ phone: "missing" });
	});

	test("a card place needs no phone and no address", async () => {
		const { calls } = await place(
			{ paymentMethod: "stripe" },
			{
				placeResult: {
					...COD_PLACED,
					state: "pending",
					clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_x" },
				},
			},
		);
		expect(placeCalls(calls)).toHaveLength(1);
	});
});

describe("buyer copy for the COD refusals", () => {
	test.each([
		["PAYMENT_METHOD_UNAVAILABLE", /isn't available for this order/],
		["OFFLINE_NEEDS_PHYSICAL", /only available for orders with items we deliver/],
		["OFFLINE_ORDER_LIMIT", /isn't available for this order right now/],
		["SHIPPING_PHONE_REQUIRED", /phone number for cash on delivery/],
	])("%s says what happened and what to do", (token, copy) => {
		expect(cartErrorMessage(token)).toMatch(copy);
		expect(cartErrorMessage(token)).not.toBe(cartErrorMessage("SOMETHING_UNKNOWN"));
	});

	test("OFFLINE_ORDER_LIMIT is neutral: it never implies the buyer has orders open", () => {
		const copy = cartErrorMessage("OFFLINE_ORDER_LIMIT");
		expect(copy).toMatch(/choose another payment method/);
		expect(copy).not.toMatch(/already|waiting|earlier order|you have/i);
	});
});

const amount = { state: "not_applicable", money: null, label: "—" } as const;

function model(overrides: Partial<CheckoutModel> = {}): CheckoutModel {
	const card = { value: "stripe", label: "Card", note: "Pay by card." } as const;
	const cod = { value: "cod", label: "Cash on delivery", note: "Pay the courier." } as const;
	return {
		summary: {
			orderCreated: false,
			idempotencyKey: "checkout:c1",
			readyToPlace: true,
			requiresShipping: true,
			addressRequired: false,
			paymentAccountNeedsAddress: false,
			hasUnpricedLines: false,
			selection: { couponCode: null, shippingMethodId: null, destination: null },
			shipping: { status: "no_zones", options: [], noOptions: false },
			totals: {
				subtotal: amount,
				discount: amount,
				shipping: amount,
				tax: amount,
				total: amount,
				appliedCouponCode: null,
				totalExcludesUncalculated: false,
			},
		} as unknown as CheckoutSummaryView,
		errorMessage: null,
		checkedOut: false,
		locked: null,
		ended: false,
		couponValue: "",
		refusedCouponCode: null,
		couponError: null,
		destinationError: null,
		shippingError: null,
		noOptionsCopy: "",
		destination: null,
		destinationName: null,
		destinationRegionName: null,
		regionRefused: false,
		countryRefused: false,
		countryValue: "",
		regionValue: "",
		countries: countryOptions("en-US"),
		deliveryRegions: regionChoice("", "", "en-US"),
		deliveryRegionRequired: false,
		regionRequiredCountries: [],
		addressRegions: regionChoice("", "", "en-US"),
		showDelivery: false,
		showAddress: true,
		buyerLocation: false,
		chosenOption: null,
		notReadyCopy: "",
		paymentConfigured: true,
		paymentMethods: [card, cod],
		chosenMethod: "stripe",
		codDetails: "when-chosen",
		notConfiguredLead: "",
		emailValue: "",
		emailNote: "",
		addressValues: {
			name: "",
			line1: "",
			line2: "",
			city: "",
			postalCode: "",
			country: "",
			region: "",
			phone: "",
		},
		fieldErrors: {},
		ledgerRows: [],
		sumRows: [],
		footnote: null,
		...overrides,
	};
}

/** The place button's markup. */
function submitOf(html: string): string {
	return /<button[^>]*data-testid="place-submit"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
}
/** The phone field's label. */
function phoneLabel(html: string): string {
	return /<label[^>]*for="address-phone"[^>]*>[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
}

describe("the review (CheckoutView) — cash on delivery", () => {
	let container: AstroContainer;
	beforeAll(async () => {
		container = await AstroContainer.create();
	});
	const render = (m: CheckoutModel): Promise<string> =>
		container.renderToString(CheckoutView, { props: { model: m } });

	test("card and COD: both labels, toggled by the checked radio (CSS, no script)", async () => {
		const html = await render(model());
		const submit = submitOf(html);
		expect(submit).toMatch(/<span class="checkout-submit-card">Continue to payment<\/span>/);
		expect(submit).toMatch(/<span class="checkout-submit-cod">Place order<\/span>/);
		// The page adds no script for it.
		expect(html).not.toMatch(/<script/);
		const css = readFileSync(path.join(SRC, "themes/tempered/commerce.css"), "utf8");
		expect(css).toMatch(/\.checkout-submit-cod \{\s*display: none;/);
		expect(css).toMatch(
			/\.checkout-details:has\(input\[name="paymentMethod"\]\[value="cod"\]:checked\)\s*\.checkout-submit-cod \{\s*display: inline;/,
		);
		expect(css).toMatch(
			/\.checkout-details:has\(input\[name="paymentMethod"\]\[value="cod"\]:checked\)\s*\.checkout-submit-card \{\s*display: none;/,
		);
	});

	test("COD alone: 'Place order', never 'Continue to payment'", async () => {
		const html = await render(
			model({
				paymentMethods: [{ value: "cod", label: "Cash on delivery", note: "Pay the courier." }],
				chosenMethod: "cod",
				codDetails: "always",
			}),
		);
		expect(submitOf(html)).toContain("Place order");
		expect(html).not.toContain("Continue to payment");
		expect(html).toMatch(/<input type="hidden" name="paymentMethod" value="cod"/);
	});

	test("card alone: 'Continue to payment' only", async () => {
		const html = await render(
			model({
				paymentMethods: [{ value: "stripe", label: "Card", note: "Pay by card." }],
				codDetails: null,
			}),
		);
		expect(submitOf(html)).toContain("Continue to payment");
		expect(submitOf(html)).not.toContain("Place order");
		expect(phoneLabel(html)).not.toContain("required");
	});

	test("the radio checks the chosen method — a refused COD place comes back on COD", async () => {
		const html = await render(model({ chosenMethod: "cod" }));
		const radio = (value: string) =>
			new RegExp(`<input[^>]*name="paymentMethod"[^>]*value="${value}"[^>]*>`).exec(html)?.[0] ??
			"";
		expect(radio("cod")).toContain("checked");
		expect(radio("stripe")).not.toContain("checked");
	});

	test("COD alone: the address and phone are required, on a store with no zones", async () => {
		const html = await render(
			model({
				paymentMethods: [{ value: "cod", label: "Cash on delivery", note: "Pay the courier." }],
				chosenMethod: "cod",
				codDetails: "always",
			}),
		);
		expect(phoneLabel(html)).toMatch(/<span class="checkout-req">required<\/span>/);
		expect(html).toMatch(/<input[^>]*id="address-phone"[^>]*aria-required="true"/);
		expect(html).toMatch(/<input[^>]*id="address-line1"[^>]*aria-required="true"/);
		expect(html).toContain("Required for cash on delivery");
		expect(html).not.toContain("leave it entirely blank");
	});

	test("card and COD: the address and phone say they are required for cash on delivery", async () => {
		const html = await render(model());
		expect(phoneLabel(html)).toContain("required for cash on delivery");
		expect(html).toMatch(
			/<label[^>]*for="address-line1"[^>]*>[\s\S]*?required for cash on delivery/,
		);
		expect(html).toContain("Optional for card payment");
	});

	// The locked review exists only for a pending CARD order: "Continue to
	// payment" there needs card on offer, not merely some method configured.
	const locked = {
		id: "o1",
		resumeHref: "/checkout/pay?order=o1",
		otherEmailNotice: null,
	} as const;

	test("locked, card offered: 'Continue to payment' links to the resume path", async () => {
		const html = await render(model({ locked }));
		expect(html).toMatch(
			/<a class="u-btn" href="\/checkout\/pay\?order=o1">\s*Continue to payment/,
		);
		expect(html).not.toContain("Card payment isn't set up");
	});

	test("locked, COD alone: no 'Continue to payment'; the card notice says it can't be paid", async () => {
		const html = await render(
			model({
				locked,
				paymentConfigured: true,
				paymentMethods: [{ value: "cod", label: "Cash on delivery", note: "Pay the courier." }],
				chosenMethod: "cod",
				codDetails: "always",
			}),
		);
		expect(html).not.toContain("Continue to payment");
		expect(html).toContain(
			"Card payment isn't set up on this store, so this order can't be paid right now.",
		);
	});

	test("locked, nothing configured: the card notice", async () => {
		const html = await render(
			model({ locked, paymentConfigured: false, paymentMethods: [], codDetails: null }),
		);
		expect(html).not.toContain("Continue to payment");
		expect(html).toContain("Card payment isn't set up on this store");
	});

	test("a refused phone is marked beside the field", async () => {
		const html = await render(
			model({ fieldErrors: { phone: "Enter a phone number — it's needed for cash on delivery." } }),
		);
		expect(html).toMatch(/<input[^>]*id="address-phone"[^>]*aria-invalid="true"/);
		expect(html).toMatch(/id="phone-error"[^>]*>\s*Enter a phone number/);
	});
});
