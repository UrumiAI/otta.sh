/** Late payments, webhook redeliveries, auth errors, stale reserves and stale product events. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import type { OrderDoc, ProductDoc } from "../src/model.js";
import { completeStock, orders } from "../src/orders.js";
import { onAfterPublish, onAfterUnpublish } from "../src/products.js";
import { applySession } from "../src/settle.js";
import { applyStock } from "../src/stock.js";
import { sweep } from "../src/sweep.js";
import { callRoute, deliver, linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

const MIN = 60_000;

describe("an unheld (late) sale is taken exactly once", () => {
	it("a replayed completion after the hold was converted does not take stock again", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const id = orderKey(1);
		// Expired, but its release was interrupted: the hold is still there.
		const c = orders(s.ctx);
		const v = await c.getVersioned(id);
		await c.compareAndSet(id, v!.revision, {
			...v!.value,
			status: "expired",
			stock: "releasing",
			stockPending: 1,
		});
		const cs = s.stripe.only();
		s.stripe.complete(cs.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", cs.id));
		expect((await s.stock("p1")).onHand).toBe(4);
		// Replay the commit (a completer whose final CAS was lost, or the sweep).
		const again = await c.getVersioned(id);
		await completeStock(s.ctx, id, {
			value: { ...(again!.value as OrderDoc), stock: "committing" },
			revision: again!.revision,
		});
		expect((await s.stock("p1")).onHand).toBe(4);
	});
});

describe("a released review order stays closed on webhook redelivery", () => {
	it("redelivered completion does not reopen it", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.complete(cs.id, { amount_total: 1 });
		const ev = await s.stripe.event("checkout.session.completed", cs.id);
		await deliver(s.ctx, ev);
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" })).ok,
		).toBe(true);
		await deliver(s.ctx, ev);
		const o = await s.order(orderKey(1));
		expect(o.status).toBe("canceled");
		expect((await s.stock("p1")).onHand).toBe(3);
	});
});

describe("auth errors never push orders to review; review still records a payment", () => {
	it("a 401 on retrieve leaves due orders pending", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		// The key was revoked: every Stripe call is now 401 (same prefix as the fake: later wins).
		s.http.on("*", "https://api.stripe.com/v1/checkout/sessions", {
			status: 401,
			json: { error: { message: "Invalid API Key" } },
		});
		await sweep(s.ctx, Date.now() + 60 * MIN);
		expect((await s.order(orderKey(1))).status).toBe("pending");
	});
	it("a payment that lands on an unreachable-review order is recorded", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const cs = s.stripe.only();
		s.stripe.sessions.delete(cs.id); // 404 for the sweep
		await sweep(s.ctx, Date.now() + 60 * MIN);
		expect((await s.order(orderKey(1))).status).toBe("review");
		const paid = {
			id: cs.id,
			url: null,
			status: "complete" as const,
			paymentStatus: "paid" as const,
			amountTotal: cs.amount_total,
			amountSubtotal: null,
			amountDiscount: null,
			amountShipping: null,
			amountTax: null,
			currency: "USD",
			paymentIntentId: "pi_1",
			email: null,
			shippingAddress: null,
			orderId: orderKey(1),
			expiresAt: 1,
			storeTag: (await s.order(orderKey(1))).store,
		};
		await applySession(s.ctx, paid);
		const o = await s.order(orderKey(1));
		expect(o.status).toBe("review");
		expect(o.paymentIntentId).toBe("pi_1");
		expect(o.amountPaid).toBe(cs.amount_total);
		expect(o.attention).toMatch(/PAID/);
	});
});

describe("a stale reserve after a held sale does not leave a hold", () => {
	it("reserve after commit is a noop", async () => {
		const s = await makeShop(nProducts(1, 5));
		const A = orderKey(1);
		await applyStock(s.ctx, "p1", { kind: "reserve", orderId: A, qty: 1 });
		await applyStock(s.ctx, "p1", { kind: "commit", orderId: A, qty: 1 });
		await applyStock(s.ctx, "p1", { kind: "reserve", orderId: A, qty: 1 });
		expect((await s.stock("p1")).holds).toEqual({});
	});
});

const productEvent = (at: string, data: Record<string, unknown>) => ({
	content: { id: "p1", status: "published", updatedAt: at, data: { title: "Mug", ...data } },
	collection: "products",
});

describe("stale product events lose to newer ones", () => {
	it("an older publish does not roll the price back", async () => {
		const s = await makeShop([]);
		await onAfterPublish(productEvent("2026-11-21T10:00:02.000Z", { price: 20 }), s.ctx);
		await onAfterPublish(productEvent("2026-11-21T10:00:01.000Z", { price: 10 }), s.ctx);
		expect(((await s.raw("products").get("p1")) as ProductDoc).price).toBe(2000);
	});
	it("an older publish does not re-activate an unpublished product", async () => {
		const s = await makeShop([]);
		await onAfterPublish(productEvent("2026-11-21T10:00:01.000Z", { price: 10 }), s.ctx);
		await onAfterUnpublish(
			{
				content: { id: "p1", status: "draft", updatedAt: "2026-11-21T10:00:03.000Z", data: {} },
				collection: "products",
			},
			s.ctx,
		);
		await onAfterPublish(productEvent("2026-11-21T10:00:02.000Z", { price: 10 }), s.ctx);
		expect(((await s.raw("products").get("p1")) as ProductDoc).active).toBe(false);
	});
	it("a newer publish after unpublish re-activates", async () => {
		const s = await makeShop([]);
		await onAfterPublish(productEvent("2026-11-21T10:00:01.000Z", { price: 10 }), s.ctx);
		await onAfterUnpublish(
			{
				content: { id: "p1", status: "draft", updatedAt: "2026-11-21T10:00:02.000Z", data: {} },
				collection: "products",
			},
			s.ctx,
		);
		await onAfterPublish(productEvent("2026-11-21T10:00:03.000Z", { price: 10 }), s.ctx);
		expect(((await s.raw("products").get("p1")) as ProductDoc).active).toBe(true);
	});
});
