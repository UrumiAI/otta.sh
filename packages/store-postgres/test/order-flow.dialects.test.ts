import {
	createOrderFromCart,
	expireOrders,
	getCart,
	idempotencyKey,
	type Order,
	type OrderStore,
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

		test("a second checkout of the same cart with a DIFFERENT idempotency key is rejected CART_CHECKED_OUT at the store level", async () => {
			const h = await makeHarness();
			await h.seedPhysical({
				productId: "p1",
				sku: "SKU-1",
				priceCents: 500,
				title: "W",
				onHand: 10,
			});
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			]);
			const first = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-tab-1"));
			if (!first.ok) throw new Error(first.reason);
			const reservationId = first.order.lines[0]!.reservationId!;

			// Two tabs, per-click keys (G2): distinct key on the checked-out cart.
			const second = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-tab-2"));
			expect(second).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
			expect(await h.reservationState(reservationId)).toBe("adopted");
			// And the same-key replay is still honored (the idempotent path).
			const replay = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-tab-1"));
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.order.id).toBe(first.order.id);
		});

		test("expireOrders' release is order-scoped: a stale order pointing at a foreign adopted (or committed) reservation never frees it and never crashes the sweep", async () => {
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
			const owner = await createOrderFromCart(h.createDeps, cmd(cartId, "stripe", "k-owner"));
			if (!owner.ok) throw new Error(owner.reason);
			const reservationId = owner.order.lines[0]!.reservationId!;
			expect(await h.reservationState(reservationId)).toBe("adopted");

			// A stale order (the pre-fence two-tab artifact) whose line points at the
			// OWNER's reservation, already past its TTL.
			await h.orderStore.createFromCart({
				orderId: `stale-${owner.order.id}` as typeof owner.order.id,
				cartId: "cart-stale",
				currency: owner.order.currency,
				idempotencyKey: idempotencyKey("k-stale"),
				holdExpiresAt: "2026-07-10T00:01:00.000Z",
				buyerRef: "stale@example.com",
				paymentMethod: "stripe",
				lines: [
					{
						productId: owner.order.lines[0]!.productId,
						sku: brandSku("SKU-1"),
						title: "W",
						unitPrice: owner.order.lines[0]!.unitPrice,
						currency: owner.order.currency,
						quantity: 2,
						fulfillmentKind: "physical",
						reservationId,
					},
				],
				totals: owner.order.totals,
			});

			h.clock.advance(2 * 60 * 1000); // stale TTL passed; owner's 15-min hold live
			expect(await expireOrders(h.expireDeps)).toBe(1); // the stale order expires…
			// …but the owner's adopted hold is untouched and stock did not return.
			expect(await h.reservationState(reservationId)).toBe("adopted");
			expect(await h.onHand("SKU-1")).toBe(8);

			// The owner settles (commit) — and a later sweep must not throw on any
			// stale row pointing at the now-COMMITTED reservation (an unscoped
			// release would crash EVERY subsequent run).
			const settled = await settleOrder(
				h.settleDeps,
				h.stripeGw,
				h.stripeGw.webhook(evt(owner.order)),
			);
			expect(settled.ok).toBe(true);
			expect(await h.reservationState(reservationId)).toBe("committed");
			await expect(expireOrders(h.expireDeps)).resolves.toBe(0); // survives
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

		// -- review round: mid-flight flip loss (F1) + crash-window resumption (F2) --

		test("a settle losing the paid flip to a concurrent expiry records the PAID_FLIP_LOST anomaly and flags reconciliation (mid-flight loser is loud)", async () => {
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
			h.clock.advance(16 * 60 * 1000); // past the checkout TTL; sweep not yet run

			// Force the interleave on the REAL store: settle loads `pending`, then
			// the expiry sweep wins between the load and the pending→paid flip.
			// (Explicit delegation — a prototype proxy would break the Kysely
			// store's #private-field receivers.)
			const racingOrderStore: OrderStore = {
				createFromCart: (i) => h.orderStore.createFromCart(i),
				getById: (id) => h.orderStore.getById(id),
				getByIdempotencyKey: (k) => h.orderStore.getByIdempotencyKey(k),
				markPaid: async (id) => {
					await expireOrders(h.expireDeps);
					return h.orderStore.markPaid(id);
				},
				markFailed: (id) => h.orderStore.markFailed(id),
				expire: (id, at) => h.orderStore.expire(id, at),
				listExpirable: (at) => h.orderStore.listExpirable(at),
				recordPayment: (i) => h.orderStore.recordPayment(i),
				getCapturedPayments: (id) => h.orderStore.getCapturedPayments(id),
				listRefunds: (id) => h.orderStore.listRefunds(id),
				getRefundByIdempotencyKey: (k) => h.orderStore.getRefundByIdempotencyKey(k),
				recordRefund: (i) => h.orderStore.recordRefund(i),
				flagReconciliation: (id, d) => h.orderStore.flagReconciliation(id, d),
				resolveReconciliation: (i) => h.orderStore.resolveReconciliation(i),
				recordFulfillment: (i) => h.orderStore.recordFulfillment(i),
				cancelOrder: (i) => h.orderStore.cancelOrder(i),
				transition: (i) => h.orderStore.transition(i),
				listForCustomer: (c) => h.orderStore.listForCustomer(c),
				listEventsForOrder: (id) => h.orderStore.listEventsForOrder(id),
				listOrders: (f, p) => h.orderStore.listOrders(f, p),
				countOrders: (f) => h.orderStore.countOrders(f),
				linkGuestOrders: (c, ref) => h.orderStore.linkGuestOrders(c, ref),
				claimNextEmail: (now, lease) => h.orderStore.claimNextEmail(now, lease),
				markEmailSent: (id, now) => h.orderStore.markEmailSent(id, now),
				rescheduleEmail: (id, at) => h.orderStore.rescheduleEmail(id, at),
			};

			const settled = await settleOrder(
				{ ...h.settleDeps, orderStore: racingOrderStore },
				h.stripeGw,
				h.stripeGw.webhook(evt(res.order)),
			);
			expect(settled.ok).toBe(true);
			if (settled.ok) expect(settled.noop).toBe(true);
			const order = await h.orderStore.getById(res.order.id);
			expect(order?.state).toBe("expired");
			expect(order?.reconciliationFlag).not.toBeNull();
			const anomalies = await h.db
				.selectFrom("payment_events")
				.selectAll()
				.where("kind", "=", "PAID_FLIP_LOST")
				.where("order_id", "=", res.order.id)
				.execute();
			expect(anomalies).toHaveLength(1);
			expect(await h.reservationState(reservationId)).toBe("released");
		});

		test("a settle retry after a crash between dedupe and markPaid completes the settlement", async () => {
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
			const event = evt(res.order);
			// Simulate the crash: only the payment_events dedupe row landed.
			await h.paymentEventStore.dedupe(event.dedupeKey, res.order.id, "stripe", FUTURE);

			// The gateway retry re-delivers the SAME event: it must RESUME, not no-op.
			const settled = await settleOrder(h.settleDeps, h.stripeGw, h.stripeGw.webhook(event));
			expect(settled.ok).toBe(true);
			if (settled.ok) expect(settled.noop).toBe(false);
			expect((await h.orderStore.getById(res.order.id))?.state).toBe("paid");
			expect(await h.reservationState(reservationId)).toBe("committed");
			const payments = await h.db
				.selectFrom("payments")
				.selectAll()
				.where("order_id", "=", res.order.id)
				.execute();
			expect(payments).toHaveLength(1);
		});

		test("a settle retry after a crash between markPaid and commit completes the side-effects exactly once", async () => {
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
			const event = evt(res.order);
			// Simulate the crash: dedupe + the paid flip landed; commit/record did not.
			await h.paymentEventStore.dedupe(event.dedupeKey, res.order.id, "stripe", FUTURE);
			await h.orderStore.markPaid(res.order.id);
			expect(await h.reservationState(reservationId)).toBe("adopted");

			const settled = await settleOrder(h.settleDeps, h.stripeGw, h.stripeGw.webhook(event));
			expect(settled.ok).toBe(true);
			expect(await h.reservationState(reservationId)).toBe("committed");
			// A further retry moves nothing more (exactly once).
			await settleOrder(h.settleDeps, h.stripeGw, h.stripeGw.webhook(event));
			const payments = await h.db
				.selectFrom("payments")
				.selectAll()
				.where("order_id", "=", res.order.id)
				.execute();
			expect(payments).toHaveLength(1);
			const anomalies = await h.db
				.selectFrom("payment_events")
				.selectAll()
				.where("kind", "is not", null)
				.execute();
			expect(anomalies).toHaveLength(0);
		});

		test("commit against a released reservation throws the loud ReservationCommitLostError; against a committed one it is a benign no-op (guard-first)", async () => {
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
			const cart = (await h.cartStore.get(cartId))!;
			const reservationId = cart.lines[0]!.reservationId!;
			await h.inventory.commit(reservationId); // held → committed
			await expect(h.inventory.commit(reservationId)).resolves.toBeUndefined(); // benign replay
			expect(await h.reservationState(reservationId)).toBe("committed");

			// A second, lost hold: released before commit → the loud typed anomaly.
			await h.seedPhysical({
				productId: "p2",
				sku: "SKU-2",
				priceCents: 500,
				title: "X",
				onHand: 5,
			});
			const cartId2 = await h.cartWith([
				{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
			]);
			const cart2 = (await h.cartStore.get(cartId2))!;
			const lost = cart2.lines[0]!.reservationId!;
			await h.inventory.release(lost);
			await expect(h.inventory.commit(lost)).rejects.toThrow("not held/adopted/committed");
		});
	});
}

orderFlowTests(makeSqliteOrderFlow, "sqlite");

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderFlowTests(makePgOrderFlow, "pg");
});
