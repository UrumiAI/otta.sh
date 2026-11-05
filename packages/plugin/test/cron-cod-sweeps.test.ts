/**
 * ADR-0044 in the commerce sweep:
 *
 *  - `cod-auto-cancel`: an `awaiting_payment` cash-on-delivery order older than the
 *    merchant's window (`settings:codAutoCancelDays`, default 14, 0 = off) is
 *    cancelled — its stock back on sale, its coupon use freed — and a fresh one is
 *    left alone. Inside the tick's query budget like every leg.
 *  - `coupon-orphans` (review finding 2): a redemption whose order is
 *    `awaiting_payment` or `shipped_awaiting_payment` is LIVE — the order owns its
 *    coupon use — so the walk passes it: it never pins the cursor nor waits on the
 *    order's (meaningless) hold deadline.
 *
 * Real SQLite documents, through the sweep's own composition.
 */
import {
	cancelOrder,
	cancelUnpaidOfflineOrders,
	cents,
	currency,
	NOOP_LOGGER,
	idempotencyKey,
	offlinePaymentRef,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	type OrderState,
} from "@urumi.ai/otta-domain";
import { EmdashCouponStore, uuidIdGen, type StorageAccess } from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	runCommerceSweeps,
	SWEEP_TASK_NAME,
	type CommerceSweepSummary,
	type SweepLeg,
} from "../src/cron/index.js";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import { COD_AUTO_CANCEL_DAYS_KEY } from "../src/payments/cash-on-delivery.js";
import {
	adapters,
	DAY_MS,
	HOUR_MS,
	memoryCursors,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

/** The coupon walk's cursor overlap (`CURSOR_OVERLAP_MS` in sweeps.ts). */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const PAID = 600;
/** The Workers Free preset. */
const FREE = 30;

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

/**
 * A one-line physical COD order over one real adopted hold, created at
 * `createdAt` and placed (`pending → awaiting_payment`, as checkout flips it), with
 * a redemption of `coupon` claimed as checkout claims it. Optionally shipped.
 */
async function placeCodOrder(
	storage: StorageAccess,
	tag: string,
	createdAt: Date,
	options: { coupon?: { id: string; code: string }; state?: OrderState } = {},
): Promise<{ id: string; sku: string }> {
	const s = adapters(storage, createdAt);
	const sku = `COD-${tag}`;
	await s.inventory.seedOnHand(toSku(sku), 10);
	const held = await s.inventory.reserve(toSku(sku), 1, idempotencyKey(`res-${tag}`));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	const holdExpiresAt = new Date(createdAt.getTime() + 15 * 60_000).toISOString();
	await s.inventory.stampHoldDeadline(held.reservationId, holdExpiresAt);
	const id = `order-${tag}`;
	await s.inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId(id),
		holdExpiresAt,
		now: createdAt.toISOString(),
	});
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-${tag}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${tag}`),
		holdExpiresAt,
		buyerRef: `buyer-${tag}@example.test`,
		paymentMethod: "cod",
		offlineClientKey: `client-${tag}`,
		lines: [
			{
				productId: toProductId(`prod-${tag}`),
				sku: toSku(sku),
				title: "Cash Widget",
				unitPrice: cents(1000),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: {
			subtotal: cents(1000),
			total: cents(1000),
			currency: currency("USD"),
			...(options.coupon === undefined ? {} : { appliedCouponCode: options.coupon.code }),
		},
	});
	if (options.coupon !== undefined) {
		const redeemed = await coupons(storage, createdAt).redeem({
			couponId: options.coupon.id,
			orderId: toOrderId(id),
			idempotencyKey: idempotencyKey(`create-${tag}`),
			createdAt: createdAt.toISOString(),
		});
		if (!redeemed.ok) throw new Error(`could not redeem: ${redeemed.reason}`);
	}
	const placed = await s.orderStore.transition({
		orderId: toOrderId(id),
		fromState: "pending",
		toState: "awaiting_payment",
		idempotencyKey: idempotencyKey(`create-${tag}`),
		enqueueEmail: true,
	});
	if (!placed.transitioned) throw new Error("could not place the COD order");
	if (options.state === "shipped_awaiting_payment") {
		const shipped = await s.orderStore.transition({
			orderId: toOrderId(id),
			fromState: "awaiting_payment",
			toState: "shipped_awaiting_payment",
			idempotencyKey: idempotencyKey(`ship-${tag}`),
			enqueueEmail: false,
		});
		if (!shipped.transitioned) throw new Error("could not ship the COD order");
	}
	return { id, sku };
}

function coupons(storage: StorageAccess, at: Date): EmdashCouponStore {
	return new EmdashCouponStore({ storage, idGen: uuidIdGen, clock: adapters(storage, at).clock });
}

async function seedCoupon(storage: StorageAccess, id: string, code: string): Promise<void> {
	await coupons(storage, NOW).create({
		id,
		code,
		type: "percentage",
		amountCents: null,
		rateBps: 1000,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: cents(0),
		startsAt: new Date(NOW.getTime() - 60 * DAY_MS).toISOString(),
		expiresAt: new Date(NOW.getTime() + 60 * DAY_MS).toISOString(),
		maxUses: 10,
		maxUsesPerCustomer: null,
	});
}

async function sweep(storage: StorageAccess, kv: Record<string, unknown> = {}, at = NOW) {
	return await runCommerceSweeps(
		sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID, ...kv }),
		SWEEP_TASK_NAME,
		{ cursors: memoryCursors(), emailSender: recordingSender([]), now: at, queryBudget: PAID },
	);
}

describe("cod-auto-cancel", () => {
	test("a stale awaiting_payment COD order is cancelled, its stock and coupon released; a fresh one is untouched", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		await seedCoupon(storage, "coupon-cod", "CODSAVE");
		const stale = await placeCodOrder(storage, "stale", new Date(NOW.getTime() - 15 * DAY_MS), {
			coupon: { id: "coupon-cod", code: "CODSAVE" },
		});
		const fresh = await placeCodOrder(storage, "fresh", new Date(NOW.getTime() - 13 * DAY_MS));
		const s = adapters(storage, NOW);
		expect(await s.inventory.getOnHand(toSku(stale.sku))).toBe(9);
		expect((await coupons(storage, NOW).findById("coupon-cod"))?.usesCount).toBe(1);

		const summary = await sweep(storage);
		expect(leg(summary, "cod-auto-cancel")).toMatchObject({ ok: true, count: 1 });

		const cancelled = await s.orderStore.getById(toOrderId(stale.id));
		expect(cancelled).toMatchObject({
			state: "cancelled",
			cancellation: { reason: "other", detail: "Not paid within 14 days" },
		});
		expect((await s.orderStore.getById(toOrderId(fresh.id)))?.state).toBe("awaiting_payment");
		// The stale order's coupon use is free again; its unit is back on sale (the
		// release intent the cancel records may finish on the tick's own hold leg).
		expect((await coupons(storage, NOW).findById("coupon-cod"))?.usesCount).toBe(0);
		const later = await sweep(storage, {}, new Date(NOW.getTime() + HOUR_MS));
		expect(await s.inventory.getOnHand(toSku(stale.sku))).toBe(10);
		expect(await s.inventory.getOnHand(toSku(fresh.sku))).toBe(9);
		expect(leg(later, "cod-auto-cancel").ok).toBe(true);
		expect((await s.orderStore.getById(toOrderId(fresh.id)))?.state).toBe("awaiting_payment");
	});

	test("the merchant's window is read from kv: 0 turns it off, and a shorter one reaches younger orders", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		const order = await placeCodOrder(storage, "window", new Date(NOW.getTime() - 3 * DAY_MS));
		const s = adapters(storage, NOW);

		const off = await sweep(storage, { [COD_AUTO_CANCEL_DAYS_KEY]: 0 });
		expect(leg(off, "cod-auto-cancel").count).toBe(0);
		expect((await s.orderStore.getById(toOrderId(order.id)))?.state).toBe("awaiting_payment");

		const lowered = await sweep(storage, { [COD_AUTO_CANCEL_DAYS_KEY]: 2 });
		expect(leg(lowered, "cod-auto-cancel").count).toBe(1);
		expect(await s.orderStore.getById(toOrderId(order.id))).toMatchObject({
			state: "cancelled",
			cancellation: { detail: "Not paid within 2 days" },
		});
	});

	test("a shipped_awaiting_payment order is never auto-cancelled: the goods are out", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		const order = await placeCodOrder(storage, "shipped", new Date(NOW.getTime() - 40 * DAY_MS), {
			state: "shipped_awaiting_payment",
		});
		const summary = await sweep(storage);
		expect(leg(summary, "cod-auto-cancel").count).toBe(0);
		expect((await adapters(storage, NOW).orderStore.getById(toOrderId(order.id)))?.state).toBe(
			"shipped_awaiting_payment",
		);
	});
});

describe("cod-auto-cancel walks past a skipped order (review: a flagged head blocked the leg)", () => {
	test("on Workers Free, a flagged oldest order never stops a younger due order being cancelled", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		// The oldest: a Mark paid recorded the cash and died before its flip. The
		// auto-cancel flags it for a person and skips it — every pass.
		const flagged = await placeCodOrder(storage, "head", new Date(NOW.getTime() - 30 * DAY_MS));
		const younger = await placeCodOrder(storage, "behind", new Date(NOW.getTime() - 20 * DAY_MS));
		const s = adapters(storage, NOW);
		await s.orderStore.recordPayment({
			orderId: toOrderId(flagged.id),
			gateway: "cod",
			providerRef: offlinePaymentRef("cod", toOrderId(flagged.id)),
			amount: cents(1000),
			currency: currency("USD"),
			status: "succeeded",
		});
		const cursors = memoryCursors();
		// The leg shares Free ticks with every other leg, so it is deferred on some;
		// what matters is that it gets PAST the head, which before the cursor it never
		// did however many ticks ran.
		for (let tick = 0; tick < 30; tick++) {
			const at = new Date(NOW.getTime() + tick * 60_000);
			const summary = await runCommerceSweeps(
				sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: FREE }),
				SWEEP_TASK_NAME,
				{ cursors, emailSender: recordingSender([]), now: at, queryBudget: FREE },
			);
			expect(leg(summary, "cod-auto-cancel").ok).toBe(true);
			expect(summary.budget.queriesUsed).toBeLessThanOrEqual(FREE);
			if ((await s.orderStore.getById(toOrderId(younger.id)))?.state === "cancelled") break;
		}
		expect((await s.orderStore.getById(toOrderId(younger.id)))?.state).toBe("cancelled");
		const head = await s.orderStore.getById(toOrderId(flagged.id));
		expect(head?.state).toBe("awaiting_payment");
		expect(head?.reconciliationFlag).toMatch(/cash recorded/);
	});
});

describe("cod-auto-cancel's coupon release is begun only with room for the cancel after it", () => {
	test("a stale coupon COD order never takes a tick past its ceiling, whatever the budget", async () => {
		const logged = vi.spyOn(console, "log").mockImplementation(() => {});
		let ran = 0;
		let freeCancelled = false;
		for (let budget = 30; budget <= 70; budget++) {
			const { storage } = await makeSqliteStorage(commerceStorageLayout());
			await seedCoupon(storage, "coupon-room", "CODROOM");
			const order = await placeCodOrder(storage, "room", new Date(NOW.getTime() - 20 * DAY_MS), {
				coupon: { id: "coupon-room", code: "CODROOM" },
			});
			const cursors = memoryCursors();
			for (let tick = 0; tick < 8; tick++) {
				logged.mockClear();
				const summary = await runCommerceSweeps(
					sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: budget }),
					SWEEP_TASK_NAME,
					{
						cursors,
						emailSender: recordingSender([]),
						now: new Date(NOW.getTime() + tick * 60_000),
						queryBudget: budget,
					},
				);
				const where = `budget ${String(budget)}, tick ${String(tick)}`;
				const outcome = leg(summary, "cod-auto-cancel");
				expect(outcome.ok, `${where}: ${String(outcome.error)}`).toBe(true);
				expect(summary.budget.queriesUsed, where).toBeLessThanOrEqual(budget);
				// The ceiling never cut the cancel after a release it let begin.
				const lines = logged.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
				expect(lines, where).not.toMatch(/stopped at the ceiling: [^\n]*cod-auto-cancel/);
				// Either it fitted and was cancelled with its use freed, or nothing was begun.
				const state = (await adapters(storage, NOW).orderStore.getById(toOrderId(order.id)))?.state;
				const uses = (await coupons(storage, NOW).findById("coupon-room"))?.usesCount;
				expect([state, uses], where).toEqual(
					state === "cancelled" ? ["cancelled", 0] : ["awaiting_payment", 1],
				);
				if (state === "cancelled") {
					ran++;
					if (budget === FREE) freeCancelled = true;
					break;
				}
			}
		}
		// Some budgets afford it: the test is not vacuous.
		expect(ran).toBeGreaterThan(0);
		// And Workers Free is one of them: reserving more than the cancel still costs
		// once the release returns put a coupon order out of a Free tick's reach.
		expect(freeCancelled).toBe(true);
	});
});

describe("coupon-orphans and an auto-cancelled COD order", () => {
	test("a use the auto-cancel did not free (skipped, or lost to a crash) is freed by coupon-orphans; a merchant's cancel keeps its use", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		await seedCoupon(storage, "coupon-auto", "CODAUTO");
		await seedCoupon(storage, "coupon-kept", "CODKEPT");
		const createdAt = new Date(NOW.getTime() - 20 * DAY_MS);
		const auto = await placeCodOrder(storage, "auto-skipped", createdAt, {
			coupon: { id: "coupon-auto", code: "CODAUTO" },
		});
		const kept = await placeCodOrder(storage, "merchant-cancel", createdAt, {
			coupon: { id: "coupon-kept", code: "CODKEPT" },
		});
		const s = adapters(storage, NOW);
		// The auto-cancel's flip landed and its coupon release did not.
		await cancelUnpaidOfflineOrders(
			{
				orderStore: s.orderStore,
				couponStore: { releaseByOrder: async () => 0 },
				clock: s.clock,
				logger: NOOP_LOGGER,
			},
			{ maxAgeDays: 14, limit: 1 },
		);
		expect((await s.orderStore.getById(toOrderId(auto.id)))?.state).toBe("cancelled");
		const merchant = await cancelOrder(
			{ orderStore: s.orderStore, logger: NOOP_LOGGER },
			{
				orderId: toOrderId(kept.id),
				reason: "other",
				detail: "Buyer called",
				cancelledBy: "admin@example.test",
				idempotencyKey: idempotencyKey("merchant-cancel"),
			},
		);
		expect(merchant.ok).toBe(true);
		expect((await coupons(storage, NOW).findById("coupon-auto"))?.usesCount).toBe(1);

		const summary = await sweep(storage);
		expect(leg(summary, "coupon-orphans")).toMatchObject({ ok: true, count: 1 });
		expect((await coupons(storage, NOW).findById("coupon-auto"))?.usesCount).toBe(0);
		expect((await coupons(storage, NOW).findById("coupon-kept"))?.usesCount).toBe(1);
	});
});

describe("auto-cancel's coupon release is durable (review round 2, M2)", () => {
	test("coupon-orphans has ALREADY passed the redemption and the release fails: the order is not cancelled, and the next sweep frees the use and cancels it", async () => {
		const { storage } = await makeSqliteStorage(commerceStorageLayout());
		await seedCoupon(storage, "coupon-durable", "CODDURABLE");
		const createdAt = new Date(NOW.getTime() - 20 * DAY_MS);
		const order = await placeCodOrder(storage, "durable", createdAt, {
			coupon: { id: "coupon-durable", code: "CODDURABLE" },
		});
		const s = adapters(storage, NOW);
		const cursors = memoryCursors();
		const run = async (kv: Record<string, unknown>, at = NOW) =>
			await runCommerceSweeps(
				sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID, ...kv }),
				SWEEP_TASK_NAME,
				{ cursors, emailSender: recordingSender([]), now: at, queryBudget: PAID },
			);

		// 1. With auto-cancel off, coupon-orphans judges the redemption (the order is
		//    unpaid: live) and its cursor moves PAST it — it will never look again.
		await run({ [COD_AUTO_CANCEL_DAYS_KEY]: 0 });
		expect(await cursors.read("coupon-orphans")).toBe(
			new Date(createdAt.getTime() - CURSOR_OVERLAP_MS).toISOString(),
		);
		// 2. An auto-cancel whose coupon release FAILS: released first, so nothing is
		//    cancelled — the order stays listed.
		const failed = await cancelUnpaidOfflineOrders(
			{
				orderStore: s.orderStore,
				couponStore: {
					releaseByOrder: async () => {
						throw new Error("coupon store busy");
					},
				},
				clock: s.clock,
				logger: NOOP_LOGGER,
			},
			{ maxAgeDays: 14, limit: 1 },
		);
		expect(failed).toMatchObject({ cancelled: 0, skipped: 1 });
		expect((await s.orderStore.getById(toOrderId(order.id)))?.state).toBe("awaiting_payment");
		expect((await coupons(storage, NOW).findById("coupon-durable"))?.usesCount).toBe(1);
		// 3. The leg's next run (its slow cadence: a quarter-hour on) frees the use
		//    and cancels.
		const healed = await run({}, new Date(NOW.getTime() + 16 * 60 * 1000));
		expect(leg(healed, "cod-auto-cancel")).toMatchObject({ ok: true, count: 1 });
		expect((await s.orderStore.getById(toOrderId(order.id)))?.state).toBe("cancelled");
		expect((await coupons(storage, NOW).findById("coupon-durable"))?.usesCount).toBe(0);
	});
});

describe("coupon-orphans and an unpaid COD order (review finding 2)", () => {
	test.each(["awaiting_payment", "shipped_awaiting_payment"] as const)(
		"a redemption whose order is %s is ruled live: kept, and the cursor advances past it",
		async (state) => {
			const { storage } = await makeSqliteStorage(commerceStorageLayout());
			await seedCoupon(storage, "coupon-live", "CODLIVE");
			// Placed two days ago — past the coupon grace, past its (meaningless) hold —
			// and inside the auto-cancel window, so nothing else touches it.
			const createdAt = new Date(NOW.getTime() - 2 * DAY_MS);
			const order = await placeCodOrder(storage, `live-${state}`, createdAt, {
				coupon: { id: "coupon-live", code: "CODLIVE" },
				state,
			});
			const cursors = memoryCursors();
			const summary = await runCommerceSweeps(
				sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: PAID }),
				SWEEP_TASK_NAME,
				{ cursors, emailSender: recordingSender([]), now: NOW, queryBudget: PAID },
			);
			expect(leg(summary, "coupon-orphans")).toMatchObject({ ok: true, count: 0 });
			// The cursor moved past the redemption — to its instant less the walk's usual
			// five-minute overlap — judged, never stopped at (no cursor) nor held back
			// (1 ms before it).
			expect(await cursors.read("coupon-orphans")).toBe(
				new Date(createdAt.getTime() - CURSOR_OVERLAP_MS).toISOString(),
			);
			expect((await coupons(storage, NOW).findById("coupon-live"))?.usesCount).toBe(1);
			expect((await adapters(storage, NOW).orderStore.getById(toOrderId(order.id)))?.state).toBe(
				state,
			);
		},
	);
});
