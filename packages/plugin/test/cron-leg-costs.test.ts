/**
 * The sweep's per-leg query-cost ESTIMATES (`LEG_QUERY_COSTS`), checked against
 * real units.
 *
 * WHY. The tick admits a leg only if its entry reads plus one unit fit, and
 * admits a loop's first unit on the estimate before it has seen a real one — so
 * an estimate that is too LOW lets a leg overrun the per-invocation query cap on
 * Workers Free, which is exactly the failure the budget exists to prevent. Each
 * case here performs ONE real unit of a leg's work, through the same store
 * composition and counting the sweep uses (every storage and kv call once, plus
 * one for the email request a real send makes), and asserts the estimate covers it.
 *
 * Measured against SQLite: EmDash's host may issue more than one statement per
 * call, which no test here can see.
 */
import {
	NOOP_LOGGER,
	cents,
	currency,
	customerId as toCustomerId,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	money,
	cancelOrder,
	escalateStaleLateRefunds,
	expireOrdersBatch,
	cancelDueIntents,
	COUPON_RECOUNT_SETTLE_MS,
	DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS,
	retryLatePaymentRefunds,
	settleOrder,
	dispatchOrderEmails,
	orderHoldingRedemption,
	type EmailSender,
	type PaymentGateway,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import {
	collectionOf,
	COUPONS_COLLECTION,
	EmdashReportingStore,
	INVENTORY_COLLECTION,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	type CouponDoc,
	type InventoryDoc,
	type OrderDoc,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { makeSqliteStorage } from "@urumi.ai/otta-store-emdash/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import {
	CONTENT_MISS_QUERIES,
	CONTENT_READ_QUERIES,
	COUPON_RECOUNT_CALLS,
	COUPON_RELEASE_CALLS,
	GUEST_COUPON_RELEASE_CALLS,
	LATE_REFUND_ESCALATION_UNIT,
	LEG_QUERY_COSTS,
	legReserveQueries,
	legStartCalls,
	MAINTENANCE_LEGS,
	PRODUCT_ORPHAN_DELETE_CALLS,
	REPORTING_LINES_BUILD_CALLS,
	REPORTING_MONTH_BUILD_CALLS,
	REPORTING_VERIFY_CALLS,
	REPORTING_VERIFY_DAY_CALLS,
	SWEEP_LEGS,
	EMAIL_SEND_AND_RECORD_CALLS,
	holdIntentCost,
	releaseStrandedOnSku,
	strandedReleaseCost,
	TICK_OVERHEAD_QUERIES,
	UNPROMOTED_LEGS,
} from "../src/cron/sweeps.js";
import {
	EMAIL_AVAILABILITY_READS,
	EMAIL_SENDER_BUILD_READS,
	EMAIL_SENT_RECORD_WRITES,
	emailSendingAvailable,
	makeEmailSender,
} from "../src/email/ctx-email-sender.js";
import { resolvePaymentGateways } from "../src/payments/resolve-payment-gateways.js";
import { STORE_DISPLAY_NAME_KEY } from "../src/email/email-render-context.js";
import { LOGIN_LINK_URL_KEY } from "../src/storefront/login-link.js";
import type { PluginContext } from "../src/types.js";
import { strandOrder } from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

let storage: StorageAccess;
const counter = { calls: 0 };
/** Run (uncounted) just before a counted call — how a case lands a peer's write in
 *  the middle of the unit it measures. */
let beforeCall: ((collection: string, method: string) => Promise<void>) | null = null;

beforeAll(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
}, 120_000);

/** The sweep's composition, over a store whose every call is counted. */
function counted() {
	const wrapped = wrappedStorage();
	const kv = new Map<string, unknown>();
	const ctx = {
		http: {
			fetch() {
				throw new Error("no egress in a cost measurement");
			},
		},
		kv: {
			async get(key: string) {
				counter.calls++;
				return kv.get(key) ?? null;
			},
			async set(key: string, value: unknown) {
				counter.calls++;
				kv.set(key, value);
			},
			async delete(key: string) {
				return kv.delete(key);
			},
			async list() {
				return [];
			},
		},
		storage: wrapped,
	} as unknown as PluginContext;
	return createInProcessCommerceStores(ctx);
}

/** The sweep's composition over the RAW store — a peer whose calls are not counted. */
function uncounted() {
	const kv = new Map<string, unknown>();
	const ctx = {
		http: {
			fetch() {
				throw new Error("no egress in a cost measurement");
			},
		},
		kv: {
			async get(key: string) {
				return kv.get(key) ?? null;
			},
			async set(key: string, value: unknown) {
				kv.set(key, value);
			},
			async delete(key: string) {
				return kv.delete(key);
			},
			async list() {
				return [];
			},
		},
		storage,
	} as unknown as PluginContext;
	return createInProcessCommerceStores(ctx);
}

/** The sweep's composition with a seeded kv and the host's `ctx.email`
 *  (ADR-0031), every storage, kv and send call counted. */
function countedEmailContext(seed: Record<string, unknown>) {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const ctx = {
		http: {
			fetch() {
				throw new Error("email never goes over ctx.http");
			},
		},
		email: {
			send() {
				counter.calls++;
				return Promise.resolve();
			},
		},
		kv: {
			async get(key: string) {
				counter.calls++;
				return kv.get(key) ?? null;
			},
			async set(key: string, value: unknown) {
				counter.calls++;
				kv.set(key, value);
			},
			async delete(key: string) {
				return kv.delete(key);
			},
			async list() {
				return [];
			},
		},
		storage: wrappedStorage(),
	} as unknown as PluginContext;
	return { ctx, stores: createInProcessCommerceStores(ctx) };
}

/** Count the calls `body` makes. */
async function cost(body: () => Promise<unknown>): Promise<number> {
	counter.calls = 0;
	await body();
	return counter.calls;
}

