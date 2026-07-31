/**
 * C8 (storefront-checkout plan §3) — the build-time Stripe publishable key and
 * the site's own `buyerRef` guard.
 *
 * ── Why test 8b exists at all ─────────────────────────────────────────────
 * "The key is absent" and "we read the wrong variable name" are
 * INDISTINGUISHABLE at runtime: both render "Card payment isn't set up on this
 * store yet.", nothing throws, and no test fails. An earlier draft of the plan
 * named this variable `STRIPE_PUBLISHABLE_KEY`; implemented literally it would
 * have shipped that message to every buyer while a valid `pk_test_…` sat
 * unread in `~/.otta-deploy.env`. So the variable NAME is pinned as test
 * data, the config module is pinned to read that spelling and no other, and a
 * present-but-malformed value THROWS at build (mirroring `resolveServiceUrl`'s
 * "throw early rather than bake garbage") — leaving quiet degradation as the
 * behaviour for a genuinely unprovisioned key, and only that.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { isPlausibleEmail } from "../src/lib/email.js";
import { resolveStripePublishableKey, STRIPE_PUBLIC_KEY_VAR } from "../src/lib/stripe-config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASTRO_CONFIG = readFileSync(path.resolve(HERE, "../astro.config.ts"), "utf8");
const ENV_EXAMPLE = readFileSync(path.resolve(HERE, "../.env.example"), "utf8");

describe("8a — resolveStripePublishableKey", () => {
	test("returns a valid pk_test_ key unchanged", () => {
		expect(resolveStripePublishableKey("pk_test_51AbCdEf0123456789")).toBe(
			"pk_test_51AbCdEf0123456789",
		);
	});

	test("accepts a pk_live_ key too (a live storefront is a legitimate build)", () => {
		expect(resolveStripePublishableKey("pk_live_51AbCdEf0123456789")).toBe(
			"pk_live_51AbCdEf0123456789",
		);
	});

	test("trims surrounding whitespace (a value pasted into .env keeps its newline otherwise)", () => {
		expect(resolveStripePublishableKey("  pk_test_abc123  ")).toBe("pk_test_abc123");
	});

	test.each([[undefined], [""], ["   "]])(
		"an ABSENT key (%p) resolves to undefined — never a placeholder that would half-boot Stripe.js",
		(raw) => {
			expect(resolveStripePublishableKey(raw)).toBeUndefined();
		},
	);
});

describe("8b — the loud-failure guards", () => {
	test("the variable name is EXACTLY the provisioned one: STRIPE_PUBLIC_KEY", () => {
		// Pinned as DATA. `~/.otta-deploy.env` carries STRIPE_PUBLIC_KEY;
		// STRIPE_PUBLISHABLE_KEY appears nowhere in our provisioning.
		expect(STRIPE_PUBLIC_KEY_VAR).toBe("STRIPE_PUBLIC_KEY");
	});

	test("astro.config reads STRIPE_PUBLIC_KEY and never STRIPE_PUBLISHABLE_KEY", () => {
		expect(ASTRO_CONFIG).toContain("STRIPE_PUBLIC_KEY");
		expect(ASTRO_CONFIG).not.toContain("STRIPE_PUBLISHABLE_KEY");
	});

	test(".env.example documents that exact spelling, and not the wrong one", () => {
		expect(ENV_EXAMPLE).toContain("STRIPE_PUBLIC_KEY");
		expect(ENV_EXAMPLE).not.toContain("STRIPE_PUBLISHABLE_KEY");
	});

	test.each([
		["garbage"],
		["sk_test_thisIsASECRETkey"],
		["pk_wrong_123"],
		["PK_TEST_123"],
		["pk_test_"],
	])("a PRESENT-but-malformed value (%p) THROWS at build rather than silently degrading", (raw) => {
		expect(() => resolveStripePublishableKey(raw)).toThrow(/STRIPE_PUBLIC_KEY/);
	});

	test("BOTH halves of the degraded state exist: the review page hides the button AND the endpoint refuses to create an order", () => {
		// Hiding the button alone is a UI convention, not a guarantee — a direct
		// POST would still hold stock for 15 minutes against a payment that
		// cannot happen.
		const page = readFileSync(path.resolve(HERE, "../src/pages/checkout/index.astro"), "utf8");
		const endpoint = readFileSync(path.resolve(HERE, "../src/pages/checkout/place.ts"), "utf8");
		expect(page).toContain("STRIPE_PUBLISHABLE_KEY");
		expect(endpoint).toContain("STRIPE_PUBLISHABLE_KEY === undefined");
	});

	test("the throw names the variable but NEVER echoes the value (a mistyped secret key must not reach a build log)", () => {
		let message = "";
		try {
			resolveStripePublishableKey("sk_test_SUPERSECRETVALUE");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("STRIPE_PUBLIC_KEY");
		expect(message).not.toContain("SUPERSECRETVALUE");
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
