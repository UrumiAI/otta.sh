/**
 * The redemption's CRASH SEAMS — the windows the inverted claim order exists to make
 * survivable, driven with real fault injection over real storage.
 *
 * A redemption moves three documents that no primitive can write together: the
 * per-key record, the per-customer counter, and the coupon's own `usesCount`. The SQL
 * adapter held them in one transaction and undid a per-customer refusal by rolling it
 * back. Here the order is inverted — per-customer slot first, global counter second —
 * so a refusal can be COMPENSATED instead of rolled back, and every step is idempotent
 * so any later replayer finishes a partial.
 *
 * | Crash point | What must be true |
 * |---|---|
 * | the guarded `+1` is in flight | the claim has landed and the counter has NOT moved |
 * | after the key-doc create, before the slot claim | the replay takes the slot once and bumps once |
 * | after the per-customer slot, before the `+1` | the replay completes the bump, and the slot is not taken twice |
 * | after the `+1`, before the recorded answer | the replay recognises the witness and does NOT bump again |
 * | the same, with a PEER bump overwriting the witness | the documented ONE HIGH residual, never low |
 * | a refused `+1` | the per-customer slot is given back, and the refusal is recorded |
 * | after the refusal, BEFORE the compensation | the replay refuses again and the slot still comes back |
 * | after the compensation, before the recorded answer | the replay refuses again and releases nothing twice |
 * | two CONCURRENT replayers of a refused key | one answer, one compensation, nothing released twice |
 * | between a release's slot-free and its delete | the replay deletes and decrements exactly once |
 * | between a release's delete and its decrement | the counter is left HIGH, never low — and a second release is a no-op |
 *
 * Injection is `mode: "instead"` where the point is that a write never happened, and
 * every case reads the documents back BEFORE replaying, so the state the replay heals
 * is the state the store really leaves behind rather than one the test assumed.
 *
 * This file is also the proof that the `updateIf` half of the fault-injection helper
 * works: the first case PARKS a guarded update and asserts the counter really stands
 * still while it is parked. Without that, every seam here could pass while injecting
 * nothing.
 */
import {
	cents,
	currency,
	customerId,
	idempotencyKey,
	orderId,
	type CreateCouponInput,
} from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	COUPON_BUMP_LEASE_MS,
	COUPONS_COLLECTION,
	COUPON_CUSTOMER_CAPS_COLLECTION,
	COUPON_REDEMPTIONS_COLLECTION,
	couponCustomerCapId,
	couponRedemptionDocId,
	type CouponCustomerCapDoc,
	type CouponDoc,
	type CouponRedemptionDoc,
} from "../src/index.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	isClaimWrite,
	isGuardedUpdate,
	isUpdateWrite,
	nthCall,
	onId,
	parkCall,
	withCollection,
} from "./helpers/fault-injection.js";

const USD = currency("USD");
const AT = "2026-07-10T00:00:00.000Z";

function coupon(over: Partial<CreateCouponInput> = {}): CreateCouponInput {
	return {
		id: "c1",
		code: "SEAM",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: 5,
		maxUsesPerCustomer: null,
		...over,
	};
}

function redeemInput(key: string, over: { customer?: string; order?: string } = {}) {
	return {
		couponId: "c1",
		orderId: orderId(over.order ?? `o-${key}`),
		idempotencyKey: idempotencyKey(key),
		...(over.customer === undefined ? {} : { customerId: customerId(over.customer) }),
		createdAt: AT,
	};
}

