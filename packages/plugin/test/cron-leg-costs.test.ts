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
	cancelDueIntents,
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
import { LATE_REFUND_ESCALATION_UNIT, LEG_QUERY_COSTS } from "../src/cron/sweeps.js";
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

/** A pending order over one adopted reservation. */
async function placeOrder(suffix: string, holdExpiresAt: string) {
	const s = counted();
	const sku = `COST-${suffix}`;
	await s.inventory.seedOnHand(toSku(sku), 10);
	const held = await s.inventory.reserve(toSku(sku), 1, idempotencyKey(`res-${suffix}`));
	if (!held.ok) throw new Error(held.reason);
	await s.inventory.stampHoldDeadline(
		held.reservationId,
		new Date(Date.now() + DAY_MS).toISOString(),
	);
	const id = `order-${suffix}`;
	await s.inventory.adoptMany({
		reservationIds: [held.reservationId],
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
		lines: [
			{
				productId: toProductId(`prod-${suffix}`),
				sku: toSku(sku),
				title: "Cost Widget",
				unitPrice: cents(1000),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: currency("USD") },
	});
	return { id, sku, reservationId: held.reservationId };
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

	test("expire-orders: one order's flip, read, hold release and coupon release", async () => {
		const placed = await placeOrder("expire", new Date(Date.now() - 30 * MINUTE_MS).toISOString());
		const s = counted();
		const now = new Date().toISOString();
		const used = await cost(async () => {
			await s.orderStore.expire(toOrderId(placed.id), now);
			const order = await s.orderStore.getById(toOrderId(placed.id));
			for (const line of order?.lines ?? []) {
				if (line.reservationId !== null) {
					await s.inventory.releaseAdopted(line.reservationId, toOrderId(placed.id));
				}
			}
			await s.couponStore.releaseByOrder(toOrderId(placed.id));
		});
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["expire-orders"].unit);
	});

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

	test("reporting-heal: one day reconciled", async () => {
		const s = counted();
		const day = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
		const used = await cost(() =>
			s.reportingStore.reconcile({ from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` }),
		);
		expect(used).toBeLessThanOrEqual(LEG_QUERY_COSTS["reporting-heal"].unit);
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
