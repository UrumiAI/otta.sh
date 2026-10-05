/**
 * `storefront/order/resume` — the order page's way back to an unpaid order on
 * any device (QA U-2). The client is stubbed HERE only to observe what the
 * route asks and what it lets out; what `resumeOrderPayment` itself does (the
 * order's own key, the same intent, refusing a lapsed or settled order) is the
 * commerce-client contract's, run over a real store.
 *
 * What the route must hold:
 *  - the order id is the WHOLE credential — the same capability the public order
 *    read takes, and nothing else is read from the input;
 *  - the reply is PROJECTED: the order id, the client action, the formatted
 *    total and the masked email hint — never the buyer reference, the ship-to or
 *    the intent id;
 *  - an id that cannot name an order is ORDER_NOT_FOUND without a client call.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const resumeOrderPayment = vi.fn();
vi.mock("../src/commerce/make-commerce-client.js", () => ({
	makeCommerceClient: async () => ({ resumeOrderPayment }),
}));

const { createOrderResumeRouteHandler, STOREFRONT_ORDER_RESUME_ROUTE } =
	await import("../src/storefront/checkout-routes.js");

async function resume(input: Record<string, unknown>): Promise<unknown> {
	return createOrderResumeRouteHandler()(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		{} as never,
	);
}

const ORDER_ID = "6f1c2a64-0d1e-4c55-9d7e-2f1a3b4c5d6e";

const PENDING_ORDER = {
	id: ORDER_ID,
	state: "pending",
	currency: "USD",
	paymentMethod: "stripe",
	holdExpiresAt: "2026-10-02T12:15:00.000Z",
	createdAt: "2026-10-02T12:00:00.000Z",
	totals: {
		currency: "USD",
		subtotalCents: 4000,
		discountCents: 0,
		shippingCents: 0,
		taxCents: 0,
		totalCents: 4000,
		appliedCouponCode: null,
		shippingZoneId: null,
		shippingMethodId: null,
	},
	lines: [],
	fulfillment: null,
	cancellation: null,
	latePayment: "none",
};

beforeEach(() => {
	resumeOrderPayment.mockReset();
});

describe("storefront/order/resume", () => {
	test("is its own public route name", () => {
		expect(STOREFRONT_ORDER_RESUME_ROUTE).toBe("storefront/order/resume");
	});

	test("hands back ONLY the order id, the client action, the total and the email hint", async () => {
		resumeOrderPayment.mockResolvedValue({
			ok: true,
			order: PENDING_ORDER,
			intent: {
				gateway: "stripe",
				intentId: "pi_123",
				clientAction: { kind: "stripe_client_secret", clientSecret: "pi_123_secret_abc" },
			},
			buyerRefHint: "b•••@e•••.com",
		});

		const result = await resume({ orderId: ORDER_ID });

		expect(resumeOrderPayment).toHaveBeenCalledWith(ORDER_ID, {});
		expect(result).toEqual({
			ok: true,
			orderId: ORDER_ID,
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_123_secret_abc" },
			total: { amount: 4000, currency: "USD", formatted: "$40.00" },
			buyerRefHint: "b•••@e•••.com",
		});
		expect(JSON.stringify(result)).not.toContain('pi_123"');
	});

	test("forwards the order id and the PROOF (cart, session, email) — nothing else", async () => {
		resumeOrderPayment.mockResolvedValue({ ok: false, reason: "PROOF_REQUIRED" });
		await resume({
			orderId: ORDER_ID,
			cartId: "cart-x",
			sessionToken: "sess-1",
			email: "a@b.co",
			idempotencyKey: "checkout:cart-y",
			buyerRef: "attacker@example.com",
		});
		expect(resumeOrderPayment.mock.calls[0]).toEqual([
			ORDER_ID,
			{ cartId: "cart-x", sessionToken: "sess-1", email: "a@b.co" },
		]);
	});

	test("no proof is forwarded as none; blank or non-string proof is dropped", async () => {
		resumeOrderPayment.mockResolvedValue({ ok: false, reason: "PROOF_REQUIRED" });
		await resume({ orderId: ORDER_ID, cartId: "  ", sessionToken: 7, email: "" });
		expect(resumeOrderPayment.mock.calls[0]).toEqual([ORDER_ID, {}]);
	});

	test("an over-long email is EMAIL_MISMATCH without a client call", async () => {
		expect(await resume({ orderId: ORDER_ID, email: `${"a".repeat(400)}@b.co` })).toEqual({
			ok: false,
			reason: "EMAIL_MISMATCH",
		});
		expect(resumeOrderPayment).not.toHaveBeenCalled();
	});

	test.each([[""], ["   "], ["has space"], ["x".repeat(300)]])(
		"an id that cannot name an order (%p) is ORDER_NOT_FOUND without a client call",
		async (orderId) => {
			expect(await resume({ orderId })).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
			expect(resumeOrderPayment).not.toHaveBeenCalled();
		},
	);

	test("a non-string id is a malformed call", async () => {
		expect(await resume({ orderId: 42 })).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(resumeOrderPayment).not.toHaveBeenCalled();
	});

	test.each([
		["ORDER_NOT_FOUND"],
		["ORDER_NOT_PAYABLE"],
		["PAYMENT_INTENT_FAILED"],
		["PROOF_REQUIRED"],
		["EMAIL_MISMATCH"],
		["THROTTLED"],
	])("a refusal (%s) passes through as its reason", async (reason) => {
		resumeOrderPayment.mockResolvedValue({ ok: false, reason });
		expect(await resume({ orderId: ORDER_ID })).toEqual({ ok: false, reason });
	});

	test("an intent already in flight is BUSY and retryable, like the place route's", async () => {
		resumeOrderPayment.mockResolvedValue({ ok: false, reason: "PAYMENT_INTENT_IN_FLIGHT" });
		expect(await resume({ orderId: ORDER_ID })).toEqual({
			ok: false,
			error: "BUSY",
			retryable: true,
		});
	});

	test("a reply that carries no client secret is not payable here", async () => {
		resumeOrderPayment.mockResolvedValue({
			ok: true,
			order: PENDING_ORDER,
			intent: { gateway: "stripe", intentId: "", clientAction: { kind: "none" } },
			buyerRefHint: "b•••@e•••.com",
		});
		expect(await resume({ orderId: ORDER_ID })).toEqual({
			ok: false,
			reason: "ORDER_NOT_PAYABLE",
		});
	});
});
