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
	cents,
	currency,
	customerId as toCustomerId,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
	money,
	escalateStaleLateRefunds,
	expireOrdersBatch,
	cancelDueIntents,
	DEFAULT_INTENT_CANCEL_MAX_ATTEMPTS,
	retryLatePaymentRefunds,
	settleOrder,
	type PaymentGateway,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import {
	collectionOf,
	INVENTORY_COLLECTION,
	ORDER_SKU_INDEX_COLLECTION,
	orderSkuIndexId,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	type InventoryDoc,
	type OrderDoc,
	type OrderSkuIndexDoc,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import {
	CONTENT_MISS_QUERIES,
	CONTENT_READ_QUERIES,
	LATE_REFUND_ESCALATION_UNIT,
	LEG_QUERY_COSTS,
	legReserveQueries,
	legStartCalls,
	MAINTENANCE_LEGS,
	PRODUCT_ORPHAN_DELETE_CALLS,
	SWEEP_LEGS,
	TICK_OVERHEAD_QUERIES,
	UNPROMOTED_LEGS,
} from "../src/cron/sweeps.js";
import { resolvePaymentGateways } from "../src/payments/resolve-payment-gateways.js";
import type { PluginContext } from "../src/types.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

let storage: StorageAccess;
const counter = { calls: 0 };

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

/** Count the calls `body` makes. */
async function cost(body: () => Promise<unknown>): Promise<number> {
	counter.calls = 0;
	await body();
	return counter.calls;
}

/** A pending order over `lines` adopted reservations, one SKU each. */
async function placeOrder(suffix: string, holdExpiresAt: string, lines = 1) {
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
	await s.inventory.adoptMany({
		reservationIds: held,
		orderId: toOrderId(id),
		holdExpiresAt,
		now: new Date(Date.now() - HOUR_MS).toISOString(),
	});
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
		},
	});
	return { id, sku: skus[0] ?? "", skus, reservationId: held[0] ?? "" };
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

	// QA2 M2: one order expiry was 22 calls on a 30-call Workers Free tick, so a
	// backlog expired one order every three minutes. The use-case re-read the order
	// the flip had written and released every line a second time after the store had
	// released them one id at a time. These pin the cut, per order shape — measured
	// the same way on the base before the change: 22 (one line) and 40 (three lines on
	// three SKUs).
	test.each([
		{ lines: 1, before: 22, ceiling: 13 },
		{ lines: 3, before: 40, ceiling: 23 },
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

	test("order-sku-index: one order's pointer, found already healed", async () => {
		const placed = await placeOrder("index", new Date(Date.now() + DAY_MS).toISOString());
		const pointers = collectionOf<OrderSkuIndexDoc>(wrappedStorage(), ORDER_SKU_INDEX_COLLECTION);
		const id = orderSkuIndexId(placed.sku.toLowerCase(), placed.id);
		const used = await cost(async () => {
			const applied = await pointers.compareAndSet(id, null, {
				sku: placed.sku.toLowerCase(),
				orderId: placed.id,
				createdAt: new Date().toISOString(),
			});
			if (!applied.applied) await pointers.get(id);
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["order-sku-index"].unit);
	});

	test("coupon-orphans: one judged redemption and its release", async () => {
		const s = counted();
		const couponId = "coupon-cost";
		await s.couponStore.create({
			id: couponId,
			code: "COSTSWEEP",
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
		const claimed = await s.couponStore.redeem({
			couponId,
			orderId: toOrderId("order-cost-never-written"),
			idempotencyKey: idempotencyKey("redeem-cost"),
			customerId: toCustomerId("cust-cost"),
			createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
		});
		if (!claimed.ok) throw new Error("redeem failed");
		const used = await cost(async () => {
			await s.orderStore.getById(toOrderId("order-cost-never-written"));
			await s.couponStore.release(claimed.redemptionId);
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["coupon-orphans"].unit);
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
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["cancel-intents"].entry);
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
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["late-refunds"].entry);
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
		// Measured: a hold expiry with its list (~20) and a stock-commit completion (~15)
		// never fit behind a cancel. An order expiry (14 with its due check) and a stranded
		// sku carry (12 with its cursor) do not fit behind the WORST cancel (a refused,
		// read-back, given-up and flagged one: 7)...
		expect(needsHead.toSorted()).toEqual([
			"expire-holds",
			"expire-orders",
			"hold-intents",
			"sku-transfers",
		]);
		// ...but they fit behind an ordinary one (5), which is every cancel but an
		// intent's last failing attempt — for them the guard is a backstop, not the pace.
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
					counter.calls++;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
	}
	return wrapped;
}
