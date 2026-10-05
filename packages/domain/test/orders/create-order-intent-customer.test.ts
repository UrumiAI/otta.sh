import { beforeEach, describe, expect, test } from "vitest";
import { idempotencyKey } from "../../src/money/ids.js";
import {
	createOrderFromCart,
	type CreateOrderCommand,
} from "../../src/orders/create-order-from-cart.js";
import type {
	CreateIntentInput,
	PaymentGateway,
	PaymentIntentHandle,
} from "../../src/ports/payment-gateway.js";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

/**
 * Issue #382, review round 2: whether a payment named a provider-side customer
 * (Stripe: the India account's Customer) is decided ONCE per order — by the
 * gateway, on the order's first intent — and recorded with that intent. Every
 * replay and resume of the order hands the recorded decision back, so the
 * gateway re-decides nothing and its same-key request stays byte-identical. An
 * intent recorded without one (an older order, a gateway with no such notion)
 * hands back nothing, exactly as before.
 */
let h: OrderHarness;

/** A gateway that answers a scripted `customerRef` and records every input. */
function customerGateway(answer: () => string | null | undefined) {
	const inputs: CreateIntentInput[] = [];
	const gateway: PaymentGateway = {
		id: "stripe",
		refundable: false,
		async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
			inputs.push(input);
			const customerRef = input.customerRef !== undefined ? input.customerRef : answer();
			return {
				gateway: "stripe",
				intentId: `pi_${input.orderId}`,
				clientAction: { kind: "stripe_client_secret", clientSecret: "secret" },
				...(customerRef !== undefined ? { customerRef } : {}),
			};
		},
		verifyConfirmation: () => Promise.reject(new Error("unused")),
		refund: () => Promise.reject(new Error("unused")),
		cancelIntent: () => Promise.reject(new Error("unused")),
	};
	return { gateway, inputs };
}

beforeEach(() => {
	h = makeOrderHarness();
});

async function digitalCart(): Promise<string> {
	await h.seedDigital({ productId: "d1", sku: "EBOOK", priceCents: 1500, title: "Ebook" });
	return h.cartWith([{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);
}

function cmd(cartId: string): CreateOrderCommand {
	return {
		cartId,
		idempotencyKey: idempotencyKey(`checkout:${cartId}`),
		buyerRef: "asha@example.com",
		paymentMethod: "stripe",
	};
}

describe("the order's customer decision is recorded with its first intent and replayed", () => {
	test("the first intent decides; it is recorded; a replay hands the recorded customer back", async () => {
		const { gateway, inputs } = customerGateway(() => "cus_1");
		const deps = { ...h.createDeps, gateways: { stripe: gateway } };
		const cartId = await digitalCart();
		const first = await createOrderFromCart(deps, cmd(cartId));
		if (!first.ok) throw new Error(first.reason);
		expect(inputs[0]?.customerRef).toBeUndefined();
		const recorded = await h.createDeps.orderStore.listPaymentIntents(first.order.id);
		expect(recorded.map((r) => r.customerRef)).toEqual(["cus_1"]);

		const replay = await createOrderFromCart(deps, cmd(cartId));
		expect(replay.ok && replay.order.id).toBe(first.order.id);
		expect(inputs[1]?.customerRef).toBe("cus_1");
	});

	test("a recorded 'no customer' (null) is handed back as null — the gateway must not decide again", async () => {
		const { gateway, inputs } = customerGateway(() => null);
		const deps = { ...h.createDeps, gateways: { stripe: gateway } };
		const cartId = await digitalCart();
		await createOrderFromCart(deps, cmd(cartId));
		await createOrderFromCart(deps, cmd(cartId));
		expect(inputs[1]?.customerRef).toBeNull();
	});

	test("an intent recorded with NO decision (older orders, other gateways) hands back nothing — as before", async () => {
		const { gateway, inputs } = customerGateway(() => undefined);
		const deps = { ...h.createDeps, gateways: { stripe: gateway } };
		const cartId = await digitalCart();
		const first = await createOrderFromCart(deps, cmd(cartId));
		if (!first.ok) throw new Error(first.reason);
		const recorded = await h.createDeps.orderStore.listPaymentIntents(first.order.id);
		expect(recorded[0]).not.toHaveProperty("customerRef");
		await createOrderFromCart(deps, cmd(cartId));
		expect(inputs[1]).not.toHaveProperty("customerRef");
	});
});
