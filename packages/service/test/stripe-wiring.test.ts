import { cents, currency, idempotencyKey, orderId } from "@otta-sh/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { wireStripeGateway } from "../src/stripe-wiring.js";

// The inverse hazard of the live-createIntent change: a deployment with a
// STRIPE_WEBHOOK_SECRET but NO STRIPE_SECRET_KEY hands buyers OFFLINE (fake,
// unpayable) client secrets. That must be a loud boot warning — and NEVER a
// throw: staging / e2e run without a secret key and must keep working.

describe("wireStripeGateway (boot signal, never fail-closed)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("no STRIPE_WEBHOOK_SECRET ⇒ undefined (Stripe simply not configured), no warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(wireStripeGateway({})).toBeUndefined();
		expect(wireStripeGateway({ STRIPE_WEBHOOK_SECRET: "" })).toBeUndefined();
		expect(wireStripeGateway({ STRIPE_SECRET_KEY: "sk_test" })).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	test("webhook secret ONLY ⇒ a gateway with refundable:false + OFFLINE intents, and a loud warning about unpayable client secrets", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const gateway = wireStripeGateway({ STRIPE_WEBHOOK_SECRET: "whsec_x" });
		expect(gateway).toBeDefined();
		expect(gateway?.refundable).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0])).toMatch(/STRIPE_SECRET_KEY/);
		expect(String(warn.mock.calls[0])).toMatch(/offline|unpayable/i);
		// And it really is the offline deterministic handle.
		const intent = await gateway!.createIntent({
			orderId: orderId("ord-9"),
			amount: cents(1000),
			currency: currency("USD"),
			idempotencyKey: idempotencyKey("k-9"),
			lines: [{ title: "Widget", quantity: 1 }],
		});
		expect(intent.intentId).toBe("pi_ord-9");
	});

	test("webhook secret + STRIPE_SECRET_KEY ⇒ refundable:true (live intents), no warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const gateway = wireStripeGateway({
			STRIPE_WEBHOOK_SECRET: "whsec_x",
			STRIPE_SECRET_KEY: "sk_test_1",
		});
		expect(gateway?.refundable).toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});

	test("an EMPTY-STRING STRIPE_SECRET_KEY is treated as absent (offline + the warning)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const gateway = wireStripeGateway({ STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_SECRET_KEY: "" });
		expect(gateway?.refundable).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
	});
});