/** A pending order over `lines` adopted reservations, one SKU each. */
async function placeOrder(
	suffix: string,
	holdExpiresAt: string,
	lines = 1,
	appliedCouponCode?: string,
	adopt = true,
) {
	const s = counted();
	const skus: string[] = [];
	const held: string[] = [];
	for (let i = 0; i < lines; i++) {
		const sku = lines === 1 ? `COST-${suffix}` : `COST-${suffix}-${String(i)}`;
		await s.inventory.seedOnHand(toSku(sku), 10);
		const reserved = await s.inventory.reserve(
			toSku(sku),
			1,
			idempotencyKey(`res-${suffix}-${String(i)}`),
		);
		if (!reserved.ok) throw new Error(reserved.reason);
		await s.inventory.stampHoldDeadline(
			reserved.reservationId,
			new Date(Date.now() + DAY_MS).toISOString(),
		);
		skus.push(sku);
		held.push(reserved.reservationId);
	}
	const id = `order-${suffix}`;
	if (adopt) {
		await s.inventory.adoptMany({
			reservationIds: held,
			orderId: toOrderId(id),
			holdExpiresAt,
			now: new Date(Date.now() - HOUR_MS).toISOString(),
		});
	}
	await s.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: `cart-${suffix}`,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${suffix}`),
		holdExpiresAt,
		buyerRef: `buyer-${suffix}@example.test`,
		paymentMethod: "stripe",
		lines: held.map((reservationId, i) => ({
			productId: toProductId(`prod-${suffix}-${String(i)}`),
			sku: toSku(skus[i] ?? ""),
			title: "Cost Widget",
			unitPrice: cents(1000),
			currency: currency("USD"),
			quantity: 1,
			fulfillmentKind: "physical" as const,
			reservationId: toReservationId(reservationId),
		})),
		totals: {
			subtotal: cents(1000 * lines),
			total: cents(1000 * lines),
			currency: currency("USD"),
			...(appliedCouponCode !== undefined ? { appliedCouponCode } : {}),
		},
	});
	return { id, sku: skus[0] ?? "", skus, reservationId: held[0] ?? "", reservationIds: held };
}

/** What the two coupon cases measured (#598 review) — pinned, so a change that moves
 *  them shows up here and in `LEG_QUERY_COSTS` together. */
const COUPON_ORPHAN_WORST_UNIT = 10;
const EXPIRY_WITH_COUPON_UNIT = 21;

/** A live percentage coupon for a cost case; returns its id. */
async function costCoupon(
	s: ReturnType<typeof counted>,
	id: string,
	code: string,
): Promise<string> {
	await s.couponStore.create({
		id,
		code,
		type: "percentage",
		amountCents: null,
		rateBps: 1000,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: cents(0),
		startsAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
		expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
		maxUses: 10,
		maxUsesPerCustomer: 1,
	});
	return id;
}

/** The calls the expiry use-case makes for the given (already listed) orders. */
async function expiryUnitCost(ids: readonly string[]): Promise<number> {
	const s = counted();
	return await cost(() =>
		expireOrdersBatch(
			{
				orderStore: s.orderStore,
				inventoryStore: s.inventory,
				couponStore: s.couponStore,
				clock: s.clock,
				logger: NOOP_LOGGER,
			},
			new Date(),
			{ due: ids.map((id) => toOrderId(id)) },
		),
	);
}

describe("one real unit of each leg fits its LEG_QUERY_COSTS estimate", () => {
	test("expire-holds: one hold flip", async () => {
		const s = counted();
		const sku = "COST-HOLD";
		await s.inventory.seedOnHand(toSku(sku), 5);
		const key = idempotencyKey("cost-hold");
		const held = await s.inventory.reserve(toSku(sku), 1, key);
		if (!held.ok) throw new Error(held.reason);
		const cartId = await s.cartStore.create(currency("USD"));
		await s.cartStore.upsertLine({
			cartId,
			sku,
			productId: null,
			qty: 1,
			reservationId: held.reservationId,
			expiresAt: new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
			key,
		});
		const now = new Date().toISOString();
		const used = await cost(() => s.cartStore.expireHold(held.reservationId, now, now));
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["expire-holds"].unit);
	});

	test("expire-orders: one order's whole expiry unit (flip, email locator, rollup, hold release, intent stamp)", async () => {
		const placed = await placeOrder("expire", new Date(Date.now() - 30 * MINUTE_MS).toISOString());
		const used = await expiryUnitCost([placed.id]);
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["expire-orders"].unit);
	});

	// #598: an order with a coupon applied releases it through `releaseByOrder`, which
	// now runs TWO indexed scans (by the order's id, and by its creation key) before
	// releasing what they found. Here the redemption sits under the key with another
	// order id — the same-key replay shape — so the key scan is the one that finds it.
	test("expire-orders: one order's expiry unit with its coupon released by key", async () => {
		const s = counted();
		const couponId = await costCoupon(s, "coupon-cost-expire", "COSTEXPIRE");
		const placed = await placeOrder(
			"expire-coupon",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
			1,
			"COSTEXPIRE",
		);
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`${placed.id}-never-persisted`),
			idempotencyKey: idempotencyKey("create-expire-coupon"),
			customerId: toCustomerId("cust-cost-expire"),
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("redeem failed");
		const used = await expiryUnitCost([placed.id]);
		expect((await s.couponStore.findById(couponId))?.usesCount).toBe(0);
		// ABOVE the leg's first-unit estimate, deliberately: that estimate is the common
		// one-line, coupon-less unit, and the gate learns a dearer unit from the first
		// one it sees, as it does for a many-line order (see `LEG_QUERY_COSTS`). Raising
		// it to this would move `expire-orders` behind the starvation guard on Free
		// (the preset case below).
		expect(used).toBe(EXPIRY_WITH_COUPON_UNIT);
		expect(used).toBeGreaterThan(LEG_QUERY_COSTS["expire-orders"].unit);
	});

	// #621: the sweep starts an expired order's coupon release only when the tick can
	// still afford all of it (`COUPON_RELEASE_CALLS`), so the ceiling never lands
	// between the redemption's delete and the decrement. Measured on the dearer shape
	// above: found by key, with a per-customer slot to free.
	test("expire-orders: an expired order's coupon release alone fits COUPON_RELEASE_CALLS", async () => {
		const s = counted();
		const couponId = await costCoupon(s, "coupon-cost-release", "COSTRELEASE");
		const placed = await placeOrder(
			"release-coupon",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
			1,
			"COSTRELEASE",
		);
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`${placed.id}-never-persisted`),
			idempotencyKey: idempotencyKey("create-release-coupon"),
			customerId: toCustomerId("cust-cost-release"),
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("redeem failed");
		const order = await s.orderStore.getById(toOrderId(placed.id));
		if (order === null) throw new Error("no order");
		const used = await cost(() => s.couponStore.releaseByOrder(order));
		expect((await s.couponStore.findById(couponId))?.usesCount).toBe(0);
		expect(used).toBe(COUPON_RELEASE_CALLS);
	});

	// A guest redemption has no per-customer slot to free: two calls fewer.
	test("expire-orders: a guest order's coupon release alone fits GUEST_COUPON_RELEASE_CALLS", async () => {
		const s = counted();
		const couponId = await costCoupon(s, "coupon-cost-guest", "COSTGUEST");
		const placed = await placeOrder(
			"release-guest",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
			1,
			"COSTGUEST",
		);
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(placed.id),
			idempotencyKey: idempotencyKey("create-release-guest"),
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("redeem failed");
		const order = await s.orderStore.getById(toOrderId(placed.id));
		if (order === null) throw new Error("no order");
		expect(order.customerId).toBeNull();
		const used = await cost(() => s.couponStore.releaseByOrder(order));
		expect((await s.couponStore.findById(couponId))?.usesCount).toBe(0);
		expect(used).toBe(GUEST_COUPON_RELEASE_CALLS);
	});

	// QA2 M2: one order expiry was 22 calls on a 30-call Workers Free tick, so a
	// backlog expired one order every three minutes. The use-case re-read the order
	// the flip had written and released every line a second time after the store had
	// released them one id at a time. These pin the cut, per order shape — measured
	// the same way on the base before the change: 22 (one line) and 40 (three lines on
	// three SKUs).
	test.each([
		// +1 each since #572: the rollup event dirties its month document first.
		{ lines: 1, before: 22, ceiling: 14 },
		{ lines: 3, before: 40, ceiling: 24 },
	])(
		"expire-orders: a $lines-line order costs at most $ceiling calls (was $before)",
		async ({ lines, ceiling }) => {
			const placed = await placeOrder(
				`expire-lines-${String(lines)}`,
				new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
				lines,
			);
			const s = counted();
			const used = await expiryUnitCost([placed.id]);
			expect(used).toBeLessThanOrEqual(ceiling);
			// And it did the whole job: every unit back, the order expired.
			for (const sku of placed.skus) expect(await s.inventory.getOnHand(toSku(sku))).toBe(10);
			expect((await s.orderStore.getById(toOrderId(placed.id)))?.state).toBe("expired");
		},
	);

	test("order-emails: one claim, its reads, the send and the mark", async () => {
		const placed = await placeOrder("email", new Date(Date.now() + DAY_MS).toISOString());
		const s = counted();
		await s.orderStore.markPaid(toOrderId(placed.id));
		const now = new Date().toISOString();
		const used = await cost(async () => {
			const row = await s.orderStore.claimNextEmail(
				now,
				new Date(Date.now() + HOUR_MS).toISOString(),
			);
			if (row === null) throw new Error("expected a row to claim");
			await s.orderStore.getById(row.orderId);
			counter.calls++; // the provider request a real send makes (a subrequest)
			await s.orderStore.markEmailSent(row.id, now);
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["order-emails"].unit);
	});

	// QA3 N2 guard: the email unit's cost is measured with the REAL sender
	// construction (`makeEmailSender` + the `ctx.email` send), so the table cannot
	// drift below what a send really costs.
	describe("order-emails with the real ctx.email sender", () => {
		const seed = {
			[STORE_DISPLAY_NAME_KEY]: "Cost Shop",
			[LOGIN_LINK_URL_KEY]: "https://shop.example/account/verify",
		};

		test("the leg's entry is the availability check: ctx.email, plus one read of the 'no provider' record", async () => {
			const { ctx } = countedEmailContext(seed);
			let available = false;
			const used = await cost(async () => {
				available = await emailSendingAvailable(ctx);
			});
			expect(available).toBe(true);
			expect(used).toBe(EMAIL_AVAILABILITY_READS);
			expect(LEG_QUERY_COSTS["order-emails"].entry).toBe(EMAIL_AVAILABILITY_READS);
		});

		test("building the sender and its send fit EMAIL_SENDER_BUILD_READS + 1 + EMAIL_SENT_RECORD_WRITES", async () => {
			const { ctx } = countedEmailContext(seed);
			const used = await cost(async () => {
				const sender = await makeEmailSender(ctx);
				await sender?.send({
					to: "buyer@example.test" as never,
					template: "order-confirmation",
					data: { orderId: "ord_cost", totalCents: 100, currency: "USD" },
					idempotencyKey: "row_cost",
				});
			});
			expect(used).toBe(EMAIL_SENDER_BUILD_READS + 1 + EMAIL_SENT_RECORD_WRITES);
		});

		test("one real unit — claim, reads, the first send with its build, the mark — fits the unit", async () => {
			const placed = await placeOrder("email-real", new Date(Date.now() + DAY_MS).toISOString());
			const { ctx, stores } = countedEmailContext(seed);
			await stores.orderStore.markPaid(toOrderId(placed.id));
			let sent = 0;
			const used = await cost(async () => {
				let built: Promise<EmailSender | undefined> | undefined;
				sent = await dispatchOrderEmails(
					{
						orderStore: stores.orderStore,
						customerStore: stores.customerStore,
						clock: stores.clock,
						emailSender: {
							async send(input) {
								built ??= makeEmailSender(ctx);
								await (await built)?.send(input);
							},
						},
					},
					{ batchLimit: 1 },
				);
			});
			expect(sent).toBe(1);
			expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["order-emails"].unit);
			expect(LEG_QUERY_COSTS["order-emails"].unit).toBe(4 + EMAIL_SEND_AND_RECORD_CALLS);
		});
	});

	test("hold-intents: the three completers on one order with an outstanding intent", async () => {
		const holdExpiresAt = new Date(Date.now() + DAY_MS).toISOString();
		const placed = await placeOrder("intent", holdExpiresAt);
		const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
		const before = await orders.getVersioned(placed.id);
		const pendingSince = new Date(Date.now() - HOUR_MS).toISOString();
		await orders.compareAndSet(placed.id, before!.revision, {
			...before!.value,
			holdsPendingAt: pendingSince,
			holdsAdopted: {
				reservationIds: [placed.reservationId],
				holdExpiresAt,
				recordedAt: pendingSince,
				completedAt: null,
			},
		});
		const s = counted();
		const id = toOrderId(placed.id);
		const used = await cost(async () => {
			await s.orderStore.completeHoldAdoption(id);
			await s.orderStore.completeHoldCommit(id);
			await s.orderStore.completeHoldRelease(id);
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["hold-intents"].unit);
	});

	/**
	 * The adoption completer's race path (issue #599): the order read pending, a
	 * cancel lands before the adopt, and the completer re-reads and releases what it
	 * just adopted — the costliest way through it. Measured at one and at three lines,
	 * against the per-row estimate the gate admits the row on.
	 */
	for (const lines of [1, 3]) {
		test(`hold-intents: an adoption a cancel overtakes, re-read and released (${String(lines)} line${lines === 1 ? "" : "s"})`, async () => {
			const holdExpiresAt = new Date(Date.now() + DAY_MS).toISOString();
			const suffix = `race-${String(lines)}`;
			const placed = await placeOrder(suffix, holdExpiresAt, lines, undefined, false);
			const orders = collectionOf<OrderDoc>(storage, ORDERS_COLLECTION);
			const before = await orders.getVersioned(placed.id);
			const pendingSince = new Date(Date.now() - HOUR_MS).toISOString();
			await orders.compareAndSet(placed.id, before!.revision, {
				...before!.value,
				holdsPendingAt: pendingSince,
				holdsAdopted: {
					reservationIds: placed.reservationIds,
					holdExpiresAt,
					recordedAt: pendingSince,
					completedAt: null,
				},
			});
			const row = await orders.get(placed.id);
			const s = counted();
			const peer = uncounted();
			const id = toOrderId(placed.id);
			let cancelled = false;
			beforeCall = async (collection, method) => {
				if (cancelled || collection !== INVENTORY_COLLECTION || method !== "compareAndSet") return;
				cancelled = true;
				const res = await cancelOrder(
					{ orderStore: peer.orderStore },
					{
						orderId: id,
						reason: "customer_request",
						cancelledBy: "ops",
						idempotencyKey: idempotencyKey(`cx-${suffix}`),
					},
				);
				if (!(res.ok && res.cancelled)) throw new Error("the peer cancel must land");
			};
			let releasedFor: string | null = null;
			const used = await cost(async () => {
				try {
					releasedFor = (await s.orderStore.completeHoldAdoption(id)).releasedFor;
				} finally {
					beforeCall = null;
				}
				await s.orderStore.completeHoldCommit(id);
				await s.orderStore.completeHoldRelease(id);
			});
			// The premise: this really was the race path.
			expect(releasedFor).toBe("cancelled");
			for (const sku of placed.skus) {
				expect(
					(await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(sku))?.onHand,
				).toBe(10);
			}
			expect(used).toBeLessThanOrEqual(holdIntentCost({ data: row! }));
			if (lines === 1) expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["hold-intents"].unit);
		});
	}

	test("order-sku-index: one order's pointer, found already healed", async () => {
		const placed = await placeOrder("index", new Date(Date.now() + DAY_MS).toISOString());
		// The leg gets the order document from its window page, so the read is not the unit's.
		const doc = await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(placed.id);
		if (doc === null) throw new Error("the placed order must exist");
		const s = counted();
		let healed: { written: number } | undefined;
		const used = await cost(async () => {
			healed = await s.orderStore.healOrderSkuIndex(doc);
		});
		// Found already healed: the refused create and its read-back, nothing written.
		expect(healed?.written).toBe(0);
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["order-sku-index"].unit);
	});

	test("coupon-orphans: one judged redemption and its release — no order by id or key", async () => {
		const s = counted();
		const couponId = await costCoupon(s, "coupon-cost", "COSTSWEEP");
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId("order-cost-never-written"),
			idempotencyKey: idempotencyKey("redeem-cost"),
			customerId: toCustomerId("cust-cost"),
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("redeem failed");
		const redemption = {
			orderId: toOrderId("order-cost-never-written"),
			idempotencyKey: idempotencyKey("redeem-cost"),
			couponId,
		};
		const used = await cost(async () => {
			expect(await orderHoldingRedemption(s, redemption)).toBeNull();
			await s.couponStore.release(claimed.redemptionId);
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["coupon-orphans"].unit);
	});

	// #598 review: the WORST lookup — no order under the redemption's id, a
	// three-SKU order under its key that applied the coupon. The miss by id, the key
	// peek (the key, then its order — never the healing resolve, whose by-sku
	// re-assert would cost a write per SKU), the coupon read that confirms the code,
	// and the release.
	test("coupon-orphans: the worst unit — the order found by key under another id, and a release", async () => {
		const s = counted();
		const couponId = await costCoupon(s, "coupon-cost-bykey", "COSTBYKEY");
		const placed = await placeOrder(
			"orphan-bykey",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
			3,
			"COSTBYKEY",
		);
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId(`${placed.id}-never-persisted`),
			idempotencyKey: idempotencyKey("create-orphan-bykey"),
			customerId: toCustomerId("cust-cost-bykey"),
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("redeem failed");
		const redemption = {
			orderId: toOrderId(`${placed.id}-never-persisted`),
			idempotencyKey: idempotencyKey("create-orphan-bykey"),
			couponId,
		};
		const used = await cost(async () => {
			const holder = await orderHoldingRedemption(s, redemption);
			expect(holder?.order.id).toBe(placed.id);
			await s.couponStore.release(claimed.redemptionId);
		});
		expect(used).toBe(COUPON_ORPHAN_WORST_UNIT);
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["coupon-orphans"].unit);
	});

	// #619: the worst unit is the confirming look that writes — the coupon read, the
	// in-flight count, the applied count and the correcting compare-and-set.
	test("coupon-recount: one coupon's confirmed correction", async () => {
		const s = counted();
		const couponId = await costCoupon(s, "coupon-cost-recount", "COSTRECOUNT");
		const docs = collectionOf<CouponDoc>(storage, COUPONS_COLLECTION);
		const doc = await docs.getVersioned(couponId);
		if (doc === null) throw new Error("no coupon");
		await docs.compareAndSet(couponId, doc.revision, { ...doc.value, usesCount: 3 });
		const T0 = new Date(Date.now() - 2 * COUPON_RECOUNT_SETTLE_MS).toISOString();
		const first = await s.couponStore.recountUses(couponId, null, T0);
		if (first.outcome !== "drift") throw new Error(`expected drift, got ${first.outcome}`);
		const used = await cost(async () => {
			expect(
				await s.couponStore.recountUses(couponId, first.observation, new Date().toISOString()),
			).toEqual({ outcome: "corrected", from: 3, to: 0 });
		});
		expect(used).toBe(COUPON_RECOUNT_CALLS);
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["coupon-recount"].unit);
	});

	test("stranded-holds: one sku holding one unit for a dead order, released (#631)", async () => {
		const placed = await placeOrder("stranded", new Date(Date.now() + DAY_MS).toISOString());
		await strandOrder(storage, placed.id, "cancelled", new Date());
		// The leg gets the inventory document from its page, so that read is not the unit's.
		const doc = await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(placed.sku);
		if (doc === null) throw new Error("the placed sku must exist");
		expect(1 + strandedReleaseCost(1)).toBe(LEG_QUERY_COSTS["stranded-holds"].unit);
		const s = counted();
		const orders = collectionOf<OrderDoc>(wrappedStorage(), ORDERS_COLLECTION);
		let released = 0;
		const used = await cost(async () => {
			released = (await releaseStrandedOnSku(doc, orders, s)).released;
		});
		expect(released).toBe(1);
		expect(
			(await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(placed.sku))?.onHand,
		).toBe(10);
		expect(used, `measured ${String(used)}`).toBe(LEG_QUERY_COSTS["stranded-holds"].unit);
	});

	test("stranded-holds: a sku held by a live order costs its order read alone", async () => {
		const placed = await placeOrder("stranded-live", new Date(Date.now() + DAY_MS).toISOString());
		const doc = await collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION).get(placed.sku);
		if (doc === null) throw new Error("the placed sku must exist");
		const s = counted();
		const orders = collectionOf<OrderDoc>(wrappedStorage(), ORDERS_COLLECTION);
		const used = await cost(async () => {
			expect(await releaseStrandedOnSku(doc, orders, s)).toEqual({ released: 0 });
		});
		expect(used).toBe(1);
	});

	test("stranded-holds: the release of three holds one order adopted on one sku fits strandedReleaseCost(3)", async () => {
		const s = counted();
		const sku = "COST-STRANDED-MANY";
		await s.inventory.seedOnHand(toSku(sku), 10);
		const held: string[] = [];
		for (let i = 0; i < 3; i++) {
			const reserved = await s.inventory.reserve(
				toSku(sku),
				1,
				idempotencyKey(`res-stranded-many-${String(i)}`),
			);
			if (!reserved.ok) throw new Error(reserved.reason);
			await s.inventory.stampHoldDeadline(
				reserved.reservationId,
				new Date(Date.now() + DAY_MS).toISOString(),
			);
			held.push(reserved.reservationId);
		}
		await s.inventory.adoptMany({
			reservationIds: held,
			orderId: toOrderId("order-stranded-many"),
			holdExpiresAt: new Date(Date.now() + DAY_MS).toISOString(),
			now: new Date().toISOString(),
		});
		const used = await cost(async () => {
			expect(
				await s.inventory.releaseAdoptedManyReporting(held, "order-stranded-many"),
			).toHaveLength(3);
		});
		expect(used, `measured ${String(used)}`).toBe(strandedReleaseCost(3));
	});

	test("sku-transfers: one product with a stranded carry", async () => {
		const s = counted();
		const productId = "prod-cost-xfer";
		const fromSku = "COST-XFER-OLD";
		const toSkuName = "COST-XFER-NEW";
		await s.productCommerce.upsert(
			{
				productId: toProductId(productId),
				sku: toSku(toSkuName),
				price: money(cents(1999), currency("USD")),
				productKind: "physical",
			},
			idempotencyKey("upsert-cost-xfer"),
		);
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		const token = "xfer-token-cost";
		await inventory.put(fromSku, {
			sku: fromSku,
			onHand: 0,
			holds: {},
			transferOut: { token, toSku: toSkuName, qty: 7 },
		});
		const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
		const current = await products.getVersioned(productId);
		await products.compareAndSet(productId, current!.revision, {
			...current!.value,
			pendingRenames: { [token]: { token, fromSku, toSku: toSkuName, commandKey: "cmd-cost" } },
		});
		const used = await cost(async () => {
			await s.productCommerce.completeRecordedRenames(toProductId(productId));
			await s.productCommerce.completePendingSkuTransfer(fromSku);
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["sku-transfers"].unit);
	});

	test("late-refunds: one order's reserved late refund resumed (ledger, re-drive, the two Stripe calls, resolve, notice)", async () => {
		const placed = await placeOrder(
			"late-refund",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
		);
		const s = counted();
		const id = toOrderId(placed.id);
		await s.orderStore.expire(id, new Date().toISOString());
		// The webhook's attempt hit a transient Stripe failure: reserved + scheduled.
		const fake = new FakePaymentGateway({ id: "stripe" });
		fake.setRefundResult({ ok: false, reason: "RETRYABLE" });
		const settleDeps = {
			orderStore: s.orderStore,
			entitlementStore: s.entitlementStore,
			paymentEventStore: s.paymentEventStore,
			inventoryStore: s.inventory,
			clock: s.clock,
		};
		const settled = await settleOrder(
			settleDeps,
			fake,
			fake.webhook({
				outcome: "succeeded",
				orderId: placed.id,
				providerRef: "pi_cost_late",
				amount: 1000,
				currency: "USD",
				dedupeKey: "evt_cost_late",
			}),
		);
		expect(settled).toEqual({ ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" });
		fake.clearRefundResult();
		// A real Stripe refund is two subrequests: the pre-flight read and the create.
		const stripe: PaymentGateway = {
			id: "stripe",
			refundable: true,
			createIntent: (i) => fake.createIntent(i),
			verifyConfirmation: (raw) => fake.verifyConfirmation(raw),
			cancelIntent: (input) => fake.cancelIntent(input),
			async refund(input) {
				counter.calls += 2;
				return fake.refund(input);
			},
		};
		const later = new Date(Date.now() + 2 * HOUR_MS);
		const used = await cost(() =>
			retryLatePaymentRefunds(
				{
					orderStore: s.orderStore,
					paymentEventStore: s.paymentEventStore,
					clock: { now: () => later },
					gateways: () => ({ stripe }),
				},
				{ limit: 1 },
			),
		);
		expect((await s.orderStore.listRefunds(id)).map((r) => r.status)).toEqual(["recorded"]);
		// The leg's ENTRY covers the due list read (1 of these calls).
		expect(used - 1, `measured ${String(used - 1)}`).toBeLessThanOrEqual(
			LEG_QUERY_COSTS["late-refunds"].unit,
		);
	});

	test("late-refunds ESCALATION: one stale retry given up — no provider call", async () => {
		const placed = await placeOrder(
			"late-escalate",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
		);
		const s = counted();
		const id = toOrderId(placed.id);
		await s.orderStore.expire(id, new Date().toISOString());
		const fake = new FakePaymentGateway({ id: "stripe" });
		fake.setRefundResult({ ok: false, reason: "RETRYABLE" });
		await settleOrder(
			{
				orderStore: s.orderStore,
				entitlementStore: s.entitlementStore,
				paymentEventStore: s.paymentEventStore,
				inventoryStore: s.inventory,
				clock: s.clock,
			},
			fake,
			fake.webhook({
				outcome: "succeeded",
				orderId: placed.id,
				providerRef: "pi_cost_escalate",
				amount: 1000,
				currency: "USD",
				dedupeKey: "evt_cost_escalate",
			}),
		);
		const stale = new Date(Date.now() + 4 * DAY_MS);
		const used = await cost(() =>
			escalateStaleLateRefunds(
				{
					orderStore: s.orderStore,
					paymentEventStore: s.paymentEventStore,
					clock: { now: () => stale },
				},
				{ limit: 1 },
			),
		);
		expect((await s.orderStore.listRefunds(id)).map((r) => r.status)).toEqual(["unverified"]);
		// The age-ranked stale list read (1) is the escalation's entry.
		expect(used - 1, `measured ${String(used - 1)}`).toBeLessThanOrEqual(
			LATE_REFUND_ESCALATION_UNIT,
		);
	});

	test("cancel-intents: one expired order's intent withdrawn (ledger, the Stripe cancel, the bookkeeping)", async () => {
		const placed = await placeOrder(
			"cancel-intent",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
		);
		const s = counted();
		const id = toOrderId(placed.id);
		await s.orderStore.recordPaymentIntent({
			orderId: id,
			gateway: "stripe",
			intentId: "pi_cost_cancel",
		});
		await s.orderStore.expire(id, new Date().toISOString());
		const fake = new FakePaymentGateway({ id: "stripe" });
		// A real Stripe cancel is one subrequest.
		const stripe: PaymentGateway = {
			id: "stripe",
			refundable: true,
			createIntent: (i) => fake.createIntent(i),
			verifyConfirmation: (raw) => fake.verifyConfirmation(raw),
			refund: (i) => fake.refund(i),
			async cancelIntent(input) {
				counter.calls += 1;
				return fake.cancelIntent(input);
			},
		};
		const due = await s.orderStore.listIntentCancelsDue(new Date().toISOString(), 1);
		// The due list is the leg's due check; the unit is everything after it.
		const used = await cost(() =>
			cancelDueIntents(
				{
					orderStore: s.orderStore,
					clock: { now: () => new Date() },
					gateways: () => ({ stripe }),
				},
				{ limit: 1, due },
			),
		);
		expect(fake.cancelCalls).toHaveLength(1);
		expect(used, `measured ${String(used)}`).toBeLessThanOrEqual(
			LEG_QUERY_COSTS["cancel-intents"].unit,
		);
	});

	// The WORST cancel unit: Stripe refuses the cancel (payment_intent_unexpected_state),
	// the transport reads the intent back (a second subrequest) and finds it still
	// payable, and this is the last attempt — so the intent is given up and the order
	// flagged. Measured with fix/late-charge-window merged (which adds the read-back
	// and the give-up flag): 7 — the ledger 1, the cancel POST and intent GET 2, the
	// give-up write 2, the flag 2. Without that branch the same case is 5 (no flag).
	test("cancel-intents worst unit: a refused cancel read back as payable, on its last attempt, given up and flagged", async () => {
		const placed = await placeOrder(
			"cancel-intent-worst",
			new Date(Date.now() - 30 * MINUTE_MS).toISOString(),
		);
		const s = counted();
		const id = toOrderId(placed.id);
		await s.orderStore.recordPaymentIntent({
			orderId: id,
			gateway: "stripe",
			intentId: "pi_cost_worst",
		});
		await s.orderStore.expire(id, new Date().toISOString());
		await s.orderStore.updatePaymentIntentCancel(id, "pi_cost_worst", {
			cancelDueAt: new Date(Date.now() - MINUTE_MS).toISOString(),
			cancelAttempts: DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS - 1,
			cancelOutcome: null,
		});
		const fake = new FakePaymentGateway({ id: "stripe" });
		const stripe: PaymentGateway = {
			id: "stripe",
			refundable: true,
			createIntent: (i) => fake.createIntent(i),
			verifyConfirmation: (raw) => fake.verifyConfirmation(raw),
			refund: (i) => fake.refund(i),
			async cancelIntent() {
				counter.calls += 2;
				return { ok: false, reason: "RETRYABLE" };
			},
		};
		const due = await s.orderStore.listIntentCancelsDue(new Date().toISOString(), 1);
		expect(due).toEqual([id]);
		const used = await cost(() =>
			cancelDueIntents(
				{
					orderStore: s.orderStore,
					clock: { now: () => new Date() },
					gateways: () => ({ stripe }),
				},
				{ limit: 1, due },
			),
		);
		const [intent] = await s.orderStore.listPaymentIntents(id);
		expect(intent?.cancelOutcome).toBe("failed");
		expect(used, `measured ${String(used)}`).toBeLessThanOrEqual(
			LEG_QUERY_COSTS["cancel-intents"].unit,
		);
		// The measured worst case, pinned: lowering the estimate below it is a regression.
		expect(LEG_QUERY_COSTS["cancel-intents"].unit).toBeGreaterThanOrEqual(7);
	});

	test("cancel-intents entry: resolving the deployment's gateways (their secret reads)", async () => {
		const ctx = {
			http: { fetch: () => Promise.reject(new Error("no egress")) },
			kv: {
				async get() {
					counter.calls++;
					return null;
				},
			},
		} as unknown as PluginContext;
		const used = await cost(() => resolvePaymentGateways(ctx));
		// Exactly Stripe's two secret reads: the entry is sized to it, no headroom.
		expect(used).toBe(2);
		expect(LEG_QUERY_COSTS["cancel-intents"].entry).toBe(used);
	});

	test("late-refunds entry: resolving the deployment's gateways (their secret reads)", async () => {
		const ctx = {
			http: { fetch: () => Promise.reject(new Error("no egress")) },
			kv: {
				async get() {
					counter.calls++;
					return null;
				},
			},
		} as unknown as PluginContext;
		// The due list is the leg's due check, charged before the entry.
		const used = await cost(() => resolvePaymentGateways(ctx));
		// Exactly Stripe's two secret reads: the entry is sized to it, no headroom.
		expect(used).toBe(2);
		expect(LEG_QUERY_COSTS["late-refunds"].entry).toBe(used);
	});

	test("product-orphans: one orphan's soft delete (the row's flip and its sku claim's release)", async () => {
		const s = counted();
		const pid = toProductId("prod-cost-orphan");
		await s.productCommerce.upsert(
			{ productId: pid, sku: toSku("COST-ORPHAN"), price: money(cents(900), currency("USD")) },
			idempotencyKey("cost-orphan-seed"),
		);
		const used = await cost(() =>
			s.productCommerce.softDelete(pid, idempotencyKey("products:prod-cost-orphan:deleted")),
		);
		expect(used).toBeLessThanOrEqual(PRODUCT_ORPHAN_DELETE_CALLS);
		// On top: one row's reads at worst (two misses at one query each, then a hit at
		// three), the canary read, and this delete.
		expect(LEG_QUERY_COSTS["product-orphans"].unit).toBe(
			2 * CONTENT_MISS_QUERIES +
				CONTENT_READ_QUERIES +
				CONTENT_READ_QUERIES +
				PRODUCT_ORPHAN_DELETE_CALLS,
		);
	});

	test("reporting-heal: one day reconciled", async () => {
		const s = counted();
		const day = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
		const used = await cost(() =>
			s.reportingStore.reconcile({ from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` }),
		);
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["reporting-heal"].unit);
	});

	// The rollup verifier (#572 review): one run re-checks two built months and one
	// day's product lines, between a cursor read and a cursor write. Measured as the
	// sweep runs it — the same store calls in the same order — over two currencies'
	// documents, so a month's days are a full page.
	test("reporting-heal: one verifier run fits REPORTING_VERIFY_CALLS", async () => {
		const day = new Date().toISOString().slice(0, 10);
		const month = day.slice(0, 7);
		await placeOrder("verify-a", new Date(Date.now() + DAY_MS).toISOString());
		await placeOrder("verify-b", new Date(Date.now() + DAY_MS).toISOString(), 2);
		const raw = new EmdashReportingStore({ storage, clock: { now: () => new Date() } });
		await raw.rebuildDayProducts(day);
		expect(await raw.rebuildMonth(month)).toBe(true);
		const store = new EmdashReportingStore({
			storage: wrappedStorage(),
			clock: { now: () => new Date() },
		});
		const used = await cost(async () => {
			// The cursor read (a kv get).
			counter.calls++;
			const months = await store.monthsAfter(null, "2100-01", 2);
			expect(months).toContain(month);
			// Two months' rebuilds, as the sweep makes them (the second is this month again).
			expect(await store.buildMonth(month)).toBe("unchanged");
			expect(await store.buildMonth(month)).toBe("unchanged");
			expect(await store.dayBefore(null, "2100-01-01")).not.toBeNull();
			expect(await store.rebuildDayProducts(day)).toMatchObject({ repaired: 0 });
			// The cursor write (a kv set).
			counter.calls++;
		});
		expect(used).toBe(REPORTING_VERIFY_CALLS);
	});

	// The refresh's units, which its loops are admitted on (#572 review): on the Free
	// preset the leg's share left after its walk is below a reconcile unit, so sizing
	// them by the reconcile unit kept the refresh from ever running there.
	test("reporting-heal: one day's lines built, one month built, one day re-checked", async () => {
		const placed = await placeOrder("refresh-units", new Date(Date.now() + DAY_MS).toISOString());
		const day = new Date().toISOString().slice(0, 10);
		const month = day.slice(0, 7);
		const order = (await collectionOf<OrderDoc>(storage, ORDERS_COLLECTION).get(placed.id))!;
		const orderCurrency = order.currency;
		const store = new EmdashReportingStore({
			storage: wrappedStorage(),
			clock: { now: () => new Date() },
		});
		// Its lines are dirty, in one currency: the build writes them.
		const docs = collectionOf<{ currency: string; productsDirty?: number }>(
			storage,
			REPORTING_DAILY_COLLECTION,
		);
		const page = await docs.query({ where: { date: day }, limit: 10 });
		for (const { id, data } of page.items) {
			if (data.currency === orderCurrency) await docs.put(id, { ...data, productsDirty: 1 });
			else await docs.delete(id);
		}
		const built = await cost(async () => {
			expect(await store.rebuildDayProducts(day)).toMatchObject({ written: 1 });
		});
		expect(built).toBe(REPORTING_LINES_BUILD_CALLS);
		const monthBuilt = await cost(async () => {
			expect(await store.buildMonth(month)).toBe("built");
		});
		expect(monthBuilt).toBe(REPORTING_MONTH_BUILD_CALLS);
		const checked = await cost(async () => {
			expect(await store.dayBefore(null, "2100-01-01")).not.toBeNull();
			expect(await store.rebuildDayProducts(day)).toMatchObject({ written: 0 });
		});
		expect(checked).toBe(REPORTING_VERIFY_DAY_CALLS);
	});
});

