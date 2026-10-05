/**
 * A second checkout tab (QA2 X2). Two tabs reviewed the same cart; the first
 * placed the order. The second tab's submit replays THAT order on the cart's
 * stable key, and the order keeps the email the first tab gave it — so a
 * different email typed here was silently ignored and the shopper was sent on to
 * pay an order whose confirmation goes elsewhere.
 *
 * Now: when the plugin says the order's email is not the one typed
 * (`emailMatches: false`), place does NOT land on the pay page. It stashes the
 * order as usual (so "Continue to payment" works) and goes back to the locked
 * review with `ORDER_PLACED_OTHER_EMAIL`, which names the masked address and
 * offers to pay it or start a new cart. A normal place also stashes the masked
 * email, so the fresh pay page states where the confirmation goes, as the resume
 * path already did.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";
import { STOREFRONT_CHECKOUT_PLACE_ROUTE } from "@otta-sh/plugin";
import { readCheckoutStash } from "../src/lib/checkout-cookie.js";
import { lockedOtherEmailNotice } from "../src/lib/checkout-review.js";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";
import { templateOf } from "./astro-source.js";
import { SRC, viewCases } from "./theme-views.js";

vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
}));

const SITE = "http://localhost:4321";

function placed(emailMatches: boolean) {
	return {
		ok: true,
		orderId: "order-1",
		state: "pending",
		alreadyPlaced: false,
		clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_abc" },
		total: { amount: 4000, currency: "USD", formatted: "$40.00" },
		buyerRefHint: "j•••@e•••.com",
		emailMatches,
	};
}

function run(placeResult: unknown) {
	const handler = async (_id: string, _method: string, routePath: string) =>
		routePath.replace(/^\//, "") === STOREFRONT_CHECKOUT_PLACE_ROUTE
			? { success: true, data: placeResult }
			: { success: false };
	const url = new URL("/checkout/place", SITE);
	const request = new Request(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE },
		body: new URLSearchParams({
			email: "other@mailbox.test",
			idempotencyKey: "checkout:cart-existing",
		}).toString(),
	});
	const jar = new Map<string, string>([["otta_cart", "cart-existing"]]);
	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
			set: (name: string, value: string) => void jar.set(name, value),
			delete: (name: string) => void jar.delete(name),
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	return { context, stash: () => readCheckoutStash(context.cookies) };
}

describe("POST /checkout/place — the order's email", () => {
	test("a normal place stashes the masked email, so the pay page states where the confirmation goes", async () => {
		const { context, stash } = run(placed(true));
		const response = await PLACE_POST(context);
		expect(response.headers.get("location")).toBe("/checkout/pay");
		expect(stash()?.emailHint).toBe("j•••@e•••.com");
	});

	test("an order another tab placed with a DIFFERENT email: back to the review, never the pay page", async () => {
		const { context, stash } = run(placed(false));
		const response = await PLACE_POST(context);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/checkout?error=ORDER_PLACED_OTHER_EMAIL");
		// Stashed like any place, so "Continue to payment" pays THIS order.
		expect(stash()).toMatchObject({ orderId: "order-1", emailHint: "j•••@e•••.com" });
	});
});

describe("lockedOtherEmailNotice — the locked review says which email the order has", () => {
	const LOCKED = { id: "order-1" };

	test("names the masked address from this order's stash", () => {
		const notice = lockedOtherEmailNotice("ORDER_PLACED_OTHER_EMAIL", LOCKED, {
			orderId: "order-1",
			clientSecret: "s",
			emailHint: "j•••@e•••.com",
		});
		expect(notice).toContain("j•••@e•••.com");
		expect(notice).toMatch(/another tab/i);
		expect(notice).toMatch(/new cart/i);
	});

	test("without a usable stash it still says so, naming no address", () => {
		const notice = lockedOtherEmailNotice("ORDER_PLACED_OTHER_EMAIL", LOCKED, null);
		expect(notice).toMatch(/another tab/i);
		expect(notice).not.toContain("•••");
		expect(
			lockedOtherEmailNotice("ORDER_PLACED_OTHER_EMAIL", LOCKED, {
				orderId: "another-order",
				clientSecret: "s",
				emailHint: "x•••@y•••.com",
			}),
		).not.toContain("x•••");
	});

	test("any other token, or an unlocked review, shows nothing", () => {
		expect(lockedOtherEmailNotice(null, LOCKED, null)).toBeNull();
		expect(lockedOtherEmailNotice("CHECKOUT_STALE", LOCKED, null)).toBeNull();
		expect(lockedOtherEmailNotice("ORDER_PLACED_OTHER_EMAIL", null, null)).toBeNull();
	});

	test("the token has copy for an unlocked review too (a cart that rotated in between)", () => {
		expect(cartErrorMessage("ORDER_PLACED_OTHER_EMAIL")).toMatch(/already placed/i);
	});
});

describe("the checkout page and view", () => {
	test("the page hands the view the notice, read from this order's stash", () => {
		const page = readFileSync(path.join(SRC, "pages/checkout/index.astro"), "utf8");
		expect(page).toContain("lockedOtherEmailNotice(");
		expect(page).toContain("readCheckoutStash(");
	});

	test.each(viewCases("checkout"))(
		"%s prints the locked notice from the model",
		(_l, { source }) => {
			expect(templateOf(source)).toContain("locked.otherEmailNotice");
		},
	);
});
