/**
 * #603 — a refused POST lands back on its page with `?error=…`, and that
 * refusal has to REACH the shopper. Before this, the page came back with the
 * same <title>, focus at the top, and the notice a plain div — a screen-reader
 * user could not tell the order had not been placed.
 *
 * Three things, all without JavaScript (the checkout ships no script for it):
 *  - the document title says "Error: " first, so the reload announces it;
 *  - the notice is `role="alert"` + `tabindex="-1"` with a stable id;
 *  - every failure redirect carries that id as its fragment, so the browser
 *    scrolls to the notice and starts sequential focus from it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CheckoutSummaryView } from "@urumi.ai/otta-plugin";
import type { APIContext } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test, vi } from "vitest";

const { getEmDashEntry } = vi.hoisted(() => ({ getEmDashEntry: vi.fn() }));
vi.mock("emdash", () => ({ getEmDashEntry }));

import { seeOther } from "../src/lib/cart-actions.js";
import { countryOptions } from "../src/lib/countries.js";
import {
	CART_ERROR_ID,
	CHECKOUT_ERROR_ID,
	errorTitle,
	PRODUCT_ERROR_ID,
} from "../src/lib/error-notice.js";
import { regionChoice } from "../src/lib/regions.js";
import { POST as CART_ADD_POST } from "../src/pages/cart/add.js";
import { POST as CART_REMOVE_POST } from "../src/pages/cart/remove.js";
import { POST as CART_UPDATE_POST } from "../src/pages/cart/update.js";
import type { CartModel, CheckoutModel, ProductContentModel } from "../src/themes/contract.js";
import CartView from "../src/themes/tempered/CartView.astro";
import CheckoutView from "../src/themes/tempered/CheckoutView.astro";
import ProductView from "../src/themes/tempered/ProductView.astro";
import { SRC } from "./theme-views.js";

const SITE = "http://localhost:4321";

describe("errorTitle", () => {
	test('prefixes "Error: " exactly when the page shows an error', () => {
		expect(errorTitle("Checkout", true)).toBe("Error: Checkout");
		expect(errorTitle("Checkout", false)).toBe("Checkout");
	});
});

describe("each page titles itself through errorTitle", () => {
	test.each([
		["pages/checkout/index.astro", /title=\{errorTitle\(\s*"Checkout",/],
		["pages/cart/index.astro", /title=\{errorTitle\(\s*"Cart",/],
		["pages/products/[slug].astro", /title=\{errorTitle\(/],
	])("%s", (file, pattern) => {
		const source = readFileSync(path.join(SRC, file), "utf8");
		expect(source).toMatch(pattern);
	});
});

/** The opening tag of the element carrying `id`, or "" when none renders. */
function openTagWithId(html: string, id: string): string {
	return new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
}

function expectAnnouncedNotice(html: string, id: string, message: string): void {
	const open = openTagWithId(html, id);
	expect(open).not.toBe("");
	expect(open).toContain('role="alert"');
	expect(open).toContain('tabindex="-1"');
	expect(html.slice(html.indexOf(open))).toContain(message);
}

const amount = { state: "not_applicable", money: null, label: "—" } as const;

