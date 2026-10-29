/**
 * `recountUses` (issue #619) against the interleavings the domain contract cannot
 * reach on the fake: a redeem or a release caught HALF-WAY between its two documents.
 *
 * | Held at | What must be true |
 * |---|---|
 * | the recount's own compare-and-set, while a redeem's `+1` lands | the write refuses (`moved`): the redeem is counted, never lost |
 * | a redeem's `+1`, with the step already `bumping` | `in_flight`, nothing written |
 * | a redeem's recorded answer, after its `+1` | `in_flight`, nothing written |
 * | a release's decrement, after its delete | the drift is seen but never corrected on that look; once the `-1` lands the counter is exact |
 *
 * The first row rests on one host behaviour, and the case pins it rather than
 * assuming it: the redeem's `+1` is a guarded `updateIf`, not a compare-and-set, and
 * it still MOVES the document's revision (the host's revision trigger fires on every
 * update). That is what makes the recount's compare-and-set at the revision it read
 * refuse after a bump; a host that stopped moving it would let the recount write the
 * redeem away.
 *
 * The real-concurrency half — a crowd of redeems racing confirmed recounts — is
 * Postgres-required and lives in `coupon-recount-race.pg.test.ts`.
 */
import { COUPON_RECOUNT_SETTLE_MS, idempotencyKey, orderId } from "@urumi.ai/otta-domain";
import { expect, test } from "vitest";
import {
	COUPON_REDEMPTIONS_COLLECTION,
	COUPONS_COLLECTION,
	type CouponDoc,
	type CouponRedemptionDoc,
} from "../src/index.js";
import { COUPON_LAYOUT } from "./coupon-collections.js";
import { makeCouponHarness, type CouponHarness } from "./coupon-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	isGuardedUpdate,
	isUpdateWrite,
	nthCall,
	onId,
	parkCall,
	withCollection,
} from "./helpers/fault-injection.js";

const AT = "2026-07-10T00:00:00.000Z";
const T0 = "2026-07-10T01:00:00.000Z";
/** Old enough to confirm an observation made at `T0`. */
const SETTLED = new Date(Date.parse(T0) + COUPON_RECOUNT_SETTLE_MS).toISOString();
const LATER = new Date(Date.parse(T0) + 2 * COUPON_RECOUNT_SETTLE_MS).toISOString();
const LATEST = new Date(Date.parse(T0) + 3 * COUPON_RECOUNT_SETTLE_MS).toISOString();

function redeemInput(key: string) {
	return {
		couponId: "c1",
		orderId: orderId(`o-${key}`),
		idempotencyKey: idempotencyKey(key),
		createdAt: AT,
	};
}

