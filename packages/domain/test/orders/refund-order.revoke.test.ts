import {
	cents,
	createOrderFromCart,
	type EntitlementStore,
	idempotencyKey,
	type Order,
	type OrderId,
	refundOrder,
	type RefundOrderDeps,
	settleOrder,
	sku as brandSku,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness, USD } from "./fake-harness.js";

const SKU = brandSku("DIG-1");
const BUYER = "buyer@example.com";

/**
 * A FULL refund revokes the order's download access; a partial one does not
 * (issue #376, product-owner decision). "Full" is the domain's own definition:
 * the order reached `refunded`, which the ledger flips exactly when the FINALIZED
 * refunds reach the ceiling `min(Σ captured, total)`.
 */
describe("refundOrder revokes the order's entitlements on a FULL refund", () => {
	let h: OrderHarness;
	let deps: RefundOrderDeps;
	beforeEach(() => {
		h = makeOrderHarness();
		deps = {
			orderStore: h.orderStore,
			entitlementStore: h.entitlementStore,
			paymentEventStore: h.paymentEventStore,
			clock: h.clock,
		};
	});

	/** A digital order paid through `gw`, settled — so its entitlement is granted. */
	async function paidDigital(
		key: string,
		gw: FakePaymentGateway = h.stripeGw,
		priceCents = 900,
	): Promise<Order> {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: BUYER,
			paymentMethod: gw.id,
		});
		if (!res.ok) throw new Error(`seed digital order failed: ${res.reason}`);
		const settled = await settleOrder(
			h.settleDeps,
			gw,
			gw.webhook({
				outcome: "succeeded",
				orderId: res.order.id,
				providerRef: `pi_${key}`,
				amount: res.order.totals.total,
				currency: "USD",
				dedupeKey: `evt-${key}`,
			}),
		);
		if (!settled.ok) throw new Error(`settle failed: ${settled.reason}`);
		expect(await entitled(res.order.id)).toBe(true);
		return res.order;
	}

	function entitled(orderId: OrderId): Promise<boolean> {
		return h.entitlementStore.check({ orderId, sku: SKU });
	}

	function refund(
		order: Order,
		amount: number,
		key: string,
		gw: FakePaymentGateway = h.stripeGw,
		over: Partial<RefundOrderDeps> = {},
	) {
		return refundOrder({ ...deps, ...over }, gw, {
			orderId: order.id,
			amount: cents(amount),
			currency: USD,
			refundedBy: "admin",
			idempotencyKey: idempotencyKey(key),
		});
	}

	test("a full gateway refund flips the order to refunded and revokes its entitlement", async () => {
		const order = await paidDigital("o1");
		const res = await refund(order, order.totals.total, "r1");
		expect(res.ok && res.fullyRefunded).toBe(true);
		expect(await entitled(order.id)).toBe(false);
		expect(await h.entitlementStore.check({ buyerRef: BUYER, sku: SKU })).toBe(false);
	});

	test("a partial refund keeps the entitlement; the refund that completes the ceiling revokes it", async () => {
		const order = await paidDigital("o1");
		const first = await refund(order, 300, "r1");
		expect(first.ok && !first.fullyRefunded).toBe(true);
		expect(await entitled(order.id)).toBe(true);

		const rest = await refund(order, order.totals.total - 300, "r2");
		expect(rest.ok && rest.fullyRefunded).toBe(true);
		expect(await entitled(order.id)).toBe(false);
	});

	test("a full MANUAL refund (a non-refundable gateway records it) revokes too", async () => {
		const order = await paidDigital("o1", h.x402Gw);
		const res = await refund(order, order.totals.total, "r1", h.x402Gw);
		expect(res.ok && res.fullyRefunded).toBe(true);
		expect(await entitled(order.id)).toBe(false);
	});

	test("a same-key replay of the full refund has no double effect", async () => {
		const order = await paidDigital("o1");
		await refund(order, order.totals.total, "r1");
		const replay = await refund(order, order.totals.total, "r1");
		expect(replay.ok && replay.duplicate && replay.fullyRefunded).toBe(true);
		// One provider call, one ledger row, still revoked — and nothing re-granted.
		expect(h.stripeGw.refundCalls).toHaveLength(1);
		expect(await h.orderStore.listRefunds(order.id)).toHaveLength(1);
		expect(h.entitlementStore.all().map((e) => e.state)).toEqual(["revoked"]);
	});

	// The crash window: the refund is finalized (money returned, order `refunded`)
	// and the process dies before the revocation lands. The same-key retry takes the
	// ledger's `recorded` replay branch — no second provider call — and that branch
	// revokes too, so the retry is what finishes the revocation.
	test("a crash between the finalized refund and the revocation is healed by the same-key retry", async () => {
		const order = await paidDigital("o1");
		const crashing: EntitlementStore = {
			grant: (input) => h.entitlementStore.grant(input),
			check: (query) => h.entitlementStore.check(query),
			revokeByOrder: () => Promise.reject(new Error("crash after finalize")),
		};
		await expect(
			refund(order, order.totals.total, "r1", h.stripeGw, { entitlementStore: crashing }),
		).rejects.toThrow("crash after finalize");
		expect((await h.orderStore.getById(order.id))?.state).toBe("refunded");
		expect(await entitled(order.id)).toBe(true); // the window this test is about

		const retry = await refund(order, order.totals.total, "r1");
		expect(retry.ok && retry.duplicate).toBe(true);
		expect(h.stripeGw.refundCalls).toHaveLength(1);
		expect(await entitled(order.id)).toBe(false);
	});

	test("a refund the provider rejects revokes nothing", async () => {
		const order = await paidDigital("o1");
		h.stripeGw.setRefundResult({ ok: false, reason: "TERMINAL" });
		const res = await refund(order, order.totals.total, "r1");
		expect(res.ok).toBe(false);
		expect(await entitled(order.id)).toBe(true);
	});

	test("only the refunded order is revoked — the buyer's other order keeps the sku", async () => {
		const refunded = await paidDigital("o1");
		const kept = await paidDigital("o2");
		await refund(refunded, refunded.totals.total, "r1");
		expect(await entitled(refunded.id)).toBe(false);
		expect(await entitled(kept.id)).toBe(true);
		expect(await h.entitlementStore.check({ buyerRef: BUYER, sku: SKU })).toBe(true);
	});

	// A settlement redelivered after the refund cannot re-open access: settle only
	// re-drives side-effects on a `paid` order, and grant-once returns the revoked
	// grant in any case.
	test("a settlement redelivered after the full refund does not re-grant", async () => {
		const order = await paidDigital("o1");
		await refund(order, order.totals.total, "r1");
		await settleOrder(
			h.settleDeps,
			h.stripeGw,
			h.stripeGw.webhook({
				outcome: "succeeded",
				orderId: order.id,
				providerRef: "pi_o1",
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: "evt-o1",
			}),
		);
		expect(await entitled(order.id)).toBe(false);
	});
});
