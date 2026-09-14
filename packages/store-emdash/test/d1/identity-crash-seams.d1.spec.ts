/**
 * The identity residues, the claim fence and the address ownership check, on **D1**.
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
 * so the concurrency questions stay in the Postgres suites. Promises do interleave at
 * `await` points, which is all the claim-fence case needs: it parks one write, moves
 * the clock, lets a peer through, and releases.
 *
 * The cross-customer address cases are here rather than only on the Node tiers because
 * they are a SECURITY invariant, and an invariant pinned on two of three tiers is
 * pinned on the wrong number of them.
 */
import { customerId, email, DuplicateCustomerEmailError } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	collectionOf,
	CUSTOMER_EMAILS_COLLECTION,
	CUSTOMERS_COLLECTION,
	type CustomerDoc,
	type CustomerEmailDoc,
} from "../../src/index.js";
import { isUpdateWrite, parkCall, settleOne, withCollection } from "../helpers/fault-injection.js";
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

test("a registrant parked past the abandon window is fenced out by its own re-assertion", async () => {
	const ABANDON_AFTER_MS = 10_000;
	const live = makeIdentityHarness(bound.storage, { claimAbandonAfterMs: ABANDON_AFTER_MS });
	const claims = collectionOf<CustomerEmailDoc>(bound.storage, CUSTOMER_EMAILS_COLLECTION);
	const customers = collectionOf<CustomerDoc>(bound.storage, CUSTOMERS_COLLECTION);
	// Park the RE-ASSERTION, so the parked call sits between its claim and its account
	// write — the gap the fence exists for.
	const parked = parkCall(claims, isUpdateWrite);
	const stalled = makeIdentityHarness(bound.storage, {
		claimAbandonAfterMs: ABANDON_AFTER_MS,
		clock: live.clock,
		idPrefix: "stalled-",
		storageForStore: withCollection(bound.storage, CUSTOMER_EMAILS_COLLECTION, parked.collection),
	});

	const registration = settleOne(
		stalled.customerStore.create({ email: email("fenced@example.com") }),
	);
	await parked.arrived;
	expect(await customers.count()).toBe(0);

	live.advance(ABANDON_AFTER_MS + 1);
	const peer = await live.customerStore.create({ email: email("fenced@example.com") });

	parked.release();
	expect(await registration).toBeInstanceOf(DuplicateCustomerEmailError);
	// One account owns the address, and it is the peer's.
	expect(await customers.count()).toBe(1);
	expect((await live.customerStore.getByEmail(email("fenced@example.com")))?.id).toBe(peer.id);
	expect((await claims.get("fenced@example.com"))?.customerId).toBe(peer.id);
});

test("an address write is refused to anyone but its owner", async () => {
	const h = makeIdentityHarness(bound.storage);
	const a = customerId("owner-a");
	const b = customerId("owner-b");
	const theirs = await h.addressStore.create(a, {
		kind: "shipping",
		name: "Ada Lovelace",
		line1: "1 Analytical Way",
		city: "London",
		postalCode: "EC1",
		country: "GB",
	});

	// The ownership check is on the address inside the CALLER's own document, so B's
	// attempt is a miss rather than a hijack — and there is no address collection it
	// could have reached A's row through.
	expect(await h.addressStore.update(b, theirs.id, { city: "Hijacked" })).toBeNull();
	expect(await h.addressStore.delete(b, theirs.id)).toBe(false);
	expect((await h.addressStore.list(a)).map((x) => x.city)).toEqual(["London"]);
	// A's own writes work, which is what makes the refusal above about ownership.
	expect((await h.addressStore.update(a, theirs.id, { city: "Cambridge" }))?.city).toBe(
		"Cambridge",
	);
	expect(await h.addressStore.delete(a, theirs.id)).toBe(true);
});
