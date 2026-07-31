import { createTestFacilitator, X402PaymentGateway } from "@otta-sh/payments-x402";

/** The x402 slice of the service env (review G4). */
export interface X402Env {
	X402_PAYTO?: string | undefined;
	X402_FACILITATOR_SECRET?: string | undefined;
	X402_ACCEPTS?: string | undefined;
	X402_ALLOW_TEST_FACILITATOR?: string | undefined;
}

/**
 * Wire the x402 gateway from env — FAIL CLOSED (review G4).
 *
 * The only facilitator this bin can currently wire is `createTestFacilitator`:
 * an OFFLINE shared-secret HMAC check, NOT a real x402 facilitator
 * verification — anyone holding (or guessing a deployment leaked)
 * `X402_FACILITATOR_SECRET` can mint a "verified" proof and settle any
 * same-priced order. So configuring `X402_PAYTO` + `X402_FACILITATOR_SECRET`
 * WITHOUT the explicit `X402_ALLOW_TEST_FACILITATOR=true` opt-in refuses to
 * start (a thrown Error, never a silently-armed gateway), and the opt-in path
 * warns loudly at startup that it is not production-safe. A production
 * deployment replaces this with a real `HTTPFacilitatorClient`-backed
 * `X402Facilitator` (the seam is `X402PaymentGateway`'s injected
 * `facilitator`), at which point the opt-in gate stops applying to it.
 *
 * @returns the gateway, or `undefined` when x402 is simply not configured.
 * @throws when x402 IS configured but the test-facilitator opt-in is absent.
 */
export function wireX402Gateway(env: X402Env): X402PaymentGateway | undefined {
	const payTo = env.X402_PAYTO;
	const secret = env.X402_FACILITATOR_SECRET;
	if (payTo === undefined || payTo.length === 0 || secret === undefined || secret.length === 0) {
		return undefined; // x402 not configured — nothing to wire.
	}
	if (env.X402_ALLOW_TEST_FACILITATOR !== "true") {
		throw new Error(
			"x402 is configured (X402_PAYTO + X402_FACILITATOR_SECRET) but the only available " +
				"facilitator is the OFFLINE TEST facilitator (shared-secret HMAC, no real x402 " +
				"verification) — refusing to start. Set X402_ALLOW_TEST_FACILITATOR=true ONLY for " +
				"non-production environments, or wire a real HTTPFacilitatorClient-backed facilitator.",
		);
	}
	console.warn(
		"[service] ⚠ x402 is using createTestFacilitator (X402_ALLOW_TEST_FACILITATOR=true): " +
			"offline shared-secret HMAC verification — NOT production-safe. Any holder of " +
			"X402_FACILITATOR_SECRET can forge a settling proof.",
	);
	return new X402PaymentGateway({
		facilitator: createTestFacilitator(secret),
		payTo,
		accepts: (env.X402_ACCEPTS ?? "eip155:8453").split(","),
	});
}
