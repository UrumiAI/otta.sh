import { beforeEach, describe, expect, test, vi } from "vitest";
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

/** `target` with some methods replaced; every other member is the real one,
 *  bound to the real object (the fake's private fields stay reachable). */
function overriding<T extends object>(target: T, over: Partial<T>): T {
	return new Proxy(target, {
		get(t, key) {
			if (key in over) return over[key as keyof T];
			const value: unknown = Reflect.get(t, key, t);
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
		},
	});
}

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

describe("the ORDER decides whether its payment carries a customer (review round 3)", () => {
	const ADDRESS = {
		name: "Asha Rao",
		line1: "12 Park Street",
		city: "Kolkata",
		postalCode: "700016",
		country: "IN",
	};

	test("the requirement is frozen on the order in the creating insert — true, or an explicit false", async () => {
		const { gateway } = customerGateway(() => null);
		const deps = { ...h.createDeps, gateways: { stripe: gateway } };
		const required = await createOrderFromCart(deps, {
			...cmd(await digitalCart()),
			addressRequired: true,
			shippingAddress: ADDRESS,
		});
		const h2 = makeOrderHarness();
		await h2.seedDigital({ productId: "d1", sku: "EBOOK", priceCents: 1500, title: "Ebook" });
		const cart2 = await h2.cartWith([{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);
		const notRequired = await createOrderFromCart(
			{ ...h2.createDeps, gateways: { stripe: gateway } },
			cmd(cart2),
		);
		expect(required.ok && required.order.buyerAddressRequired).toBe(true);
		expect(notRequired.ok && notRequired.order.buyerAddressRequired).toBe(false);
	});

	test("customerRequired = placed under the requirement AND holding an address — the same on the first intent and every replay", async () => {
		const { gateway, inputs } = customerGateway(() => "cus_1");
		const deps = { ...h.createDeps, gateways: { stripe: gateway } };
		const cartId = await digitalCart();
		const command = { ...cmd(cartId), addressRequired: true, shippingAddress: ADDRESS };
		await createOrderFromCart(deps, command);
		await createOrderFromCart(deps, cmd(cartId)); // the locked review's retry: no flag, no address
		expect(inputs.map((i) => i.customerRequired)).toEqual([true, true]);
	});

	test("not placed under the requirement ⇒ false on every intent, even with an address", async () => {
		const { gateway, inputs } = customerGateway(() => null);
		const deps = { ...h.createDeps, gateways: { stripe: gateway } };
		const cartId = await digitalCart();
		await createOrderFromCart(deps, { ...cmd(cartId), shippingAddress: ADDRESS });
		// A replay whose caller would now require it changes nothing: the order decided.
		await createOrderFromCart(deps, { ...cmd(cartId), addressRequired: true });
		expect(inputs.map((i) => i.customerRequired)).toEqual([false, false]);
	});

	test("the intent record's write is lost: the replay still gets the order's decision", async () => {
		const { gateway, inputs } = customerGateway(() => "cus_1");
		const store = h.createDeps.orderStore;
		const failingStore = overriding(store, {
			recordPaymentIntent: () => Promise.reject(new Error("write lost")),
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = { ...h.createDeps, orderStore: failingStore, gateways: { stripe: gateway } };
		const cartId = await digitalCart();
		await createOrderFromCart(deps, {
			...cmd(cartId),
			addressRequired: true,
			shippingAddress: ADDRESS,
		});
		await createOrderFromCart(deps, cmd(cartId));
		expect(errors).toHaveBeenCalled();
		// Nothing recorded, so no `customerRef` — but the yes/no is the order's.
		expect(inputs[1]).not.toHaveProperty("customerRef");
		expect(inputs.map((i) => i.customerRequired)).toEqual([true, true]);
		errors.mockRestore();
	});

	test("an order created before the snapshot existed carries none: the gateway decides, as before", async () => {
		const { gateway, inputs } = customerGateway(() => null);
		const store = h.createDeps.orderStore;
		const legacyStore = overriding(store, {
			getByIdempotencyKey: async (key) => {
				const order = await store.getByIdempotencyKey(key);
				if (order === null) return null;
				const { buyerAddressRequired: _dropped, ...legacy } = order;
				return legacy;
			},
		});
		const cartId = await digitalCart();
		await createOrderFromCart({ ...h.createDeps, gateways: { stripe: gateway } }, cmd(cartId));
		await createOrderFromCart(
			{ ...h.createDeps, orderStore: legacyStore, gateways: { stripe: gateway } },
			cmd(cartId),
		);
		expect(inputs[1]).not.toHaveProperty("customerRequired");
	});

	test("a failed read of the recorded decision on a replay THROWS — it is never read as 'none'", async () => {
		const { gateway, inputs } = customerGateway(() => "cus_1");
		const cartId = await digitalCart();
		await createOrderFromCart({ ...h.createDeps, gateways: { stripe: gateway } }, cmd(cartId));
		const store = h.createDeps.orderStore;
		const failingStore = overriding(store, {
			listPaymentIntents: () => Promise.reject(new Error("read failed")),
		});
		await expect(
			createOrderFromCart(
				{ ...h.createDeps, orderStore: failingStore, gateways: { stripe: gateway } },
				cmd(cartId),
			),
		).rejects.toThrow("read failed");
		expect(inputs).toHaveLength(1);
	});
});
