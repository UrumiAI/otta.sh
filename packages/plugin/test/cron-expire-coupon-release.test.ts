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
 * So the sweep never begins a coupon release it cannot afford, and finishes one it
 * has begun inside the commit window (`COUPON_RELEASE_CALLS`). Which call the
 * ceiling would land on depends on what the tick spent before the expiry reached
 * this order, so the suite runs the unit with every amount of room around its cost,
 * for a guest redemption, a customer-bound one, and a customer-bound one whose
 * per-customer slot write loses its compare-and-set to a peer once or twice — and
 * pins for each: one budget-limited sweep, then the next coupon sweep leaves
 * `usesCount` exact, then a third sweep changes nothing.
 */
import {
	cents,
	currency,
	customerId,
	idempotencyKey,
	orderId as toOrderId,
} from "@urumi.ai/otta-domain";
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
import { COMMIT_WINDOW_EXEMPT_BUDGET, MAX_COMMIT_WINDOW } from "../src/cron/tick-budget.js";
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
const CAPS = "coupon_customer_caps";

let warnings: string[];

beforeEach(() => {
	warnings = [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function leg(summary: CommerceSweepSummary, name: SweepLeg) {
	const found = summary.legs.find((entry) => entry.leg === name);
	if (found === undefined) throw new Error(`no ${name} leg`);
	return found;
}

/**
 * `storage` with a PEER writing the per-customer slot document just before each of
 * the next `races.left` compare-and-sets on it, so that write loses and the store
 * retries — real contention, on the real document. `races.lost` counts the losses.
 */
function racingSlots(storage: StorageAccess, races: { left: number; lost: number }): StorageAccess {
	const caps = storage[CAPS];
	if (caps === undefined) throw new Error(`no ${CAPS} collection`);
	const wrapped = new Proxy(caps, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop !== "compareAndSet") return (value as (...a: unknown[]) => unknown).bind(target);
			return async (id: string, ...rest: unknown[]) => {
				if (races.left > 0) {
					races.left--;
					const current = await target.getVersioned(id);
					if (current !== null) await target.compareAndSet(id, current.revision, current.value);
				}
				const written = (await (value as (...a: unknown[]) => Promise<unknown>).apply(target, [
					id,
					...rest,
				])) as { applied: boolean };
				if (!written.applied) races.lost++;
				return written;
			};
		},
	});
	return { ...storage, [CAPS]: wrapped };
}

/** A lapsed one-line order that applied `SAVE10`, its redemption claimed as
 *  checkout claims it (the order's id and creation key, the order's customer), the
 *  coupon at one use. */
async function lapsedOrderWithCoupon(storage: StorageAccess, customer: string | null) {
	const placed = await placeOrder(
		storage,
		"coupon-cut",
		new Date(NOW.getTime() - 30 * MINUTE_MS),
		new Date(NOW.getTime() - 2 * HOUR_MS),
		{ appliedCouponCode: "SAVE10", ...(customer === null ? {} : { customerId: customer }) },
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
		maxUsesPerCustomer: 1,
	});
	const redeemed = await coupons.redeem({
		couponId: "coupon-cut",
		orderId: toOrderId(placed.id),
		idempotencyKey: idempotencyKey("create-coupon-cut"),
		...(customer === null ? {} : { customerId: customerId(customer) }),
		createdAt: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
	});
	expect(redeemed.ok).toBe(true);
	return { orderId: toOrderId(placed.id), coupons };
}

const SHAPES = [
	{ name: "a guest redemption", customer: null, slotRaces: 0 },
	{ name: "a customer-bound redemption", customer: "cust-cut", slotRaces: 0 },
	{
		name: "a customer-bound redemption, its slot write lost once",
		customer: "cust-cut",
		slotRaces: 1,
	},
	// Two lost slot writes is the most the commit window absorbs (see
	// `COUPON_RELEASE_CALLS`): the customer figure (7) plus the window is exactly that
	// release's cost, so a figure below the real one fails here.
	{
		name: "a customer-bound redemption, its slot write lost twice",
		customer: "cust-cut",
		slotRaces: 2,
	},
] as const;