describeEachDialect("coupon crash seams", (ctx) => {
	const bound = ctx.useStorage(COUPON_LAYOUT);

	/** The redemption record under a key, if any. */
	async function record(key: string): Promise<CouponRedemptionDoc | null> {
		return bound
			.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION)
			.get(couponRedemptionDocId("c1", key));
	}

	/** The coupon document, for the counter and its witness. */
	async function couponDoc(): Promise<CouponDoc | null> {
		return bound.collection<CouponDoc>(COUPONS_COLLECTION).get("c1");
	}

	/** The keys holding a per-customer slot, or null when there is no counter. */
	async function slots(customer: string): Promise<readonly string[] | null> {
		const doc = await bound
			.collection<CouponCustomerCapDoc>(COUPON_CUSTOMER_CAPS_COLLECTION)
			.get(couponCustomerCapId("c1", customer));
		return doc === null ? null : doc.keys;
	}

	/** A harness whose COUPON collection is wrapped, sharing the clean one's clock. */
	function twin(h: CouponHarness, wrapped: Parameters<typeof withCollection>[2]): CouponHarness {
		return wrappedTwin(h, COUPONS_COLLECTION, wrapped);
	}

	/** A harness with ONE named collection wrapped, sharing the clean one's clock. */
	function wrappedTwin(
		h: CouponHarness,
		collection: string,
		wrapped: Parameters<typeof withCollection>[2],
	): CouponHarness {
		return makeCouponHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(bound.storage, collection, wrapped),
		});
	}

	test("a PARKED guarded update holds the counter still: the claim has landed, the +1 has not", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon());
		const parked = parkCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isGuardedUpdate),
		);
		const pending = twin(h, parked.collection).store.redeem(redeemInput("k-park"));
		await parked.arrived;

		// The claim is durable and unapplied; the counter has not moved. If the helper
		// were not really intercepting `updateIf`, the bump would already have landed.
		expect(parked.parked()).toBe(1);
		expect((await couponDoc())?.usesCount).toBe(0);
		const claimed = await record("k-park");
		expect(claimed).not.toBeNull();
		expect(claimed?.outcome).toBeNull();

		parked.release();
		const res = await pending;
		expect(res.ok).toBe(true);
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-park"))?.outcome).toEqual({ ok: true });
	});

	test("crash after the per-customer slot, before the +1: the replay completes the bump and takes no second slot", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 5, maxUsesPerCustomer: 2 }));
		const failing = failCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isGuardedUpdate),
			{ mode: "instead" },
		);
		await expect(
			twin(h, failing.collection).store.redeem(redeemInput("k-a", { customer: "cust-1" })),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// The state the crash really leaves: the slot is taken, the counter is not moved,
		// and the key is claimed-but-unapplied.
		expect(await slots("cust-1")).toEqual(["k-a"]);
		expect((await couponDoc())?.usesCount).toBe(0);
		expect((await record("k-a"))?.outcome).toBeNull();

		// A crashed owner still holds the step until its LEASE lapses — that is what
		// keeps a LIVE owner from being overtaken — so the replay below is a replay
		// after the lease, exactly as the outbox's crashed-dispatcher case is.
		h.clock.advance(COUPON_BUMP_LEASE_MS + 1);
		const replay = await h.store.redeem(redeemInput("k-a", { customer: "cust-1" }));
		expect(replay.ok).toBe(true);
		if (replay.ok) expect(replay.replayed).toBe(true);
		// Counters exact: one use, and ONE slot — the key was already in the set, so the
		// replay's claim was the no-op it has to be.
		expect((await couponDoc())?.usesCount).toBe(1);
		expect(await slots("cust-1")).toEqual(["k-a"]);
	});

	test("crash after the +1, before the outcome record: the replay records the answer and does NOT bump again", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 5 }));
		const docId = couponRedemptionDocId("c1", "k-b");
		// TWO read-modify-writes land on the key document: `claimed → bumping` first, then
		// the recorded answer. The SECOND is the seam — the bump has already happened by
		// then — so the matcher counts rather than taking the first match.
		const failing = failCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			nthCall(2, onId(docId, isUpdateWrite)),
			{ mode: "instead" },
		);
		const crashing = makeCouponHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(
				bound.storage,
				COUPON_REDEMPTIONS_COLLECTION,
				failing.collection,
			),
		});
		await expect(crashing.store.redeem(redeemInput("k-b"))).rejects.toMatchObject({
			name: "InjectedCrashError",
		});

		// The bump landed and stamped its witness; the answer was never recorded, so the
		// key is left owning a step it never finished.
		const mid = await couponDoc();
		expect(mid?.usesCount).toBe(1);
		expect(mid?.lastRedeemedKey).toBe("k-b");
		const stuck = await record("k-b");
		expect(stuck?.state).toBe("bumping");
		expect(stuck?.outcome).toBeNull();

		// A crashed owner still holds the step until its LEASE lapses — that is what
		// keeps a LIVE owner from being overtaken — so the replay below is a replay
		// after the lease, exactly as the outbox's crashed-dispatcher case is.
		h.clock.advance(COUPON_BUMP_LEASE_MS + 1);
		const replay = await h.store.redeem(redeemInput("k-b"));
		expect(replay.ok).toBe(true);
		// Exact, because the witness survived: nothing else bumped this coupon in
		// between, so the taker recognises the `+1` as already applied.
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-b"))?.state).toBe("applied");
	});

	test("a refused +1 gives the per-customer slot back, and no global headroom was consumed", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 1, maxUsesPerCustomer: 1 }));
		// Spend the only global use on somebody else.
		expect((await h.store.redeem(redeemInput("k-other", { customer: "cust-2" }))).ok).toBe(true);

		const refused = await h.store.redeem(redeemInput("k-c", { customer: "cust-1" }));
		expect(refused).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });
		// The compensation ran: this customer holds no slot, so a later redemption of a
		// coupon that has headroom again is not blocked by a use they never made.
		expect(await slots("cust-1")).toEqual([]);
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-c"))?.outcome).toEqual({
			ok: false,
			reason: "COUPON_EXHAUSTED",
		});

		// And the refusal is what a replay of that key reads back, touching nothing.
		expect(await h.store.redeem(redeemInput("k-c", { customer: "cust-1" }))).toEqual({
			ok: false,
			reason: "COUPON_EXHAUSTED",
		});
		expect((await couponDoc())?.usesCount).toBe(1);
	});

	test("crash after the compensation, before the outcome record: the replay refuses again and releases nothing twice", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 1, maxUsesPerCustomer: 1 }));
		expect((await h.store.redeem(redeemInput("k-other", { customer: "cust-2" }))).ok).toBe(true);

		const docId = couponRedemptionDocId("c1", "k-d");
		// Again the SECOND key-document update: the first is `claimed → bumping`.
		const failing = failCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			nthCall(2, onId(docId, isUpdateWrite)),
			{ mode: "instead" },
		);
		const crashing = makeCouponHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(
				bound.storage,
				COUPON_REDEMPTIONS_COLLECTION,
				failing.collection,
			),
		});
		await expect(
			crashing.store.redeem(redeemInput("k-d", { customer: "cust-1" })),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// The slot was taken and given back; the refusal was never recorded.
		expect(await slots("cust-1")).toEqual([]);
		expect((await record("k-d"))?.outcome).toBeNull();
		expect((await couponDoc())?.usesCount).toBe(1);

		// A crashed owner still holds the step until its LEASE lapses — that is what
		// keeps a LIVE owner from being overtaken — so the replay below is a replay
		// after the lease, exactly as the outbox's crashed-dispatcher case is.
		h.clock.advance(COUPON_BUMP_LEASE_MS + 1);
		expect(await h.store.redeem(redeemInput("k-d", { customer: "cust-1" }))).toEqual({
			ok: false,
			reason: "COUPON_EXHAUSTED",
		});
		// Still empty, still one use: the second compensation removed a key that was
		// already gone, which is the whole point of recording slots as a key set.
		expect(await slots("cust-1")).toEqual([]);
		expect((await couponDoc())?.usesCount).toBe(1);
	});

	test("a release crashing between its delete and its decrement leaves the counter HIGH, never low", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 5, maxUsesPerCustomer: 1 }));
		const res = await h.store.redeem(redeemInput("k-e", { customer: "cust-1" }));
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		// The release's FIRST guarded update is the decrement (the redeem above ran on
		// the clean store), so failing one `updateIf` is exactly this seam.
		const failing = failCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isGuardedUpdate),
			{ mode: "instead" },
		);
		await expect(twin(h, failing.collection).store.release(res.redemptionId)).rejects.toMatchObject(
			{ name: "InjectedCrashError" },
		);

		// The record is gone and the slot is back, but the use is still counted: one use
		// nobody holds. That is the ONLY direction a two-document release can fail in
		// without a transaction, and it is the safe one — it refuses a redemption that
		// might have fit, and never grants one that does not.
		expect(await record("k-e")).toBeNull();
		expect(await slots("cust-1")).toEqual([]);
		expect((await couponDoc())?.usesCount).toBe(1);

		// A second release is a no-op rather than a second decrement, so the error stays
		// bounded at one instead of compounding.
		await h.store.release(res.redemptionId);
		expect((await couponDoc())?.usesCount).toBe(1);
	});

	test("crash after the key-doc create, before the slot claim: the replay takes one slot and bumps once", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 5, maxUsesPerCustomer: 1 }));
		// Die on the write that would have taken the per-customer slot — a
		// create-if-absent on the counter document, which does not exist yet.
		const failing = failCall(
			bound.collection<CouponCustomerCapDoc>(COUPON_CUSTOMER_CAPS_COLLECTION),
			isClaimWrite,
			{ mode: "instead" },
		);
		await expect(
			wrappedTwin(h, COUPON_CUSTOMER_CAPS_COLLECTION, failing.collection).store.redeem(
				redeemInput("k-f", { customer: "cust-1" }),
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// The claim is durable and owns nothing yet: no slot, no counter movement, and
		// the bump right was never taken.
		expect(await slots("cust-1")).toBeNull();
		expect((await couponDoc())?.usesCount).toBe(0);
		expect((await record("k-f"))?.state).toBe("claimed");

		const replay = await h.store.redeem(redeemInput("k-f", { customer: "cust-1" }));
		expect(replay.ok).toBe(true);
		expect(await slots("cust-1")).toEqual(["k-f"]);
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-f"))?.state).toBe("applied");
	});

	test("crash after the refusal, BEFORE its compensation: the replay refuses again and the slot still comes back", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 1, maxUsesPerCustomer: 1 }));
		// Spend the only global use on somebody else, so this customer's bump is refused.
		expect((await h.store.redeem(redeemInput("k-other", { customer: "cust-2" }))).ok).toBe(true);

		// The compensation is the read-modify-write that removes this key from the slot
		// set. Dying on it is "the bump was refused and the process went away before it
		// could give the slot back".
		const failing = failCall(
			bound.collection<CouponCustomerCapDoc>(COUPON_CUSTOMER_CAPS_COLLECTION),
			isUpdateWrite,
			{ mode: "instead" },
		);
		await expect(
			wrappedTwin(h, COUPON_CUSTOMER_CAPS_COLLECTION, failing.collection).store.redeem(
				redeemInput("k-g", { customer: "cust-1" }),
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// The state the crash really leaves: the slot is still held by a redemption that
		// was refused, and the answer was never recorded.
		expect(await slots("cust-1")).toEqual(["k-g"]);
		expect((await record("k-g"))?.state).toBe("bumping");
		expect((await couponDoc())?.usesCount).toBe(1);

		// A crashed owner still holds the step until its LEASE lapses — that is what
		// keeps a LIVE owner from being overtaken — so the replay below is a replay
		// after the lease, exactly as the outbox's crashed-dispatcher case is.
		h.clock.advance(COUPON_BUMP_LEASE_MS + 1);
		expect(await h.store.redeem(redeemInput("k-g", { customer: "cust-1" }))).toEqual({
			ok: false,
			reason: "COUPON_EXHAUSTED",
		});
		// The replay re-ran the refusal AND its compensation: no global headroom was
		// taken, and this customer holds nothing.
		expect(await slots("cust-1")).toEqual([]);
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-g"))?.state).toBe("refused");
	});

	test("two CONCURRENT replayers of a refused key: one answer, one compensation, nothing released twice", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 1, maxUsesPerCustomer: 1 }));
		expect((await h.store.redeem(redeemInput("k-other", { customer: "cust-2" }))).ok).toBe(true);

		// Both callers carry the SAME key, so one owns the refusal and the other reads
		// it back — and the loser can take its slot AFTER the winner has compensated,
		// which is the interleaving that would otherwise leak a per-customer use.
		const input = redeemInput("k-h", { customer: "cust-1" });
		const [a, b] = await Promise.all([h.store.redeem(input), h.store.redeem(input)]);
		expect(a).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });
		expect(b).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });
		expect(await slots("cust-1")).toEqual([]);
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-h"))?.state).toBe("refused");
	});

	test("crash between a release's slot-free and its delete: the replay deletes and decrements exactly once", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 5, maxUsesPerCustomer: 1 }));
		const res = await h.store.redeem(redeemInput("k-i", { customer: "cust-1" }));
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		// Die on the delete that claims the decrement, AFTER the slot has been freed.
		const failing = failCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			(call) => call.method === "compareAndDelete",
			{ mode: "instead" },
		);
		await expect(
			wrappedTwin(h, COUPON_REDEMPTIONS_COLLECTION, failing.collection).store.release(
				res.redemptionId,
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });

		// The slot is back, the record is not deleted, and the use is still counted —
		// which is the right order: the decrement is claimed by the delete, so nothing
		// has been given back twice.
		expect(await slots("cust-1")).toEqual([]);
		expect((await record("k-i"))?.state).toBe("applied");
		expect((await couponDoc())?.usesCount).toBe(1);

		await h.store.release(res.redemptionId);
		expect(await record("k-i")).toBeNull();
		expect((await couponDoc())?.usesCount).toBe(0);
		// And a third release is still a no-op.
		await h.store.release(res.redemptionId);
		expect((await couponDoc())?.usesCount).toBe(0);
	});

	test("the ONE HIGH residual: a peer bump overwrites the witness, so the taker re-bumps", async () => {
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 10 }));
		const docId = couponRedemptionDocId("c1", "k-j");
		// Crash after the `+1`, before the answer is recorded (the SECOND key-doc update).
		const failing = failCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			nthCall(2, onId(docId, isUpdateWrite)),
			{ mode: "instead" },
		);
		await expect(
			wrappedTwin(h, COUPON_REDEMPTIONS_COLLECTION, failing.collection).store.redeem(
				redeemInput("k-j"),
			),
		).rejects.toMatchObject({ name: "InjectedCrashError" });
		expect((await couponDoc())?.usesCount).toBe(1);

		// A DIFFERENT key redeems in the crash window and overwrites the witness. This is
		// the documented inexact seam: the taker can no longer tell that k-j's `+1`
		// landed, so it bumps again.
		expect((await h.store.redeem(redeemInput("k-peer"))).ok).toBe(true);
		expect((await couponDoc())?.lastRedeemedKey).toBe("k-peer");

		// A crashed owner still holds the step until its LEASE lapses — that is what
		// keeps a LIVE owner from being overtaken — so the replay below is a replay
		// after the lease, exactly as the outbox's crashed-dispatcher case is.
		h.clock.advance(COUPON_BUMP_LEASE_MS + 1);
		const replay = await h.store.redeem(redeemInput("k-j"));
		expect(replay.ok).toBe(true);
		// Three uses recorded for two redemptions: ONE HIGH, never low. A high count
		// refuses a redemption that might have fit; it never grants one that does not,
		// and releasing either redemption gives its own use back.
		expect((await couponDoc())?.usesCount).toBe(3);
		expect((await record("k-j"))?.state).toBe("applied");
	});

	test("a LIVE owner of the bump step is never overtaken: the peer waits, then refuses retryably", async () => {
		// The property the lease exists for, pinned deterministically rather than raced.
		// The first caller's `+1` is PARKED, so it holds the step without finishing it;
		// the second caller of the same key must not walk past it and add a second use.
		const h = makeCouponHarness(bound.storage);
		await h.store.create(coupon({ maxUses: 5 }));
		const parked = parkCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isGuardedUpdate),
		);
		const owner = twin(h, parked.collection).store.redeem(redeemInput("k-live"));
		await parked.arrived;

		// A short patience so the case does not sit through the whole budget; the LEASE,
		// not the patience, is what forbids the takeover.
		const peer = makeCouponHarness(bound.storage, { clock: h.clock, maxCasAttempts: 3 });
		await expect(peer.store.redeem(redeemInput("k-live"))).rejects.toMatchObject({
			code: "STORAGE_CONTENTION",
			retryable: true,
		});
		// Nothing was added behind the owner's back.
		expect((await couponDoc())?.usesCount).toBe(0);

		parked.release();
		expect((await owner).ok).toBe(true);
		expect((await couponDoc())?.usesCount).toBe(1);
		// And now that an answer is recorded, the peer's retry reads it instead.
		const retried = await peer.store.redeem(redeemInput("k-live"));
		expect(retried.ok).toBe(true);
		if (retried.ok) expect(retried.replayed).toBe(true);
		expect((await couponDoc())?.usesCount).toBe(1);
	});
});
