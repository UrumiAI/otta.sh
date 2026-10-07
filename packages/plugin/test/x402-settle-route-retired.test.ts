/**
 * ADR-0028 increment 2: the public `entitlements/x402/settle` route is retired.
 *
 * It was the only surface that turned client-supplied JSON into a `page_gate`
 * confirmation, so its absence is half of Decision 2's invariant. This pins the
 * registration in Node, cheaply; `in-process-egress.sandbox.test.ts` pins the
 * same thing inside workerd, along with "no facilitator was asked".
 */
import { describe, expect, test } from "vitest";
import plugin from "../src/plugin.js";

describe("the retired x402 settle route (ADR-0028 increment 2)", () => {
	test("entitlements/x402/settle is not registered", () => {
		// Non-vacuous: the same lookup finds the Stripe settle route, so a miss
		// below is the deletion, not a wrong object. The array path keeps the
		// slashes from being read as anything but one key.
		expect(plugin.routes).toHaveProperty(["webhooks/stripe/settle"]);
		expect(plugin.routes).not.toHaveProperty(["entitlements/x402/settle"]);
	});
});
