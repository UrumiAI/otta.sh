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
	});
}
