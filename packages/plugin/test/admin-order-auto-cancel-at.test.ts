/**
 * "Auto-cancels in N days" on the admin order detail (ADR-0044 §6, B-N6).
 *
 * The detail wire carries `autoCancelAt`: when the `cod-auto-cancel` sweep will
 * cancel this order if nobody marks it paid — `createdAt` plus the live window
 * (`settings:codAutoCancelDays`). Only an `awaiting_payment` order of an
 * offline settlement has one: a shipped one is never auto-cancelled (the goods
 * are out), a card order is not this sweep's, and a window of 0 (off) or one
 * that cannot be read means no date — never a guessed one.
 *
 * Driven over a REAL document store through `InProcessAdminOrdersClient`.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type OrderId,
} from "@urumi.ai/otta-domain";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { COD_AUTO_CANCEL_DAYS_KEY } from "../src/payments/cash-on-delivery.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
const DAY_MS = 86_400_000;

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	await harness.ctx.kv.delete(COD_AUTO_CANCEL_DAYS_KEY);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

async function seed(
	id: string,
	paymentMethod: "cod" | "stripe",
	state: "pending" | "awaiting_payment" | "paid",
): Promise<OrderId> {
	const oid = toOrderId(id);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod,
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Mug",
				unitPrice: cents(1500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
	});
	if (state === "awaiting_payment") {
		await harness.stores.orderStore.transition({
			orderId: oid,
			fromState: "pending",
			toState: "awaiting_payment",
			idempotencyKey: toIdempotencyKey(`placed-${id}`),
			enqueueEmail: false,
		});
	}
	if (state === "paid") await harness.stores.orderStore.markPaid(oid);
	return oid;
}

async function detail(id: string) {
	const client = new InProcessAdminOrdersClient(harness.ctx);
	const result = await client.getOrder(id);
	if (result === null) throw new Error(`no order ${id}`);
	return result.order;
}

function plusDays(iso: string, days: number): string {
	return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

test("an awaiting-payment COD order: createdAt + the default window (14 days)", async () => {
	await seed("cod-default", "cod", "awaiting_payment");
	const order = await detail("cod-default");
	expect(order.autoCancelAt).toBe(plusDays(order.createdAt, 14));
});

test("the merchant's window is the live one", async () => {
	await harness.ctx.kv.set(COD_AUTO_CANCEL_DAYS_KEY, 5);
	await seed("cod-five", "cod", "awaiting_payment");
	const order = await detail("cod-five");
	expect(order.autoCancelAt).toBe(plusDays(order.createdAt, 5));
});

test("a window of 0 (auto-cancel off) has no date", async () => {
	await harness.ctx.kv.set(COD_AUTO_CANCEL_DAYS_KEY, 0);
	await seed("cod-off", "cod", "awaiting_payment");
	expect((await detail("cod-off")).autoCancelAt).toBeNull();
});

test("a window that cannot be read has no date — never a guessed one", async () => {
	await seed("cod-kv-fail", "cod", "awaiting_payment");
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(harness.ctx.kv, "get").mockRejectedValue(new Error("kv down"));
	const order = await detail("cod-kv-fail");
	expect(order.state).toBe("awaiting_payment");
	expect(order.autoCancelAt).toBeNull();
});

test("only an awaiting-payment offline order has one", async () => {
	await seed("cod-stuck", "cod", "pending");
	await seed("cod-paid", "cod", "paid");
	await seed("card-pending", "stripe", "pending");
	await seed("card-paid", "stripe", "paid");
	for (const id of ["cod-stuck", "cod-paid", "card-pending", "card-paid"]) {
		expect((await detail(id)).autoCancelAt, id).toBeNull();
	}
});

test("a card order never reads the window", async () => {
	await seed("card-no-read", "stripe", "paid");
	const get = vi.spyOn(harness.ctx.kv, "get");
	await detail("card-no-read");
	expect(get.mock.calls.map(([key]) => key)).not.toContain(COD_AUTO_CANCEL_DAYS_KEY);
});
