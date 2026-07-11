import type { CustomerId, Email } from "../money/ids.js";
import type { LoginFailure } from "../customers/errors.js";

/**
 * `issueChallenge` outcome (review round H1). `THROTTLED` = the per-email
 * active-challenge cap is hit: no new challenge is inserted and no email is
 * sent — but the HTTP response the caller returns stays IDENTICAL to the
 * success case (§9 Risk 4: throttling must not become an enumeration or
 * probing oracle any more than account existence may).
 */
export type IssueChallengeResult =
	| {
			ok: true;
			challengeId: string;
			/** The one-time plaintext token to embed in the emailed magic link.
			 *  Stored only as a hash (§4); returned here once so the caller can
			 *  email it. */
			token: string;
	  }
	| { ok: false; reason: "THROTTLED" };

export type VerifyChallengeResult =
	| { ok: true; customerId: CustomerId }
	| { ok: false; reason: LoginFailure };

/**
 * The `CustomerCredentialVerifier` port (Phase 5 §4) — **mechanism-specific**:
 * this is the only surface that changes when the auth mechanism changes
 * (magic-link → password/passkey). The v1 adapter is magic-link (§4 draft ADR):
 * `issueChallenge` mints a one-time emailable token (rate-limited per email —
 * at most N unconsumed, unexpired challenges may exist for one address, §9
 * Risk 4); `verifyChallenge` redeems it once, resolving (get-or-create) the
 * customer for the challenge's email. Per-IP limiting is deliberately NOT this
 * port's concern — it is gateway-layer scope (ADR-0004).
 */
export interface CustomerCredentialVerifier {
	issueChallenge(email: Email): Promise<IssueChallengeResult>;
	verifyChallenge(challengeId: string, token: string): Promise<VerifyChallengeResult>;
	/**
	 * Delete consumed and expired challenges (review round H1: the table must
	 * not grow unboundedly). Returns the number of rows removed. Driven by the
	 * same cron/internal-trigger precedent as the email outbox dispatcher.
	 */
	pruneChallenges(now: string): Promise<number>;
}
