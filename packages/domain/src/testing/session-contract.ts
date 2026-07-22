import { describe, expect, test } from "vitest";
import { customerId } from "../money/ids.js";
import type { SessionStore } from "../ports/session-store.js";

export interface SessionHarness {
	store: SessionStore;
	/** Advance the injected clock (to cross the session TTL). */
	advance(ms: number): void;
	/** The TTL the harness built the store with, so the expiry case can cross it. */
	ttlMs: number;
}

export interface SessionContractOptions {
	dialect: string;
}

/**
 * The reusable `SessionStore` behavioral spec (§7): create/validate/revoke,
 * expiry, and revoked-token rejection — opaque DB-backed tokens (§9 decision 5),
 * never the plaintext token in storage.
 */
export function sessionContract(
	makeHarness: () => Promise<SessionHarness>,
	opts: SessionContractOptions,
): void {
	const CUST = customerId("cust-session");

	describe(`sessionContract [${opts.dialect}]`, () => {
		test("create then validate returns the customer id", async () => {
			const { store } = await makeHarness();
			const session = await store.create(CUST);
			expect(await store.validate(session.token)).toBe(CUST);
		});

		test("validate of an unknown token returns null", async () => {
			const { store } = await makeHarness();
			expect(await store.validate("never-issued")).toBeNull();
		});

		test("a revoked token no longer validates", async () => {
			const { store } = await makeHarness();
			const session = await store.create(CUST);
			await store.revoke(session.token);
			expect(await store.validate(session.token)).toBeNull();
		});

		test("an expired token no longer validates", async () => {
			const h = await makeHarness();
			const session = await h.store.create(CUST);
			h.advance(h.ttlMs + 1);
			expect(await h.store.validate(session.token)).toBeNull();
		});

		// -- listForCustomer: token-free session history (admin-UX Increment 1) ---

		test("listForCustomer returns newest-first, token-free summaries (never a token or hash)", async () => {
			const h = await makeHarness();
			const first = await h.store.create(CUST);
			h.advance(10);
			const second = await h.store.create(CUST);
			h.advance(10);
			const third = await h.store.create(CUST);

			const sessions = await h.store.listForCustomer(CUST);
			expect(sessions).toHaveLength(3);
			// Newest-first — expiresAt = createdAt + ttl identifies each session
			// without depending on adapter-specific id formats.
			expect(sessions.map((s) => s.expiresAt)).toEqual([
				third.expiresAt,
				second.expiresAt,
				first.expiresAt,
			]);
			// createdAt strictly descending (the clock advanced between creates).
			expect(sessions[0]!.createdAt > sessions[1]!.createdAt).toBe(true);
			expect(sessions[1]!.createdAt > sessions[2]!.createdAt).toBe(true);
			// The summary shape is EXACTLY the four metadata fields — no `token`,
			// no `tokenHash`, no credential material of any kind.
			for (const s of sessions) {
				expect(Object.keys(s).toSorted()).toEqual(["createdAt", "expiresAt", "id", "revokedAt"]);
				expect(typeof s.id).toBe("string");
				expect(s.id.length).toBeGreaterThan(0);
				expect(s.revokedAt).toBeNull();
			}
		});

		test("listForCustomer is scoped to one customer — another customer's sessions never leak in", async () => {
			const h = await makeHarness();
			const other = customerId("cust-other");
			await h.store.create(CUST);
			await h.store.create(other);
			expect(await h.store.listForCustomer(CUST)).toHaveLength(1);
			expect(await h.store.listForCustomer(other)).toHaveLength(1);
		});

		test("listForCustomer reflects a revoke (revokedAt set) and keeps expired sessions (it is a history)", async () => {
			const h = await makeHarness();
			const revoked = await h.store.create(CUST);
			h.advance(10);
			const kept = await h.store.create(CUST);
			await h.store.revoke(revoked.token);
			// Cross the TTL so BOTH sessions are expired: the history still lists them.
			h.advance(h.ttlMs + 1);

			const sessions = await h.store.listForCustomer(CUST);
			expect(sessions).toHaveLength(2);
			const revokedRow = sessions.find((s) => s.expiresAt === revoked.expiresAt);
			const keptRow = sessions.find((s) => s.expiresAt === kept.expiresAt);
			expect(revokedRow?.revokedAt).not.toBeNull();
			expect(keptRow?.revokedAt).toBeNull();
		});

		test("listForCustomer on a customer with no sessions returns []", async () => {
			const h = await makeHarness();
			expect(await h.store.listForCustomer(customerId("cust-empty"))).toEqual([]);
		});
	});
}
