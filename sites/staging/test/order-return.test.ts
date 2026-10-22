/**
 * Stripe's return to the confirmation page (ADR-0012, 2026-10-22 amendment).
 *
 * Stripe appends `payment_intent`, `payment_intent_client_secret` and
 * `redirect_status` to the `return_url`. With the store's publishable key, that
 * client secret reads the PaymentIntent back — amount, card brand and last four,
 * and the `shipping` block (the buyer's name and address). So the page no longer
 * keeps them in its URL: on arrival it records the two it uses (the intent id and
 * the status, never the secret) in a short-lived HttpOnly cookie for THIS order,
 * and 303s to the bare `/orders/<id>`. Everything that used to read the query now
 * reads that record.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { CookieSetOptions } from "../src/lib/checkout-cookie.js";
import {
	ORDER_RETURN_COOKIE_NAME,
	ORDER_RETURN_MAX_AGE_SECONDS,
	hasStripeReturn,
	orderPathWithoutStripeReturn,
	readStripeReturn,
	recordStripeReturn,
} from "../src/lib/order-return.js";
import { splitAstro } from "./astro-source.js";

const ORDER = "6382b183-3b01-44cb-a026-956790c93b7e";
const PI = "pi_3UTJ6dCj0uRYMHMb0AgMYwoF";
const SECRET = `${PI}_secret_mue2elY2oPWCGYSRgjstbYRjD`;

function stripeReturnUrl(extra = ""): URL {
	return new URL(
		`https://shop.example/orders/${ORDER}?payment_intent=${PI}&payment_intent_client_secret=${SECRET}&redirect_status=succeeded${extra}`,
	);
}

function jar(initial?: string) {
	let value = initial;
	const sets: { name: string; value: string; options: CookieSetOptions }[] = [];
	return {
		sets,
		get: (name: string) =>
			name === ORDER_RETURN_COOKIE_NAME && value !== undefined ? { value } : undefined,
		set(name: string, next: string, options: CookieSetOptions) {
			sets.push({ name, value: next, options });
			value = next;
		},
	};
}

describe("hasStripeReturn", () => {
	test("true when Stripe's parameters are on the URL", () => {
		expect(hasStripeReturn(stripeReturnUrl())).toBe(true);
	});

	test("true for any one of the three — a partial set is still scrubbed", () => {
		for (const name of ["payment_intent", "payment_intent_client_secret", "redirect_status"]) {
			expect(hasStripeReturn(new URL(`https://shop.example/orders/${ORDER}?${name}=x`))).toBe(true);
		}
	});

	test("false for the bare order URL and for the page's own parameters", () => {
		expect(hasStripeReturn(new URL(`https://shop.example/orders/${ORDER}`))).toBe(false);
		expect(hasStripeReturn(new URL(`https://shop.example/orders/${ORDER}?error=BUSY`))).toBe(false);
	});
});

describe("orderPathWithoutStripeReturn", () => {
	test("drops Stripe's three parameters and nothing else", () => {
		expect(orderPathWithoutStripeReturn(stripeReturnUrl())).toBe(`/orders/${ORDER}`);
		expect(orderPathWithoutStripeReturn(stripeReturnUrl("&error=BUSY"))).toBe(
			`/orders/${ORDER}?error=BUSY`,
		);
	});

	test("is a same-origin path — never an absolute URL another host could be put into", () => {
		expect(orderPathWithoutStripeReturn(stripeReturnUrl()).startsWith("/")).toBe(true);
		expect(orderPathWithoutStripeReturn(stripeReturnUrl()).startsWith("//")).toBe(false);
	});
});

describe("recordStripeReturn / readStripeReturn", () => {
	test("records the intent id and the status for this order — never the client secret", () => {
		const cookies = jar();
		recordStripeReturn(cookies, ORDER, stripeReturnUrl());
		expect(cookies.sets).toHaveLength(1);
		const [set] = cookies.sets;
		expect(set?.value).not.toContain("secret");
		expect(set?.value).not.toContain(SECRET);
		expect(readStripeReturn(cookies, ORDER)).toEqual({ paymentIntent: PI, status: "succeeded" });
	});

	test("HttpOnly, Secure, SameSite=Lax, scoped to the order pages, short-lived", () => {
		const cookies = jar();
		recordStripeReturn(cookies, ORDER, stripeReturnUrl());
		expect(cookies.sets[0]?.options).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/orders/",
			maxAge: ORDER_RETURN_MAX_AGE_SECONDS,
		});
		expect(ORDER_RETURN_MAX_AGE_SECONDS).toBeLessThanOrEqual(60 * 60);
	});

	test("a record for another order is not this order's return", () => {
		const cookies = jar();
		recordStripeReturn(cookies, "another-order", stripeReturnUrl());
		expect(readStripeReturn(cookies, ORDER)).toBeNull();
	});

	test("no cookie, or a malformed one, is no return", () => {
		expect(readStripeReturn(jar(), ORDER)).toBeNull();
		for (const raw of [
			"",
			ORDER,
			`${ORDER}/`,
			`${ORDER}/pi_x`,
			`${ORDER}/<script>:succeeded`,
			`${ORDER}/pi_x:Succeeded!`,
		]) {
			expect(readStripeReturn(jar(raw), ORDER)).toBeNull();
		}
	});

	test("a malformed intent id or status on the URL is not recorded", () => {
		for (const query of [
			"payment_intent=nope&redirect_status=succeeded",
			`payment_intent=${PI}&redirect_status=<b>`,
			`payment_intent_client_secret=${SECRET}`,
		]) {
			const cookies = jar();
			recordStripeReturn(cookies, ORDER, new URL(`https://shop.example/orders/${ORDER}?${query}`));
			expect(cookies.sets).toEqual([]);
		}
	});
});

describe("the order page scrubs the return before it renders", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const source = readFileSync(path.join(here, "../src/pages/orders/[orderId].astro"), "utf8");
	const { frontmatter } = splitAstro(source);

	test("it 303s to the bare order path when Stripe's parameters are present", () => {
		expect(frontmatter).toMatch(/if \(hasStripeReturn\(Astro\.url\)\)/);
		const scrub =
			/if \(hasStripeReturn\(Astro\.url\)\) \{[\s\S]*?\n\}/.exec(frontmatter)?.[0] ?? "";
		expect(scrub).toMatch(/recordStripeReturn\(Astro\.cookies, orderId, Astro\.url\)/);
		expect(scrub).toMatch(/status: 303/);
		expect(scrub).toMatch(/Location: orderPathWithoutStripeReturn\(Astro\.url\)/);
		// It sets a cookie, so no shared cache may keep it.
		expect(scrub).toMatch(/"Cache-Control": PRIVATE_NO_STORE/);
	});

	test("it redirects BEFORE the order is read — no commerce call for a URL it is about to drop", () => {
		expect(frontmatter.indexOf("hasStripeReturn(Astro.url)")).toBeLessThan(
			frontmatter.indexOf("dispatchOttaRoute<"),
		);
	});

	test("it no longer reads Stripe's parameters from its own query", () => {
		expect(frontmatter).not.toMatch(
			/searchParams\.(get|has)\(\s*["'](payment_intent|redirect_status)/,
		);
		expect(frontmatter).toContain("readStripeReturn(Astro.cookies");
	});
});
