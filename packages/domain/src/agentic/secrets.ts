import type { AgentSessionId } from "./model.js";

/** What a derived secret is for; part of the derivation input, so the two never collide. */
export type AgentSessionSecretPurpose = "order" | "handoff";

/**
 * The shortest server key an {@link AgentSessionSecrets} adapter accepts, in
 * bytes (256 bits, the HMAC-SHA256 output size). An adapter refuses to
 * construct under an empty or shorter key: a keyless or weakly keyed derive
 * would make every `order_secret` and hand-off token computable from the
 * session id, which agents and shoppers both hold.
 */
export const AGENT_SESSION_MIN_SERVER_KEY_BYTES = 32;

/**
 * Id minting, secret derivation, hashing and comparison for agent sessions,
 * injected so the domain stays IO-free (no `crypto` here). Tests inject a
 * deterministic fake; every adapter must pass `agentSessionSecretsContract`,
 * which builds it under several server keys.
 *
 * Secrets are DERIVED, never stored: `order_secret = derive("order", id)` and
 * the hand-off token of link generation `g` is `derive("handoff", id, g)`. The
 * session stores only their hashes, and a replay re-derives the exact secret the
 * lost response carried. Whenever a use-case re-derives a secret to hand it out
 * again it hashes it and compares with the stored hash; on a mismatch it refuses
 * with `SECRET_KEY_MISMATCH` and never hands out a secret that would not verify.
 *
 * Key rotation: derive MUST be keyed, so rotating the server key changes every
 * derived secret. Outstanding `order_secret`s and hand-off links are then
 * invalidated for every path that re-derives them (create/write replays,
 * `complete`, any answer carrying the current link): those refuse with
 * `SECRET_KEY_MISMATCH`. A link or secret a holder already has keeps verifying
 * (verification compares hashes, which are keyless), and `issue_handoff` mints
 * a fresh link under the new key; the `order_secret` cannot be re-issued.
 */
export interface AgentSessionSecrets {
	/**
	 * A fresh, unguessable session-id suffix: at least 128 random bits, base64url
	 * (at least 22 characters of `[A-Za-z0-9_-]`). The id is a bearer credential
	 * for reading and writing the session, so a collision-free counter is not
	 * enough.
	 */
	mintId(): string;
	/**
	 * The `order_secret` of `sessionId`: deterministic, and MUST be keyed:
	 * HMAC-SHA256 under the server key (at least
	 * {@link AGENT_SESSION_MIN_SERVER_KEY_BYTES} bytes), over an encoding that
	 * separates purpose, id and generation; output base64url. Never a plain hash
	 * of its inputs.
	 */
	derive(purpose: "order", sessionId: AgentSessionId): Promise<string>;
	/** The hand-off token of link generation `generation` (a positive integer), keyed as above. */
	derive(purpose: "handoff", sessionId: AgentSessionId, generation: number): Promise<string>;
	/** The stored form of a secret (SHA-256). Deterministic. */
	hash(secret: string): Promise<string>;
	/**
	 * Equality that takes the same time wherever the inputs first differ. Used
	 * only for secret hashes. Inputs of different lengths answer `false`; it
	 * never throws (unlike Node's bare `timingSafeEqual`).
	 */
	constantTimeEqual(a: string, b: string): boolean;
}
