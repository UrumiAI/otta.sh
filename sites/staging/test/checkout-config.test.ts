/**
 * C8 (storefront-checkout plan §3) — the Stripe publishable key and the site's
 * own `buyerRef` guard.
 *
 * ── The key is a Settings value now (issue #498) ──────────────────────────
 * It used to be baked in at build time from `STRIPE_PUBLIC_KEY`, which an
 * operator with only the admin could not set. The plugin now holds it (entered
 * in Settings, shape-checked on save and on read) and the checkout pages read it
 * per request through `readStripePublishableKey`.
 *
 * What the old build check guarded still holds, and is pinned here: "no key"
 * (a store that has not connected Stripe) is the ONLY way to reach "Card payment
 * isn't set up" — a read that FAILED is `unavailable`, which the pages answer as
 * busy — and a build that still sets the old variable fails loudly instead of
 * looking like configuration (site-config.test.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STOREFRONT_PAYMENT_CONFIG_ROUTE } from "@urumi.ai/otta-plugin";
import { describe, expect, test } from "vitest";
import { isPlausibleEmail } from "../src/lib/email.js";
import { readStripePublishableKey } from "../src/lib/stripe-config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE = readFileSync(path.resolve(HERE, "../.env.example"), "utf8");
const SITE = new URL("http://localhost:4321/checkout");

/** A fake public dispatcher answering the payment-config route from a script
 *  (the last answer repeats); `null` answers with a non-success envelope. */
function answering(...answers: unknown[]): { handler: never; routes: string[] } {
	const routes: string[] = [];
	const handler = async (_id: string, _method: string, route: string) => {
		routes.push(route.replace(/^\//, ""));
		const data = answers[Math.min(routes.length - 1, answers.length - 1)];
		return data === null ? { success: false } : { success: true, data };
	};
	return { handler: handler as never, routes };
}

describe("8a — readStripePublishableKey", () => {
	test("a stored key is configured, read from the plugin's payment-config route", async () => {
		const { handler, routes } = answering({ ok: true, stripePublishableKey: "pk_live_51Abc0123" });
		expect(await readStripePublishableKey(handler, SITE)).toEqual({
			state: "configured",
			key: "pk_live_51Abc0123",
		});
		expect(routes).toEqual([STOREFRONT_PAYMENT_CONFIG_ROUTE]);
	});

	test("no stored key is unconfigured — the one way to 'card payment isn't set up'", async () => {
		const { handler } = answering({ ok: true, stripePublishableKey: null });
		expect(await readStripePublishableKey(handler, SITE)).toEqual({ state: "unconfigured" });
	});

	test("BUSY twice (the one allowlisted retry spent) is unavailable, not unconfigured", async () => {
		const busy = { ok: false, error: "BUSY", retryable: true };
		const { handler, routes } = answering(busy, busy);
		expect(await readStripePublishableKey(handler, SITE)).toEqual({ state: "unavailable" });
		expect(routes).toHaveLength(2);
	});

	test("BUSY then an answer is the answer (it is a read, so it is retried once)", async () => {
		const { handler } = answering(
			{ ok: false, error: "BUSY", retryable: true },
			{ ok: true, stripePublishableKey: "pk_test_51Abc0123" },
		);
		expect((await readStripePublishableKey(handler, SITE)).state).toBe("configured");
	});

	test.each([
		["a render failure", { ok: false, error: "RENDER_FAILED" }],
		["a failed envelope", null],
	])("%s is unavailable", async (_name, answer) => {
		const { handler } = answering(answer);
		expect(await readStripePublishableKey(handler, SITE)).toEqual({ state: "unavailable" });
	});

	test("no dispatcher at all is unavailable", async () => {
		expect(await readStripePublishableKey(undefined, SITE)).toEqual({ state: "unavailable" });
	});
});

describe("8b — the guards around the degraded state", () => {
	test("BOTH halves of 'not set up' exist: the review hides the button AND the endpoint refuses to create an order", () => {
		// Hiding the button alone is a UI convention, not a guarantee — a direct
		// POST would still hold stock for 15 minutes against a payment that
		// cannot happen.
		const page = readFileSync(path.resolve(HERE, "../src/pages/checkout/index.astro"), "utf8");
		const endpoint = readFileSync(path.resolve(HERE, "../src/pages/checkout/place.ts"), "utf8");
		expect(page).toContain("readStripePublishableKey");
		expect(endpoint).toContain('stripeKey.state === "unconfigured"');
	});

	test("every page answers an UNAVAILABLE read as busy, never as 'not set up'", () => {
		for (const file of ["index.astro", "place.ts", "pay.astro"]) {
			const source = readFileSync(path.resolve(HERE, `../src/pages/checkout/${file}`), "utf8");
			expect(source, file).toContain('stripeKey.state === "unavailable"');
		}
	});

	test(".env.example no longer offers STRIPE_PUBLIC_KEY as a setting", () => {
		expect(ENV_EXAMPLE).not.toMatch(/^#?\s*STRIPE_PUBLIC_KEY=/m);
	});
});

describe("8c — isPlausibleEmail (the buyerRef guard nothing upstream provides)", () => {
	// The service accepts ANY non-empty string up to 320 chars
	// (`schemas.ts`: z.string().min(1).max(320), no regex), and the consequences
	// of a typo are not cosmetic: ADR-0004's guest-order claiming matches on
	// buyer_ref, so a bad address yields an order no customer can ever claim,
	// and ADR-0005's order emails are addressed from it. The order is immutable,
	// so there is no self-service repair.
	test.each([
		["a@b.co"],
		["A.B+tag@Example.co.uk"],
		["buyer@sub.domain.example.com"],
		["first.last@example.museum"],
		["x@y.zz"],
		["  padded@example.com  "],
	])("accepts the realistic address %p", (raw) => {
		expect(isPlausibleEmail(raw)).toBe(true);
	});

	test.each([
		[""],
		["   "],
		["asdf"],
		["jo@"],
		["a@b"],
		["a b@c.com"],
		["a@b."],
		["a@.com"],
		["a@@b.com"],
		["@b.com"],
		["a@b..com"],
		["a\t@b.com"],
	])("rejects the malformed input %p", (raw) => {
		expect(isPlausibleEmail(raw)).toBe(false);
	});

	test("rejects an address past the service's own 320-character bound", () => {
		expect(isPlausibleEmail(`${"a".repeat(315)}@b.com`)).toBe(false);
	});

	test("TRIMS but NEVER lowercases — the service stores buyer_ref verbatim and claiming is already case-insensitive", () => {
		// The guard is a predicate; the normalization it sanctions is trim only.
		// This is the pin that stops a future "helpful" .toLowerCase().
		const source = readFileSync(path.resolve(HERE, "../src/lib/email.ts"), "utf8");
		expect(source).toContain(".trim()");
		expect(source).not.toContain("toLowerCase");
	});
});
