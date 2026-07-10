import {
	createOrderFromCart,
	expireOrders,
	idempotencyKey,
	type Order,
	type OrderStore,
	settleOrder,
	sku as brandSku,
} from "@urumi/domain";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

describe("settleOrder", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	async function pendingPhysical(key = "k1"): Promise<Order> {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(`seed order failed: ${res.reason}`);
		return res.order;
	}

	async function pendingDigital(key = "kd"): Promise<Order> {
		await h.seedDigital({ productId: "d1", sku: "DIG-1", priceCents: 900, title: "Ebook" });
		const cartId = await h.cartWith([{ sku: "DIG-1", productId: "d1", qty: 1, kind: "digital" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: "buyer@example.com",
			paymentMethod: "x402",
		});
		if (!res.ok) throw new Error(`seed digital order failed: ${res.reason}`);
		return res.order;
	}

	function evt(
		order: Order,
		over: Partial<{ dedupeKey: string; amount: number; outcome: "succeeded" | "failed" }> = {},
	) {
		return h.stripeGw.webhook({
			outcome: over.outcome ?? "succeeded",
			orderId: order.id,
			providerRef: "pi_1",
			amount: over.amount ?? order.totals.total,
			currency: "USD",
			dedupeKey: over.dedupeKey ?? "evt-1",
		});
	}

	test("verified confirmation flips pending→paid and commits the reservation (physical)", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		const res = await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		expect(res.ok).toBe(true);
		expect((await h.orderStore.getById(order.id))?.state).toBe("paid");
		expect(h.inventory.reservationState(reservationId)).toBe("committed");
		expect(h.orderStore.payments(order.id)).toHaveLength(1);
	});

	test("verified confirmation on a digital line grants an entitlement", async () => {
		const order = await pendingDigital();
		const raw = h.x402Gw.webhook({
			outcome: "succeeded",
			orderId: order.id,
			providerRef: "rcpt_1",
			amount: order.totals.total,
			currency: "USD",
			dedupeKey: "rcpt-1",
		});
		const res = await settleOrder(h.settleDeps, h.x402Gw, raw);
		expect(res.ok).toBe(true);
		expect((await h.orderStore.getById(order.id))?.state).toBe("paid");
		expect(await h.entitlementStore.check({ orderId: order.id, sku: brandSku("DIG-1") })).toBe(
			true,
		);
	});

	test("replayed confirmation with same dedupeKey settles once (no-op on redelivery)", async () => {
		const order = await pendingPhysical();
		await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		const replay = await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		expect(replay.ok).toBe(true);
		if (replay.ok) expect(replay.noop).toBe(true);
		expect(h.orderStore.payments(order.id)).toHaveLength(1); // recorded once
		expect(h.paymentEventStore.anomalies()).toHaveLength(0);
	});

	test("already-paid order + late confirmation is a no-op (webhook-before-redirect)", async () => {
		const order = await pendingPhysical();
		await settleOrder(h.settleDeps, h.stripeGw, evt(order, { dedupeKey: "evt-A" }));
		// A DIFFERENT event id (passes dedupe) arriving after paid → no-op success.
		const late = await settleOrder(h.settleDeps, h.stripeGw, evt(order, { dedupeKey: "evt-B" }));
		expect(late.ok).toBe(true);
		if (late.ok) expect(late.noop).toBe(true);
		expect((await h.orderStore.getById(order.id))?.state).toBe("paid");
	});

	test("amount/currency mismatch is rejected and recorded as anomaly", async () => {
		const order = await pendingPhysical();
		const res = await settleOrder(h.settleDeps, h.stripeGw, evt(order, { amount: 999 }));
		expect(res).toEqual({ ok: false, reason: "AMOUNT_MISMATCH" });
		expect((await h.orderStore.getById(order.id))?.state).toBe("pending");
		expect(h.paymentEventStore.anomalies().some((a) => a.kind === "AMOUNT_MISMATCH")).toBe(true);
	});

	test("invalid signature confirmation is rejected", async () => {
		const order = await pendingPhysical();
		const raw = h.stripeGw.webhook(
			{
				outcome: "succeeded",
				orderId: order.id,
				providerRef: "pi_1",
				amount: order.totals.total,
				currency: "USD",
				dedupeKey: "evt-1",
			},
			{ badSignature: true },
		);
		const res = await settleOrder(h.settleDeps, h.stripeGw, raw);
		expect(res).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
		expect((await h.orderStore.getById(order.id))?.state).toBe("pending");
	});

	test("payment_failed → failed → releases the reservation", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		expect(h.inventory.onHand("SKU-1")).toBe(4); // 5 - 1 reserved
		const res = await settleOrder(h.settleDeps, h.stripeGw, evt(order, { outcome: "failed" }));
		expect(res.ok).toBe(true);
		expect((await h.orderStore.getById(order.id))?.state).toBe("failed");
		expect(h.inventory.reservationState(reservationId)).toBe("released");
		expect(h.inventory.onHand("SKU-1")).toBe(5); // stock returned
	});

	test("order-expiry guarded transition (pending→expired) releases the adopted reservation exactly once", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		h.clock.advance(16 * 60 * 1000);
		const first = await expireOrders(h.expireDeps);
		const second = await expireOrders(h.expireDeps); // double-sweep race
		expect(first).toBe(1);
		expect(second).toBe(0);
		expect((await h.orderStore.getById(order.id))?.state).toBe("expired");
		expect(h.inventory.reservationState(reservationId)).toBe("released");
		expect(h.inventory.onHand("SKU-1")).toBe(5); // returned exactly once
	});

	test("commit that matches 0 rows because the adopted hold was lost (released) records a payment_events anomaly + flags manual reconciliation — never a silent no-op", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		// Simulate a stray release of the adopted hold (invariant violation).
		await h.inventory.release(reservationId);
		const res = await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		expect(res.ok).toBe(true); // money received; the order is paid
		const settled = await h.orderStore.getById(order.id);
		expect(settled?.state).toBe("paid");
		expect(settled?.reconciliationFlag).not.toBeNull();
		expect(h.paymentEventStore.anomalies().some((a) => a.kind === "COMMIT_LOST")).toBe(true);
	});

	test("commit on an already-committed reservation (idempotent replay) is a benign no-op, not an anomaly", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		// A direct re-commit of the now-committed reservation is a benign no-op.
		await expect(h.inventory.commit(reservationId)).resolves.toBeUndefined();
		expect(h.inventory.reservationState(reservationId)).toBe("committed");
		expect(h.paymentEventStore.anomalies()).toHaveLength(0);
	});

	// -- review round: mid-flight flip loss (F1) + crash-window resumption (F2) --

	/** An OrderStore wrapper whose markPaid first lets the expiry sweep win —
	 *  forcing the exact load→(expire)→flip interleave of F1. */
	function raceExpiryIntoMarkPaid(): OrderStore {
		return {
			createFromCart: (i) => h.orderStore.createFromCart(i),
			getById: (id) => h.orderStore.getById(id),
			markPaid: async (id) => {
				await expireOrders(h.expireDeps);
				return h.orderStore.markPaid(id);
			},
			markFailed: (id) => h.orderStore.markFailed(id),
			expire: (id, at) => h.orderStore.expire(id, at),
			listExpirable: (at) => h.orderStore.listExpirable(at),
			recordPayment: (i) => h.orderStore.recordPayment(i),
			flagReconciliation: (id, d) => h.orderStore.flagReconciliation(id, d),
		};
	}

	test("a settle losing the paid flip to a mid-flight expiry records the paid-but-released anomaly and flags reconciliation — never a silent no-op", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		// Past the checkout TTL, but the sweep has not run yet: settle loads the
		// order still `pending`, then the sweep wins between load and flip.
		h.clock.advance(16 * 60 * 1000);
		const res = await settleOrder(
			{ ...h.settleDeps, orderStore: raceExpiryIntoMarkPaid() },
			h.stripeGw,
			evt(order),
		);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.noop).toBe(true);
		const fresh = await h.orderStore.getById(order.id);
		expect(fresh?.state).toBe("expired");
		expect(fresh?.reconciliationFlag).not.toBeNull(); // flagged for manual reconciliation
		expect(h.paymentEventStore.anomalies().some((a) => a.kind === "PAID_FLIP_LOST")).toBe(true);
		// The expiry released the stock — which is exactly why this must be loud.
		expect(h.inventory.reservationState(reservationId)).toBe("released");
	});

	test("a settle retry after a crash between dedupe and markPaid completes the settlement", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		// Simulate the crash: the payment_events dedupe row landed, nothing else.
		await h.paymentEventStore.dedupe(
			"evt-crash-a",
			order.id,
			"stripe",
			h.clock.now().toISOString(),
		);
		// The gateway retry re-delivers the SAME event: it must RESUME, not no-op.
		const res = await settleOrder(
			h.settleDeps,
			h.stripeGw,
			evt(order, { dedupeKey: "evt-crash-a" }),
		);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.noop).toBe(false); // it genuinely settled on this drive
		expect((await h.orderStore.getById(order.id))?.state).toBe("paid");
		expect(h.inventory.reservationState(reservationId)).toBe("committed");
		expect(h.orderStore.payments(order.id)).toHaveLength(1);
	});

	test("a settle retry after a crash between markPaid and commit completes the side-effects exactly once", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		// Simulate the crash: dedupe row + the paid flip landed; commit/record did not.
		await h.paymentEventStore.dedupe(
			"evt-crash-b",
			order.id,
			"stripe",
			h.clock.now().toISOString(),
		);
		await h.orderStore.markPaid(order.id);
		expect(h.inventory.reservationState(reservationId)).toBe("adopted"); // not yet committed

		const res = await settleOrder(
			h.settleDeps,
			h.stripeGw,
			evt(order, { dedupeKey: "evt-crash-b" }),
		);
		expect(res.ok).toBe(true);
		expect(h.inventory.reservationState(reservationId)).toBe("committed");
		expect(h.orderStore.payments(order.id)).toHaveLength(1);

		// A further retry moves nothing more (exactly once).
		await settleOrder(h.settleDeps, h.stripeGw, evt(order, { dedupeKey: "evt-crash-b" }));
		expect(h.orderStore.payments(order.id)).toHaveLength(1);
		expect(h.paymentEventStore.anomalies()).toHaveLength(0);
	});

	test("a settle retry after a crash between markPaid and grant heals the missing entitlement exactly once", async () => {
		const order = await pendingDigital();
		// Simulate the crash: dedupe + paid flip landed; the grant did not.
		await h.paymentEventStore.dedupe("rcpt-crash", order.id, "x402", h.clock.now().toISOString());
		await h.orderStore.markPaid(order.id);
		expect(await h.entitlementStore.check({ orderId: order.id, sku: brandSku("DIG-1") })).toBe(
			false,
		);

		const raw = h.x402Gw.webhook({
			outcome: "succeeded",
			orderId: order.id,
			providerRef: "rcpt_crash",
			amount: order.totals.total,
			currency: "USD",
			dedupeKey: "rcpt-crash",
		});
		const res = await settleOrder(h.settleDeps, h.x402Gw, raw);
		expect(res.ok).toBe(true);
		expect(await h.entitlementStore.check({ orderId: order.id, sku: brandSku("DIG-1") })).toBe(
			true,
		);
		// A further retry grants nothing more.
		await settleOrder(h.settleDeps, h.x402Gw, raw);
		expect(h.entitlementStore.all()).toHaveLength(1);
	});

	test("a retry after a crash between markFailed and release completes the release", async () => {
		const order = await pendingPhysical();
		const reservationId = order.lines[0]!.reservationId!;
		// Simulate the crash: dedupe + failed flip landed; the release did not.
		await h.paymentEventStore.dedupe(
			"evt-fail-crash",
			order.id,
			"stripe",
			h.clock.now().toISOString(),
		);
		await h.orderStore.markFailed(order.id);
		expect(h.inventory.reservationState(reservationId)).toBe("adopted"); // stock still gone

		const res = await settleOrder(
			h.settleDeps,
			h.stripeGw,
			evt(order, { outcome: "failed", dedupeKey: "evt-fail-crash" }),
		);
		expect(res.ok).toBe(true);
		expect(h.inventory.reservationState(reservationId)).toBe("released");
		expect(h.inventory.onHand("SKU-1")).toBe(5); // stock returned exactly once
	});
});
