/**
 * THE BACKLOG SIMULATION (QA2 M2): a store with work waiting in EVERY sweep leg at
 * once, swept minute by minute on the Workers Free preset (30 calls a tick).
 *
 * WHAT QA SAW on that preset: one order expiry cost 22 calls, so lapsed orders
 * expired one every three minutes and lagged by up to 43; the scans and completers
 * behind the critical legs were deferred for hours (`coupon-orphans` 180 ticks in a
 * row, `sku-transfers` 175, `hold-intents` 145 — a paid order's stock commit two
 * hours late); and two ticks used 334 and 44 calls, past Workers Free's 50.
 *
 * WHAT THIS PINS, over real documents on SQLite and the real tick:
 *  - no tick ever makes more than 30 calls (counted from OUTSIDE the sweep, and by
 *    the sweep itself — the two agree);
 *  - `cancel-intents` is never deferred: a due payment intent is withdrawn first;
 *  - every leg with work makes progress within `PROGRESS_WITHIN` ticks, and no leg
 *    waits more than `MAX_WAIT` ticks in a row;
 *  - the expiry keeps a throughput of at least `MIN_EXPIRIES_PER_MINUTE` while every
 *    other leg is busy too — 50 lapsed orders cleared inside `EXPIRY_WITHIN` ticks.
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	orderId as toOrderId,
	productId as toProductId,
	settleOrder,
	sku as toSku,
	type SendEmailInput,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashCouponStore,
	EmdashEntitlementStore,
	EmdashPaymentEventStore,
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	ORDER_SKU_INDEX_COLLECTION,
	ORDERS_COLLECTION,
	orderSkuIndexId,
	PRODUCT_COMMERCE_COLLECTION,
	uuidIdGen,
	type InventoryDoc,
	type OrderDoc,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	runCommerceSweeps,
	SWEEP_LEGS,
	SWEEP_TASK_NAME,
	type CommerceSweepSummary,
	type SweepLeg,
} from "../src/cron/index.js";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import { LEG_PRIORITY, MAINTENANCE_LEGS } from "../src/cron/sweeps.js";
import {
	adapters,
	DAY_MS,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	placeLapsedOrder,
	placeOrder,
	placePaidOrderOwingCommit,
	recordingSender,
	seedLapsedHolds,
	sweepContext,
	type CallCounter,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const FREE = 30;
const LAPSED_ORDERS = 50;
/** The pinned pace. Measured on this simulation: all 50 expired by tick 73 (0.68 a
 *  minute) with every other leg busy at the same time — about twice QA's one every
 *  three minutes, which starved everything else. With only an expiry backlog it is
 *  one a minute (`cron-sweep-ceiling`). The floor leaves room for the cost table
 *  moving a call or two. */
const MIN_EXPIRIES_PER_MINUTE = 0.6;
const EXPIRY_WITHIN = Math.ceil(LAPSED_ORDERS / MIN_EXPIRIES_PER_MINUTE);
/** Every leg with work does some of it inside this many ticks of the backlog. */
const PROGRESS_WITHIN = 12;
/** And is never passed over more than this many ticks in a row. */
const MAX_WAIT = 8;

/**
 * The seed's "now": a FIXED instant, never the wall clock (review I-2). The
 * simulation's pace depends on the UTC day its orders fall in (orders created on a
 * day that has closed are reporting-heal work too), so a start taken from
 * `Date.now()` failed the pinned pace whenever a run began near 22:00 UTC (tick 91
 * > 84). At 08:00 UTC the seed, START and all 240 ticks stay inside one UTC day.
 *
 * The wall clock is pinned with them (`atWallClock`): the sweep's stores stamp
 * what they write (an expiry's queued email, among others) on the system clock,
 * as production does, so the wall clock must read the seed's time while seeding
 * and each tick's `now` while it runs. Only `Date` is faked; the tick's time box
 * still runs on the real elapsed time (`performance.now`).
 */
