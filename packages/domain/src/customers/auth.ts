import type { Clock } from "../ports/clock.js";
import type {
	CustomerCredentialVerifier,
	IssueChallengeResult,
} from "../ports/credential-verifier.js";
import type { CustomerStore } from "../ports/customer-store.js";
import type { OrderStore } from "../ports/order-store.js";
import type { SessionStore } from "../ports/session-store.js";
import type { CustomerId, Email } from "../money/ids.js";
import type { LoginFailure } from "./errors.js";

export interface RequestLoginDeps {
	credentialVerifier: CustomerCredentialVerifier;
}

/** `ok:true` carries the challenge + the one-time token to embed in the emailed
 *  magic link (emailed by the service route, never returned to an API client);
 *  `THROTTLED` (review round H1) means the per-email cap is hit — issue nothing,
 *  email nothing, but respond identically. */
export type RequestLoginResult = IssueChallengeResult;

/**
 * Begin a magic-link login (Phase 5 §7). Issues a challenge for a never-seen
 * email too (first login creates the account on verify), so there is **no
 * account-existence oracle** (§9 Risk 4): the route returns an identical
 * "if an account exists, we've sent a link" response regardless — including
 * when the request is rate-limited (`THROTTLED` must not be observable either).
 */
export async function requestLogin(
	deps: RequestLoginDeps,
	input: { email: Email },
): Promise<RequestLoginResult> {
	return deps.credentialVerifier.issueChallenge(input.email);
}

export interface VerifyLoginDeps {
	credentialVerifier: CustomerCredentialVerifier;
	customerStore: CustomerStore;
	sessionStore: SessionStore;
	orderStore: OrderStore;
	clock: Clock;
}

export type VerifyLoginResult =
	| { ok: true; sessionToken: string; expiresAt: string; customerId: CustomerId }
	| { ok: false; reason: LoginFailure };

/**
 * Redeem a magic-link token (Phase 5 §7). On success: mark the email verified,
 * **link any guest orders** with a matching `buyer_ref` (§9 Risk 3 — safe
 * because the login already proved inbox ownership), and mint a session. The
 * session token is the only credential returned; everything downstream depends
 * solely on `SessionStore.validate`.
 */
export async function verifyLogin(
	deps: VerifyLoginDeps,
	input: { challengeId: string; token: string },
): Promise<VerifyLoginResult> {
	const verified = await deps.credentialVerifier.verifyChallenge(input.challengeId, input.token);
	if (!verified.ok) return { ok: false, reason: verified.reason };

	const customer = await deps.customerStore.get(verified.customerId);
	if (customer !== null) {
		if (customer.emailVerifiedAt === null) {
			await deps.customerStore.update(verified.customerId, {
				emailVerifiedAt: deps.clock.now().toISOString(),
			});
		}
		// Claim any guest orders placed under this email before the account existed.
		await deps.orderStore.linkGuestOrders(verified.customerId, customer.email);
	}

	const session = await deps.sessionStore.create(verified.customerId);
	return {
		ok: true,
		sessionToken: session.token,
		expiresAt: session.expiresAt,
		customerId: verified.customerId,
	};
}
