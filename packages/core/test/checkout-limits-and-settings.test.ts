/** Regression tests: checkout bounds, settings validation, currencies, replays, admin rules, pruning. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { updateOrder } from "../src/orders.js";
import { onAfterPublish, onAfterUnpublish } from "../src/products.js";
import { PRUNE_AFTER_DAYS, sweep } from "../src/sweep.js";
import {
	callRoute,
	deliver,
	linesFor,
	makeShop,
	nProducts,
	orderKey,
	type Shop,
} from "./fixtures.js";

describe("relative URLs with no site URL fail as NOT_CONFIGURED", () => {
	it("refuses before creating an order or holding stock", async () => {
		const s = await makeShop(nProducts(1, 3));
		(s.ctx as unknown as { site: { url: string } }).site.url = "";
		const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
		expect(await s.raw("orders").get(orderKey(1))).toBeNull();
		expect((await s.stock("p1")).holds).toEqual({});
		expect(s.stripe.sessions.size).toBe(0);
	});
});

const get = (s: Shop, n = 1) => callRoute(s.ctx, "order", { id: orderKey(n), key: "" });
const key = async (s: Shop, n = 1) => (await s.order(orderKey(n))).orderKey;
const read = async (s: Shop, n = 1) =>
	callRoute(s.ctx, "order", { id: orderKey(n), key: await key(s, n) });

describe("the order page settles from Stripe when the webhook never arrives", () => {
	it("paid at Stripe, no webhook: the GET reports paid and takes stock once", async () => {
		const s = await makeShop(nProducts(8, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(8) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		const k = await key(s);
		s.resetCalls();
		const r = await callRoute(s.ctx, "order", { id: orderKey(1), key: k });
		expect(s.calls().total).toBe(25); // 1 + settings 1 + kv get/set 2 + retrieve 1 + (1 + 2*8 + 1 + stamp delete 1) + re-read 1, under 30
		expect(r.order.status).toBe("paid");
		expect((await s.allStock()).map((d) => [d.onHand, Object.keys(d.holds).length])).toEqual(
			Array.from({ length: 8 }, () => [4, 0]),
		);
		// A later webhook and another poll change nothing.
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		expect((await read(s)).order.status).toBe("paid");
		expect((await s.stock("p1")).onHand).toBe(4);
	});

	it("still open at Stripe: one retrieve, no change", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const before = s.http.requests.length;
		const r = await read(s);
		expect(r.order.status).toBe("pending");
		const sent = s.http.requests.slice(before);
		expect(sent.map((q) => q.method)).toEqual(["GET"]);
		expect(sent[0]!.url).toBe(`https://api.stripe.com/v1/checkout/sessions/${s.stripe.only().id}`);
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
	});

	it("a wrong key never reaches Stripe", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const before = s.http.requests.length;
		expect((await get(s)).ok).toBe(false);
		expect(s.http.requests.length).toBe(before);
	});

	it("Stripe down: answers pending instead of failing", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.http.on("GET", "https://api.stripe.com/v1/checkout/sessions/", {
			status: 503,
			json: { error: { message: "down" } },
		});
		const r = await read(s);
		expect([r.ok, r.order.status]).toEqual([true, "pending"]);
	});

	it("a paid order does not call Stripe again", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		const before = s.http.requests.length;
		expect((await read(s)).order.status).toBe("paid");
		expect(s.http.requests.length).toBe(before);
	});
});

describe("settings that are filled in but invalid refuse checkout", () => {
	for (const [name, bad] of [
		["currency", { currency: "EURO" }],
		["currency Stripe takes differently (UGX)", { currency: "UGX" }],
		["three-decimal shipping not a multiple of 10", { currency: "KWD", flatShipping: 1005 }],
		["negative shipping", { flatShipping: -5 }],
		["fractional shipping", { flatShipping: "2.5" }],
		["bad ship-to country", { shippingCountries: "DE, Germany" }],
		["max qty out of range", { maxQtyPerLine: 0 }],
	] as const) {
		it(name, async () => {
			const s = await makeShop(nProducts(1, 3));
			s.kv.seedSettings(bad);
			const r = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
			expect(r).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
			expect(s.stripe.sessions.size).toBe(0);
		});
	}
	it("empty values use the defaults", async () => {
		const s = await makeShop(nProducts(1, 3));
		s.kv.seedSettings({ flatShipping: "", maxQtyPerLine: "", shippingCountries: "" });
		expect((await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).ok).toBe(true);
	});
});

describe("bounds on the public checkout", () => {
	it("max quantity per product is the merchant's", async () => {
		const s = await makeShop(nProducts(1, 50));
		s.kv.seedSettings({ maxQtyPerLine: 2 });
		const r = await placeOrder({ key: orderKey(1), lines: [{ productId: "p1", qty: 3 }] }, s.ctx);
		expect(r).toMatchObject({ ok: false, code: "INVALID_LINES" });
		expect((await s.stock("p1")).holds).toEqual({});
	});
	it("open checkouts are capped; a replay of an existing key still works", async () => {
		const s = await makeShop(nProducts(1, 50));
		s.kv.seedSettings({ maxOpenCheckouts: 2 });
		const a = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect((await placeOrder({ key: orderKey(2), lines: linesFor(1) }, s.ctx)).ok).toBe(true);
		expect(await placeOrder({ key: orderKey(3), lines: linesFor(1) }, s.ctx)).toMatchObject({
			ok: false,
			code: "BUSY",
		});
		expect(await s.raw("orders").get(orderKey(3))).toBeNull();
		expect(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).toEqual(a);
		expect(Object.keys((await s.stock("p1")).holds)).toHaveLength(2);
	});
});

describe("the sweep prunes old unpaid orders, never paid ones", () => {
	it("deletes expired+released orders past the retention, keeps the rest", async () => {
		const s = await makeShop(nProducts(1, 9));
		for (const n of [1, 2, 3]) await placeOrder({ key: orderKey(n), lines: linesFor(1) }, s.ctx);
		const sid = (n: number) => s.stripe.forOrder(orderKey(n))!.id;
		s.stripe.expire(sid(1));
		await deliver(s.ctx, await s.stripe.event("checkout.session.expired", sid(1)));
		s.stripe.complete(sid(2));
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sid(2)));
		expect((await s.order(orderKey(1))).stock).toBe("released");
		const day = 86_400_000;
		// Inside the retention: nothing pruned.
		expect((await sweep(s.ctx, Date.now() + 80 * day)).pruned).toBe(0);
		// Past it: the expired one goes; the paid one stays; #3 was still pending
		// and the earlier sweep expired it through Stripe, so it is pruned next time.
		const r = await sweep(s.ctx, Date.now() + PRUNE_AFTER_DAYS * day + day);
		expect(r.pruned).toBeGreaterThanOrEqual(1);
		expect(await s.raw("orders").get(orderKey(1))).toBeNull();
		expect((await s.order(orderKey(2))).status).toBe("paid");
		await sweep(s.ctx, Date.now() + 2 * PRUNE_AFTER_DAYS * day);
		expect(await s.raw("orders").get(orderKey(3))).toBeNull();
		expect((await s.order(orderKey(2))).status).toBe("paid");
		expect((await s.stock("p1")).onHand).toBe(8);
	});
});

describe("one key is one purchase", () => {
	it("a replayed key with different lines is refused, never sent to the first order's payment", async () => {
		const s = await makeShop(nProducts(2, 5));
		const a = await placeOrder({ key: orderKey(1), lines: [{ productId: "p1", qty: 1 }] }, s.ctx);
		expect(a.ok).toBe(true);
		const b = await placeOrder({ key: orderKey(1), lines: [{ productId: "p2", qty: 1 }] }, s.ctx);
		expect(b).toMatchObject({ ok: false, code: "KEY_REUSED" });
		expect(
			await placeOrder({ key: orderKey(1), lines: [{ productId: "p1", qty: 2 }] }, s.ctx),
		).toMatchObject({ code: "KEY_REUSED" });
		expect(
			await placeOrder(
				{ key: orderKey(1), lines: [{ productId: "p1", qty: 1 }], email: "x@y.z" },
				s.ctx,
			),
		).toMatchObject({ code: "KEY_REUSED" });
		expect((await s.stock("p2")).holds).toEqual({});
	});
	it("the same request in another line order or split lines is a replay", async () => {
		const s = await makeShop(nProducts(2, 5));
		const a = await placeOrder(
			{
				key: orderKey(1),
				lines: [
					{ productId: "p1", qty: 1 },
					{ productId: "p2", qty: 2 },
				],
			},
			s.ctx,
		);
		const lines = [
			{ productId: "p2", qty: 1 },
			{ productId: "p1", qty: 1 },
			{ productId: "p2", qty: 1 },
		];
		expect(await placeOrder({ key: orderKey(1), lines }, s.ctx)).toEqual(a);
	});
});

describe("accept never claims money that did not move", () => {
	it("a review order with no payment recorded can only be released", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.sessions.delete(s.stripe.only().id); // 404: the sweep sends it to review, no payment
		await sweep(s.ctx, Date.now() + 60 * 60_000);
		expect((await s.order(orderKey(1))).status).toBe("review");
		const acc = await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "accept" });
		expect(acc).toMatchObject({ ok: false, code: "NO_PAYMENT" });
		expect((await s.order(orderKey(1))).status).toBe("review");
		expect((await s.stock("p1")).onHand).toBe(3);
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" })).ok,
		).toBe(true);
		expect((await s.stock("p1")).holds).toEqual({});
	});
	it("a mismatched payment can still be accepted", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id, { amount_total: 1 });
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "accept" })).ok,
		).toBe(true);
		expect((await s.stock("p1")).onHand).toBe(2);
	});
});

describe("set_stock never overwrites sales it did not see", () => {
	it("a retry after a sale is refused; a keyed retry is a no-op", async () => {
		const s = await makeShop(nProducts(1, 5));
		const set = (o: Record<string, unknown>) =>
			callRoute(s.ctx, "stock/set", { productId: "p1", ...o });
		expect(await set({ onHand: 10 })).toMatchObject({ ok: false, code: "BAD_INPUT" });
		expect((await set({ onHand: 10, expectedOnHand: 5, key: "k1" })).ok).toBe(true);
		// A sale happens, then the client retries the same call.
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		expect((await s.stock("p1")).onHand).toBe(9);
		expect((await set({ onHand: 10, expectedOnHand: 5, key: "k1" })).ok).toBe(true); // same key: no-op
		expect(await set({ onHand: 10, expectedOnHand: 5 })).toMatchObject({
			ok: false,
			code: "STOCK_CHANGED",
		});
		expect((await s.stock("p1")).onHand).toBe(9);
		expect((await set({ onHand: 20, expectedOnHand: 9 })).ok).toBe(true);
		expect((await s.stock("p1")).onHand).toBe(20);
	});
});

describe("small public-route rules", () => {
	it("a zero-total order is refused before holding stock", async () => {
		const s = await makeShop([{ id: "p1", price: 0, stock: 3 }], { shipping: 0 });
		expect(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).toMatchObject({
			ok: false,
			code: "FREE_ORDER",
		});
		expect((await s.stock("p1")).holds).toEqual({});
	});
	it("availability does not disclose products that are not on sale", async () => {
		const s = await makeShop(nProducts(1, 3));
		await onAfterUnpublish(
			{
				content: { id: "p1", status: "draft", updatedAt: "2999-01-01T00:00:00.000Z", data: {} },
				collection: "products",
			},
			s.ctx,
		);
		const r = await callRoute(s.ctx, "availability", { ids: "p1" });
		expect(r.products).toEqual({});
	});
});

describe("the cap counts orders still holding stock, not only pending ones", () => {
	it("a cart that cannot be filled is refused before any order or hold exists", async () => {
		const s = await makeShop([...nProducts(5, 10), { id: "p6", price: 10, stock: 0 }]);
		const lines = [1, 2, 3, 4, 5, 6].map((n) => ({ productId: `p${n}`, qty: 1 }));
		expect(await placeOrder({ key: orderKey(1), lines }, s.ctx)).toMatchObject({
			code: "OUT_OF_STOCK",
		});
		expect(await s.raw("orders").get(orderKey(1))).toBeNull();
		expect((await s.allStock()).every((d) => Object.keys(d.holds).length === 0)).toBe(true);
	});
	it("a canceled order that still has to release (lost a race) counts until the sweep releases it", async () => {
		const s = await makeShop(nProducts(6, 10));
		s.kv.seedSettings({ maxOpenCheckouts: 1 });
		await placeOrder({ key: orderKey(1), lines: linesFor(6) }, s.ctx);
		// As left by a cancel whose release lost its CAS rounds.
		await updateOrder(s.ctx, orderKey(1), (d) => ({
			...d,
			status: "canceled",
			stock: "releasing",
			stockPending: 1,
		}));
		expect((await s.order(orderKey(1))).open).toBe(1);
		expect(await placeOrder({ key: orderKey(2), lines: linesFor(1) }, s.ctx)).toMatchObject({
			code: "BUSY",
		});
		await sweep(s.ctx, Date.now() + 5 * 60_000);
		expect((await s.order(orderKey(1))).open).toBe(0);
		expect((await s.stock("p1")).holds).toEqual({});
		expect((await placeOrder({ key: orderKey(2), lines: linesFor(1) }, s.ctx)).ok).toBe(true);
	});
});

describe("retries, closed orders and stock set", () => {
	it("a retry of an existing order gets its checkout URL even after the product was unpublished", async () => {
		const s = await makeShop(nProducts(1, 3));
		const a = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		await onAfterUnpublish(
			{
				content: { id: "p1", status: "draft", updatedAt: "2999-01-01T00:00:00.000Z", data: {} },
				collection: "products",
			},
			s.ctx,
		);
		expect(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).toEqual(a);
		expect(await placeOrder({ key: orderKey(2), lines: linesFor(1) }, s.ctx)).toMatchObject({
			code: "PRODUCT_UNAVAILABLE",
		});
	});
	it("with the Stripe key removed, an abandoned reserving order is given up after its window", async () => {
		const s = await makeShop(nProducts(1, 3));
		s.stripe.failNextCreate(503);
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect((await s.order(orderKey(1))).stock).toBe("reserving");
		s.kv.seedSettings({ stripeSecretKey: "" });
		await sweep(s.ctx, Date.now() + 50 * 60_000);
		await sweep(s.ctx, Date.now() + 55 * 60_000);
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock, o.open]).toEqual(["canceled", "released", 0]);
		expect((await s.stock("p1")).holds).toEqual({});
	});
	it("prune never deletes an order that carries a payment", async () => {
		const s = await makeShop(nProducts(1, 3));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id, { amount_total: 1 });
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", s.stripe.only().id));
		expect(
			(await callRoute(s.ctx, "orders/resolve", { id: orderKey(1), action: "release" })).ok,
		).toBe(true);
		await sweep(s.ctx, Date.now() + 2 * PRUNE_AFTER_DAYS * 86_400_000);
		expect((await s.order(orderKey(1))).paymentIntentId).not.toBeNull();
	});
	it("an invalid currency setting never prices products in the fallback currency", async () => {
		const s = await makeShop([]);
		s.kv.seedSettings({ currency: "ISK" });
		await onAfterPublish(
			{
				content: {
					id: "p9",
					status: "published",
					updatedAt: "2026-11-22T00:00:00.000Z",
					data: { title: "X", price: 1500 },
				},
				collection: "products",
			},
			s.ctx,
		);
		s.kv.seedSettings({ currency: "USD" });
		expect(
			await placeOrder({ key: orderKey(1), lines: [{ productId: "p9", qty: 1 }] }, s.ctx),
		).toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
	});
	it("STOCK_CHANGED returns the current stock so the caller can retry", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx); // one held
		const r = await callRoute(s.ctx, "stock/set", {
			productId: "p1",
			onHand: 8,
			expectedOnHand: 4,
		});
		expect(r).toMatchObject({
			ok: false,
			code: "STOCK_CHANGED",
			stock: { onHand: 5, held: 1, available: 4 },
		});
		expect(
			(
				await callRoute(s.ctx, "stock/set", {
					productId: "p1",
					onHand: 8,
					expectedOnHand: r.stock.onHand,
				})
			).ok,
		).toBe(true);
	});
	it("availability is capped at 10", async () => {
		const s = await makeShop(nProducts(1, 500));
		expect((await callRoute(s.ctx, "availability", { ids: "p1" })).products.p1.available).toBe(10);
	});
});

describe("the order key never goes into the cancel URL", () => {
	it("a cancel URL with {ORDER_KEY} is a settings problem", async () => {
		const s = await makeShop(nProducts(1, 3));
		s.kv.seedSettings({ cancelUrl: "/cart?k={ORDER_KEY}" });
		expect(await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).toMatchObject({
			ok: false,
			code: "NOT_CONFIGURED",
		});
	});
});