function checkoutModel(errorMessage: string | null): CheckoutModel {
	return {
		summary: {
			orderCreated: false,
			idempotencyKey: "checkout:c1",
			readyToPlace: true,
			requiresShipping: false,
			addressRequired: true,
			paymentAccountNeedsAddress: true,
			hasUnpricedLines: false,
			selection: { couponCode: null, shippingMethodId: null, destination: null },
			shipping: { status: "not_required", options: [], noOptions: false },
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
		errorMessage,
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
	};
}

function cartModel(errorMessage: string | null): CartModel {
	return {
		summary: null,
		errorMessage,
		degraded: false,
		degradedLead: "Your cart is unavailable right now.",
		pricingNotice: false,
		empty: true,
		terminal: false,
		placedOrderId: null,
		staleCurrency: null,
		showHoldTimer: false,
		lineViews: [],
		sumRows: [],
		totalAmount: { state: "not_calculated", money: null, label: "—" },
		partialNote: null,
	};
}

function productModel(errorMessage: string | null): ProductContentModel {
	return {
		state: "ok",
		title: "Otta Tee",
		description: null,
		art: "otta-tee",
		image: null,
		dimmed: false,
		degradedLead: null,
		errorMessage,
		errorAction: null,
		purchase: null,
		showNotForSale: true,
	};
}

describe("the views render the refusal as a focusable alert with the redirect's id", () => {
	let container: AstroContainer;
	beforeAll(async () => {
		container = await AstroContainer.create();
	});

	test("checkout", async () => {
		const html = await container.renderToString(CheckoutView, {
			props: { model: checkoutModel("Enter a valid email address.") },
		});
		expectAnnouncedNotice(html, CHECKOUT_ERROR_ID, "Enter a valid email address.");
		const clean = await container.renderToString(CheckoutView, {
			props: { model: checkoutModel(null) },
		});
		expect(openTagWithId(clean, CHECKOUT_ERROR_ID)).toBe("");
	});

	test("cart", async () => {
		const html = await container.renderToString(CartView, {
			props: { model: cartModel("That item is no longer available.") },
		});
		expectAnnouncedNotice(html, CART_ERROR_ID, "That item is no longer available.");
		const clean = await container.renderToString(CartView, { props: { model: cartModel(null) } });
		expect(openTagWithId(clean, CART_ERROR_ID)).toBe("");
	});

	test("product", async () => {
		const html = await container.renderToString(ProductView, {
			props: { model: productModel("There is not enough in stock.") },
		});
		expectAnnouncedNotice(html, PRODUCT_ERROR_ID, "There is not enough in stock.");
		const clean = await container.renderToString(ProductView, {
			props: { model: productModel(null) },
		});
		expect(openTagWithId(clean, PRODUCT_ERROR_ID)).toBe("");
	});
});

function postContext(
	pathname: string,
	form: Record<string, string>,
	answer: unknown = { ok: false, error: "OUT_OF_STOCK" },
): APIContext {
	const url = new URL(pathname, SITE);
	return {
		request: new Request(url, {
			method: "POST",
			headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form).toString(),
		}),
		url,
		cookies: {
			get: (name: string) => (name === "otta_cart" ? { value: "cart-1" } : undefined),
			set: () => {},
			delete: () => {},
		},
		locals: {
			emdash: {
				handlePublicPluginApiRoute: async () => ({ success: true, data: answer }),
			},
		},
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
}

describe("a refused POST redirects to the notice's fragment", () => {
	test("a refused cart update → #cart-error", async () => {
		const response = await CART_UPDATE_POST(
			postContext("/cart/update", { lineId: "l1", idempotencyKey: "k1", qty: "2" }),
		);
		expect(response.headers.get("location")).toBe("/cart?error=OUT_OF_STOCK#cart-error");
	});

	test("a refused cart remove → #cart-error", async () => {
		const response = await CART_REMOVE_POST(
			postContext(
				"/cart/remove",
				{ lineId: "l1", idempotencyKey: "k1" },
				{
					ok: false,
					error: "LINE_NOT_FOUND",
				},
			),
		);
		expect(response.headers.get("location")).toBe("/cart?error=LINE_NOT_FOUND#cart-error");
	});

	test("a refused PDP add → #product-error, a returnTo's own hash replaced, not doubled", async () => {
		const response = await CART_ADD_POST(
			postContext("/cart/add", {
				sku: "OTTA-TEE",
				idempotencyKey: "k1",
				qty: "99999",
				returnTo: "/products/otta-tee#reviews",
			}),
		);
		expect(response.headers.get("location")).toBe(
			"/products/otta-tee?error=QTY_TOO_LARGE#product-error",
		);
	});

	test("seeOther adds the fragment only beside an error", () => {
		const context = postContext("/cart/update", {});
		expect(seeOther(context, "/cart", undefined, CART_ERROR_ID).headers.get("location")).toBe(
			"/cart",
		);
		expect(seeOther(context, "/cart", "X", CART_ERROR_ID).headers.get("location")).toBe(
			"/cart?error=X#cart-error",
		);
		expect(seeOther(context, "/cart", "X").headers.get("location")).toBe("/cart?error=X");
	});
});