describeEachDialect("EmdashCouponStore.recountUses interleavings", (ctx) => {
	const bound = ctx.useStorage(COUPON_LAYOUT);

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

	/** A coupon with `held` applied redemptions and a counter seeded at `counted`. */
	async function drifted(h: CouponHarness, held: number, counted: number): Promise<void> {
		await h.seedCoupon({ id: "c1", code: "RECOUNT", createdAt: AT });
		for (let i = 0; i < held; i++) {
			expect((await h.store.redeem(redeemInput(`held-${String(i)}`))).ok).toBe(true);
		}
		await h.seedCoupon({ id: "c1", code: "RECOUNT", createdAt: AT, usesCount: counted });
	}

	test(`a recount's write held while a redeem lands is refused: the redeem is counted, never lost [${ctx.dialect}]`, async () => {
		const h = makeCouponHarness(bound.storage);
		await drifted(h, 1, 3);
		const first = await h.store.recountUses("c1", null, T0);
		if (first.outcome !== "drift") throw new Error(`expected drift, got ${first.outcome}`);

		// The recount's correcting write: a compare-and-set at the revision it read.
		const parked = parkCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isUpdateWrite),
		);
		const recounting = wrappedTwin(h, COUPONS_COLLECTION, parked.collection).store.recountUses(
			"c1",
			first.observation,
			SETTLED,
		);
		// The recount has read the counter (3) and counted one applied redemption, and
		// is about to write 1.
		await parked.arrived;

		const before = await h.coupons.getVersioned("c1");
		expect((await h.store.redeem(redeemInput("racer"))).ok).toBe(true);
		const after = await h.coupons.getVersioned("c1");
		expect(after?.value.usesCount).toBe(4);
		// The guard the recount's write relies on: the guarded `+1` moved the revision.
		expect(after?.revision).not.toBe(before?.revision);

		parked.release();
		expect(await recounting).toEqual({ outcome: "moved" });
		// Not 1: the racer's use survives.
		expect(await h.usesOf("c1")).toBe(4);

		// Left alone, the drift (two uses nobody holds) is corrected to the two held.
		const seen = await h.store.recountUses("c1", null, LATER);
		if (seen.outcome !== "drift") throw new Error(`expected drift, got ${seen.outcome}`);
		expect(seen.observation).toMatchObject({ usesCount: 4, liveUses: 2 });
		expect(await h.store.recountUses("c1", seen.observation, LATEST)).toEqual({
			outcome: "corrected",
			from: 4,
			to: 2,
		});
		expect(await h.usesOf("c1")).toBe(2);
	});

	test(`a redeem whose step is taken but whose +1 is parked is in flight: nothing is written [${ctx.dialect}]`, async () => {
		const h = makeCouponHarness(bound.storage);
		await drifted(h, 1, 3);
		const first = await h.store.recountUses("c1", null, T0);
		if (first.outcome !== "drift") throw new Error(`expected drift, got ${first.outcome}`);

		const parked = parkCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isGuardedUpdate),
		);
		const redeeming = wrappedTwin(h, COUPONS_COLLECTION, parked.collection).store.redeem(
			redeemInput("mid-bump"),
		);
		await parked.arrived;

		expect(await h.store.recountUses("c1", first.observation, SETTLED)).toEqual({
			outcome: "in_flight",
		});
		expect(await h.usesOf("c1")).toBe(3);

		parked.release();
		expect((await redeeming).ok).toBe(true);
		expect(await h.usesOf("c1")).toBe(4);
	});

	test(`a redeem whose +1 has landed but whose answer is not recorded is in flight: nothing is written [${ctx.dialect}]`, async () => {
		const h = makeCouponHarness(bound.storage);
		await drifted(h, 1, 3);
		const first = await h.store.recountUses("c1", null, T0);
		if (first.outcome !== "drift") throw new Error(`expected drift, got ${first.outcome}`);

		// The key document's read-modify-writes: the bump step, its heartbeat, then the
		// recorded answer — the third is parked, after the `+1` has landed.
		const parked = parkCall(
			bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION),
			nthCall(3, isUpdateWrite),
		);
		const redeeming = wrappedTwin(h, COUPON_REDEMPTIONS_COLLECTION, parked.collection).store.redeem(
			redeemInput("landed"),
		);
		await parked.arrived;
		expect(await h.usesOf("c1")).toBe(4);

		// Counting only `applied`, the recount would see one held use against four and
		// take this redeem's away. It is `bumping`, so nothing is judged.
		expect(await h.store.recountUses("c1", first.observation, SETTLED)).toEqual({
			outcome: "in_flight",
		});
		expect(await h.store.recountUses("c1", null, SETTLED)).toEqual({ outcome: "in_flight" });
		expect(await h.usesOf("c1")).toBe(4);

		parked.release();
		expect((await redeeming).ok).toBe(true);
		const seen = await h.store.recountUses("c1", null, LATER);
		if (seen.outcome !== "drift") throw new Error(`expected drift, got ${seen.outcome}`);
		expect(seen.observation).toMatchObject({ usesCount: 4, liveUses: 2 });
		expect(await h.store.recountUses("c1", seen.observation, LATEST)).toEqual({
			outcome: "corrected",
			from: 4,
			to: 2,
		});
	});

	test(`a release between its delete and its decrement is never corrected on that look [${ctx.dialect}]`, async () => {
		const h = makeCouponHarness(bound.storage);
		await h.seedCoupon({ id: "c1", code: "RECOUNT", createdAt: AT });
		const held = await h.store.redeem(redeemInput("leaving"));
		expect((await h.store.redeem(redeemInput("staying"))).ok).toBe(true);
		if (!held.ok) throw new Error("redeem refused");
		expect(await h.usesOf("c1")).toBe(2);

		const parked = parkCall(
			bound.collection<CouponDoc>(COUPONS_COLLECTION),
			onId("c1", isGuardedUpdate),
		);
		const releasing = wrappedTwin(h, COUPONS_COLLECTION, parked.collection).store.release(
			held.redemptionId,
		);
		// The redemption is deleted; its `-1` has not landed.
		await parked.arrived;
		const first = await h.store.recountUses("c1", null, T0);
		if (first.outcome !== "drift") throw new Error(`expected drift, got ${first.outcome}`);
		expect(first.observation).toMatchObject({ usesCount: 2, liveUses: 1 });
		expect(await h.usesOf("c1")).toBe(2);

		parked.release();
		await releasing;
		expect(await h.usesOf("c1")).toBe(1);
		// The decrement moved the counter's version, so the old observation confirms
		// nothing — and the counter is exact anyway. Correcting on the first look would
		// have left it at 0 with one use held.
		expect(await h.store.recountUses("c1", first.observation, SETTLED)).toEqual({
			outcome: "exact",
			usesCount: 1,
		});
		expect(await h.usesOf("c1")).toBe(1);
	});
	test(`it counts bumping BEFORE applied: a redeem settling between the counts is seen in one of them [${ctx.dialect}]`, async () => {
		// The order is the guard, not a style: a redeem moves bumping -> applied. Counted
		// bumping-first, a redeem caught between the counts is in flight at the first or
		// applied at the second. Counted the other way round, it can miss both — absent
		// from "applied", then gone from "bumping" — and its landed +1 reads as drift.
		const h = makeCouponHarness(bound.storage);
		await drifted(h, 2, 3);
		const counts: unknown[] = [];
		const redemptions = bound.collection<CouponRedemptionDoc>(COUPON_REDEMPTIONS_COLLECTION);
		const recording = new Proxy(redemptions, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (prop !== "count" || typeof value !== "function") return value;
				return async (where: { state?: unknown }) => {
					counts.push(where.state);
					return await (value as (w: unknown) => Promise<number>).call(target, where);
				};
			},
		});
		const twin = wrappedTwin(h, COUPON_REDEMPTIONS_COLLECTION, recording);
		const result = await twin.store.recountUses("c1", null, T0);
		expect(result).toMatchObject({ outcome: "drift", observation: { usesCount: 3, liveUses: 2 } });
		expect(counts).toEqual(["bumping", "applied"]);
	});
});