const SEEDED_AT = new Date("2026-09-20T08:00:00.000Z");
/** Two hours after the seed, so a late refund the setup leaves `reserved` is due. */
const START = new Date(SEEDED_AT.getTime() + 2 * HOUR_MS);

/** Fake `Date` only, reading `at`; real timers stay real. */
function atWallClock(at: Date): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(at);
}

let storage: StorageAccess;
const stripe = new FakePaymentGateway({ id: "stripe" });

beforeAll(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	atWallClock(SEEDED_AT);
	try {
		await seedEveryLeg();
	} finally {
		vi.useRealTimers();
	}
}, 300_000);

/** Work in every leg, each through the adapters production uses. */
async function seedEveryLeg(): Promise<void> {
	const base = adapters(storage, SEEDED_AT);

	// expire-orders: 50 lapsed orders; cancel-intents: ten of them carry a recorded
	// payment intent the buyer could still pay.
	for (let i = 0; i < LAPSED_ORDERS; i++) {
		const placed = await placeLapsedOrder(storage, `lapsed-${String(i)}`, START, i * 1000);
		if (i < 10) {
			await base.orderStore.recordPaymentIntent({
				orderId: toOrderId(placed.id),
				gateway: "stripe",
				intentId: `pi_lapsed_${String(i)}`,
			});
		}
	}

	// expire-holds: ten abandoned cart holds.
	await seedLapsedHolds(storage, "carts", 10, START);

	// hold-intents + order-emails: five paid orders whose stock commit is owed, each
	// with its confirmation queued.
	for (let i = 0; i < 5; i++) {
		await placePaidOrderOwingCommit(
			storage,
			`paid-${String(i)}`,
			START,
			(LAPSED_ORDERS + i) * 1000,
		);
	}

	// prune-challenges: twenty expired sign-in challenges.
	const challenges = collectionOf<Record<string, unknown>>(storage, "login_challenges");
	const expired = new Date(START.getTime() - HOUR_MS).toISOString();
	for (let i = 0; i < 20; i++) {
		await challenges.put(`ch-${String(i)}`, {
			challengeId: `ch-${String(i)}`,
			email: `c${String(i)}@example.test`,
			emailLower: `c${String(i)}@example.test`,
			tokenHash: "x",
			createdAt: expired,
			expiresAt: expired,
			consumedAt: null,
			consumed: "no",
		});
	}

	// sku-transfers: a rename's carry stranded between the two inventory documents.
	const products = new EmdashProductCommerceStore({ storage, clock: base.clock });
	await products.upsert(
		{
			productId: toProductId("prod-xfer"),
			sku: toSku("XFER-NEW"),
			price: money(cents(1999), currency("USD")),
			productKind: "physical",
		},
		idempotencyKey("upsert-xfer"),
	);
	await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).put("XFER-OLD", {
		sku: "XFER-OLD",
		onHand: 0,
		holds: {},
		transferOut: { token: "xfer-token", toSku: "XFER-NEW", qty: 7 },
	});
	const productDocs = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const product = await productDocs.getVersioned("prod-xfer");
	if (product === null) throw new Error("no product");
	await productDocs.compareAndSet("prod-xfer", product.revision, {
		...product.value,
		pendingRenames: {
			"xfer-token": {
				token: "xfer-token",
				fromSku: "XFER-OLD",
				toSku: "XFER-NEW",
				commandKey: "cmd-xfer",
			},
		},
	});

	// order-sku-index: three recent orders whose derived sku pointer was lost.
	const pointers = collectionOf(storage, ORDER_SKU_INDEX_COLLECTION);
	for (let i = 0; i < 3; i++) {
		const placed = await placeOrder(
			storage,
			`unindexed-${String(i)}`,
			new Date(START.getTime() + DAY_MS),
			new Date(START.getTime() - 10 * MINUTE_MS + i * 1000),
		);
		await pointers.delete(orderSkuIndexId(placed.sku.toLowerCase(), placed.id));
	}

	// reporting-heal: yesterday's orders, their live rollup claims not yet absorbed.
	const yesterday = new Date(START.getTime() - DAY_MS);
	for (let i = 0; i < 5; i++) {
		const placed = await placeOrder(
			storage,
			`yesterday-${String(i)}`,
			new Date(yesterday.getTime() + HOUR_MS),
			new Date(yesterday.getTime() + i * 1000),
		);
		const s = adapters(storage, yesterday);
		await s.orderStore.markPaid(toOrderId(placed.id));
		await s.orderStore.completeHoldAdoption(toOrderId(placed.id));
		await s.orderStore.completeHoldCommit(toOrderId(placed.id));
	}

	// coupon-orphans: three redemptions claimed for orders that never became durable.
	const coupons = new EmdashCouponStore({ storage, idGen: uuidIdGen, clock: base.clock });
	await coupons.create({
		id: "coupon-orphan",
		code: "ORPHAN10",
		type: "percentage",
		amountCents: null,
		rateBps: 1000,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: cents(0),
		startsAt: new Date(START.getTime() - 30 * DAY_MS).toISOString(),
		expiresAt: new Date(START.getTime() + 30 * DAY_MS).toISOString(),
		maxUses: 100,
		maxUsesPerCustomer: null,
	});
	for (let i = 0; i < 3; i++) {
		const claimed = await coupons.redeem({
			couponId: "coupon-orphan",
			orderId: toOrderId(`never-written-${String(i)}`),
			idempotencyKey: idempotencyKey(`orphan-${String(i)}`),
			createdAt: new Date(START.getTime() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("seed redemption failed");
	}

	// late-refunds: an expired order paid late, whose refund hit a retryable failure.
	const late = await placeOrder(
		storage,
		"late-paid",
		new Date(SEEDED_AT.getTime() - 30 * MINUTE_MS),
		new Date(SEEDED_AT.getTime() - HOUR_MS),
	);
	const now = adapters(storage, SEEDED_AT);
	expect(await now.orderStore.expire(toOrderId(late.id), SEEDED_AT.toISOString())).toBe(true);
	stripe.setRefundResult({ ok: false, reason: "RETRYABLE" });
	const settled = await settleOrder(
		{
			orderStore: now.orderStore,
			entitlementStore: new EmdashEntitlementStore({ storage, idGen: uuidIdGen, clock: now.clock }),
			paymentEventStore: new EmdashPaymentEventStore({ storage }),
			inventoryStore: now.inventory,
			clock: now.clock,
		},
		stripe,
		stripe.webhook({
			outcome: "succeeded",
			orderId: late.id,
			providerRef: `pi_${late.id}`,
			amount: 1000,
			currency: "USD",
			dedupeKey: `evt_${late.id}`,
		}),
	);
	expect(settled).toEqual({ ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" });
	stripe.clearRefundResult();
}

interface LegTrace {
	/** The first tick the leg did some of its work: a unit for the legs with units,
	 *  a run of its body for the scans (whose walk is the work). */
	firstProgress: number | null;
	longestWait: number;
	wait: number;
}

/** The seeded lapsed orders that carry an intent and are expired while that intent
 *  is still unresolved (payable at the provider). */
async function expiredWithPayableIntent(): Promise<string[]> {
	const s = adapters(storage);
	const found: string[] = [];
	for (let i = 0; i < 10; i++) {
		const id = toOrderId(`order-lapsed-${String(i)}`);
		if ((await s.orderStore.getById(id))?.state !== "expired") continue;
		const intents = await s.orderStore.listPaymentIntents(id);
		if (intents.some((intent) => intent.cancelOutcome === null)) found.push(id);
	}
	return found;
}

/** Everything the seed put in every leg, read back from the documents. */
async function allWorkDone(sent: readonly SendEmailInput[]): Promise<Record<string, boolean>> {
	const s = adapters(storage);
	const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
	const pending = await orders.query({ where: { state: "pending" }, limit: 100 });
	const owing = await orders.query({ where: { holdsPendingAt: { lte: "9999" } }, limit: 100 });
	const pointers = collectionOf(storage, ORDER_SKU_INDEX_COLLECTION);
	const unindexed = await Promise.all(
		[0, 1, 2].map((i) =>
			pointers.get(orderSkuIndexId(`order-unindexed-${String(i)}`, `order-unindexed-${String(i)}`)),
		),
	);
	const claims = await collectionOf<{ absorbedAt: string | null }>(
		storage,
		"reporting_applied",
	).query({
		where: { date: new Date(START.getTime() - DAY_MS).toISOString().slice(0, 10) },
		limit: 100,
	});
	const coupons = new EmdashCouponStore({ storage, idGen: uuidIdGen, clock: s.clock });
	return {
		"expire-orders": pending.items.every((item) => !item.id.startsWith("order-lapsed-")),
		"cancel-intents": stripe.cancelCalls.length >= 10,
		"expire-holds": (await s.inventory.getOnHand(toSku("HOLD-carts"))) === 10,
		"hold-intents": owing.items.length === 0,
		"order-emails": sent.length >= LAPSED_ORDERS + 5,
		"prune-challenges":
			(await collectionOf(storage, "login_challenges").query({ limit: 1 })).items.length === 0,
		"sku-transfers": (await s.inventory.getOnHand(toSku("XFER-NEW"))) === 7,
		"order-sku-index": unindexed.every((pointer) => pointer !== null),
		"reporting-heal": claims.items.every((claim) => claim.data.absorbedAt !== null),
		"coupon-orphans": (await coupons.findById("coupon-orphan"))?.usesCount === 0,
		"late-refunds": stripe.refundCalls.length >= 1,
	};
}

describe("a backlog in every leg, on the Workers Free preset", () => {
	test("no tick passes 30 calls, cancel-intents always runs, every leg progresses, and the expiry keeps its pace", async () => {
		const counter: CallCounter = { calls: 0 };
		const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: FREE });
		const cursors = memoryCursors();
		const sent: SendEmailInput[] = [];
		const traces = new Map<SweepLeg, LegTrace>(
			SWEEP_LEGS.map((leg) => [leg, { firstProgress: null, longestWait: 0, wait: 0 }]),
		);
		let expired = 0;
		let expiredBy: number | null = null;
		let done: Record<string, boolean> = {};
		let tick = 0;

		for (; tick < 240; tick++) {
			counter.calls = 0;
			const at = new Date(START.getTime() + tick * MINUTE_MS);
			atWallClock(at);
			let summary: CommerceSweepSummary;
			try {
				summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
					cursors,
					emailSender: recordingSender(sent),
					gateways: { stripe },
					now: at,
					tickClock: () => performance.now(),
				});
			} finally {
				vi.useRealTimers();
			}
			expect(counter.calls, `tick ${String(tick)} (outside count)`).toBeLessThanOrEqual(FREE);
			expect(summary.budget.queriesUsed, `tick ${String(tick)}`).toBe(counter.calls);

			for (const entry of summary.legs) {
				expect(entry.ok, `${entry.leg} at tick ${String(tick)}: ${entry.error ?? ""}`).toBe(true);
				const trace = traces.get(entry.leg)!;
				const ran = entry.deferred !== true && entry.notDue !== true && entry.queries > 0;
				const progressed = MAINTENANCE_LEGS.includes(entry.leg) ? ran : entry.count > 0;
				if (progressed && trace.firstProgress === null) trace.firstProgress = tick;
				if (entry.deferred === true) {
					trace.wait++;
					trace.longestWait = Math.max(trace.longestWait, trace.wait);
				} else {
					trace.wait = 0;
				}
			}
			// cancel-intents runs first — except in the one tick per interval a Free
			// late-refund resume leads; the expiry waits with it (N1 below).
			const cancel = summary.legs.find((entry) => entry.leg === "cancel-intents");
			const lead = summary.legs.find((entry) => entry.leg === "late-refunds");
			if (cancel?.deferred === true) {
				expect(
					lead?.queries ?? 0,
					`cancel-intents deferred at tick ${String(tick)}`,
				).toBeGreaterThanOrEqual(15);
			}
			// QA3 N1: at no tick boundary is an expired order still payable.
			expect(await expiredWithPayableIntent(), `after tick ${String(tick)}`).toEqual([]);

			expired += summary.legs.find((entry) => entry.leg === "expire-orders")?.count ?? 0;
			if (expired >= LAPSED_ORDERS && expiredBy === null) expiredBy = tick + 1;
			if (expiredBy !== null && tick % 10 === 9) {
				done = await allWorkDone(sent);
				if (Object.values(done).every(Boolean)) break;
			}
		}

		const report = [...traces]
			.map(
				([leg, trace]) =>
					`${leg}: first progress at tick ${String(trace.firstProgress)}, longest wait ${String(trace.longestWait)}`,
			)
			.join("\n");
		// The pace: 50 lapsed orders, every other leg busy too.
		expect(expiredBy, report).not.toBeNull();
		expect(
			expiredBy!,
			`all ${String(LAPSED_ORDERS)} expired by tick ${String(expiredBy)}`,
		).toBeLessThanOrEqual(EXPIRY_WITHIN);
		// Every leg had work, and every leg got to it — soon, and never passed over long.
		for (const leg of SWEEP_LEGS) {
			const trace = traces.get(leg)!;
			expect(trace.firstProgress, `${leg} never progressed\n${report}`).not.toBeNull();
			expect(trace.firstProgress!, `${leg}\n${report}`).toBeLessThan(PROGRESS_WITHIN);
			expect(trace.longestWait, `${leg}\n${report}`).toBeLessThanOrEqual(MAX_WAIT);
		}
		// And all of it was done, on the Free preset, within four hours of ticks.
		expect(done, `after ${String(tick + 1)} ticks`).toEqual(
			Object.fromEntries(SWEEP_LEGS.map((leg) => [leg, true])),
		);
	}, 300_000);

	test("an expiry-only backlog clears at about one order a minute (QA: one every three)", async () => {
		const { storage: own } = await makeSqliteStorage(commerceStorageLayout());
		const start = new Date("2026-09-21T12:00:00.000Z");
		for (let i = 0; i < 20; i++) await placeLapsedOrder(own, `only-${String(i)}`, start, i * 1000);
		const counter: CallCounter = { calls: 0 };
		const ctx = sweepContext(own, counter, { [BACKGROUND_WORK_KEY]: FREE });
		const cursors = memoryCursors();
		let expired = 0;
		let tick = 0;
		for (; tick < 40 && expired < 20; tick++) {
			counter.calls = 0;
			const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				now: new Date(start.getTime() + tick * MINUTE_MS),
			});
			expect(counter.calls).toBeLessThanOrEqual(FREE);
			expired += summary.legs.find((entry) => entry.leg === "expire-orders")?.count ?? 0;
		}
		expect(expired).toBe(20);
		// Measured: 22 ticks — one expiry a tick, less the first ticks' share for the
		// slow-cadence scans' first pass and the expiry emails it queues.
		expect(tick, `20 lapsed orders took ${String(tick)} ticks`).toBeLessThanOrEqual(23);
	}, 120_000);

	test("cancel-intents runs first in every tick, and the money legs come before housekeeping", () => {
		expect(LEG_PRIORITY[0]).toBe("cancel-intents");
		const housekeeping: SweepLeg[] = [
			"prune-challenges",
			"sku-transfers",
			"order-sku-index",
			"reporting-heal",
			"coupon-orphans",
		];
		for (const moneyLeg of ["expire-orders", "hold-intents", "late-refunds"] as const) {
			for (const chore of housekeeping) {
				expect(LEG_PRIORITY.indexOf(moneyLeg), `${moneyLeg} before ${chore}`).toBeLessThan(
					LEG_PRIORITY.indexOf(chore),
				);
			}
		}
	});
});
