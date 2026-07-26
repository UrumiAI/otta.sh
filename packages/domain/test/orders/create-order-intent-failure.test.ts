import {
	cents,
	createOrderFromCart,
	currency,
	expireOrders,
	idempotencyKey,
	PaymentIntentError,
	type CreateIntentInput,
	type PaymentIntentHandle,
} from "@urumi/domain";
import { FakePaymentGateway } from "@urumi/domain/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

const USD = currency("USD");

/**
 * A gateway whose `createIntent` can be scripted to throw — the domain-side
 * stand-in for a live Stripe `paymentIntents.create` that fails. Everything else
 * (verify / refund) is the ordinary fake.
 */
class ScriptedGateway extends FakePaymentGateway {
	/** Thrown by the NEXT `createIntent` when set (a `PaymentIntentError`, or any
	 *  other error to prove non-intent bugs are not swallowed). */
	failWith: unknown = null;
	calls = 0;

	override async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		this.calls++;
		if (this.failWith !== null) throw this.failWith;
		return super.createIntent(input);
	}
}

function intentError(retryable = true): PaymentIntentError {
	return new PaymentIntentError({
		gateway: "stripe",
		retryable,
		providerStatus: 503,
		providerCode: "api_error",
	});
}

function cmd(cartId: string, over: Record<string, unknown> = {}) {
	return {
		cartId,
		idempotencyKey: idempotencyKey("k-intent"),
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe" as const,
		...over,
	};
}

describe("createOrderFromCart — a live createIntent failure (PAYMENT_INTENT_FAILED)", () => {
	let h: OrderHarness;
	let gw: ScriptedGateway;

	beforeEach(async () => {
		h = makeOrderHarness();
		gw = new ScriptedGateway({ id: "stripe" });
		h.createDeps.gateways = { stripe: gw, x402: h.x402Gw };
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			onHand: 10,
		});
	});

	async function seedCoupon(): Promise<void> {
		await h.couponStore.create({
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 100,
			maxUsesPerCustomer: null,
		});
	}

	function cart(): Promise<string> {
		return h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
	}

	test("a PaymentIntentError returns ok:false PAYMENT_INTENT_FAILED and the pending order row still EXISTS (healed later by expireOrders)", async () => {
		const cartId = await cart();
		gw.failWith = intentError();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
		const order = await h.orderStore.getByIdempotencyKey(idempotencyKey("k-intent"));
		expect(order, "the pending order row stays — it carries holdExpiresAt").not.toBeNull();
		expect(order?.state).toBe("pending");
	});

	test("the mapped failure is LOGGED with providerStatus/providerCode — those fields are never write-only", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const cartId = await cart();
		gw.failWith = intentError(false);
		await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(error).toHaveBeenCalled();
		const logged = error.mock.calls.map((c) => JSON.stringify(c)).join(" ");
		expect(logged).toContain("503");
		expect(logged).toContain("api_error");
		error.mockRestore();
	});

	test("the coupon redemption is NOT released on PAYMENT_INTENT_FAILED — the inserted order owns it", async () => {
		await seedCoupon();
		const cartId = await cart();
		gw.failWith = intentError();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(res).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
		expect(h.couponStore.usesCount("cpn"), "the use stays consumed").toBe(1);
		expect(h.couponStore.redemptionCount("cpn")).toBe(1);
	});

	test("a same-key retry returns the ORIGINAL order with its discount intact, plus a fresh intent", async () => {
		await seedCoupon();
		const cartId = await cart();
		gw.failWith = intentError();
		const first = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(first.ok).toBe(false);

		gw.failWith = null; // Stripe recovers; the same key re-issues the SAME intent.
		const retry = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(retry.ok).toBe(true);
		if (!retry.ok) return;
		expect(retry.order.totals.discount).toBe(500);
		expect(retry.order.totals.total).toBe(500);
		expect(retry.intent.intentId).toBe(`fake_${retry.order.id}`);
		// Still exactly one redemption — the retry re-honored it, never double-redeemed.
		expect(h.couponStore.usesCount("cpn")).toBe(1);
		expect(h.couponStore.redemptionCount("cpn")).toBe(1);
	});

	test("an intent failure on the I1 REPLAY path also returns PAYMENT_INTENT_FAILED — no second order, no coupon movement", async () => {
		await seedCoupon();
		const cartId = await cart();
		const first = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(first.ok).toBe(true);

		gw.failWith = intentError();
		const replay = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(replay).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
		expect(await h.orderStore.countOrders({}), "no SECOND order was minted").toBe(1);
		expect(h.couponStore.usesCount("cpn")).toBe(1);
		expect(h.couponStore.redemptionCount("cpn")).toBe(1);
	});

	test("a NON-PaymentIntentError throw from createIntent still propagates (bugs are not swallowed)", async () => {
		const cartId = await cart();
		gw.failWith = new TypeError("undefined is not a function");
		await expect(createOrderFromCart(h.createDeps, cmd(cartId))).rejects.toThrow(TypeError);
	});

	test("a PRE-INSERT throw after a fresh redemption still RELEASES the coupon; no order was minted", async () => {
		await seedCoupon();
		const cartId = await cart();
		h.orderStore.createFromCart = () => {
			throw new Error("orders insert exploded");
		};
		await expect(
			createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" })),
		).rejects.toThrow(/exploded/);
		expect(h.couponStore.usesCount("cpn"), "released: no order owns the redemption").toBe(0);
		expect(h.couponStore.redemptionCount("cpn")).toBe(0);
	});

	test("a POST-INSERT non-intent throw (cartStore.checkout explodes) does NOT release the coupon — the inserted order owns it", async () => {
		await seedCoupon();
		const cartId = await cart();
		h.cartStore.checkout = () => {
			throw new Error("cart checkout exploded");
		};
		await expect(
			createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" })),
		).rejects.toThrow(/exploded/);
		const order = await h.orderStore.getByIdempotencyKey(idempotencyKey("k-intent"));
		expect(order, "the order row was inserted before the throw").not.toBeNull();
		expect(h.couponStore.usesCount("cpn"), "held by the inserted order").toBe(1);
		expect(h.couponStore.redemptionCount("cpn")).toBe(1);
	});

	test("expireOrders sweeps the stranded pending order, releasing BOTH the reservation and the coupon", async () => {
		await seedCoupon();
		const cartId = await cart();
		gw.failWith = intentError();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(res.ok).toBe(false);
		expect(await h.inventory.getOnHand("SKU-1"), "still held").toBe(9);

		h.clock.advance(16 * 60 * 1000); // past the 15-minute checkout TTL
		expect(await expireOrders(h.expireDeps)).toBe(1);
		expect(h.couponStore.usesCount("cpn"), "freed by the sweep").toBe(0);
		expect(await h.inventory.getOnHand("SKU-1"), "stock returned").toBe(10);
	});

	test("RESERVATION_LOST keeps its EAGER coupon release (the deliberate asymmetry with PAYMENT_INTENT_FAILED)", async () => {
		await seedCoupon();
		const cartId = await cart();
		const cartRow = await h.cartStore.get(cartId);
		// The sweep reaps the hold before adoption ⇒ RESERVATION_LOST.
		await h.inventory.release(cartRow!.lines[0]!.reservationId!);
		const res = await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }));
		expect(res).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		expect(h.couponStore.usesCount("cpn"), "eagerly released: recovery is a NEW cart + key").toBe(
			0,
		);
	});
});
