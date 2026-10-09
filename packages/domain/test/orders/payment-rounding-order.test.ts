import {
	buildOrderEmailData,
	createOrderFromCart,
	currency,
	idempotencyKey,
	type Order,
	renderEmail,
	settleOrder,
} from "@otta-sh/domain";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

/**
 * ADR-0035's amendment, end to end through the order: a KWD order's total is
 * rounded to its payment increment (0.010) when it is created, the rounding is
 * frozen on the order, the payment intent asks for the rounded total, settlement
 * accepts exactly that amount, and the order email shows a signed "Rounding" row.
 * A USD order carries none of it.
 */
describe("an order in a currency with a payment increment", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	async function pendingOrder(code: string, priceCents: number, key = "k1"): Promise<Order> {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents,
			title: "Widget",
			onHand: 5,
			currency: currency(code),
		});
		const cartId = await h.cartWith(
			[{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }],
			code,
		);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(`seed order failed: ${res.reason}`);
		return res.order;
	}

	function confirmation(order: Order, amount: number, dedupeKey = "evt-1") {
		return h.stripeGw.webhook({
			outcome: "succeeded",
			orderId: order.id,
			providerRef: "pi_1",
			amount,
			currency: order.totals.currency,
			dedupeKey,
		});
	}

	test("KWD 1.234: the order total is 1.230, the rounding −0.004 is frozen, and the intent asks for 1.230", async () => {
		const order = await pendingOrder("KWD", 1234);
		expect(order.totals.subtotal).toBe(1234);
		expect(order.totals.total).toBe(1230);
		expect(order.totals.rounding).toBe(-4);
		const stored = await h.orderStore.getById(order.id);
		expect(stored?.totals.total).toBe(1230);
		expect(stored?.totals.rounding).toBe(-4);
		expect(h.stripeGw.intentCalls.at(-1)?.amount).toBe(1230);
	});

	test("settlement accepts the ROUNDED total and refuses the exact one", async () => {
		const order = await pendingOrder("KWD", 1235);
		expect(order.totals.total).toBe(1240);
		const wrong = await settleOrder(h.settleDeps, h.stripeGw, confirmation(order, 1235, "evt-x"));
		expect(wrong).toEqual({ ok: false, reason: "AMOUNT_MISMATCH" });
		const right = await settleOrder(h.settleDeps, h.stripeGw, confirmation(order, 1240, "evt-y"));
		expect(right.ok).toBe(true);
		expect((await h.orderStore.getById(order.id))?.state).toBe("paid");
	});

	test("the order email carries the rounding and shows it as a signed row", async () => {
		const order = await pendingOrder("KWD", 1234);
		const data = buildOrderEmailData(order, "paid");
		expect(data["roundingCents"]).toBe(-4);
		const rendered = renderEmail("order-confirmation", data, {
			// Integer string maths: a three-decimal amount, no float.
			formatMoney: (minor, code) =>
				`${code} ${String(Math.trunc(minor / 1000))}.${String(minor % 1000).padStart(3, "0")}`,
		});
		expect(rendered.text).toContain("Rounding: −KWD 0.004");
		expect(rendered.text).toContain("KWD 1.230");
	});

	test("a KWD total that is already a multiple of 0.010 carries rounding 0 and no email row", async () => {
		const order = await pendingOrder("KWD", 1230);
		expect(order.totals.total).toBe(1230);
		expect(order.totals.rounding).toBe(0);
		expect(Object.hasOwn(buildOrderEmailData(order, "paid"), "roundingCents")).toBe(false);
	});

	test("a USD order has no rounding anywhere: totals, intent, email data", async () => {
		const order = await pendingOrder("USD", 1234);
		expect(order.totals.total).toBe(1234);
		expect(Object.hasOwn(order.totals, "rounding")).toBe(false);
		expect(h.stripeGw.intentCalls.at(-1)?.amount).toBe(1234);
		expect(Object.hasOwn(buildOrderEmailData(order, "paid"), "roundingCents")).toBe(false);
	});
});
