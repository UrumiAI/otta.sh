/**
 * The identity seams, driven from the forbidden side.
 *
 * Every case here injects a crash into a REAL storage collection — the write either
 * lands and the continuation is lost, or never happens at all — reads the residue
 * back so the state being healed is asserted rather than assumed, and then proves
 * what a later caller sees. Nothing is faked: the document that lands is the one the
 * host would have written.
 *
 * Two claims are on trial, and the question is the same for both: what does a crash
 * between the claim and the write it guards leave behind, and does the leftover
 * refuse something it could have allowed (acceptable) or allow something it should
 * have refused (never)?
 */
import { customerId, email, DuplicateCustomerEmailError } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	failCall,
	isClaimWrite,
	isUpdateWrite,
	parkCall,
	settleOne,
	withCollection,
	type CallMatcher,
} from "./helpers/fault-injection.js";
import {
	collectionOf,
	CUSTOMER_EMAILS_COLLECTION,
	CUSTOMERS_COLLECTION,
	LOGIN_CHALLENGE_CLAIMS_COLLECTION,
	LOGIN_CHALLENGES_COLLECTION,
	type ChallengeThrottleDoc,
	type CustomerDoc,
	type CustomerEmailDoc,
	type StorageAccess,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { IDENTITY_LAYOUT } from "./identity-collections.js";
import {
	CHALLENGE_TTL_MS,
	makeIdentityHarness,
	MAX_ACTIVE_CHALLENGES,
	type IdentityHarness,
	type IdentityHarnessOptions,
} from "./identity-harness.js";

/** The abandon window every seam here opens deliberately. */
const ABANDON_AFTER_MS = 10_000;

/** Any delete of a claim document — the release half of a claim's lifecycle. */
const isRelease: CallMatcher = (call) => call.method === "compareAndDelete";

/** Any write at all on a collection — used to lose a release whichever form it takes. */
const isAnyWrite: CallMatcher = (call) =>
	call.method === "compareAndSet" || call.method === "compareAndDelete";

describeEachDialect("identity crash seams", (ctx) => {
	const bound = ctx.useStorage(IDENTITY_LAYOUT);

	/** A harness whose STORES write through `storage`, sharing one clock with `twin`. */
	const crashing = (storage: StorageAccess, twin?: IdentityHarness): IdentityHarness => {
		const options: IdentityHarnessOptions = {
			storageForStore: storage,
			claimAbandonAfterMs: ABANDON_AFTER_MS,
			// Its own id space: the crashing caller is a different process, and a replayer
			// that minted the same ids would be adopting its own abandoned work by
			// accident rather than by the rule under test.
			idPrefix: "crashed-",
		};
		return makeIdentityHarness(
			bound.storage,
			twin === undefined ? options : { ...options, clock: twin.clock },
		);
	};

	const healthy = (): IdentityHarness =>
		makeIdentityHarness(bound.storage, { claimAbandonAfterMs: ABANDON_AFTER_MS });

	// -- the email claim -------------------------------------------------------

	test("a crash between claiming an address and writing the account gives the address back", async () => {
		const live = healthy();
		const customers = collectionOf<CustomerDoc>(bound.storage, CUSTOMERS_COLLECTION);
		// The account write never happens: "the process died before write B".
		const broken = failCall(customers, isClaimWrite, { mode: "instead" });
		const crashed = crashing(
			withCollection(bound.storage, CUSTOMERS_COLLECTION, broken.collection),
			live,
		);

		await expect(
			crashed.customerStore.create({ email: email("crash@example.com") }),
		).rejects.toThrow(/injected crash/);
		expect(broken.failed()).toBe(1);
		// Read the residue back: no account, and the compensating release gave the
		// address back, so nothing is stranded.
		expect(await customers.count()).toBe(0);
		expect(await live.emailClaims.get("crash@example.com")).toBeNull();

		// And the address registers cleanly afterwards.
		const registered = await live.customerStore.create({ email: email("crash@example.com") });
		expect((await live.customerStore.getByEmail(email("crash@example.com")))?.id).toBe(
			registered.id,
		);
	});

	test("a crash that loses the release too refuses the address for one abandon window, never registers it twice", async () => {
		const live = healthy();
		const customers = collectionOf<CustomerDoc>(bound.storage, CUSTOMERS_COLLECTION);
		const claims = collectionOf<CustomerEmailDoc>(bound.storage, CUSTOMER_EMAILS_COLLECTION);
		// Both halves die: the account write never happens AND the release that would
		// have given the address back is lost with the process.
		const brokenCustomers = failCall(customers, isClaimWrite, { mode: "instead" });
		const brokenClaims = failCall(claims, isRelease, { mode: "instead" });
		let storage = withCollection(bound.storage, CUSTOMERS_COLLECTION, brokenCustomers.collection);
		storage = withCollection(storage, CUSTOMER_EMAILS_COLLECTION, brokenClaims.collection);
		const crashed = crashing(storage, live);

		await expect(
			crashed.customerStore.create({ email: email("orphan@example.com") }),
		).rejects.toThrow(/injected crash/);
		// The residue, read back: an orphan claim with no account behind it.
		expect(await customers.count()).toBe(0);
		expect((await claims.get("orphan@example.com"))?.customerId).toBeDefined();

		// It refuses rather than over-admits, and it refuses HONESTLY: no account is
		// visible under the address, so nothing has been registered twice.
		await expect(
			live.customerStore.create({ email: email("orphan@example.com") }),
		).rejects.toBeInstanceOf(DuplicateCustomerEmailError);
		expect(await live.customerStore.getByEmail(email("orphan@example.com"))).toBeNull();

		// One abandon window later the claim is takeable, and the address is usable
		// again without an operator.
		live.advance(ABANDON_AFTER_MS + 1);
		const registered = await live.customerStore.create({ email: email("orphan@example.com") });
		expect((await claims.get("orphan@example.com"))?.customerId).toBe(registered.id);
		expect(await customers.count()).toBe(1);
	});

	test("a registrant parked past the abandon window is fenced out by its own re-assertion", async () => {
		const live = healthy();
		const claims = collectionOf<CustomerEmailDoc>(bound.storage, CUSTOMER_EMAILS_COLLECTION);
		const customers = collectionOf<CustomerDoc>(bound.storage, CUSTOMERS_COLLECTION);
		// Park the RE-ASSERTION — the update write on the claim this registrant already
		// holds — so the parked call sits between its claim and its account write, which
		// is exactly the gap the fence exists for.
		const parked = parkCall(claims, isUpdateWrite);
		const stalled = crashing(
			withCollection(bound.storage, CUSTOMER_EMAILS_COLLECTION, parked.collection),
			live,
		);

		const registration = settleOne(
			stalled.customerStore.create({ email: email("stalled@example.com") }),
		);
		await parked.arrived;
		// It holds the claim and has written nothing else.
		expect((await claims.get("stalled@example.com"))?.customerId).toMatch(/^crashed-/);
		expect(await customers.count()).toBe(0);

		// The registrant stops being alive for longer than its lease, and a peer takes
		// the address over and registers it.
		live.advance(ABANDON_AFTER_MS + 1);
		const peer = await live.customerStore.create({ email: email("stalled@example.com") });

		// The stalled call wakes up. Its re-assertion is the fence: it is pinned to the
		// revision the peer's takeover replaced, so it refuses BEFORE any account write.
		parked.release();
		expect(await registration).toBeInstanceOf(DuplicateCustomerEmailError);

		// One account owns the address, it is the peer's, and the claim names it.
		expect(await customers.count()).toBe(1);
		expect((await live.customerStore.getByEmail(email("stalled@example.com")))?.id).toBe(peer.id);
		expect((await claims.get("stalled@example.com"))?.customerId).toBe(peer.id);
	});

	test("an account whose claim is gone is still found by address, and the read writes the claim back", async () => {
		const live = healthy();
		const registered = await live.customerStore.create({ email: email("lost@example.com") });
		// The state a lost release, or a release that raced an adoption, would leave:
		// the account is there and nothing points at it.
		expect(await live.emailClaims.delete("lost@example.com")).toBe(true);

		// The read resolves anyway — the claim is the fast path, not the definition of
		// existence — and it heals on the way through.
		expect((await live.customerStore.getByEmail(email("LOST@example.com")))?.id).toBe(
			registered.id,
		);
		expect((await live.emailClaims.get("lost@example.com"))?.customerId).toBe(registered.id);

		// And the healed claim is a real one: the address is refused to a newcomer.
		await expect(
			live.customerStore.create({ email: email("lost@example.com") }),
		).rejects.toBeInstanceOf(DuplicateCustomerEmailError);
	});

	// -- the challenge throttle ------------------------------------------------

	test("a crash between taking a slot and writing the challenge gives the slot back", async () => {
		const live = healthy();
		const challenges = collectionOf(bound.storage, LOGIN_CHALLENGES_COLLECTION);
		const broken = failCall(challenges, isClaimWrite, { mode: "instead" });
		const crashed = crashing(
			withCollection(bound.storage, LOGIN_CHALLENGES_COLLECTION, broken.collection),
			live,
		);

		await expect(crashed.verifier.issueChallenge(email("slot@example.com"))).rejects.toThrow(
			/injected crash/,
		);
		// The residue: no challenge, and the slot handed back, so the window is whole.
		expect(await live.challenges.count()).toBe(0);
		expect(await live.slotsOf("slot@example.com")).toBeNull();
		for (let i = 0; i < MAX_ACTIVE_CHALLENGES; i++) {
			expect((await live.verifier.issueChallenge(email("slot@example.com"))).ok).toBe(true);
		}
	});

	test("a crash that loses the slot release too costs one admission until the slot's own expiry", async () => {
		const live = healthy();
		const challenges = collectionOf(bound.storage, LOGIN_CHALLENGES_COLLECTION);
		const throttle = collectionOf<ChallengeThrottleDoc>(
			bound.storage,
			LOGIN_CHALLENGE_CLAIMS_COLLECTION,
		);
		const brokenChallenges = failCall(challenges, isClaimWrite, { mode: "instead" });
		// The release is lost whichever shape it takes — an empty window is a delete.
		const brokenThrottle = failCall(throttle, isRelease, { mode: "instead" });
		let storage = withCollection(
			bound.storage,
			LOGIN_CHALLENGES_COLLECTION,
			brokenChallenges.collection,
		);
		storage = withCollection(storage, LOGIN_CHALLENGE_CLAIMS_COLLECTION, brokenThrottle.collection);
		const crashed = crashing(storage, live);

		await expect(crashed.verifier.issueChallenge(email("held@example.com"))).rejects.toThrow(
			/injected crash/,
		);
		// The residue: a slot held for a challenge that was never written.
		expect(await live.challenges.count()).toBe(0);
		expect(await live.slotsOf("held@example.com")).toHaveLength(1);

		// It costs an admission — over-refusal, which is the direction a residual must
		// take — and nothing over the cap is ever admitted.
		for (let i = 0; i < MAX_ACTIVE_CHALLENGES - 1; i++) {
			expect((await live.verifier.issueChallenge(email("held@example.com"))).ok).toBe(true);
		}
		expect(await live.verifier.issueChallenge(email("held@example.com"))).toEqual({
			ok: false,
			reason: "THROTTLED",
		});

		// The slot lapses at the expiry it carries: no sweeper, no operator.
		live.advance(CHALLENGE_TTL_MS + 1);
		expect((await live.verifier.issueChallenge(email("held@example.com"))).ok).toBe(true);
	});

	test("a crash after the consume but before the slot release keeps the redeem once-only", async () => {
		const live = healthy();
		const issued = await live.verifier.issueChallenge(email("consume@example.com"));
		if (!issued.ok) throw new Error("the first request must be admitted");
		const challenges = collectionOf(bound.storage, LOGIN_CHALLENGES_COLLECTION);
		// "the process died AFTER this write": the consume lands, the release is lost.
		const broken = failCall(challenges, isUpdateWrite, { mode: "after" });
		const crashed = crashing(
			withCollection(bound.storage, LOGIN_CHALLENGES_COLLECTION, broken.collection),
			live,
		);

		await expect(
			crashed.verifier.verifyChallenge(issued.challengeId, issued.token),
		).rejects.toThrow(/injected crash/);
		// The residue, read back: the consume is DURABLE, and the slot is still held.
		expect((await live.challenges.get(issued.challengeId))?.consumedAt).not.toBeNull();
		expect(await live.slotsOf("consume@example.com")).toHaveLength(1);

		// A replay of the magic link is refused, which is the invariant that matters:
		// the crash cost a slot, never a second redemption.
		expect(await live.verifier.verifyChallenge(issued.challengeId, issued.token)).toEqual({
			ok: false,
			reason: "CONSUMED",
		});
		live.advance(CHALLENGE_TTL_MS + 1);
		expect((await live.verifier.issueChallenge(email("consume@example.com"))).ok).toBe(true);
	});

	// -- address ownership under contention ------------------------------------

	test("an address update that loses its revision re-checks ownership rather than resurrecting the address", async () => {
		const live = healthy();
		const owner = customerId("cust-owner");
		const address = await live.addressStore.create(owner, {
			kind: "shipping",
			name: "Ada Lovelace",
			line1: "1 Analytical Way",
			city: "London",
			postalCode: "EC1",
			country: "GB",
		});
		const customers = collectionOf<CustomerDoc>(bound.storage, CUSTOMERS_COLLECTION);
		// Park the update's own write, so the delete lands between its ownership check
		// and the commit that check was taken for.
		const parked = parkCall(customers, isAnyWrite);
		const slow = crashing(
			withCollection(bound.storage, CUSTOMERS_COLLECTION, parked.collection),
			live,
		);

		const update = settleOne(slow.addressStore.update(owner, address.id, { city: "Cambridge" }));
		await parked.arrived;
		expect(await live.addressStore.delete(owner, address.id)).toBe(true);
		parked.release();

		// The retry re-reads, finds no such address in the document, and answers the
		// miss. A blind re-commit would have put a deleted address back.
		expect(await update).toBeNull();
		expect(await live.addressStore.list(owner)).toEqual([]);
		// The document was the customer's only content, so it left no litter either.
		expect(await customers.get(owner)).toBeNull();
	});
});
