import { describe, expect, test } from "vitest";
import { email, type Email } from "../money/ids.js";
import type { CustomerCredentialVerifier } from "../ports/credential-verifier.js";
import type { CustomerStore } from "../ports/customer-store.js";

export interface CredentialVerifierHarness {
	verifier: CustomerCredentialVerifier;
	/** The customer store the verifier get-or-creates against (for assertions). */
	customerStore: CustomerStore;
	advance(ms: number): void;
	/** The harness clock's current instant (ISO-8601) — what the adapters see. */
	now(): string;
	/** The challenge TTL the harness built the verifier with. */
	challengeTtlMs: number;
	/** The per-email active-challenge cap the harness built the verifier with
	 *  (review round H1) — the throttle case issues exactly this many first. */
	maxActiveChallenges: number;
}

export interface CredentialVerifierContractOptions {
	dialect: string;
}

/** Issue a challenge that MUST succeed (narrows the H1 union for the happy-path
 *  cases, which never operate anywhere near the throttle cap). */
async function issue(
	verifier: CustomerCredentialVerifier,
	to: Email,
): Promise<{ challengeId: string; token: string }> {
	const res = await verifier.issueChallenge(to);
	if (!res.ok) throw new Error(`issueChallenge unexpectedly throttled: ${res.reason}`);
	return { challengeId: res.challengeId, token: res.token };
}

/**
 * The reusable magic-link `CustomerCredentialVerifier` behavioral spec (§4/5.2):
 * issue → verify round trip (get-or-creates the customer), wrong/expired/
 * consumed token rejection (guards magic-link URL replay), the per-email
 * rate-limit window, and the consumed/expired-row prune (review round H1).
 */
export function credentialVerifierContract(
	makeHarness: () => Promise<CredentialVerifierHarness>,
	opts: CredentialVerifierContractOptions,
): void {
	const EMAIL = email("login@example.com");

	describe(`credentialVerifierContract [${opts.dialect}]`, () => {
		test("issueChallenge then verifyChallenge with the right token returns the customer id", async () => {
			const { verifier, customerStore } = await makeHarness();
			const { challengeId, token } = await issue(verifier, EMAIL);
			const result = await verifier.verifyChallenge(challengeId, token);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const customer = await customerStore.getByEmail(EMAIL);
				expect(customer?.id).toBe(result.customerId);
			}
		});

		test("verifyChallenge with the wrong token returns INVALID", async () => {
			const { verifier } = await makeHarness();
			const { challengeId } = await issue(verifier, EMAIL);
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
			const { challengeId, token } = await issue(h.verifier, EMAIL);
			h.advance(h.challengeTtlMs + 1);
			expect(await h.verifier.verifyChallenge(challengeId, token)).toEqual({
				ok: false,
				reason: "EXPIRED",
			});
		});

		test("verifyChallenge with an already-consumed token returns CONSUMED (guards URL replay)", async () => {
			const { verifier } = await makeHarness();
			const { challengeId, token } = await issue(verifier, EMAIL);
			const first = await verifier.verifyChallenge(challengeId, token);
			expect(first.ok).toBe(true);
			expect(await verifier.verifyChallenge(challengeId, token)).toEqual({
				ok: false,
				reason: "CONSUMED",
			});
		});

		// -- review round H1: per-email rate limit + prune ----------------------

		test("rapid repeat requests hit the per-email cap: the Nth issues no new challenge (THROTTLED)", async () => {
			const h = await makeHarness();
			for (let i = 0; i < h.maxActiveChallenges; i++) {
				expect((await h.verifier.issueChallenge(EMAIL)).ok).toBe(true);
			}
			// The cap is per EMAIL, so the Nth request for THIS address is refused…
			expect(await h.verifier.issueChallenge(EMAIL)).toEqual({
				ok: false,
				reason: "THROTTLED",
			});
			// …while a different address is unaffected (not a global limiter).
			expect((await h.verifier.issueChallenge(email("other@example.com"))).ok).toBe(true);
		});

		test("consuming a challenge frees the throttle window; expiry frees it too", async () => {
			const h = await makeHarness();
			const first = await issue(h.verifier, EMAIL);
			for (let i = 1; i < h.maxActiveChallenges; i++) {
				await issue(h.verifier, EMAIL);
			}
			expect(await h.verifier.issueChallenge(EMAIL)).toEqual({ ok: false, reason: "THROTTLED" });
			// Consume one → one slot frees.
			expect((await h.verifier.verifyChallenge(first.challengeId, first.token)).ok).toBe(true);
			expect((await h.verifier.issueChallenge(EMAIL)).ok).toBe(true);
			// Let the rest expire → the window fully resets.
			h.advance(h.challengeTtlMs + 1);
			expect((await h.verifier.issueChallenge(EMAIL)).ok).toBe(true);
		});

		test("pruneChallenges removes consumed and expired rows, not live ones", async () => {
			const h = await makeHarness();
			// One consumed…
			const consumed = await issue(h.verifier, EMAIL);
			await h.verifier.verifyChallenge(consumed.challengeId, consumed.token);
			// …one expired…
			await issue(h.verifier, email("expiring@example.com"));
			h.advance(h.challengeTtlMs + 1);
			// …one live (issued after the advance).
			const live = await issue(h.verifier, email("live@example.com"));

			expect(await h.verifier.pruneChallenges(h.now())).toBe(2);
			expect(await h.verifier.pruneChallenges(h.now())).toBe(0); // idempotent
			// The live challenge survived the prune and still verifies.
			expect((await h.verifier.verifyChallenge(live.challengeId, live.token)).ok).toBe(true);
		});
	});
}
