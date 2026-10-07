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
 *    waits more than `MAX_WAIT` ticks in a row — save the deadline-free
 *    `UNPROMOTED_LEGS`, which only have to finish;
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
import { LEG_PRIORITY, MAINTENANCE_LEGS, UNPROMOTED_LEGS } from "../src/cron/sweeps.js";
import {
	adapters,
	DAY_MS,
	fakeCms,
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
 * The instant the backlog is seeded at, and START, two hours on (so a late refund
 * the setup leaves `reserved` is due). FIXED for the main case, never the wall
 * clock (review I-2: a START taken from `Date.now()` failed the pinned pace when
 * the suite ran near 22:00 UTC); the time-of-day scan below re-seeds at other
 * instants.
 *
 * THE SWEEP RUNS ON ONE CLOCK. Production passes no `now`: the tick's `now` IS the
 * stores' clock. So the (faked) wall clock reads the seed's instant while seeding
 * and each tick's instant while it runs. Driving `now` on its own while the stores
 * read the real wall clock is what made the outcome move with the time of day the
 * suite ran: the email dispatcher leases and re-schedules rows on the stores'
 * clock, and with that clock hours AHEAD of the tick an untried row came back due
 * after the four-hour run, so the expiry emails were "never sent" — two clocks no
 * deployment has. Only `Date` is faked; the tick's time budget is measured on
 * `performance.now`, which is not.
 */
let SETUP_NOW = new Date("2026-09-20T08:00:00.000Z");
let START = new Date(SETUP_NOW.getTime() + 2 * HOUR_MS);

let storage: StorageAccess;
let stripe = new FakePaymentGateway({ id: "stripe" });
/** product-orphans: the CMS behind `ctx.content`, missing three products' documents. */
const ORPHANED_PRODUCTS = [0, 1, 2].map((i) => `prod-orphan-${String(i)}`);
const cms = fakeCms({ gone: ORPHANED_PRODUCTS });

/** A fresh store holding the whole backlog, seeded with the wall clock at `setupNow`. */
async function seedAt(setupNow: Date): Promise<void> {
	SETUP_NOW = setupNow;
	START = new Date(setupNow.getTime() + 2 * HOUR_MS);
	stripe = new FakePaymentGateway({ id: "stripe" });
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.useFakeTimers({ toFake: ["Date"], now: setupNow });
	try {
		await seedEveryLeg();
	} finally {
		vi.useRealTimers();
	}
}

beforeAll(async () => {
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	await seedAt(SETUP_NOW);
}, 300_000);

/** Work in every leg, each through the adapters production uses. */
async function seedEveryLeg(): Promise<void> {
	const base = adapters(storage, SETUP_NOW);

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

	// product-orphans: three products deleted in the CMS whose afterDelete was lost.
	for (const id of ORPHANED_PRODUCTS) {
		await products.upsert(
			{
				productId: toProductId(id),
				sku: toSku(`SKU-${id}`),
				price: money(cents(1000), currency("USD")),
			},
			idempotencyKey(`upsert-${id}`),
		);
	}

	// late-refunds: an expired order paid late, whose refund hit a retryable failure.
	const late = await placeOrder(
		storage,
		"late-paid",
		new Date(SETUP_NOW.getTime() - 30 * MINUTE_MS),
		new Date(SETUP_NOW.getTime() - HOUR_MS),
	);
	const now = adapters(storage, SETUP_NOW);
	expect(await now.orderStore.expire(toOrderId(late.id), SETUP_NOW.toISOString())).toBe(true);
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
		"product-orphans": (
			await Promise.all(
				ORPHANED_PRODUCTS.map((id) =>
					collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION).get(id),
				),
			)
		).every((doc) => doc?.lifecycle === "deleted"),
		"late-refunds": stripe.refundCalls.length >= 1,
	};
}

/**
 * Sweep the seeded backlog minute by minute, the wall clock following the ticks,
 * and pin the ceiling, the ordering, every leg's progress, the expiry's pace
 * (`expiryWithin` ticks for all 50) and that ALL the work — every expiry email
 * included — is done inside four hours of ticks.
 */
