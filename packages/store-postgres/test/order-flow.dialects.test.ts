import {
	createOrderFromCart,
	expireOrders,
	getCart,
	idempotencyKey,
	type Order,
	removeLine,
	settleOrder,
	sku as brandSku,
	updateLine,
} from "@urumi/domain";
import { afterEach, describe, expect, test } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderFlow,
	makeSqliteOrderFlow,
	type OrderFlowHarness,
	teardownOrderFlow,
} from "./order-harness.js";

afterEach(teardownOrderFlow);

const FUTURE = "2026-07-10T00:15:00.000Z";

function cmd(cartId: string, method: "stripe" | "x402" = "stripe", key = "k-order") {
	return {
		cartId,
		idempotencyKey: idempotencyKey(key),
		buyerRef: "buyer@example.com",
		paymentMethod: method,
	} as const;
}

function evt(order: Order, over: Partial<{ dedupeKey: string; amount: number }> = {}) {
	return {
		outcome: "succeeded" as const,
		orderId: order.id,
		providerRef: `pi_${order.id}`,
		amount: over.amount ?? order.totals.total,
		currency: "USD",
		dedupeKey: over.dedupeKey ?? `evt-${order.id}`,
	};
}

function orderFlowTests(makeHarness: () => Promise<OrderFlowHarness>, dialect: string): void {
	describe(`order flow [${dialect}]`, () => {
		test("editing product_commerce leaves existing order_items unchanged (snapshot immutability)", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 500,
				title: "Widget",
				onHand: 10,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);

			// Edit the product through the Phase-1 sync path (price + title change).
			await h.editProduct({ productId: "p1", sku: "SKU-1", priceCents: 999, title: "Renamed" });

			const item = await h.db
				.selectFrom("order_items")
				.select(["title", "unit_price_cents", "currency"])
				.where("order_id", "=", res.order.id)
				.executeTakeFirstOrThrow();
			expect(item.title).toBe("Widget");
			expect(item.unit_price_cents).toBe(500);
			expect(item.currency).toBe("USD");
		});

		test("held→adopted flip removes the reservation from the Phase-3 held-scoped sweep", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 500,
				title: "W",
				onHand: 10,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);
			const reservationId = res.order.lines[0]!.reservationId!;
			expect(await h.reservationState(reservationId)).toBe("adopted");

			// Run the Phase-3 reservation sweep (held-scoped) after the TTL passes.
			const reclaimed = await h.sweepHeldHolds();
			expect(reclaimed).toBe(0); // adopted hold is structurally invisible to it
			expect(await h.reservationState(reservationId)).toBe("adopted");
			expect(await h.onHand("SKU-1")).toBe(8);
		});

		test("order-expiry guarded transition releases the adopted reservation exactly once under a double-sweep race", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 500,
				title: "W",
				onHand: 10,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);
			const reservationId = res.order.lines[0]!.reservationId!;

			h.clock.advance(16 * 60 * 1000);
			const [a, b] = await Promise.all([expireOrders(h.expireDeps), expireOrders(h.expireDeps)]);
			expect(a + b).toBe(1); // exactly one sweep expired it
			expect((await h.orderStore.getById(res.order.id))?.state).toBe("expired");
			expect(await h.reservationState(reservationId)).toBe("released");
			expect(await h.onHand("SKU-1")).toBe(10); // returned exactly once
		});

		test("a post-checkout cart removeLine/adjustLine cannot release or shrink an adopted hold — returns LINE_CHECKED_OUT, stock and reservation unchanged", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 500,
				title: "W",
				onHand: 10,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			]);
			const cart = (await getCart(h.cartDeps, cartId))!;
			const line = cart.lines[0]!;
			// Adopt the reservation directly WITHOUT flipping the cart, so the
			// PRIMARY reservation-state fence (not the cart-state fence) is exercised.
			await h.inventory.adopt({
				reservationId: line.reservationId!,
				orderId: "ord-direct",
				holdExpiresAt: FUTURE,
				now: "2026-07-10T00:00:00.000Z",
			});

			const rm = await removeLine(h.cartDeps, cartId, line.lineId, idempotencyKey("rm-1"));
			expect(rm).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
			const up = await updateLine(h.cartDeps, cartId, line.lineId, 1, idempotencyKey("up-1"));
			expect(up).toEqual({ ok: false, reason: "LINE_CHECKED_OUT" });
			expect(await h.reservationState(line.reservationId!)).toBe("adopted");
			expect(await h.onHand("SKU-1")).toBe(8); // stock not returned or shrunk
		});

		test("createOrderFromCart flips the cart active→checked_out; a subsequent add/adjust/remove is rejected CART_CHECKED_OUT", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 500,
				title: "W",
				onHand: 10,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);
			const cart = (await getCart(h.cartDeps, cartId))!;
			expect(cart.state).toBe("checked_out");
			const rm = await removeLine(
				h.cartDeps,
				cartId,
				cart.lines[0]!.lineId,
				idempotencyKey("rm-2"),
			);
			expect(rm).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		});

		test("Stripe webhook → paid + inventory commit exactly once; a replay settles once", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 1500,
				title: "W",
				onHand: 5,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);
			const reservationId = res.order.lines[0]!.reservationId!;
			const raw = h.stripeGw.webhook(evt(res.order));

			const settled = await settleOrder(h.settleDeps, h.stripeGw, raw);
			expect(settled.ok).toBe(true);
			expect((await h.orderStore.getById(res.order.id))?.state).toBe("paid");
			expect(await h.reservationState(reservationId)).toBe("committed");
			expect(await h.onHand("SKU-1")).toBe(4); // committed, not released

			const replay = await settleOrder(h.settleDeps, h.stripeGw, raw);
			expect(replay.ok && replay.noop).toBe(true);
			const payments = await h.db
				.selectFrom("payments")
				.selectAll()
				.where("order_id", "=", res.order.id)
				.execute();
			expect(payments).toHaveLength(1);
		});

		test("x402 page-gate → paid + entitlement granted", async () => {
			const h = await makeHarness();
			await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
			const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId, "x402"));
			if (!res.ok) throw new Error(res.reason);
			const raw = h.x402Gw.pageGate({
				orderId: res.order.id,
				transaction: `0xtx-${res.order.id}`,
				network: "eip155:8453",
				payer: "0xbuyer",
				amount: res.order.totals.total,
				currency: res.order.currency,
			});
			const settled = await settleOrder(h.settleDeps, h.x402Gw, raw);
			expect(settled.ok).toBe(true);
			expect((await h.orderStore.getById(res.order.id))?.state).toBe("paid");
			expect(
				await h.entitlementStore.check({ orderId: res.order.id, sku: brandSku("DIG-1") }),
			).toBe(true);
		});

		test("settle commit against a reservation lost to a stray release records the anomaly at SQL level (order flagged, payment_events anomaly row written)", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 1500,
				title: "W",
				onHand: 5,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			]);
			const res = await createOrderFromCart(h.createDeps, cmd(cartId));
			if (!res.ok) throw new Error(res.reason);
			const reservationId = res.order.lines[0]!.reservationId!;
			// Stray release of the adopted hold (invariant violation).
			await h.inventory.release(reservationId);

			const settled = await settleOrder(
				h.settleDeps,
				h.stripeGw,
				h.stripeGw.webhook(evt(res.order)),
			);
			expect(settled.ok).toBe(true); // money received; order is paid
			const order = await h.orderStore.getById(res.order.id);
			expect(order?.state).toBe("paid");
			expect(order?.reconciliationFlag).not.toBeNull();
			const anomalies = await h.db
				.selectFrom("payment_events")
				.selectAll()
				.where("kind", "=", "COMMIT_LOST")
				.where("order_id", "=", res.order.id)
				.execute();
			expect(anomalies).toHaveLength(1);
		});
	});
}

orderFlowTests(makeSqliteOrderFlow, "sqlite");

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderFlowTests(makePgOrderFlow, "pg");
});