describe("an expiry's coupon release cut off by the query ceiling (#621)", () => {
	test.each(SHAPES)(
		"$name: the next coupon sweep leaves usesCount exact, and a third sweep changes nothing — wherever the ceiling lands",
		async ({ customer, slotRaces }) => {
			// Budgets from too small to start the expiry at all up to comfortably past one
			// whole unit, on both sides of the Free preset (whose commit window is not
			// kept out of the ceiling): every call of the flip and the release is the
			// last one admitted for one of them.
			const skipped: number[] = [];
			for (let budget = 14; budget <= 44; budget++) {
				const label = `budget ${String(budget)}`;
				warnings = [];
				const { storage } = await makeSqliteStorage(commerceStorageLayout());
				const { orderId, coupons } = await lapsedOrderWithCoupon(storage, customer);
				const redemptions = collectionOf(storage, "coupon_redemptions");
				const races = { left: slotRaces, lost: 0 };
				const raced = sweepContext(racingSlots(storage, races), undefined, {
					[BACKGROUND_WORK_KEY]: PAID,
				});
				const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID });
				const cursors = memoryCursors();
				const sweep = async (on: typeof ctx, at: Date, queryBudget: number) =>
					await runCommerceSweeps(on, SWEEP_TASK_NAME, {
						cursors,
						emailSender: recordingSender([]),
						now: at,
						queryBudget,
					});
				const usesCount = async () => (await coupons.findById("coupon-cut"))?.usesCount;
				const held = async () => (await redemptions.query({ limit: 10 })).items.length;

				const first = await sweep(raced, NOW, budget);
				// The tick stays inside the overrun contract: past its budget only by the
				// one commit window a Free-sized tick may open, and never twice.
				expect(
					first.budget.queriesUsed,
					`${label}: within the overrun contract`,
				).toBeLessThanOrEqual(
					budget + (budget <= COMMIT_WINDOW_EXEMPT_BUDGET ? MAX_COMMIT_WINDOW : 0),
				);
				const state = (await adapters(storage).orderStore.getById(orderId))?.state;
				// Never the lost-release shape: an expired order with its redemption gone
				// and its use still counted.
				if (state === "expired" && (await held()) === 0) {
					expect(await usesCount(), `${label}: released whole`).toBe(0);
					// A release that ran to the end had its slot write raced as staged.
					expect(races.lost, `${label}: the slot write lost`).toBe(slotRaces);
				}
				if (state === "expired" && (await held()) === 1) {
					// The release was skipped, not cut: the expiry is counted, the leg is
					// reported unfinished, and nothing calls it an estimate gone wrong.
					skipped.push(budget);
					expect(leg(first, "expire-orders"), label).toMatchObject({
						ok: true,
						count: 1,
						incomplete: true,
					});
					expect(
						warnings.filter((line) =>
							line.includes("expire-orders stopped at the tick's query ceiling"),
						),
						label,
					).toEqual([]);
				}

				// The next coupon sweep (a full cadence on, so the leg is due whatever the
				// first tick stamped) — Paid room, so nothing is cut this time.
				const second = await sweep(
					ctx,
					new Date(NOW.getTime() + MAINTENANCE_LEG_INTERVAL_MS),
					PAID,
				);
				expect((await adapters(storage).orderStore.getById(orderId))?.state).toBe("expired");
				expect(await usesCount(), `${label}: healed`).toBe(0);
				expect(await held(), `${label}: no redemption left`).toBe(0);
				expect(leg(second, "coupon-orphans").ok).toBe(true);

				// A third sweep finds nothing owed and gives nothing back twice.
				const third = await sweep(
					ctx,
					new Date(NOW.getTime() + 2 * MAINTENANCE_LEG_INTERVAL_MS),
					PAID,
				);
				expect(await usesCount(), `${label}: not released twice`).toBe(0);
				expect(leg(third, "coupon-orphans")).toMatchObject({ ok: true, count: 0 });
				expect(leg(third, "expire-orders").count).toBe(0);
			}
			// The case the issue is about was actually staged: the expiry landed and its
			// coupon release did not, for at least one budget.
			expect(skipped.length).toBeGreaterThan(0);
		},
		600_000,
	);
});

describe("a same-key replay's redemption, older than its order's hold (#621)", () => {
	test("skips the still-pending order without passing it, frees the orphans behind it, and frees its coupon once the order expires", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		// The replay's order: created a few minutes ago, its hold still running. The
		// redemption keeps the FIRST attempt's `createdAt`, two hours back — old enough
		// to judge. `appliedCouponCode` is not stamped, so the expiry gives nothing back
		// itself: the coupon sweep is all that stands between the use and a lost one,
		// exactly as when the expiry's release is skipped for want of budget.
		const placed = await placeOrder(
			storage,
			"replay",
			new Date(NOW.getTime() + 10 * MINUTE_MS),
			new Date(NOW.getTime() - 5 * MINUTE_MS),
		);
		const coupons = new EmdashCouponStore({
			storage,
			idGen: uuidIdGen,
			clock: adapters(storage).clock,
		});
		await coupons.create({
			id: "coupon-replay",
			code: "REPLAY10",
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
			couponId: "coupon-replay",
			orderId: toOrderId(placed.id),
			idempotencyKey: idempotencyKey("create-replay"),
			createdAt: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
		});
		expect(redeemed.ok).toBe(true);
		// Behind it in the walk, a true orphan: a claim whose order never became durable.
		// One live checkout must not hold it up.
		const orphan = await coupons.redeem({
			couponId: "coupon-replay",
			orderId: toOrderId("order-never-persisted"),
			idempotencyKey: idempotencyKey("create-never-persisted"),
			createdAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
		});
		expect(orphan.ok).toBe(true);
		const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID });
		const cursors = memoryCursors();
		const sweep = async (at: Date) =>
			await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				now: at,
			});
		const usesCount = async () => (await coupons.findById("coupon-replay"))?.usesCount;

		// Inside the hold: the replay's redemption is skipped, not judged live, and the
		// orphan behind it is freed.
		expect(await usesCount()).toBe(2);
		const inHold = await sweep(NOW);
		expect(leg(inHold, "coupon-orphans")).toMatchObject({ ok: true, count: 1 });
		expect(await usesCount()).toBe(1);

		// The hold lapses and the order expires; the coupon sweep, its cursor still
		// before that redemption, frees the use on its next run — once.
		await sweep(new Date(NOW.getTime() + 11 * MINUTE_MS));
		expect((await adapters(storage).orderStore.getById(toOrderId(placed.id)))?.state).toBe(
			"expired",
		);
		await sweep(new Date(NOW.getTime() + 11 * MINUTE_MS + MAINTENANCE_LEG_INTERVAL_MS));
		expect(await usesCount()).toBe(0);
		const after = await sweep(
			new Date(NOW.getTime() + 11 * MINUTE_MS + 2 * MAINTENANCE_LEG_INTERVAL_MS),
		);
		expect(leg(after, "coupon-orphans")).toMatchObject({ ok: true, count: 0 });
		expect(await usesCount()).toBe(0);
	}, 120_000);
});