async function sweepTheBacklog(expiryWithin: number): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"], now: START });
	try {
		await sweepTheBacklogOnFakedClock(expiryWithin);
	} finally {
		vi.useRealTimers();
	}
}

async function sweepTheBacklogOnFakedClock(expiryWithin: number): Promise<void> {
	const counter: CallCounter = { calls: 0 };
	const ctx = sweepContext(storage, counter, { [BACKGROUND_WORK_KEY]: FREE }, cms);
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
		const tickNow = new Date(START.getTime() + tick * MINUTE_MS);
		vi.setSystemTime(tickNow);
		const summary: CommerceSweepSummary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors,
			emailSender: recordingSender(sent),
			gateways: { stripe },
			now: tickNow,
			tickClock: () => performance.now(),
		});
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
	).toBeLessThanOrEqual(expiryWithin);
	// Every leg had work, and every leg got to it — soon, and never passed over long.
	// Except the legs that are deliberately never promoted (`UNPROMOTED_LEGS`): with
	// no deadline, they wait for the backlog to clear rather than jump it — and are
	// still required to finish below.
	for (const leg of SWEEP_LEGS) {
		const trace = traces.get(leg)!;
		expect(trace.firstProgress, `${leg} never progressed\n${report}`).not.toBeNull();
		if (UNPROMOTED_LEGS.includes(leg)) continue;
		expect(trace.firstProgress!, `${leg}\n${report}`).toBeLessThan(PROGRESS_WITHIN);
		expect(trace.longestWait, `${leg}\n${report}`).toBeLessThanOrEqual(MAX_WAIT);
	}
	// And all of it was done, on the Free preset, within four hours of ticks.
	expect(done, `after ${String(tick + 1)} ticks`).toEqual(
		Object.fromEntries(SWEEP_LEGS.map((leg) => [leg, true])),
	);
}

describe("a backlog in every leg, on the Workers Free preset", () => {
	test("no tick passes 30 calls, cancel-intents always runs, every leg progresses, and the expiry keeps its pace", async () => {
		await sweepTheBacklog(EXPIRY_WITHIN);
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
			"product-orphans",
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

/**
 * THE TIME OF DAY. The sweep's only UTC-day key is `reporting-heal`'s closed day,
 * and that is a legitimate daily schedule: a backlog whose orders were created
 * before 00:00 UTC and are worked after it lands in the CLOSED day, whose first
 * heal must absorb every rollup claim those orders make — the expiry's included —
 * and is aged ahead of the expiry every few ticks. Measured: all 50 expired by
 * tick 91–94 when START is near 00:00 (73–76 at every other hour), every email
 * still sent. So the run is scanned across the day: the work is ALL done at every
 * hour, and the pace holds everywhere, with the midnight straddle given its
 * measured floor (0.5 a minute) rather than hidden by the fixed instant above.
 */
const MIDNIGHT_EXPIRY_WITHIN = Math.ceil(LAPSED_ORDERS / 0.5);

describe("the same backlog at any time of day", () => {
	test.each([
		"2026-10-06T22:00:00.000Z",
		"2026-10-06T22:30:00.000Z",
		"2026-10-07T02:00:00.000Z",
		"2026-10-07T06:00:00.000Z",
		"2026-10-07T10:00:00.000Z",
		"2026-10-07T14:00:00.000Z",
		"2026-10-07T21:00:00.000Z",
	])(
		"seeded at %s, swept from two hours on",
		async (setup) => {
			await seedAt(new Date(setup));
			const start = START.getTime();
			// The backlog's orders were made the hour before START: straddling 00:00 UTC.
			const straddles =
				new Date(start - HOUR_MS).getUTCDate() !== new Date(start + 2 * HOUR_MS).getUTCDate();
			await sweepTheBacklog(straddles ? MIDNIGHT_EXPIRY_WITHIN : EXPIRY_WITHIN);
		},
		300_000,
	);
});
