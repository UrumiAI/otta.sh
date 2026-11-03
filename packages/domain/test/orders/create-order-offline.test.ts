import {
	createOrderFromCart,
	dispatchOrderEmails,
	idempotencyKey,
	renderEmail,
	type CreateOrderCommand,
	type PaymentGateway,
} from "@urumi.ai/otta-domain";
import { FakeEmailSender } from "@urumi.ai/otta-domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

/**
 * ADR-0044: a checkout with an OFFLINE method (cash on delivery).
 *
 *  - Placed: `awaiting_payment` (not pending: it never expires), no intent
 *    recorded, ONE "order received, pay on delivery" email however often the
 *    checkout replays.
 *  - Refused before anything is minted: not offered (the toggle, or no client
 *    key), a cart with nothing to deliver, no address, no phone, the open-order
 *    caps.
 *  - A same-key replay returns its order even after the toggle went off.
 *
 * The gateway is a stand-in with the COD adapter's answers; the adapter itself
 * runs `offlinePaymentGatewayContract`.
 */
const offlineGateway: PaymentGateway = {
	id: "cod",
	refundable: false,
	createIntent: async () => ({ gateway: "cod", intentId: "", clientAction: { kind: "offline" } }),
	verifyConfirmation: async () => ({ ok: false, reason: "UNKNOWN_EVENT" }),
	refund: async () => ({ ok: false, reason: "UNSUPPORTED" }),
	cancelIntent: async () => ({ ok: false, reason: "UNSUPPORTED" }),
};

const ADDRESS = {
	name: "Asha Rao",
	line1: "12 MG Road",
	city: "Pune",
	postalCode: "411001",
	country: "IN",
	phone: "+91 98765 43210",
};

const ON = { enabled: true, clientKey: "net-1", maxOpenPerBuyer: 3, maxOpenPerClient: 3 };

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
			onHand: 50,
		});
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 500, title: "Pattern PDF" });
	});

	function place(cartId: string, over: Partial<CreateOrderCommand> = {}) {
		return createOrderFromCart(
			{ ...h.createDeps, gateways: { ...h.createDeps.gateways, cod: offlineGateway } },
			{
				cartId,
				idempotencyKey: idempotencyKey(`checkout:${cartId}`),
				buyerRef: "cash-buyer@example.com",
				paymentMethod: "cod",
				shippingAddress: ADDRESS,
				offline: ON,
				...over,
			},
		);
	}

	const physicalCart = () =>
		h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);

	test("places an awaiting_payment order with no intent and no Stripe call", async () => {
		const res = await place(await physicalCart());
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.state).toBe("awaiting_payment");
		expect(res.order.paymentMethod).toBe("cod");
		expect(res.intent).toEqual({ gateway: "cod", intentId: "", clientAction: { kind: "offline" } });
		expect(await h.orderStore.listPaymentIntents(res.order.id)).toEqual([]);
		expect(h.stripeGw.intentCalls).toHaveLength(0);
		expect(await h.orderStore.listExpirable("2999-01-01T00:00:00.000Z")).toEqual([]);
	});

	test("one 'order received, pay on delivery' email, stating the amount due, however often it replays", async () => {
		const cartId = await physicalCart();
		const first = await place(cartId);
		const replay = await place(cartId);
		expect(first.ok && replay.ok).toBe(true);
		if (!first.ok || !replay.ok) return;
		expect(replay.order.id).toBe(first.order.id);

		const emailSender = new FakeEmailSender();
		expect(
			await dispatchOrderEmails({ orderStore: h.orderStore, emailSender, clock: h.clock }),
		).toBe(1);
		expect(emailSender.countByTemplate("order-placed-offline", first.order.id)).toBe(1);
		const data = emailSender.sends[0]?.data ?? {};
		expect(data["settlement"]).toBe("offline");
		const rendered = renderEmail("order-placed-offline", data, { formatMoney: money });
		expect(rendered.subject).toMatch(/^Order received /);
		expect(rendered.text).toContain("You'll pay in cash when it's delivered");
		expect(rendered.text).toContain("[USD 2500]");
		expect(rendered.text).not.toContain("Refunded");
	});

	test("a replay whose first reply was lost returns the order even after cash on delivery was switched off", async () => {
		const cartId = await physicalCart();
		const first = await place(cartId);
		expect(first.ok).toBe(true);
		const replay = await place(cartId, { offline: { enabled: false } });
		expect(replay).toMatchObject({ ok: true, order: { state: "awaiting_payment" } });
	});

	test.each([
		[
			"switched off",
			{ offline: { enabled: false, clientKey: "net-1" } },
			"PAYMENT_METHOD_UNAVAILABLE",
		],
		[
			"no client key (no per-IP limit)",
			{ offline: { enabled: true } },
			"PAYMENT_METHOD_UNAVAILABLE",
		],
		["no address", { shippingAddress: undefined }, "MISSING_SHIPPING_ADDRESS"],
		["no phone", { shippingAddress: { ...ADDRESS, phone: "  " } }, "SHIPPING_PHONE_REQUIRED"],
	] as const)("refused when %s, minting nothing", async (_name, over, reason) => {
		const cartId = await physicalCart();
		const res = await place(cartId, over as Partial<CreateOrderCommand>);
		expect(res).toEqual({ ok: false, reason });
		expect(await h.orderStore.getByIdempotencyKey(idempotencyKey(`checkout:${cartId}`))).toBeNull();
	});

	test("a download-only cart is refused: nothing to deliver, nothing to pay on delivery", async () => {
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		expect(await place(cartId)).toEqual({ ok: false, reason: "OFFLINE_NEEDS_PHYSICAL" });
	});

	test("the caps: a buyer, or a network, with the maximum open cod orders is refused", async () => {
		for (let i = 0; i < 2; i++) {
			expect(
				(await place(await physicalCart(), { offline: { ...ON, maxOpenPerBuyer: 2 } })).ok,
			).toBe(true);
		}
		expect(await place(await physicalCart(), { offline: { ...ON, maxOpenPerBuyer: 2 } })).toEqual({
			ok: false,
			reason: "OFFLINE_ORDER_LIMIT",
		});
		// Another buyer on the same network: the network's cap.
		expect(
			await place(await physicalCart(), {
				buyerRef: "someone-else@example.com",
				offline: { ...ON, maxOpenPerClient: 2 },
			}),
		).toEqual({ ok: false, reason: "OFFLINE_ORDER_LIMIT" });
		// The same buyer elsewhere with no buyer cap: placed.
		expect(
			(
				await place(await physicalCart(), {
					offline: { ...ON, clientKey: "net-2", maxOpenPerBuyer: 0 },
				})
			).ok,
		).toBe(true);
	});

	test("a card checkout in the same store enqueues no such email and is not parked unpaid", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(`checkout:${cartId}`),
			buyerRef: "card-buyer@example.com",
			paymentMethod: "stripe",
		});
		expect(res).toMatchObject({ ok: true, order: { state: "pending" } });
		const emailSender = new FakeEmailSender();
		expect(
			await dispatchOrderEmails({ orderStore: h.orderStore, emailSender, clock: h.clock }),
		).toBe(0);
	});
});
