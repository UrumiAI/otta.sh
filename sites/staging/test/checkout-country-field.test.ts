/**
 * A country code that is shaped like one but names no country ("ZZ") is refused
 * at the site, before any dispatch, with the COUNTRY field marked (QA2 edge H).
 * It used to reach the plugin, come back INVALID_SHIPPING_ADDRESS, and mark no
 * field — "please check the delivery address" with nothing to look at.
 */
import { describe, expect, test, vi } from "vitest";
import type { APIContext } from "astro";
import { readCheckoutDraft } from "../src/lib/checkout-draft.js";
import { POST as PLACE_POST } from "../src/pages/checkout/place.js";

vi.mock("../src/lib/stripe-config.js", () => ({
	STRIPE_PUBLIC_KEY_VAR: "STRIPE_PUBLIC_KEY",
	resolveStripePublishableKey: (raw: string | undefined) => raw,
	STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
}));

const SITE = "http://localhost:4321";

function post(form: Record<string, string>) {
	const calls: string[] = [];
	const handler = async (_id: string, _method: string, routePath: string) => {
		calls.push(routePath);
		return { success: false };
	};
	const url = new URL("/checkout/place", SITE);
	const jar = new Map<string, string>([["otta_cart", "cart-existing"]]);
	const context = {
		request: new Request(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE },
			body: new URLSearchParams(form).toString(),
		}),
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
	return { context, calls };
}

const FORM = {
	email: "buyer@example.com",
	idempotencyKey: "checkout:cart-existing",
	name: "A Buyer",
	line1: "1 Test St",
	city: "Testville",
	postalCode: "90001",
};

describe("an unknown country code", () => {
	test("ZZ is refused here, never dispatched, with the country field marked", async () => {
		const { context, calls } = post({ ...FORM, country: "ZZ" });
		const response = await PLACE_POST(context);
		expect(response.headers.get("location")).toBe("/checkout?error=INVALID_SHIPPING_ADDRESS");
		expect(calls).toHaveLength(0);
		expect(readCheckoutDraft(context.cookies)?.errors).toEqual({ country: "invalid" });
	});

	test("a real code in any case still goes through to the plugin", async () => {
		const { context, calls } = post({ ...FORM, country: "us" });
		await PLACE_POST(context);
		expect(calls).toHaveLength(1);
	});
});
