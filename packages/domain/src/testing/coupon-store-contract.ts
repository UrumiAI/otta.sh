import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { customerId, idempotencyKey, orderId } from "../money/ids.js";
import type { CouponStore, CreateCouponInput, UpdateCouponInput } from "../ports/coupon-store.js";
import type { SeedCouponSummaryRow } from "./in-memory-coupon-store.js";

export interface CouponStoreHarness {
	store: CouponStore;
	/** Admin-UX Increment 3: seed a bare `coupons` row (no `create()`/clock
	 *  dance) with an EXACT `createdAt`, for the admin-list contract. The fake
	 *  wraps `InMemoryCouponStore.seedCouponRow`; the Kysely harness inserts a
	 *  real row — so fake, sqlite, and pg exercise the identical `listCoupons`
	 *  spec (mirrors `ProductCommerceStoreHarness.seedProduct`). */
	seedCoupon(row: SeedCouponSummaryRow): Promise<void>;
}

/** A coupon-list row seed with sensible defaults; overridable per case. */
function couponRow(
	overrides: Partial<SeedCouponSummaryRow> & { id: string },
): SeedCouponSummaryRow {
	return {
		code: `CODE-${overrides.id}`,
		type: "fixed_amount",
		amountCents: 500,
		currency: "USD",
		createdAt: "2026-07-10T00:00:00.000Z",
		...overrides,
	};
}

export interface CouponStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");

const FAR_FUTURE = "9999-12-31T00:00:00.000Z";

