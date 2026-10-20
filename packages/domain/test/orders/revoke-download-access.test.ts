import {
	createOrderFromCart,
	idempotencyKey,
	listOrderNotes,
	type Order,
	orderId as toOrderId,
	revokeOrderDownloadAccess,
	type RevokeDownloadAccessDeps,
	settleOrder,
	sku as brandSku,
} from "@urumi.ai/otta-domain";
import { CountingIdGen, InMemoryOrderNotesStore } from "@urumi.ai/otta-domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

const SKU = brandSku("DIG-1");

/**
 * The console's "Revoke download access" (issue #447): the one way to close a
 * paid order's downloads when its money left without moving the order — a
 * dispute or chargeback. It revokes every grant the order made and records who
 * did it on the order's History, once.
 */
describe("revokeOrderDownloadAccess", () => {
	let h: OrderHarness;
	let deps: RevokeDownloadAccessDeps;
	beforeEach(() => {
		h = makeOrderHarness();
		deps = {
			orderStore: h.orderStore,
			entitlementStore: h.entitlementStore,
			orderNotesStore: new InMemoryOrderNotesStore({
				idGen: new CountingIdGen("note"),
				clock: h.clock,
			}),
		};
	});

	async function paidOrder(kind: "digital" | "physical"): Promise<Order> {
		if (kind === "digital") {
			await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		} else {
			await h.seedPhysical({
				productId: "p1",
				sku: "PHY-1",
				priceCents: 900,
				title: "Mug",
				onHand: 5,
			});
		}
		const cartId = await h.cartWith([
			kind === "digital"
				? { sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }
				: { sku: "PHY-1", productId: "p1", qty: 1, kind: "physical" },
		]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(`order-${kind}`),
			buyerRef: "buyer@example.com",
			paymentMethod: h.stripeGw.id,
		});
		if (!res.ok) throw new Error(`seed order failed: ${res.reason}`);
		const settled = await settleOrder(
			h.settleDeps,
			h.stripeGw,
			h.stripeGw.webhook({
				outcome: "succeeded",
				orderId: res.order.id,
				providerRef: `pi_${kind}`,
				amount: res.order.totals.total,
				currency: "USD",
				dedupeKey: `evt-${kind}`,
			}),
		);
		if (!settled.ok) throw new Error(`settle failed: ${settled.reason}`);
		return res.order;
	}

	function revoke(order: Pick<Order, "id">, revokedBy = "carol") {
		return revokeOrderDownloadAccess(deps, {
			orderId: order.id,
			revokedBy,
			idempotencyKey: idempotencyKey(`admin-revoke-downloads:${order.id}`),
		});
	}

	test("revokes the order's grant and records who did it on the order", async () => {
		const order = await paidOrder("digital");
		expect(await h.entitlementStore.check({ orderId: order.id, sku: SKU })).toBe(true);

		const res = await revoke(order);

		expect(res).toEqual({ ok: true, revoked: true });
		expect(await h.entitlementStore.check({ orderId: order.id, sku: SKU })).toBe(false);
		const notes = await listOrderNotes(deps, order.id);
		expect(notes).toHaveLength(1);
		expect(notes[0]?.author).toBe("carol");
		expect(notes[0]?.body).toMatch(/download access revoked/i);
	});

	test("a replay changes nothing and adds no second note", async () => {
		const order = await paidOrder("digital");
		await revoke(order);

		const replay = await revoke(order, "dave");

		expect(replay).toEqual({ ok: true, revoked: false });
		expect(await listOrderNotes(deps, order.id)).toHaveLength(1);
	});

	test("a PENDING order is refused and nothing is recorded — a later settle would grant past it", async () => {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("order-pending"),
			buyerRef: "buyer@example.com",
			paymentMethod: h.stripeGw.id,
		});
		if (!res.ok) throw new Error(res.reason);

		expect(await revoke(res.order)).toEqual({ ok: false, reason: "NOT_DELIVERABLE" });
		expect(await listOrderNotes(deps, res.order.id)).toEqual([]);
	});

	test("a replay that closes a grant written after the first revoke says it revoked", async () => {
		const order = await paidOrder("digital");
		await revoke(order);
		// A grant landing after the revoke (a settle redelivery under a new key).
		await h.entitlementStore.grant({
			orderId: order.id,
			productId: null,
			sku: SKU,
			buyerRef: "buyer@example.com",
			source: "order_paid",
			grantIdempotencyKey: idempotencyKey("late-grant"),
		});
		expect(await h.entitlementStore.check({ orderId: order.id, sku: SKU })).toBe(true);

		expect(await revoke(order)).toEqual({ ok: true, revoked: true });
		expect(await h.entitlementStore.check({ orderId: order.id, sku: SKU })).toBe(false);
		expect(await listOrderNotes(deps, order.id)).toHaveLength(1);
	});

	test("an order with no digital line is refused and nothing is recorded", async () => {
		const order = await paidOrder("physical");
		expect(await revoke(order)).toEqual({ ok: false, reason: "NO_DOWNLOADS" });
		expect(await listOrderNotes(deps, order.id)).toEqual([]);
	});

	test("an unknown order is refused", async () => {
		expect(await revoke({ id: toOrderId("ord-missing") })).toEqual({
			ok: false,
			reason: "ORDER_NOT_FOUND",
		});
	});

	test("a blank operator is refused before anything changes", async () => {
		const order = await paidOrder("digital");
		expect(await revoke(order, "   ")).toEqual({ ok: false, reason: "EMPTY_REVOKED_BY" });
		expect(await h.entitlementStore.check({ orderId: order.id, sku: SKU })).toBe(true);
	});
});
