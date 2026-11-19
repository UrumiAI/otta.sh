/**
 * Token minting, hashing and comparison for agent sessions, injected so the
 * domain stays IO-free (no `crypto` here). The adapter mints 32 random bytes as
 * base64url and hashes with SHA-256 (spec "Hand-off link"); tests inject a
 * deterministic fake.
 */
export interface AgentSessionSecrets {
	/** A fresh, unguessable bearer token (hand-off link or `order_secret`). */
	mintToken(): string;
	/** The stored form of a token. Deterministic: the same token always hashes the same. */
	hash(token: string): Promise<string>;
	/** Equality that takes the same time wherever the inputs first differ. */
	constantTimeEqual(a: string, b: string): boolean;
}