function updateInput(over: Partial<UpdateCouponInput> = {}): UpdateCouponInput {
	return {
		amountCents: cents(750),
		rateBps: null,
		capCents: null,
		minSubtotalCents: cents(2000),
		startsAt: null,
		expiresAt: "2027-01-01T00:00:00.000Z",
		maxUses: 100,
		maxUsesPerCustomer: null,
		...over,
	};
}

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

		// -- update: LWW edit of a coupon's economics/window ---------------------

		test("update edits economics + window (LWW); code/type/usesCount are preserved", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 3 }));
			await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			const res = await store.update("c1", updateInput());
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.coupon.amountCents).toBe(750);
			expect(res.coupon.minSubtotalCents).toBe(2000);
			expect(res.coupon.maxUses).toBe(100);
			expect(res.coupon.code).toBe("SAVE5"); // immutable identity
			expect(res.coupon.type).toBe("fixed_amount"); // immutable kind
			expect(res.coupon.usesCount).toBe(1); // store-owned counter, untouched by an edit
			expect((await store.findByCode("SAVE5"))?.amountCents).toBe(750);
		});

		test("update is idempotent under replay (set-values, not deltas)", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon());
			await store.update("c1", updateInput({ maxUses: 5 }));
			await store.update("c1", updateInput({ maxUses: 5 }));
			expect((await store.findById("c1"))?.maxUses).toBe(5);
		});

		test("update is not_found for an unknown id (an edit never mints a coupon)", async () => {
			const { store } = await makeStore();
			expect(await store.update("nope", updateInput())).toEqual({ ok: false, reason: "not_found" });
		});

		// -- delete: forbid-if-redeemed + snapshot invariant ---------------------

		test("delete removes an unredeemed coupon; findByCode then returns null (recompute sees it)", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon());
			expect(await store.delete("c1")).toEqual({ ok: true });
			expect(await store.findById("c1")).toBeNull();
			expect(await store.findByCode("SAVE5")).toBeNull();
		});

		test("delete is forbidden while a redemption references the coupon (in_use_by_redemptions)", async () => {
			const { store } = await makeStore();
			await store.create(fixedCoupon({ maxUses: 3 }));
			await store.redeem({
				couponId: "c1",
				orderId: orderId("o1"),
				idempotencyKey: idempotencyKey("k1"),
				createdAt: "2026-07-10T00:00:00.000Z",
			});
			expect(await store.delete("c1")).toEqual({ ok: false, reason: "in_use_by_redemptions" });
			expect(await store.findById("c1")).not.toBeNull(); // untouched, FK + audit trail intact
		});

		test("delete becomes possible once the redemption is released; then not_found is idempotent", async () => {
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
			expect(await store.delete("c1")).toEqual({ ok: true });
			expect(await store.delete("c1")).toEqual({ ok: false, reason: "not_found" });
		});

		test("delete is an idempotent not_found no-op for an unknown id", async () => {
			const { store } = await makeStore();
			expect(await store.delete("never")).toEqual({ ok: false, reason: "not_found" });
		});

		// -- listCoupons: admin Coupons console view-only keyset list (Increment 3) --

		test("listCoupons on an empty store returns no rows and a null cursor", async () => {
			const h = await makeStore();
			const res = await h.store.listCoupons({}, { limit: 25 });
			expect(res.coupons).toEqual([]);
			expect(res.nextCursor).toBeNull();
		});

		test("listCoupons projects the summary fields (money as Cents, usesCount as the redemption indicator)", async () => {
			const h = await makeStore();
			await h.seedCoupon(
				couponRow({
					id: "c-proj",
					code: "PROJECTED",
					type: "percentage",
					amountCents: null,
					rateBps: 1500,
					capCents: 2000,
					currency: null,
					minSubtotalCents: 5000,
					startsAt: "2026-07-01T00:00:00.000Z",
					expiresAt: "2026-08-01T00:00:00.000Z",
					maxUses: 10,
					maxUsesPerCustomer: 1,
					usesCount: 3,
					createdAt: "2026-07-10T01:00:00.000Z",
				}),
			);
			const { coupons } = await h.store.listCoupons({}, { limit: 25 });
			expect(coupons).toHaveLength(1);
			const c = coupons[0]!;
			expect(c.id).toBe("c-proj");
			expect(c.code).toBe("PROJECTED");
			expect(c.type).toBe("percentage");
			expect(c.rateBps).toBe(1500);
			expect(c.capCents).toBe(2000);
			expect(c.minSubtotalCents).toBe(5000);
			// The validity window is part of the summary (PR #74 review — the
			// console list renders expiry straight off this row, no detail fetch).
			expect(c.startsAt).toBe("2026-07-01T00:00:00.000Z");
			expect(c.expiresAt).toBe("2026-08-01T00:00:00.000Z");
			expect(c.maxUses).toBe(10);
			expect(c.maxUsesPerCustomer).toBe(1);
			expect(c.usesCount).toBe(3);
			expect(c.createdAt).toBe("2026-07-10T01:00:00.000Z");
		});

		test("listCoupons with no filter orders by created_at DESC, then id DESC", async () => {
			const h = await makeStore();
			await h.seedCoupon(couponRow({ id: "cpn-a", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedCoupon(couponRow({ id: "cpn-b", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedCoupon(couponRow({ id: "cpn-c", createdAt: "2026-07-10T00:00:01.000Z" }));
			const { coupons } = await h.store.listCoupons({}, { limit: 25 });
			// Same created_at ⇒ id DESC (cpn-b before cpn-a); older cpn-c last.
			expect(coupons.map((c) => c.id)).toEqual(["cpn-b", "cpn-a", "cpn-c"]);
		});

		test("listCoupons search matches an EXACT code, case-insensitively (never a substring)", async () => {
			const h = await makeStore();
			await h.seedCoupon(couponRow({ id: "a", code: "SAVE5" }));
			await h.seedCoupon(couponRow({ id: "b", code: "SAVE50" }));
			const { coupons } = await h.store.listCoupons({ search: "save5" }, { limit: 25 });
			expect(coupons.map((c) => c.id)).toEqual(["a"]);
			// A substring of a code must NOT match.
			const partial = await h.store.listCoupons({ search: "save" }, { limit: 25 });
			expect(partial.coupons).toEqual([]);
		});

		test("listCoupons paginates forward with a keyset cursor — no overlap, no gap", async () => {
			const h = await makeStore();
			await h.seedCoupon(couponRow({ id: "p1", createdAt: "2026-07-10T00:00:01.000Z" }));
			await h.seedCoupon(couponRow({ id: "p2", createdAt: "2026-07-10T00:00:02.000Z" }));
			await h.seedCoupon(couponRow({ id: "p3", createdAt: "2026-07-10T00:00:03.000Z" }));
			// Newest-first: p3, p2, p1.
			const page1 = await h.store.listCoupons({}, { limit: 2 });
			expect(page1.coupons.map((c) => c.id)).toEqual(["p3", "p2"]);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.nextCursor?.couponId).toBe("p2"); // last returned row
			const page2 = await h.store.listCoupons({}, { limit: 2, cursor: page1.nextCursor });
			expect(page2.coupons.map((c) => c.id)).toEqual(["p1"]); // remainder
			expect(page2.nextCursor).toBeNull();
			// No overlap, no gap: the two pages concatenate to the full DESC order.
			expect([...page1.coupons, ...page2.coupons].map((c) => c.id)).toEqual(["p3", "p2", "p1"]);
		});

		test("listCoupons keyset tie-break is stable across a page boundary on identical created_at", async () => {
			const h = await makeStore();
			const at = "2026-07-10T00:00:05.000Z";
			for (const id of ["cpn-01", "cpn-02", "cpn-03", "cpn-04"]) {
				await h.seedCoupon(couponRow({ id, createdAt: at }));
			}
			// All share created_at ⇒ pure id DESC.
			const page1 = await h.store.listCoupons({}, { limit: 2 });
			expect(page1.coupons.map((c) => c.id)).toEqual(["cpn-04", "cpn-03"]);
			expect(page1.nextCursor).toEqual({ createdAt: at, couponId: "cpn-03" });
			const page2 = await h.store.listCoupons({}, { limit: 2, cursor: page1.nextCursor });
			expect(page2.coupons.map((c) => c.id)).toEqual(["cpn-02", "cpn-01"]);
			expect(page2.nextCursor).toBeNull();
		});

		test("listCoupons with rows exactly equal to the limit returns a null cursor (no phantom page)", async () => {
			const h = await makeStore();
			await h.seedCoupon(couponRow({ id: "p1", createdAt: "2026-07-10T00:00:01.000Z" }));
			await h.seedCoupon(couponRow({ id: "p2", createdAt: "2026-07-10T00:00:02.000Z" }));
			const res = await h.store.listCoupons({}, { limit: 2 });
			expect(res.coupons.map((c) => c.id)).toEqual(["p2", "p1"]);
			expect(res.nextCursor).toBeNull();
		});

		// -- countCoupons (INC-23: the exact count the admin list captions with) --

		test("countCoupons counts the whole filtered set, independently of any page size", async () => {
			const h = await makeStore();
			for (const id of ["c1", "c2", "c3"]) {
				await h.seedCoupon(couponRow({ id, code: `CODE-${id}` }));
			}
			// The point of the count: a 2-row page says nothing about the set behind
			// it, and keyset paging carries no running offset to derive one from.
			const page = await h.store.listCoupons({}, { limit: 2 });
			expect(page.coupons).toHaveLength(2);
			expect(await h.store.countCoupons({})).toBe(3);
		});

		test("countCoupons applies the same EXACT-match search predicate as listCoupons", async () => {
			const h = await makeStore();
			await h.seedCoupon(couponRow({ id: "a", code: "SAVE5" }));
			await h.seedCoupon(couponRow({ id: "b", code: "SAVE50" }));
			expect(await h.store.countCoupons({ search: "save5" })).toBe(1);
			// A substring must no more match the count than it matches the list.
			expect(await h.store.countCoupons({ search: "save" })).toBe(0);
		});

		test("countCoupons on an empty store is 0", async () => {
			const h = await makeStore();
			expect(await h.store.countCoupons({})).toBe(0);
		});
	});
}
