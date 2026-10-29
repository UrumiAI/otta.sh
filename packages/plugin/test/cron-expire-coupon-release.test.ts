/**
 * An order's expiry and its coupon release under the tick's query ceiling (#621).
 *
 * WHY. `expire-orders` flips a lapsed order to `expired` and then gives its coupon
 * use back (`releaseByOrder`). On the Workers Free preset that release can be the
 * part of the unit the ceiling refuses. Refused BEFORE the redemption's guarded
 * delete, the redemption still holds its use and `coupon-orphans` (its `expired`
 * arm) frees it on its next run. Refused AFTER the delete but before the decrement,
 * nothing is left for any sweep to find: the order is expired, the redemption is
 * gone, and the coupon's `usesCount` stays one high for good — a capped coupon then
 * refuses a shopper it should admit.
 *
 * So the sweep never starts a coupon release it cannot finish. Which call the ceiling
 * lands on depends on what the tick spent before the expiry reached this order, so
 * the suite runs the unit with every amount of room around its cost, and pins for
 * each: one budget-limited sweep, then the next coupon sweep leaves `usesCount`
 * exact, then a third sweep changes nothing.
 */
import { cents, currency, idempotencyKey, orderId as toOrderId } from "@urumi.ai/otta-domain";
import {
	collectionOf,
	EmdashCouponStore,
	uuidIdGen,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepSummary,
	type SweepLeg,
} from "../src/cron/index.js";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import { MAINTENANCE_LEG_INTERVAL_MS } from "../src/cron/sweeps.js";
import {
	adapters,
	DAY_MS,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	placeOrder,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const PAID = 600;

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function leg(summary: CommerceSweepSummary, name: SweepLeg) {
	const found = summary.legs.find((entry) => entry.leg === name);
	if (found === undefined) throw new Error(`no ${name} leg`);
	return found;
}

/** A lapsed one-line order that applied `SAVE10`, its redemption claimed as
 *  checkout claims it (the order's id and creation key), the coupon at one use. */
async function lapsedOrderWithCoupon(storage: StorageAccess) {
	const placed = await placeOrder(
		storage,
		"coupon-cut",
		new Date(NOW.getTime() - 30 * MINUTE_MS),
		new Date(NOW.getTime() - 2 * HOUR_MS),
		"SAVE10",
	);
	const coupons = new EmdashCouponStore({
		storage,
		idGen: uuidIdGen,
		clock: adapters(storage).clock,
	});
	await coupons.create({
		id: "coupon-cut",
		code: "SAVE10",
		type: "percentage",
		amountCents: null,
		rateBps: 1000,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: cents(0),
		startsAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
		expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
		maxUses: 10,
		maxUsesPerCustomer: null,
	});
	const redeemed = await coupons.redeem({
		couponId: "coupon-cut",
		orderId: toOrderId(placed.id),
		idempotencyKey: idempotencyKey("create-coupon-cut"),
		createdAt: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
	});
	expect(redeemed.ok).toBe(true);
	return { orderId: toOrderId(placed.id), coupons };
}

describe("an expiry's coupon release cut off by the query ceiling (#621)", () => {
	test("the next coupon sweep leaves usesCount exact, and a third sweep changes nothing — wherever the ceiling lands", async () => {
		// Budgets from too small to start the expiry at all up to comfortably past one
		// whole unit: every call of the flip and the release is the last one admitted
		// for one of them.
		const cutBeforeRelease: number[] = [];
		for (let budget = 14; budget <= 40; budget++) {
			const { storage } = await makeSqliteStorage(commerceStorageLayout());
			const { orderId, coupons } = await lapsedOrderWithCoupon(storage);
			const redemptions = collectionOf(storage, "coupon_redemptions");
			const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID });
			const cursors = memoryCursors();
			const sweep = async (at: Date, queryBudget: number) =>
				await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
					cursors,
					emailSender: recordingSender([]),
					now: at,
					queryBudget,
				});
			const usesCount = async () => (await coupons.findById("coupon-cut"))?.usesCount;
			const held = async () => (await redemptions.query({ limit: 10 })).items.length;

			const first = await sweep(NOW, budget);
			expect(first.budget.queriesUsed, `budget ${String(budget)}`).toBeLessThanOrEqual(budget);
			const state = (await adapters(storage).orderStore.getById(orderId))?.state;
			// Never the lost-release shape: an expired order with its redemption gone and
			// its use still counted.
			if (state === "expired" && (await held()) === 0) {
				expect(await usesCount(), `budget ${String(budget)}: released whole`).toBe(0);
			}
			if (state === "expired" && (await held()) === 1) cutBeforeRelease.push(budget);

			// The next coupon sweep (a full cadence on, so the leg is due whatever the
			// first tick stamped) — Paid room, so nothing is cut this time.
			const second = await sweep(new Date(NOW.getTime() + MAINTENANCE_LEG_INTERVAL_MS), PAID);
			expect((await adapters(storage).orderStore.getById(orderId))?.state).toBe("expired");
			expect(await usesCount(), `budget ${String(budget)}: healed`).toBe(0);
			expect(await held(), `budget ${String(budget)}: no redemption left`).toBe(0);
			expect(leg(second, "coupon-orphans").ok).toBe(true);

			// A third sweep finds nothing owed and gives nothing back twice.
			const third = await sweep(new Date(NOW.getTime() + 2 * MAINTENANCE_LEG_INTERVAL_MS), PAID);
			expect(await usesCount(), `budget ${String(budget)}: not released twice`).toBe(0);
			expect(leg(third, "coupon-orphans")).toMatchObject({ ok: true, count: 0 });
			expect(leg(third, "expire-orders").count).toBe(0);
		}
		// The case the issue is about was actually staged: the expiry landed and its
		// coupon release did not, for at least one budget.
		expect(cutBeforeRelease.length).toBeGreaterThan(0);
	}, 600_000);
});
