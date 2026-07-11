import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { customerId, idempotencyKey, orderId } from "../money/ids.js";
import type { CouponStore, CreateCouponInput } from "../ports/coupon-store.js";

export interface CouponStoreHarness {
	store: CouponStore;
}

export interface CouponStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");

const FAR_FUTURE = "9999-12-31T00:00:00.000Z";

function fixedCoupon(over: Partial<CreateCouponInput> = {}): CreateCouponInput {
	return {
		id: "c1",
		code: "SAVE5",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: null,
		maxUsesPerCustomer: null,
		...over,
	};
}

/** Behavioral spec for every `CouponStore` adapter (Phase 6 §5/§6). */
export function couponStoreContract(
	makeStore: () => Promise<CouponStoreHarness>,
	opts: CouponStoreContractOptions,
): void {
	describe(`couponStoreContract [${opts.dialect}]`, () => {
		test("create + findByCode round-trips the record", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon());
			const found = await store.findByCode("SAVE5");
			expect(found?.id).toBe("c1");
			expect(found?.type).toBe("fixed_amount");
			expect(found?.amountCents).toBe(500);
			expect(found?.currency).toBe("USD");
			expect(found?.usesCount).toBe(0);
			expect(await store.findByCode("NOPE")).toBeNull();
		});

		test("percentage coupon round-trips rateBps + cap", async () => {
			const { store } = await makeStore();
			await store.create(
				fixedCoupon({
					id: "c2",
					code: "TEN",
					type: "percentage",
					amountCents: null,
					currency: null,
					rateBps: 1000,
					capCents: cents(2000),
				}),
			);
			const found = await store.findByCode("TEN");
			expect(found?.type).toBe("percentage");
			expect(found?.rateBps).toBe(1000);
			expect(found?.capCents).toBe(2000);
		});

		test("redeem increments uses_count and records a redemption", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 3 }));
			const res = await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.replayed).toBe(false);
			expect((await store.findById("c1"))?.usesCount).toBe(1);
		});

		test("redeem replayed with the same idempotencyKey returns the same redemption and increments uses_count once", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 3 }));
			const input = {
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			};
			const first = await store.redeem(input);
			const replay = await store.redeem(input);
			expect(first.ok && replay.ok).toBe(true);
			if (!first.ok || !replay.ok) return;
			expect(replay.redemptionId).toBe(first.redemptionId);
			expect(replay.replayed).toBe(true);
			expect((await store.findById("c1"))?.usesCount).toBe(1); // once, not twice
		});

		test("redeem at maxUses returns COUPON_EXHAUSTED deterministically, with no extra decrement", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 2 }));
			for (let i = 0; i < 2; i++) {
				const r = await store.redeem({
					couponId: "c1",
					orderId: orderId(`o${i}`),
					idempotencyKey: idempotencyKey(`k${i}`),
					createdAt: "2026-07-10T00:00:00.000Z",
				});
				expect(r.ok).toBe(true);
			}
			const exhausted = await store.redeem({
				couponId: "c1",
				orderId: orderId("o3"),
				idempotencyKey: idempotencyKey("k3"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(exhausted).toEqual({ ok: false, reason: "COUPON_EXHAUSTED" });
			expect((await store.findById("c1"))?.usesCount).toBe(2);
		});

		test("maxUsesPerCustomer caps per-customer redemptions when a customer id is present", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 10, maxUsesPerCustomer: 1 }));
			const cust = customerId("cust-1");
			const first = await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				customerId: cust,
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(first.ok).toBe(true);
			const second = await store.redeem({
				couponId: "c1",
				orderId: orderId("o2"),
				idempotencyKey: idempotencyKey("k2"),
				customerId: cust,
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(second).toEqual({ ok: false, reason: "COUPON_MAX_PER_CUSTOMER" });
			// A DIFFERENT customer is unaffected.
			const other = await store.redeem({
				couponId: "c1",
				orderId: orderId("o3"),
				idempotencyKey: idempotencyKey("k3"),
				customerId: customerId("cust-2"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(other.ok).toBe(true);
		});

		test("guest checkout (no customer id) degrades to global-maxUses-only, ignoring maxUsesPerCustomer", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 5, maxUsesPerCustomer: 1 }));
			for (let i = 0; i < 3; i++) {
				const r = await store.redeem({
					couponId: "c1",
					orderId: orderId(`o${i}`),
					idempotencyKey: idempotencyKey(`k${i}`),
					createdAt: "2026-07-10T00:00:00.000Z",
				});
				expect(r.ok).toBe(true); // no per-customer key ⇒ only global cap applies
			}
			expect((await store.findById("c1"))?.usesCount).toBe(3);
		});

		test("releaseCoupon decrements uses_count and deletes the redemption row", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 3 }));
			const res = await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			await store.release(res.redemptionId);
			expect((await store.findById("c1"))?.usesCount).toBe(0);
			const remaining = await store.listRedemptionsCreatedBefore(FAR_FUTURE);
			expect(remaining.find((r) => r.id === res.redemptionId)).toBeUndefined();
		});

		test("releaseCoupon on an already-released or never-redeemed id is a no-op, not an error", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 3 }));
			const res = await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			await store.release(res.redemptionId);
			await store.release(res.redemptionId); // double release: no-op
			await store.release("never-existed"); // unknown id: no-op
			expect((await store.findById("c1"))?.usesCount).toBe(0);
		});

		test("releaseByOrder deletes the order's redemption, decrements uses_count, and is idempotent", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 5 }));
			const res = await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(res.ok).toBe(true);
			const released = await store.releaseByOrder(orderId("o1"));
			expect(released).toBe(1);
			expect((await store.findById("c1"))?.usesCount).toBe(0);
			const remaining = await store.listRedemptionsCreatedBefore(FAR_FUTURE);
			expect(remaining).toHaveLength(0);
			// Idempotent: a second release finds nothing.
			expect(await store.releaseByOrder(orderId("o1"))).toBe(0);
			expect((await store.findById("c1"))?.usesCount).toBe(0);
		});

		test("releaseByOrder on an order with no redemption is a no-op returning 0", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 5 }));
			expect(await store.releaseByOrder(orderId("no-such-order"))).toBe(0);
			expect((await store.findById("c1"))?.usesCount).toBe(0);
		});

		test("listRedemptionsCreatedBefore returns only rows strictly older than the cutoff", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 5 }));
			await store.redeem({
				couponId: "c1",
				orderId: orderId("o-old"),
				idempotencyKey: idempotencyKey("k-old"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			await store.redeem({
				couponId: "c1",
				orderId: orderId("o-new"),
				idempotencyKey: idempotencyKey("k-new"),
				createdAt: "2026-07-10T01:00:00.000Z",
			});
			const before = await store.listRedemptionsCreatedBefore("2026-07-10T00:30:00.000Z");
			expect(before.map((r) => r.orderId)).toEqual(["o-old"]);
		});
	});
}
