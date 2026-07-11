import { describe, expect, test } from "vitest";
import { email } from "../money/ids.js";
import type { CustomerCredentialVerifier } from "../ports/credential-verifier.js";
import type { CustomerStore } from "../ports/customer-store.js";

export interface CredentialVerifierHarness {
	verifier: CustomerCredentialVerifier;
	/** The customer store the verifier get-or-creates against (for assertions). */
	customerStore: CustomerStore;
	advance(ms: number): void;
	/** The challenge TTL the harness built the verifier with. */
	challengeTtlMs: number;
}

export interface CredentialVerifierContractOptions {
	dialect: string;
}

/**
 * The reusable magic-link `CustomerCredentialVerifier` behavioral spec (§4/5.2):
 * issue → verify round trip (get-or-creates the customer), wrong/expired/
 * consumed token rejection (guards magic-link URL replay).
 */
export function credentialVerifierContract(
	makeHarness: () => Promise<CredentialVerifierHarness>,
	opts: CredentialVerifierContractOptions,
): void {
	const EMAIL = email("login@example.com");

	describe(`credentialVerifierContract [${opts.dialect}]`, () => {
		test("issueChallenge then verifyChallenge with the right token returns the customer id", async () => {
			const { verifier, customerStore } = await makeHarness();
			const { challengeId, token } = await verifier.issueChallenge(EMAIL);
			const result = await verifier.verifyChallenge(challengeId, token);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const customer = await customerStore.getByEmail(EMAIL);
				expect(customer?.id).toBe(result.customerId);
			}
		});

		test("verifyChallenge with the wrong token returns INVALID", async () => {
			const { verifier } = await makeHarness();
			const { challengeId } = await verifier.issueChallenge(EMAIL);
			const result = await verifier.verifyChallenge(challengeId, "not-the-token");
			expect(result).toEqual({ ok: false, reason: "INVALID" });
		});

		test("verifyChallenge for an unknown challenge id returns INVALID", async () => {
			const { verifier } = await makeHarness();
			expect(await verifier.verifyChallenge("no-such-challenge", "x")).toEqual({
				ok: false,
				reason: "INVALID",
			});
		});

		test("verifyChallenge with an expired token returns EXPIRED", async () => {
			const h = await makeHarness();
			const { challengeId, token } = await h.verifier.issueChallenge(EMAIL);
			h.advance(h.challengeTtlMs + 1);
			expect(await h.verifier.verifyChallenge(challengeId, token)).toEqual({
				ok: false,
				reason: "EXPIRED",
			});
		});

		test("verifyChallenge with an already-consumed token returns CONSUMED (guards URL replay)", async () => {
			const { verifier } = await makeHarness();
			const { challengeId, token } = await verifier.issueChallenge(EMAIL);
			const first = await verifier.verifyChallenge(challengeId, token);
			expect(first.ok).toBe(true);
			expect(await verifier.verifyChallenge(challengeId, token)).toEqual({
				ok: false,
				reason: "CONSUMED",
			});
		});
	});
}
