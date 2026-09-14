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
 * | after the per-customer slot, before the `+1` | the replay completes the bump, and the slot is not taken twice |
 * | after the `+1`, before the outcome record | the replay records the answer and does NOT bump again |
 * | a refused `+1` | the per-customer slot is given back, and the refusal is recorded |
 * | after the compensation, before the outcome record | the replay refuses again and releases nothing twice |
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
	COUPONS_COLLECTION,
	COUPON_CUSTOMER_CAPS_COLLECTION,
	COUPON_REDEMPTIONS_COLLECTION,
	couponCustomerCapId,
	couponRedemptionDocId,
	type CouponDoc,
	type CouponRedemptionDoc,
} from "../src/index.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	isGuardedUpdate,
	isUpdateWrite,
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
			.collection<{ keys: string[] }>(COUPON_CUSTOMER_CAPS_COLLECTION)
			.get(couponCustomerCapId("c1", customer));
		return doc === null ? null : doc.keys;
	}

	/** A harness whose COUPON collection is wrapped, sharing the clean one's clock. */
	function twin(h: CouponHarness, wrapped: Parameters<typeof withCollection>[2]): CouponHarness {
		return makeCouponHarness(bound.storage, {
			clock: h.clock,
			storageForStore: withCollection(bound.storage, COUPONS_COLLECTION, wrapped),
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
		// The outcome record is the read-modify-write on the KEY document; the claim that
		// created it was a create-if-absent, so this targets step 4 alone.
		const failing = failCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			onId(docId, isUpdateWrite),
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

		// The bump landed and stamped its witness; the answer was never recorded.
		const mid = await couponDoc();
		expect(mid?.usesCount).toBe(1);
		expect(mid?.lastRedeemedKey).toBe("k-b");
		expect((await record("k-b"))?.outcome).toBeNull();

		const replay = await h.store.redeem(redeemInput("k-b"));
		expect(replay.ok).toBe(true);
		// Exact, not conservative: the witness is what keeps this from becoming 2.
		expect((await couponDoc())?.usesCount).toBe(1);
		expect((await record("k-b"))?.outcome).toEqual({ ok: true });
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
		const failing = failCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			onId(docId, isUpdateWrite),
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
});