describe("the cost table against the Workers Free preset (review of QA2 M2)", () => {
	// `cancel-intents` runs first in every tick. A leg whose ONE unit cannot fit behind
	// one intent cancel and the tick's fixed reads would wait for as long as cancels
	// keep coming — unless the starvation guard gives it the head of a tick. This pins
	// which legs rely on the guard, from the estimates the tick actually admits on, so
	// a cost-table change that adds one is a deliberate decision, not an accident.
	const FREE = 30;
	/** An ordinary cancel unit, measured above: ledger, cancel, bookkeeping write. */
	const ORDINARY_CANCEL_UNIT = 5;
	/** An idle Free tick's own spend (DEPLOYMENT.md §5: "an idle tick is 8 queries"). */
	const IDLE_FREE_TICK = 8;
	test("one unit of every leg fits behind an intent cancel and the fixed reads — or fits alone, at the head the guard gives it", () => {
		// The setting and cadence-state reads, then late-refunds' due check at the head.
		const fixed = TICK_OVERHEAD_QUERIES + 1;
		const cancel =
			1 + LEG_QUERY_COSTS["cancel-intents"].entry + LEG_QUERY_COSTS["cancel-intents"].unit;
		const needsHead: string[] = [];
		for (const leg of SWEEP_LEGS) {
			// The late-refund lead has its own rule (it leads ahead of the cancel).
			if (leg === "cancel-intents" || leg === "late-refunds") continue;
			// A leg with no deadline is never given the head (`UNPROMOTED_LEGS`): it must
			// fit ALONE in an idle Free tick, and otherwise waits for one.
			if (UNPROMOTED_LEGS.includes(leg)) {
				expect(
					IDLE_FREE_TICK + legStartCalls(leg, FREE) + legReserveQueries(leg),
					leg,
				).toBeLessThanOrEqual(FREE);
				continue;
			}
			const own =
				(MAINTENANCE_LEGS.includes(leg) ? 0 : 1) +
				legStartCalls(leg, FREE) +
				legReserveQueries(leg);
			if (fixed + cancel + own <= FREE) continue;
			needsHead.push(leg);
			expect(fixed + own, `${leg} alone at the head`).toBeLessThanOrEqual(FREE);
		}
		// Measured: a hold expiry with its list (~20) never fits behind a cancel. Since
		// the cancel's gateway entry is Stripe's two reads (not the five once sized for
		// a second gateway), a whole worst cancel is 1 + 2 + 7 = 10, and every other
		// leg's unit — an order expiry (14 with its due check), a stranded sku carry
		// (12 with its cursor), the order emails (12 plus the availability read) — fits
		// behind it.
		expect(needsHead.toSorted()).toEqual(["expire-holds"]);
		expect(SWEEP_LEGS[0]).toBe("order-emails");
		// And behind an ordinary one (5), too — for them the guard is a backstop, not
		// the pace.
		const ordinaryCancel = 1 + LEG_QUERY_COSTS["cancel-intents"].entry + ORDINARY_CANCEL_UNIT;
		for (const leg of ["expire-orders", "sku-transfers"] as const) {
			const own =
				(MAINTENANCE_LEGS.includes(leg) ? 0 : 1) +
				legStartCalls(leg, FREE) +
				legReserveQueries(leg);
			expect(fixed + ordinaryCancel + own, leg).toBeLessThanOrEqual(FREE);
		}
	});
});

/** The counted store on its own, for a case that addresses a collection directly. */
function wrappedStorage(): StorageAccess {
	const wrapped: StorageAccess = {};
	for (const [name, collection] of Object.entries(storage)) {
		wrapped[name] = new Proxy(collection, {
			get(target, prop, receiver) {
				const value: unknown = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const hook = beforeCall;
					if (hook !== null) {
						return hook(name, String(prop)).then(() => {
							counter.calls++;
							return (value as (...a: unknown[]) => unknown).apply(target, args);
						});
					}
					counter.calls++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}
