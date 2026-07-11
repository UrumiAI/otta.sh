import { afterEach, describe, expect, test, vi } from "vitest";
import { wireX402Gateway } from "../src/x402-wiring.js";

// Review G4: enabling X402_PAYTO + X402_FACILITATOR_SECRET used to silently
// wire createTestFacilitator — an OFFLINE shared-secret HMAC "verifier" — into
// the production bin, so a forged proof could settle any same-priced order.
// The bin must FAIL CLOSED: the test facilitator is wired only under an
// explicit, alarmingly-named opt-in.

describe("wireX402Gateway (fail-closed env wiring)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns undefined (x402 not configured) when payTo or the facilitator secret is missing", () => {
		expect(wireX402Gateway({})).toBeUndefined();
		expect(wireX402Gateway({ X402_PAYTO: "0xABC" })).toBeUndefined();
		expect(wireX402Gateway({ X402_FACILITATOR_SECRET: "s" })).toBeUndefined();
		expect(wireX402Gateway({ X402_PAYTO: "0xABC", X402_FACILITATOR_SECRET: "" })).toBeUndefined();
	});

	test("FAILS CLOSED: payTo + secret WITHOUT the explicit opt-in throws at startup, naming the opt-in", () => {
		expect(() =>
			wireX402Gateway({ X402_PAYTO: "0xABC", X402_FACILITATOR_SECRET: "s3cret" }),
		).toThrowError(/X402_ALLOW_TEST_FACILITATOR/);
		// Any value other than the literal "true" is still fail-closed.
		expect(() =>
			wireX402Gateway({
				X402_PAYTO: "0xABC",
				X402_FACILITATOR_SECRET: "s3cret",
				X402_ALLOW_TEST_FACILITATOR: "1",
			}),
		).toThrowError(/X402_ALLOW_TEST_FACILITATOR/);
	});

	test("with X402_ALLOW_TEST_FACILITATOR=true it wires the gateway and warns loudly that this is NOT production-safe", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const gateway = wireX402Gateway({
			X402_PAYTO: "0xABC",
			X402_FACILITATOR_SECRET: "s3cret",
			X402_ALLOW_TEST_FACILITATOR: "true",
			X402_ACCEPTS: "eip155:8453,eip155:1",
		});
		expect(gateway).toBeDefined();
		expect(gateway?.id).toBe("x402");
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0])).toMatch(/not.*production/i);
	});
});
