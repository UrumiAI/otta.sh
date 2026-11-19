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
 * again it hashes it and compares with the stored hash.
 *
 * Key rotation: derive MUST be keyed, so rotating the server key changes every
 * derived secret. A link or `order_secret` a holder already has keeps verifying
 * (verification compares hashes, which are keyless). What changes:
 * - REPLAYS (create, replace, complete, issue_handoff) that would re-derive a
 *   secret refuse with `SECRET_KEY_MISMATCH`, never handing out one that would
 *   not verify.
 * - A FRESH replace or complete whose current unused link no longer re-derives
 *   mints a new link generation under the new key in the same write and returns
 *   it; the old link dies (as any replaced link does). `issue_handoff` likewise.
 * - The `order_secret` is a stable credential and is never re-issued: an agent
 *   that lost its create response cannot recover it after a rotation (the create
 *   replay fails closed), so rotation strands the `order_secret` of every open
 *   session whose holder lost it.
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
	 * {@link AGENT_SESSION_MIN_SERVER_KEY_BYTES} bytes); output base64url. Never a
	 * plain hash of its inputs.
	 *
	 * The HMAC input MUST be an unambiguous encoding of (purpose, id, generation):
	 * either length-prefix every field (e.g. a 4-byte big-endian length before the
	 * UTF-8 bytes of each), or join them with a delimiter that cannot occur in any
	 * field (e.g. `"handoff" + "\x00" + id + "\x00" + decimal(generation)`; ids are
	 * `cs_` + base64url, so NUL never occurs). Plain concatenation is wrong:
	 * ("cs_x1", 1) and ("cs_x", 11) would derive the same token. The contract
	 * pins this with boundary-collision cases.
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
