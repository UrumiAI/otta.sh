/**
 * The cron's `hold-intents` leg finishes a cancellation's PENDING restock (issue
 * #364). `cancelOrderWithRefund` restocks only after its flip lands, and records the
 * restock it owes on the cancellation; when that restock fails, the order is
 * cancelled with its units still owed. The flip's write put the order into
 * `holdsPendingAt`, so the leg that already walks that index returns the units —
 * once, under the keys the flip recorded — and takes the order out of the index.
 */
import {
	CANCELLATION_RESTOCK_FLAG_AFTER,
	cancelOrderWithRefund,
	cents,
	type InventoryStore,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { EmdashInventoryStore } from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import { runCommerceSweeps } from "../src/cron/sweeps.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const usd = toCurrency("USD");
let h: InProcessCommerceHarness;

beforeEach(async () => {
	if (h === undefined) h = await makeInProcessCommerce();
	else await h.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await h?.close();
});

const DEFAULT_SKU = "SKU-cxl-sweep";
const QTY = 2;
const ON_HAND = 10;

/** A paid physical order whose cancellation flipped but whose restock threw. */
async function cancelledWithRestockOwed(id: string, lineSku: string = DEFAULT_SKU): Promise<void> {
	const oid = toOrderId(id);
	await h.stores.inventory.seedOnHand(lineSku, ON_HAND);
	await h.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(lineSku),
				title: "Widget",
				unitPrice: cents(500),
				currency: usd,
				quantity: QTY,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: usd },
	});
	await h.stores.orderStore.markPaid(oid);
	await h.stores.orderStore.recordPayment({
		orderId: oid,
		gateway: "stripe",
		providerRef: `pi_${id}`,
		amount: cents(1000),
		currency: usd,
		status: "succeeded",
	});
	const failingRestock = new Proxy(h.stores.inventory as InventoryStore, {
		get(target, prop, receiver) {
			if (prop === "restock") {
				return async () => {
					throw new Error("simulated restock failure");
				};
			}
			const value: unknown = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? (value as Function).bind(target) : value;
		},
	});
	const res = await cancelOrderWithRefund(
		{ orderStore: h.stores.orderStore, inventoryStore: failingRestock },
		new FakePaymentGateway({ id: "stripe" }),
		{
			orderId: oid,
			reason: "customer_request",
			cancelledBy: "admin@shop",
			restock: true,
			idempotencyKey: toIdempotencyKey(`admin-cancel:${id}`),
		},
	);
	expect(res).toMatchObject({ ok: true, cancelled: true, restockPending: true });
}

function sweep(now: Date = new Date("2100-01-01T00:00:00.000Z")) {
	return runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, { now, queryBudget: 1_000 });
}

describe("cron hold-intents: a cancellation's pending restock", () => {
	test("one tick returns the owed units once and clears the marker; the next tick moves nothing", async () => {
		await cancelledWithRestockOwed("cxl-sweep-1");
		const oid = toOrderId("cxl-sweep-1");
		expect(await h.stores.inventory.getOnHand(DEFAULT_SKU)).toBe(ON_HAND);

		const first = await sweep();
		expect(first.legs.find((leg) => leg.leg === "hold-intents")).toMatchObject({ ok: true });
		expect(await h.stores.inventory.getOnHand(DEFAULT_SKU)).toBe(ON_HAND + QTY);
		const order = await h.stores.orderStore.getById(oid);
		expect(order?.state).toBe("cancelled");
		expect(order?.cancellation?.restockPending ?? null).toBeNull();
		expect(order?.cancellation?.restocked).toBe(true);

		await sweep();
		expect(await h.stores.inventory.getOnHand(DEFAULT_SKU)).toBe(ON_HAND + QTY);
	});

	test("a restock that keeps failing is flagged, then BACKED OFF behind newer work — and still retried", async () => {
		const STUCK = "SKU-stuck";
		const original = EmdashInventoryStore.prototype.restock;
		const restock = vi
			.spyOn(EmdashInventoryStore.prototype, "restock")
			.mockImplementation(function (this: EmdashInventoryStore, sku, qty, key) {
				if (sku === STUCK) return Promise.reject(new Error("stock row locked"));
				return original.call(this, sku, qty, key);
			});
		const stuckAttempts = () => restock.mock.calls.filter(([sku]) => sku === STUCK).length;
		await cancelledWithRestockOwed("cxl-stuck", STUCK);
		const stuck = toOrderId("cxl-stuck");
		const soon = new Date(Date.now() + 60_000);

		// Three ticks: three quiet retries, then the flag.
		for (let n = 0; n < CANCELLATION_RESTOCK_FLAG_AFTER; n++) await sweep(soon);
		expect(stuckAttempts()).toBe(CANCELLATION_RESTOCK_FLAG_AFTER);
		expect((await h.stores.orderStore.getById(stuck))?.reconciliationFlag).toContain(
			"items could not be returned to stock: stock row locked",
		);

		// Newer torn work arrives. The next tick finishes it and leaves the backed-off
		// restock alone.
		await cancelledWithRestockOwed("cxl-newer", "SKU-newer");
		const tick = await sweep(soon);
		expect(tick.legs.find((leg) => leg.leg === "hold-intents")).toMatchObject({ ok: true });
		expect(await h.stores.inventory.getOnHand("SKU-newer")).toBe(ON_HAND + QTY);
		expect(stuckAttempts()).toBe(CANCELLATION_RESTOCK_FLAG_AFTER);

		// Once its back-off has passed it is tried again — never dropped.
		await sweep(new Date(Date.now() + 10 * 60_000));
		expect(stuckAttempts()).toBe(CANCELLATION_RESTOCK_FLAG_AFTER + 1);
		expect((await h.stores.orderStore.getById(stuck))?.cancellation?.restockPending).toBeDefined();
	});
});
