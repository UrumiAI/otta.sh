import type { CustomerId } from "../money/ids.js";

export interface Session {
	/** The opaque bearer token handed to the client. NEVER stored in plaintext —
	 *  the adapter persists only its hash (§4), so a DB read can't leak a usable
	 *  session. */
	token: string;
	expiresAt: string;
}

/**
 * The `SessionStore` port (Phase 5 §4) — **mechanism-agnostic**: everything
 * downstream of `validate` (`/me`, `/me/orders`, `/me/addresses`) depends only
 * on this, never on the credential verifier, so swapping magic-link for passkey
 * later touches zero session/authorization code. Opaque DB-backed tokens (not
 * JWT) so revocation actually works (§9 decision 5).
 */
export interface SessionStore {
	create(customerId: CustomerId): Promise<Session>;
	/** The session's customer, or null if the token is unknown, expired, or
	 *  revoked. The sole authority on identity for every `/me/*` handler. */
	validate(token: string): Promise<CustomerId | null>;
	revoke(token: string): Promise<void>;
}
