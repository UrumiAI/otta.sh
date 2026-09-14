/**
 * The two identity residues, on **D1**.
 *
 * The Node tiers prove the seams across both their dialects; what this tier adds is
 * that the two healing paths work through the host's OWN Kysely wiring, because both
 * of them are READS that write. The email lookup's fallback issues an `emailLower`
 * equality against D1's SQLite build and then writes the claim back, and the
 * throttle's slot expiry is a comparison inside a document the same caller
 * compare-and-sets. A tier that only ever exercised the fast path would not touch
 * either.
 *
 * It cannot race — miniflare runs the file in one `workerd` isolate on one thread —
 * so the concurrency questions stay in the Postgres suites. These are the
 * deterministic residues, driven the same way.
 */
import { email, DuplicateCustomerEmailError } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { IDENTITY_LAYOUT } from "../identity-collections.js";
import {
	CHALLENGE_TTL_MS,
	makeIdentityHarness,
	MAX_ACTIVE_CHALLENGES,
} from "../identity-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(IDENTITY_LAYOUT);

test("an account whose claim is gone is found by address, and the read writes the claim back", async () => {
	const h = makeIdentityHarness(bound.storage);
	const registered = await h.customerStore.create({ email: email("healed@example.com") });
	expect(await h.emailClaims.delete("healed@example.com")).toBe(true);

	// The fallback query is the `emailLower` index doing its job on this runtime.
	expect((await h.customerStore.getByEmail(email("HEALED@example.com")))?.id).toBe(registered.id);
	expect((await h.emailClaims.get("healed@example.com"))?.customerId).toBe(registered.id);
	await expect(
		h.customerStore.create({ email: email("healed@example.com") }),
	).rejects.toBeInstanceOf(DuplicateCustomerEmailError);
});

test("a held slot lapses at its own expiry, and the window resets without a sweeper", async () => {
	const h = makeIdentityHarness(bound.storage);
	const TO = email("lapse@example.com");
	for (let i = 0; i < MAX_ACTIVE_CHALLENGES; i++) {
		expect((await h.verifier.issueChallenge(TO)).ok).toBe(true);
	}
	expect(await h.verifier.issueChallenge(TO)).toEqual({ ok: false, reason: "THROTTLED" });
	expect(await h.slotsOf("lapse@example.com")).toHaveLength(MAX_ACTIVE_CHALLENGES);

	h.advance(CHALLENGE_TTL_MS + 1);
	expect((await h.verifier.issueChallenge(TO)).ok).toBe(true);
	// The lapsed slots are dropped by the admission that counted past them — the one
	// place the window is pruned — so the document holds only the live one.
	expect(await h.slotsOf("lapse@example.com")).toHaveLength(1);
});

test("the prune's two arms remove consumed and expired challenges and nothing live", async () => {
	const h = makeIdentityHarness(bound.storage);
	const consumed = await h.verifier.issueChallenge(email("consumed@example.com"));
	if (!consumed.ok) throw new Error("the first request must be admitted");
	expect((await h.verifier.verifyChallenge(consumed.challengeId, consumed.token)).ok).toBe(true);
	expect((await h.verifier.issueChallenge(email("expiring@example.com"))).ok).toBe(true);
	h.advance(CHALLENGE_TTL_MS + 1);
	const live = await h.verifier.issueChallenge(email("still-live@example.com"));
	if (!live.ok) throw new Error("the live request must be admitted");

	// The arms overlap and the deletes deduplicate: two documents, not three.
	expect(await h.verifier.pruneChallenges(h.now())).toBe(2);
	expect(await h.verifier.pruneChallenges(h.now())).toBe(0);
	expect((await h.verifier.verifyChallenge(live.challengeId, live.token)).ok).toBe(true);
});
