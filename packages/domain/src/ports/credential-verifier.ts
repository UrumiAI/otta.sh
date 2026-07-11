import type { CustomerId, Email } from "../money/ids.js";
import type { LoginFailure } from "../customers/errors.js";

export interface IssueChallengeResult {
	challengeId: string;
	/** The one-time plaintext token to embed in the emailed magic link. Stored
	 *  only as a hash (§4); returned here once so the caller can email it. */
	token: string;
}

export type VerifyChallengeResult =
	| { ok: true; customerId: CustomerId }
	| { ok: false; reason: LoginFailure };

/**
 * The `CustomerCredentialVerifier` port (Phase 5 §4) — **mechanism-specific**:
 * this is the only surface that changes when the auth mechanism changes
 * (magic-link → password/passkey). The v1 adapter is magic-link (§4 draft ADR):
 * `issueChallenge` mints a one-time emailable token; `verifyChallenge` redeems
 * it once, resolving (get-or-create) the customer for the challenge's email.
 */
export interface CustomerCredentialVerifier {
	issueChallenge(email: Email): Promise<IssueChallengeResult>;
	verifyChallenge(challengeId: string, token: string): Promise<VerifyChallengeResult>;
}
