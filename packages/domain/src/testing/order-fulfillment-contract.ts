import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import {
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type OrderId,
} from "../money/ids.js";
import type { CreateOrderInput } from "../ports/order-store.js";
import type { OrderState } from "../orders/model.js";
import { recordFulfillment } from "../orders/record-fulfillment.js";
import { dispatchOrderEmails, transitionOrder } from "../orders/transition.js";
import type { OrderTransitionHarness } from "./order-transition-contract.js";

const USD = currency("USD");

function pendingInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-f1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-f1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

async function seedPending(
	h: OrderTransitionHarness,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const { order } = await h.store.createFromCart(pendingInput(overrides));
	return order.id;
}

function drive(h: OrderTransitionHarness, id: OrderId, to: OrderState) {
	return transitionOrder(
		{ orderStore: h.store },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
	);
}

/** Seed an order and move it all the way to `processing` (the only state from
 *  which fulfillment/shipping is legal), draining the pre-ship emails so a later
 *  assertion counts only the shipped one. */
async function seedProcessing(
	h: OrderTransitionHarness,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const id = await seedPending(h, overrides);
	await drive(h, id, "paid");
	await drive(h, id, "processing");
	await dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
	h.emailSender.reset();
	return id;
}

function record(
	h: OrderTransitionHarness,
	id: OrderId,
	over: Partial<{
		carrier: string;
		trackingNumber: string;
		trackingUrl: string | null;
		shippedAt: string | null;
		recordedBy: string;
		key: string;
	}> = {},
) {
	return recordFulfillment(
		{ orderStore: h.store },
		{
			orderId: id,
			carrier: over.carrier ?? "UPS",
			trackingNumber: over.trackingNumber ?? "1Z-TRACK-1",
			...(over.trackingUrl !== undefined ? { trackingUrl: over.trackingUrl } : {}),
			...(over.shippedAt !== undefined ? { shippedAt: over.shippedAt } : {}),
			recordedBy: over.recordedBy ?? "admin@shop",
			idempotencyKey: idempotencyKey(over.key ?? `f:${id}`),
		},
	);
}

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}

/**
 * The reusable order-fulfillment spec (admin-UX Increment 1). Encodes: recording
 * fulfillment SHIPS the order (`processing → shipped`) and records the tracking
 * envelope atomically; the shipped notification email carries that tracking; the
 * compose is idempotent under replay; fulfillment is legal ONLY from `processing`
 * (guarding meaningless states); and the mutable-envelope-only invariant (line
 * items untouched). Runs against the fake first, then each SQL dialect.
 */
export function orderFulfillmentContract(
	makeHarness: () => Promise<OrderTransitionHarness>,
	opts: { dialect: string },
): void {
	describe(`orderFulfillmentContract [${opts.dialect}]`, () => {
		test("recording fulfillment ships the order and records the tracking envelope", async () => {
			const h = await makeHarness();
			const id = await seedProcessing(h);
			const res = await record(h, id, {
				carrier: "UPS",
				trackingNumber: "1Z-999",
				trackingUrl: "https://track/1Z-999",
				shippedAt: "2026-07-11T09:00:00.000Z",
				recordedBy: "dispatch-desk",
			});
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.recorded).toBe(true);
			const order = await h.store.getById(id);
			expect(order?.state).toBe("shipped");
			expect(order?.fulfillment).toMatchObject({
				carrier: "UPS",
				trackingNumber: "1Z-999",
				trackingUrl: "https://track/1Z-999",
				shippedAt: "2026-07-11T09:00:00.000Z",
				recordedBy: "dispatch-desk",
			});
			expect(order?.fulfillment?.recordedAt).toBeTruthy();
			// Line items are untouched — fulfillment is mutable-envelope only.
			expect(order?.lines.map((l) => l.title)).toEqual(["Widget"]);
		});

		test("the shipped email carries the tracking info (not an empty notification)", async () => {
			const h = await makeHarness();
			const id = await seedProcessing(h);
			await record(h, id, {
				carrier: "DHL",
				trackingNumber: "DH-42",
				trackingUrl: "https://dhl/DH-42",
			});
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-shipped", id)).toBe(1);
			const shipped = h.emailSender.sends.find((s) => s.template === "order-shipped");
			expect(shipped?.data["fulfillment"]).toMatchObject({
				carrier: "DHL",
				trackingNumber: "DH-42",
				trackingUrl: "https://dhl/DH-42",
			});
		});

		test("an absent tracking URL / ship time normalizes (url null, shippedAt = record time)", async () => {
			const h = await makeHarness();
			const id = await seedProcessing(h);
			const res = await record(h, id, { trackingUrl: null, shippedAt: null });
			expect(res.ok).toBe(true);
			const f = (await h.store.getById(id))?.fulfillment;
			expect(f?.trackingUrl).toBeNull();
			// Blank ship time defaults to the store's record timestamp.
			expect(f?.shippedAt).toBe(f?.recordedAt);
		});

		test("replaying record-fulfillment is an idempotent no-op and sends exactly one shipped email", async () => {
			const h = await makeHarness();
			const id = await seedProcessing(h);
			const first = await record(h, id);
			const replay = await record(h, id);
			expect(first.ok).toBe(true);
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.recorded).toBe(false); // already shipped ⇒ no-op
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-shipped", id)).toBe(1);
		});

		test("recording fulfillment on a non-processing order is rejected NOT_FULFILLABLE and ships nothing", async () => {
			const h = await makeHarness();
			// A `paid` order is not yet fulfillable — it must reach `processing` first.
			const id = await seedPending(h);
			await drive(h, id, "paid");
			await dispatch(h);
			h.emailSender.reset();
			const res = await record(h, id);
			expect(res).toEqual({ ok: false, reason: "NOT_FULFILLABLE" });
			expect((await h.store.getById(id))?.state).toBe("paid");
			expect((await h.store.getById(id))?.fulfillment).toBeNull();
			expect(await dispatch(h)).toBe(0);
		});

		test("recording fulfillment on a cancelled order is rejected NOT_FULFILLABLE", async () => {
			const h = await makeHarness();
			const id = await seedPending(h);
			await drive(h, id, "cancelled");
			await dispatch(h);
			h.emailSender.reset();
			const res = await record(h, id);
			expect(res).toEqual({ ok: false, reason: "NOT_FULFILLABLE" });
			expect((await h.store.getById(id))?.state).toBe("cancelled");
		});

		test("recording fulfillment on a missing order is ORDER_NOT_FOUND", async () => {
			const h = await makeHarness();
			const res = await record(h, orderId("ord-nope"));
			expect(res).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
		});

		test("blank carrier / tracking number / recorder are rejected before any write", async () => {
			const h = await makeHarness();
			const id = await seedProcessing(h);
			expect(await record(h, id, { carrier: "   " })).toEqual({
				ok: false,
				reason: "EMPTY_CARRIER",
			});
			expect(await record(h, id, { trackingNumber: "" })).toEqual({
				ok: false,
				reason: "EMPTY_TRACKING_NUMBER",
			});
			expect(await record(h, id, { recordedBy: "  " })).toEqual({
				ok: false,
				reason: "EMPTY_RECORDER",
			});
			// None of the rejected attempts shipped the order.
			expect((await h.store.getById(id))?.state).toBe("processing");
		});
	});
}
