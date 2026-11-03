import {
	createOrderFromCart,
	dispatchOrderEmails,
	idempotencyKey,
	OFFLINE_HOLD_EXPIRES_AT,
	renderEmail,
	type PaymentGateway,
} from "@urumi.ai/otta-domain";
import { FakeEmailSender } from "@urumi.ai/otta-domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

/**
 * ADR-0042: a checkout with an OFFLINE method (cash on delivery). The order is
 * placed `pending` with the offline hold deadline, so it never expires, and with
 * no intent recorded, so no sweep withdraws one. The buyer gets ONE
 * "order received, pay on delivery" email, which states the amount due and no
 * "Refunded" line, however often the checkout is replayed.
 *
 * The gateway here is a stand-in with the COD adapter's answers. The adapter
 * itself (`@urumi.ai/otta-payments-cod`) runs `offlinePaymentGatewayContract`.
 */
const offlineGateway: PaymentGateway = {
	id: "cod",
	refundable: false,
	createIntent: async () => ({ gateway: "cod", intentId: "", clientAction: { kind: "offline" } }),
	verifyConfirmation: async () => ({ ok: false, reason: "UNKNOWN_EVENT" }),
	refund: async () => ({ ok: false, reason: "UNSUPPORTED" }),
	cancelIntent: async () => ({ ok: false, reason: "UNSUPPORTED" }),
};

const money = (minor: number, code: string): string => `[${code} ${String(minor)}]`;

describe("createOrderFromCart — an offline (cash-on-delivery) checkout", () => {
	let h: OrderHarness;

	beforeEach(async () => {
		h = makeOrderHarness();
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1250,
			title: "Clay Pot",
			onHand: 5,
		});
	});

	function place(cartId: string) {
		return createOrderFromCart(
			{ ...h.createDeps, gateways: { ...h.createDeps.gateways, cod: offlineGateway } },
			{
				cartId,
				idempotencyKey: idempotencyKey(`checkout:${cartId}`),
				buyerRef: "cash-buyer@example.com",
				paymentMethod: "cod",
			},
		);
	}

	test("places a pending order that never expires, holding its stock, with no intent and no Stripe call", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await place(cartId);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.state).toBe("pending");
		expect(res.order.paymentMethod).toBe("cod");
		expect(res.order.holdExpiresAt).toBe(OFFLINE_HOLD_EXPIRES_AT);
		expect(res.intent).toEqual({ gateway: "cod", intentId: "", clientAction: { kind: "offline" } });
		expect(await h.orderStore.listPaymentIntents(res.order.id)).toEqual([]);
		expect(h.stripeGw.intentCalls).toHaveLength(0);
		expect(await h.orderStore.listExpirable("9999-01-01T00:00:00.000Z")).toEqual([]);
	});

	test("one 'order received, pay on delivery' email, stating the amount due, however often the checkout replays", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const first = await place(cartId);
		const replay = await place(cartId);
		expect(first.ok && replay.ok).toBe(true);
		if (!first.ok) return;

		const emailSender = new FakeEmailSender();
		const sent = await dispatchOrderEmails({
			orderStore: h.orderStore,
			emailSender,
			clock: h.clock,
		});
		expect(sent).toBe(1);
		expect(emailSender.countByTemplate("order-placed-offline", first.order.id)).toBe(1);
		const data = emailSender.sends[0]?.data ?? {};
		// Money still DUE, not returned: no notice amount, so no "Refunded" line.
		expect(data).not.toHaveProperty("noticeAmountCents");
		expect(data["totalCents"]).toBe(2500);

		const rendered = renderEmail("order-placed-offline", data, { formatMoney: money });
		expect(rendered.subject).toMatch(/^Order received /);
		expect(rendered.text).toContain("You'll pay in cash when it's delivered");
		expect(rendered.text).toContain("[USD 2500]");
		expect(rendered.text).not.toContain("Refunded");
	});

	test("a card checkout in the same store enqueues no such email", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(`checkout:${cartId}`),
			buyerRef: "card-buyer@example.com",
			paymentMethod: "stripe",
		});
		expect(res.ok).toBe(true);
		const emailSender = new FakeEmailSender();
		expect(
			await dispatchOrderEmails({ orderStore: h.orderStore, emailSender, clock: h.clock }),
		).toBe(0);
	});
});
