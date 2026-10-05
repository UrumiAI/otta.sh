import {
	cancelOrderWithRefund,
	cents,
	createOrderFromCart,
	type EntitlementStore,
	expireOrders,
	idempotencyKey,
	type Order,
	type OrderId,
	refundOrder,
	resolveUnverifiedRefund,
	settleOrder,
	sku as brandSku,
	transitionOrderAsAdmin,
} from "@otta-sh/domain";
import type { FakePaymentGateway } from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness, USD } from "./fake-harness.js";

const SKU = brandSku("DIG-1");
const BUYER = "buyer@example.com";

/**
 * EVERY path by which an order ends with its money fully returned revokes the
 * order's download access (issue #376, product-owner decision) — not only
 * `refundOrder`, which `refund-order.revoke.test.ts` covers:
 *  - Mark refunded (`transitionOrderAsAdmin` → `refunded`);
 *  - confirming an unverified refund (`resolveUnverifiedRefund`) that completes it;
 *  - cancelling a PAID order with its refund (`cancelOrderWithRefund`), which always
 *    returns everything still refundable;
 *  - and a late payment on a dead order, which can never have had a grant.
 * Per path: full → revoked; partial or no money → untouched; replay → no double effect.
 */
describe("every full-refund path revokes download access", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	async function pendingDigital(key: string, gw: FakePaymentGateway): Promise<Order> {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: BUYER,
			paymentMethod: gw.id,
		});
		if (!res.ok) throw new Error(`seed digital order failed: ${res.reason}`);
		return res.order;
	}

	function pay(order: Order, gw: FakePaymentGateway, key: string) {
		return settleOrder(
			h.settleDeps,
			gw,
			gw.webhook({
				outcome: "succeeded",
				orderId: order.id,
				providerRef: `pi_${key}`,
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: `evt-${key}`,
			}),
		);
	}

	async function paidDigital(key: string, gw: FakePaymentGateway = h.stripeGw): Promise<Order> {
		const order = await pendingDigital(key, gw);
		const settled = await pay(order, gw, key);
		if (!settled.ok) throw new Error(`settle failed: ${settled.reason}`);
		expect(await entitled(order.id)).toBe(true);
		return order;
	}

	function entitled(orderId: OrderId): Promise<boolean> {
		return h.entitlementStore.check({ orderId, sku: SKU });
	}

	function states(): string[] {
		return h.entitlementStore.all().map((e) => e.state);
	}

	/** An entitlement store whose revoke fails the first `n` times — the crash
	 *  between a recorded money/state change and its revocation. */
	function failingFirst(n: number): EntitlementStore {
		let left = n;
		return {
			grant: (input) => h.entitlementStore.grant(input),
			check: (query) => h.entitlementStore.check(query),
			revokeByOrder: (id) => {
				if (left > 0) {
					left -= 1;
					return Promise.reject(new Error("crash before revoke"));
				}
				return h.entitlementStore.revokeByOrder(id);
			},
		};
	}

	// -- Mark refunded -----------------------------------------------------------
	//
	// A manual Mark refunded records money returned OUTSIDE Otta, and is allowed only
	// when nothing is left for the provider to return (x402's money always goes back
	// outside Otta). It closes the order `refunded` — a full refund by definition.

	describe("Mark refunded", () => {
		function mark(order: Order, key: string, store: EntitlementStore = h.entitlementStore) {
			return transitionOrderAsAdmin(
				{ orderStore: h.orderStore, entitlementStore: store },
				{ orderId: order.id, toState: "refunded", idempotencyKey: idempotencyKey(key) },
			);
		}

		test("marking an order refunded revokes its entitlement", async () => {
			const order = await paidDigital("o1", h.x402Gw);
			const res = await mark(order, "m1");
			expect(res.ok && res.order.state).toBe("refunded");
			expect(await entitled(order.id)).toBe(false);
		});

		test("a replay of Mark refunded has no double effect", async () => {
			const order = await paidDigital("o1", h.x402Gw);
			await mark(order, "m1");
			const replay = await mark(order, "m1");
			expect(replay.ok && !replay.transitioned).toBe(true);
			expect(states()).toEqual(["revoked"]);
		});

		test("a crash after the flip, before the revoke, is healed by the replay", async () => {
			const order = await paidDigital("o1", h.x402Gw);
			await expect(mark(order, "m1", failingFirst(1))).rejects.toThrow("crash before revoke");
			expect((await h.orderStore.getById(order.id))?.state).toBe("refunded");
			expect(await entitled(order.id)).toBe(true);
			await mark(order, "m1");
			expect(await entitled(order.id)).toBe(false);
		});

		test("a move that is not to refunded, and a refused Mark refunded, leave it entitled", async () => {
			const x402 = await paidDigital("o1", h.x402Gw);
			const moved = await transitionOrderAsAdmin(
				{ orderStore: h.orderStore, entitlementStore: h.entitlementStore },
				{ orderId: x402.id, toState: "processing", idempotencyKey: idempotencyKey("p1") },
			);
			expect(moved.ok).toBe(true);
			expect(await entitled(x402.id)).toBe(true);

			// A card order whose money the provider still holds: Money → Refunds, not this.
			const card = await paidDigital("o2");
			const refused = await mark(card, "m2");
			expect(!refused.ok && refused.reason).toBe("REFUND_THROUGH_MONEY");
			expect(await entitled(card.id)).toBe(true);
		});
	});

	// -- confirming an unverified refund ------------------------------------------
	//
	// The provider timed out, the row is held `unverified`, and a person confirms it.
	// The confirm finalizes the row exactly as the gateway's success would, so it
	// revokes exactly when that completes the refund (the order flips `refunded`).

	describe("confirming an unverified refund", () => {
		async function unverified(order: Order, amount: number, key: string): Promise<void> {
			h.stripeGw.setRefundResult({ ok: false, reason: "UNVERIFIED" });
			const res = await refundOrder(
				{ orderStore: h.orderStore, entitlementStore: h.entitlementStore },
				h.stripeGw,
				{
					orderId: order.id,
					amount: cents(amount),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey(key),
				},
			);
			expect(!res.ok && res.reason).toBe("GATEWAY_UNVERIFIED");
			h.stripeGw.clearRefundResult();
		}

		function resolve(
			order: Order,
			key: string,
			outcome: "confirmed" | "voided",
			store: EntitlementStore = h.entitlementStore,
		) {
			return resolveUnverifiedRefund(
				{ orderStore: h.orderStore, inventoryStore: h.inventory, entitlementStore: store },
				{ orderId: order.id, refundKey: idempotencyKey(key), outcome, resolvedBy: "carol" },
			);
		}

		test("confirming the refund that completes the order revokes it", async () => {
			const order = await paidDigital("o1");
			await unverified(order, order.totals.total, "r1");
			expect(await entitled(order.id)).toBe(true);
			const res = await resolve(order, "r1", "confirmed");
			expect(res.ok && res.fullyRefunded).toBe(true);
			expect(await entitled(order.id)).toBe(false);
		});

		test("confirming a PARTIAL refund, or voiding one, leaves it entitled", async () => {
			const partial = await paidDigital("o1");
			await unverified(partial, 300, "r1");
			const confirmed = await resolve(partial, "r1", "confirmed");
			expect(confirmed.ok && !confirmed.fullyRefunded).toBe(true);
			expect(await entitled(partial.id)).toBe(true);

			const voidedOrder = await paidDigital("o2");
			await unverified(voidedOrder, voidedOrder.totals.total, "r2");
			expect((await resolve(voidedOrder, "r2", "voided")).ok).toBe(true);
			expect(await entitled(voidedOrder.id)).toBe(true);
		});

		test("a replayed confirm has no double effect, and heals a crash before the revoke", async () => {
			const order = await paidDigital("o1");
			await unverified(order, order.totals.total, "r1");
			await expect(resolve(order, "r1", "confirmed", failingFirst(1))).rejects.toThrow(
				"crash before revoke",
			);
			expect(await entitled(order.id)).toBe(true);
			const replay = await resolve(order, "r1", "confirmed");
			expect(replay.ok && !replay.changed).toBe(true);
			expect(states()).toEqual(["revoked"]);
			await resolve(order, "r1", "confirmed");
			expect(states()).toEqual(["revoked"]);
		});
	});

	// -- cancelling a paid order with its refund ----------------------------------
	//
	// The cancellation's refund is everything still refundable (the ceiling less
	// earlier refunds), and a refund that fails refuses the cancel. So once its refund
	// is recorded the buyer has ALL their money back, and access is revoked — before
	// the flip, so a cancel that the flip then loses (the order shipped) or that did
	// not finish still revokes. The order ends `cancelled`, not `refunded`, which is
	// why this path needs its own revoke.

	describe("cancel with refund", () => {
		function cancel(order: Order, key: string, store: EntitlementStore = h.entitlementStore) {
			return cancelOrderWithRefund(
				{ orderStore: h.orderStore, inventoryStore: h.inventory, entitlementStore: store },
				order.paymentMethod === "x402" ? h.x402Gw : h.stripeGw,
				{
					orderId: order.id,
					reason: "customer_request",
					detail: null,
					cancelledBy: "carol",
					restock: true,
					idempotencyKey: idempotencyKey(key),
				},
			);
		}

		test("cancelling a paid order refunds it in full and revokes its entitlement", async () => {
			const order = await paidDigital("o1");
			const res = await cancel(order, "c1");
			expect(res.ok && res.order.state).toBe("cancelled");
			expect(res.ok && res.refund?.amount).toBe(order.totals.total);
			expect(await entitled(order.id)).toBe(false);
		});

		test("after a partial refund, the cancel returns the rest and revokes", async () => {
			const order = await paidDigital("o1");
			await refundOrder(
				{ orderStore: h.orderStore, entitlementStore: h.entitlementStore },
				h.stripeGw,
				{
					orderId: order.id,
					amount: cents(300),
					currency: USD,
					refundedBy: "admin",
					idempotencyKey: idempotencyKey("r1"),
				},
			);
			expect(await entitled(order.id)).toBe(true);
			const res = await cancel(order, "c1");
			expect(res.ok && res.refund?.amount).toBe(order.totals.total - 300);
			expect(await entitled(order.id)).toBe(false);
		});

		test("a replayed cancel has no double effect: one provider refund, still revoked", async () => {
			const order = await paidDigital("o1");
			await cancel(order, "c1");
			const replay = await cancel(order, "c1");
			expect(replay.ok && !replay.cancelled).toBe(true);
			expect(h.stripeGw.refundCalls).toHaveLength(1);
			expect(states()).toEqual(["revoked"]);
		});

		test("a crash at the revoke leaves the order flagged and paid; the retry finishes and revokes", async () => {
			const order = await paidDigital("o1");
			const first = await cancel(order, "c1", failingFirst(1));
			expect(!first.ok && first.reason).toBe("CANCEL_INCOMPLETE_AFTER_REFUND");
			expect(await entitled(order.id)).toBe(true);
			const retry = await cancel(order, "c1");
			expect(retry.ok && retry.cancelled).toBe(true);
			expect(h.stripeGw.refundCalls).toHaveLength(1);
			expect(await entitled(order.id)).toBe(false);
		});

		test("a cancel whose refund fails, or that cannot refund automatically, leaves it entitled", async () => {
			const card = await paidDigital("o1");
			h.stripeGw.setRefundResult({ ok: false, reason: "TERMINAL" });
			const failed = await cancel(card, "c1");
			expect(!failed.ok && failed.reason).toBe("REFUND_FAILED");
			expect(await entitled(card.id)).toBe(true);
			h.stripeGw.clearRefundResult();

			const x402 = await paidDigital("o2", h.x402Gw);
			const manual = await cancel(x402, "c2");
			expect(!manual.ok && manual.reason).toBe("REFUND_NOT_AUTOMATIC");
			expect(await entitled(x402.id)).toBe(true);
		});

		test("confirming a cancellation's unverified refund revokes, whatever the cancel then does", async () => {
			const order = await paidDigital("o1");
			h.stripeGw.setRefundResult({ ok: false, reason: "UNVERIFIED" });
			const held = await cancel(order, "c1");
			expect(!held.ok).toBe(true);
			h.stripeGw.clearRefundResult();
			expect(await entitled(order.id)).toBe(true);

			const res = await resolveUnverifiedRefund(
				{
					orderStore: h.orderStore,
					inventoryStore: h.inventory,
					entitlementStore: h.entitlementStore,
				},
				{
					orderId: order.id,
					refundKey: idempotencyKey("c1:refund"),
					outcome: "confirmed",
					resolvedBy: "carol",
				},
			);
			expect(res.ok).toBe(true);
			expect(await entitled(order.id)).toBe(false);
		});
	});

	// -- a late payment on a dead order --------------------------------------------
	//
	// A late payment is refunded only on an order with positive evidence it left
	// `pending` UNPAID (expired, failed, or cancelled from pending), and settlement
	// grants only on the flip to `paid`. So such an order never had a grant; the
	// full late refund has nothing to revoke. Pinned, so a change that granted on a
	// dead order would show here.

	test("a late payment refunded in full on an expired order never leaves a grant", async () => {
		const order = await pendingDigital("o1", h.stripeGw);
		h.clock.advance(16 * 60 * 1000);
		expect(await expireOrders(h.expireDeps)).toBe(1);
		const res = await pay(order, h.stripeGw, "o1");
		expect(res.ok).toBe(true);
		const refunds = await h.orderStore.listRefunds(order.id);
		expect(refunds.map((r) => [r.status, r.amount])).toEqual([["recorded", order.totals.total]]);
		expect(h.entitlementStore.all()).toEqual([]);
		expect(await entitled(order.id)).toBe(false);
	});
});
