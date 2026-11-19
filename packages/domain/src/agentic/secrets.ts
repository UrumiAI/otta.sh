import type { AgentSessionId } from "./model.js";

/** What a derived secret is for; part of the derivation input, so the two never collide. */
export type AgentSessionSecretPurpose = "order" | "handoff";

/**
 * Id minting, secret derivation, hashing and comparison for agent sessions,
 * injected so the domain stays IO-free (no `crypto` here). Tests inject a
 * deterministic fake; every adapter must pass `agentSessionSecretsContract`.
 *
 * Secrets are DERIVED, never stored: `order_secret = derive("order", id)` and
 * the hand-off token of link generation `g` is `derive("handoff", id, g)`. The
 * session stores only their hashes, and a replay re-derives the exact secret the
 * lost response carried.
 */
export interface AgentSessionSecrets {
	/**
	 * A fresh, unguessable session-id suffix: at least 128 random bits, base64url
	 * (at least 22 characters of `[A-Za-z0-9_-]`). The id is a bearer credential
	 * for reading the session, so a collision-free counter is not enough.
	 */
	mintId(): string;
	/**
	 * The secret for (`purpose`, `sessionId`, `generation`): deterministic, and
	 * unguessable without the server key (the adapter uses HMAC-SHA256 under a
	 * server secret, output base64url). `generation` is omitted for `"order"`.
	 */
	derive(
		purpose: AgentSessionSecretPurpose,
		sessionId: AgentSessionId,
		generation?: number,
	): Promise<string>;
	/** The stored form of a secret (SHA-256). Deterministic. */
	hash(secret: string): Promise<string>;
	/**
	 * Equality that takes the same time wherever the inputs first differ. Used
	 * only for secret hashes. Inputs of different lengths answer `false`; it
	 * never throws (unlike Node's bare `timingSafeEqual`).
	 */
	constantTimeEqual(a: string, b: string): boolean;
}
