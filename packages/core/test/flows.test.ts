/** End-to-end flow tests for Otta Core: real storage, fake Stripe, real webhook route. */
import { afterEach, describe, expect, it } from "vitest";
import { stockSet } from "../src/admin.js";
import { placeOrder } from "../src/checkout.js";
import { sweep } from "../src/sweep.js";
import {
	callRoute,
	deliver,
	invariants,
	linesFor,
	makeShop,
	nProducts,
	orderKey,
	publish,
	type Shop,
} from "./fixtures.js";

const open: Shop[] = [];
const shop = async (...a: Parameters<typeof makeShop>) => {
	const s = await makeShop(...a);
	open.push(s);
	return s;
};
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
});

const place = (s: Shop, key: number, lines: Array<{ productId: string; qty: number }>) =>
	placeOrder({ key: orderKey(key), lines }, s.ctx) as Promise<any>;
const init = (n: number, stock = 5) =>
	Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i + 1}`, stock]));
const MIN = 60_000;

describe("A. bridge-call budget", () => {
	const rows: string[] = [];
	for (const n of [1, 3, 8]) {
		it(`n=${n}`, async () => {
			const s = await shop(nProducts(n));
			s.resetCalls();
			const r = await place(s, 1, linesFor(n));
			expect(r.ok).toBe(true);
			const placeCalls = s.calls();

			const sess = s.stripe.only();
			s.stripe.complete(sess.id);
			const paid = await s.stripe.event("checkout.session.completed", sess.id);
			s.resetCalls();
			expect((await deliver(s.ctx, paid)).status).toBe(200);
			const settleCalls = s.calls();

			const r2 = await place(s, 2, linesFor(n));
			expect(r2.ok).toBe(true);
			const sess2 = s.stripe.forOrder(orderKey(2))!;
			s.stripe.expire(sess2.id);
			const exp = await s.stripe.event("checkout.session.expired", sess2.id);
			s.resetCalls();
			expect((await deliver(s.ctx, exp)).status).toBe(200);
			const expCalls = s.calls();

			rows.push(
				`n=${n}  place=${placeCalls.total}  settle=${settleCalls.total}  expire=${expCalls.total}  (2n+4=${2 * n + 4})`,
			);
			process.stderr.write(
				`[budget] ${rows[rows.length - 1]}\n  place: ${JSON.stringify(placeCalls.byMethod)}\n`,
			);
			for (const c of [placeCalls, settleCalls, expCalls]) expect(c.total).toBeLessThanOrEqual(30);
			expect(settleCalls.total).toBe(2 * n + 6); // + the lookup-stamp delete and the setup page's webhook stamp
			expect(expCalls.total).toBe(2 * n + 6);
			// settings, open-order count, products query, stock pre-check, order create, 2n stock, Stripe, order update.
			expect(placeCalls.total).toBe(2 * n + 8); // + the recently-created count

			expect((await s.order(orderKey(1))).status).toBe("paid");
			expect((await s.order(orderKey(2))).status).toBe("expired");
			expect(await invariants(s, init(n))).toEqual([]);
		});
	}
});

describe("B. happy path", () => {
	it("place -> paid webhook -> fulfil", async () => {
		const s = await shop(nProducts(2));
		const r = await place(s, 1, [
			{ productId: "p1", qty: 2 },
			{ productId: "p2", qty: 1 },
		]);
		expect(r).toMatchObject({ ok: true, orderId: orderKey(1) });
		let o = await s.order(orderKey(1));
		expect(o).toMatchObject({
			status: "pending",
			stock: "held",
			stockPending: 0,
			total: 3000 + 500,
		});
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 2 });

		const sess = s.stripe.only();
		expect(sess.amount_total).toBe(3500);
		s.stripe.complete(sess.id);
		const w = await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		expect(w).toEqual({ status: 200, json: { received: true, outcome: "paid" } });
		o = await s.order(orderKey(1));
		expect(o).toMatchObject({
			status: "paid",
			stock: "committed",
			stockPending: 0,
			amountPaid: 3500,
			attention: null,
			email: "buyer@example.com",
		});
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(await s.stock("p2")).toMatchObject({ onHand: 4, holds: {} });

		const f = await callRoute(s.ctx, "orders/fulfil", { id: orderKey(1), tracking: "T1" });
		expect(f.ok).toBe(true);
		o = await s.order(orderKey(1));
		expect(o).toMatchObject({ status: "fulfilled", tracking: "T1", stock: "committed" });
		expect(await invariants(s, init(2))).toEqual([]);
	});
});

describe("C. duplicate webhook delivery", () => {
	it("same event twice, sequential and concurrent, never double commits", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		const ev = await s.stripe.event("checkout.session.completed", sess.id);
		expect((await deliver(s.ctx, ev)).json["outcome"]).toBe("paid");
		expect(await deliver(s.ctx, ev)).toEqual({
			status: 200,
			json: { received: true, outcome: "noop" },
		});
		const ev2 = await s.stripe.event("checkout.session.completed", sess.id);
		expect((await deliver(s.ctx, ev2)).json["outcome"]).toBe("noop");
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(await s.order(orderKey(1))).toMatchObject({
			status: "paid",
			stock: "committed",
			attention: null,
		});
	});
	it("concurrent duplicate deliveries commit once", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		const ev = await s.stripe.event("checkout.session.completed", sess.id);
		const rs = await Promise.all([deliver(s.ctx, ev), deliver(s.ctx, ev), deliver(s.ctx, ev)]);
		for (const r of rs) expect(r.status).toBe(200);
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(await invariants(s, init(1))).toEqual([]);
	});
});

describe("D. webhook before place-order finishes", () => {
	it("order update dies after Stripe create; paid webhook lands; replay", async () => {
		const s = await shop(nProducts(1));
		// Dry run in a twin shop is unnecessary: find the order-update call as the one after http.fetch.
		const probe = await shop(nProducts(1));
		await place(probe, 9, linesFor(1));
		const seq = probe.calls().sequence;
		const updateAt = seq.indexOf("http.fetch") + 2;
		expect(seq[updateAt - 1]).toBe("storage.orders.compareAndSet");

		s.resetCalls();
		s.failAt(updateAt);
		await expect(place(s, 1, [{ productId: "p1", qty: 2 }])).rejects.toThrow(/injected/);
		let o = await s.order(orderKey(1));
		expect(o).toMatchObject({ status: "pending", stock: "reserving", stripeSessionId: null });

		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		const w = await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		expect(w.json["outcome"]).toBe("paid");
		o = await s.order(orderKey(1));
		expect(o).toMatchObject({ status: "paid", stock: "committed", stripeSessionId: sess.id });
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });

		// DOCUMENTED: replay returns the non-ok ORDER_CLOSED result (never a checkout url for a paid order).
		const again = await place(s, 1, [{ productId: "p1", qty: 2 }]);
		expect(again).toMatchObject({ ok: false, code: "ORDER_CLOSED" });
		expect(s.stripe.sessions.size).toBe(1);
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(await invariants(s, init(1))).toEqual([]);
	});
});

describe("E. one key, two placeOrder calls", () => {
	it("sequential replay", async () => {
		const s = await shop(nProducts(1));
		const a = await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const b = await place(s, 1, [{ productId: "p1", qty: 2 }]);
		expect(b).toEqual(a);
		expect((await s.raw("orders").query({})).items).toHaveLength(1);
		expect(await s.stock("p1")).toMatchObject({ onHand: 5, holds: { [orderKey(1)]: 2 } });
		expect(s.stripe.sessions.size).toBe(1);
	});
	it("Promise.all concurrent", async () => {
		const s = await shop(nProducts(1));
		const rs = await Promise.all([
			place(s, 1, [{ productId: "p1", qty: 2 }]),
			place(s, 1, [{ productId: "p1", qty: 2 }]),
		]);
		expect(rs.map((r) => r.ok)).toEqual([true, true]);
		expect(rs[0].url).toBe(rs[1].url);
		expect((await s.raw("orders").query({})).items).toHaveLength(1);
		expect(await s.stock("p1")).toMatchObject({ holds: { [orderKey(1)]: 2 } });
		expect(s.stripe.sessions.size).toBe(1);
		const store = (await s.order(orderKey(1))).store;
		expect(s.stripe.creates.every((c) => c.idem === `otta-core-${store}-${orderKey(1)}`)).toBe(
			true,
		);
		expect(await invariants(s, init(1))).toEqual([]);
	});
});

describe("F. expiry racing completion", () => {
	it("expired then late completed: paid + attention, stock sold once", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.expire(sess.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.expired", sess.id));
		expect(await s.order(orderKey(1))).toMatchObject({ status: "expired", stock: "released" });
		expect(await s.stock("p1")).toMatchObject({ onHand: 5, holds: {} });
		s.stripe.complete(sess.id);
		const w = await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		expect(w.json["outcome"]).toBe("paid");
		const o = await s.order(orderKey(1));
		expect(o).toMatchObject({
			status: "paid",
			stock: "committed",
			stockPending: 0,
			attention: "PAID_WHILE_EXPIRED",
		});
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(await invariants(s, init(1))).toEqual([]);
	});
	it("completed then expired: stays paid, never released", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		const e = await s.stripe.event("checkout.session.expired", sess.id);
		expect((await deliver(s.ctx, e)).json["outcome"]).toBe("noop");
		expect(await s.order(orderKey(1))).toMatchObject({
			status: "paid",
			stock: "committed",
			attention: null,
		});
		const st = await s.stock("p1");
		expect(st).toMatchObject({ onHand: 3, holds: {} });
		expect(st.applied.filter((x) => x.endsWith(":x"))).toEqual([]);
	});
});

// Each case replays a flow once per crash point: about 2 s alone, more on a shared runner.
describe("G. crash at every await", { timeout: 30_000 }, () => {
	const N = 2;
	const lines = [
		{ productId: "p1", qty: 2 },
		{ productId: "p2", qty: 1 },
	];

	for (const after of [false, true]) {
		const mode = after ? "after effect" : "before effect";
		it(`placeOrder, ${mode}: replay converges`, async () => {
			const clean = await shop(nProducts(N));
			await place(clean, 1, lines);
			const T = clean.calls().total;
			const bad: string[] = [];
			for (let k = 1; k <= T; k++) {
				const s = await shop(nProducts(N));
				s.resetCalls();
				s.failAt(k, { after });
				try {
					await place(s, 1, lines);
				} catch {}
				s.failAt(null);
				const r = await place(s, 1, lines);
				const o = await s.order(orderKey(1));
				if (
					!r.ok ||
					o.status !== "pending" ||
					o.stock !== "held" ||
					!o.checkoutUrl ||
					o.stockPending !== 0
				)
					bad.push(`k=${k} replay -> ${JSON.stringify(r)} order=${o.status}/${o.stock}`);
				if (s.stripe.sessions.size !== 1) bad.push(`k=${k} sessions=${s.stripe.sessions.size}`);
				const sess = s.stripe.only();
				s.stripe.complete(sess.id);
				await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
				const o2 = await s.order(orderKey(1));
				if (o2.status !== "paid" || o2.stock !== "committed")
					bad.push(`k=${k} after pay ${o2.status}/${o2.stock}`);
				bad.push(...(await invariants(s, init(N))).map((p) => `k=${k} ${p}`));
			}
			expect(bad).toEqual([]);
		});

		it(`placeOrder, ${mode}: sweep-only converges to expired/canceled`, async () => {
			const clean = await shop(nProducts(N));
			await place(clean, 1, lines);
			const T = clean.calls().total;
			const bad: string[] = [];
			for (let k = 1; k <= T; k++) {
				const s = await shop(nProducts(N));
				s.resetCalls();
				s.failAt(k, { after });
				try {
					await place(s, 1, lines);
				} catch {}
				s.failAt(null);
				const t0 = Date.now();
				for (let i = 0; i < 3; i++) await sweep(s.ctx, t0 + 3 * MIN);
				for (let i = 0; i < 3; i++) await sweep(s.ctx, t0 + 60 * MIN);
				const o = (await s.raw("orders").get(orderKey(1))) as any;
				if (
					o &&
					(!["expired", "canceled"].includes(o.status) ||
						o.stock !== "released" ||
						o.stockPending !== 0)
				)
					bad.push(`k=${k} ${o.status}/${o.stock}/${o.stockPending}`);
				bad.push(...(await invariants(s, init(N))).map((p) => `k=${k} ${p}`));
			}
			expect(bad).toEqual([]);
		});

		for (const kind of ["completed", "expired"] as const) {
			it(`webhook ${kind}, ${mode}: redelivery and sweep converge`, async () => {
				const prep = async () => {
					const s = await shop(nProducts(N));
					await place(s, 1, lines);
					const sess = s.stripe.only();
					if (kind === "completed") s.stripe.complete(sess.id);
					else s.stripe.expire(sess.id);
					return { s, ev: await s.stripe.event(`checkout.session.${kind}`, sess.id) };
				};
				const { s: c, ev: cev } = await prep();
				c.resetCalls();
				await deliver(c.ctx, cev);
				const T = c.calls().total;
				const want = kind === "completed" ? "paid" : "expired";
				const wantStock = kind === "completed" ? "committed" : "released";
				const bad: string[] = [];
				for (const via of ["redeliver", "sweep"] as const)
					for (let k = 1; k <= T; k++) {
						const { s, ev } = await prep();
						s.resetCalls();
						s.failAt(k, { after });
						const first = await deliver(s.ctx, ev);
						s.failAt(null);
						// The last two calls are best-effort cleanups (the lookup-stamp delete and the
						// setup page's webhook stamp): the work is done, so a crash there still answers 200.
						if (first.status !== 500 && k < T - 1)
							bad.push(`${via} k=${k} first status ${first.status}`);
						if (via === "redeliver") {
							const second = await deliver(s.ctx, ev);
							if (second.status !== 200) bad.push(`k=${k} redelivery ${second.status}`);
						} else {
							for (let i = 0; i < 3; i++) await sweep(s.ctx, Date.now() + 60 * MIN);
						}
						const o = await s.order(orderKey(1));
						if (o.status !== want || o.stock !== wantStock || o.stockPending !== 0)
							bad.push(`${via} k=${k} ${o.status}/${o.stock}/${o.stockPending}`);
						bad.push(...(await invariants(s, init(N))).map((p) => `${via} k=${k} ${p}`));
					}
				expect(bad).toEqual([]);
			});
		}
	}
});

describe("H. out of stock", () => {
	it("last unit: first wins, second refused OUT_OF_STOCK before any order exists", async () => {
		const s = await shop([{ id: "p1", price: 10, stock: 1 }]);
		const a = await place(s, 1, [{ productId: "p1", qty: 1 }]);
		const b = await place(s, 2, [{ productId: "p1", qty: 1 }]);
		expect(a.ok).toBe(true);
		expect(b).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
		// The stock pre-check refuses it: no order, no hold. (A cancel after a lost
		// reserve race is covered by the race tests below.)
		expect(await s.order(orderKey(2))).toBeNull();
		expect(await s.stock("p1")).toMatchObject({ onHand: 1, holds: { [orderKey(1)]: 1 } });
		expect(s.stripe.sessions.size).toBe(1);
		// replay of the canceled key keeps failing the same way
		expect(await place(s, 2, [{ productId: "p1", qty: 1 }])).toMatchObject({
			ok: false,
			code: "OUT_OF_STOCK",
		});
		expect(await invariants(s, { p1: 1 })).toEqual([]);
	});
	it("concurrent for the last unit: exactly one wins", async () => {
		const s = await shop([{ id: "p1", price: 10, stock: 1 }]);
		const rs = await Promise.all([
			place(s, 1, [{ productId: "p1", qty: 1 }]),
			place(s, 2, [{ productId: "p1", qty: 1 }]),
		]);
		expect(rs.filter((r) => r.ok)).toHaveLength(1);
		expect(rs.filter((r) => !r.ok && r.code === "OUT_OF_STOCK")).toHaveLength(1);
		const st = await s.stock("p1");
		expect(Object.keys(st.holds)).toHaveLength(1);
		expect(await invariants(s, { p1: 1 })).toEqual([]);
	});
	it("second line out of stock: refused before the first line is held", async () => {
		const s = await shop([
			{ id: "p1", price: 10, stock: 5 },
			{ id: "p2", price: 10, stock: 0 },
		]);
		const r = await place(s, 1, [
			{ productId: "p1", qty: 1 },
			{ productId: "p2", qty: 1 },
		]);
		expect(r).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
		expect(await s.order(orderKey(1))).toBeNull();
		expect((await s.stock("p1")).holds).toEqual({});
	});
	it("lost CAS race on the stock doc still converges (benign rewrite)", async () => {
		const s = await shop([{ id: "p1", price: 10, stock: 3 }]);
		s.raceOnce("stock", "p1");
		const r = await place(s, 1, [{ productId: "p1", qty: 1 }]);
		expect(r.ok).toBe(true);
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(1)]: 1 });
		expect(await invariants(s, { p1: 3 })).toEqual([]);
	});
	it("lost race to a rival that takes the last unit -> OUT_OF_STOCK, rival hold intact", async () => {
		const s = await shop([{ id: "p1", price: 10, stock: 1 }]);
		const cur = await s.stock("p1");
		s.raceOnce("stock", "p1", { ...cur, holds: { [orderKey(77)]: 1 } });
		const r = await place(s, 1, [{ productId: "p1", qty: 1 }]);
		expect(r).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
		expect(await s.order(orderKey(1))).toMatchObject({
			status: "canceled",
			stock: "released",
			stockPending: 0,
		});
		expect((await s.stock("p1")).holds).toEqual({ [orderKey(77)]: 1 });
	});
	it("lost race during commit retries and commits once", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		s.raceOnce("stock", "p1");
		const w = await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		expect(w.status).toBe(200);
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
		expect(await s.order(orderKey(1))).toMatchObject({ status: "paid", stock: "committed" });
	});
});

describe("I. amount mismatch", () => {
	it("goes to review, hold kept, attention set", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id, { amount_total: 1 });
		const w = await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		expect(w.json["outcome"]).toBe("review");
		expect(await s.order(orderKey(1))).toMatchObject({
			status: "review",
			stock: "held",
			stockPending: 0,
			amountPaid: 1,
			attention: "AMOUNT_MISMATCH:1 USD",
		});
		expect(await s.stock("p1")).toMatchObject({ onHand: 5, holds: { [orderKey(1)]: 2 } });
		// a later expired event must not release a review order's hold
		s.stripe.expire(sess.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.expired", sess.id));
		expect(await s.stock("p1")).toMatchObject({ holds: { [orderKey(1)]: 2 } });
		expect(await invariants(s, init(1))).toEqual([]);
	});
	it("currency mismatch is also review", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 1 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id, { currency: "eur" });
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		expect(await s.order(orderKey(1))).toMatchObject({ status: "review", stock: "held" });
	});
});

describe("J. price snapshot", () => {
	it("editing the product after ordering leaves the order alone", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		await publish(s.ctx, { id: "p1", price: 99, stock: 5, title: "Renamed" }, "save");
		expect((await s.raw("products").get("p1")) as any).toMatchObject({
			price: 9900,
			title: "Renamed",
		});
		const o = await s.order(orderKey(1));
		expect(o.items).toEqual([
			{
				productId: "p1",
				variantId: null,
				sku: null,
				title: "Product p1",
				unitPrice: 1000,
				qty: 2,
				trackStock: true,
			},
		]);
		expect(o).toMatchObject({ subtotal: 2000, total: 2500 });
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id));
		const o2 = await s.order(orderKey(1));
		expect(o2).toMatchObject({ status: "paid", total: 2500, attention: null });
		expect(o2.items[0]).toMatchObject({ unitPrice: 1000, title: "Product p1" });
		// re-saving with unchanged content stock did not reset sold stock
		expect((await s.stock("p1")).onHand).toBe(3);
	});
});

describe("K. webhook HTTP status mapping", () => {
	it("bad signature -> 400", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, linesFor(1));
		const e = await s.stripe.event("checkout.session.completed", s.stripe.only().id);
		expect((await deliver(s.ctx, { body: e.body, sig: "t=1,v1=00" })).status).toBe(400);
		expect((await deliver(s.ctx, { body: e.body })).status).toBe(400);
		const tampered = new TextEncoder().encode(
			new TextDecoder().decode(e.body).replace("cs_test", "cs_best"),
		);
		expect((await deliver(s.ctx, { body: tampered, sig: e.sig })).status).toBe(400);
		expect((await s.order(orderKey(1))).status).toBe("pending");
	});
	it("missing webhook secret -> 503", async () => {
		const s = await shop(nProducts(1), { secrets: false });
		await place(s, 1, linesFor(1));
		const e = await s.stripe.event("checkout.session.completed", s.stripe.only().id);
		expect((await deliver(s.ctx, e)).status).toBe(503);
	});
	it("storage failure mid-settle -> 500, redelivery succeeds", async () => {
		const s = await shop(nProducts(1));
		await place(s, 1, [{ productId: "p1", qty: 2 }]);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		const e = await s.stripe.event("checkout.session.completed", sess.id);
		s.resetCalls();
		s.failAt(3);
		expect((await deliver(s.ctx, e)).status).toBe(500);
		expect((await deliver(s.ctx, e)).status).toBe(200);
		expect(await s.order(orderKey(1))).toMatchObject({ status: "paid", stock: "committed" });
		expect(await s.stock("p1")).toMatchObject({ onHand: 3, holds: {} });
	});
	it("unrelated event type is acknowledged with 200", async () => {
		const s = await shop(nProducts(1));
		const text = JSON.stringify({ id: "evt_x", type: "charge.succeeded", data: { object: {} } });
		const t = Math.floor(Date.now() / 1000);
		const k = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode("whsec_flow"),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${text}`));
		const sig = `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
		expect((await deliver(s.ctx, { body: new TextEncoder().encode(text), sig })).status).toBe(200);
	});
});

describe("OVERSOLD: a held sale paid after the merchant lowered stock below the holds", () => {
	it("commits to a negative on-hand and flags the order for the merchant", async () => {
		const s = await shop(nProducts(1, 3));
		expect((await place(s, 1, [{ productId: "p1", qty: 2 }])).ok).toBe(true);
		expect(
			((await stockSet({ productId: "p1", onHand: 1, expectedOnHand: 3 }, s.ctx)) as any).ok,
		).toBe(true);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		expect(
			(await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id))).status,
		).toBe(200);
		expect(await s.stock("p1")).toMatchObject({ onHand: -1, holds: {} });
		expect(await s.order(orderKey(1))).toMatchObject({ status: "paid", attention: "OVERSOLD" });
	});
	it("a paid order that stays within stock is not flagged", async () => {
		const s = await shop(nProducts(1, 3));
		expect((await place(s, 1, [{ productId: "p1", qty: 2 }])).ok).toBe(true);
		const sess = s.stripe.only();
		s.stripe.complete(sess.id);
		expect(
			(await deliver(s.ctx, await s.stripe.event("checkout.session.completed", sess.id))).status,
		).toBe(200);
		expect(await s.stock("p1")).toMatchObject({ onHand: 1 });
		expect((await s.order(orderKey(1))).attention).toBeNull();
	});
});
