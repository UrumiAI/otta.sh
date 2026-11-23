/** Regression tests: stores sharing a Stripe account, non-card sessions, sweep paging and upkeep. */
import { describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import { sweep } from "../src/sweep.js";
import { deliver, linesFor, makeShop, nProducts, orderKey } from "./fixtures.js";

/** Two Core stores (separate databases and install secrets) on ONE Stripe account. */
async function twoStores() {
	const a = await makeShop(nProducts(1, 5));
	const b = await makeShop(nProducts(1, 5));
	a.stripe.attach(b);
	b.kv.seedSettings({ _ipSalt: "b0b0".repeat(16) });
	return { a, b };
}

describe("two stores on one Stripe account never settle each other's orders", () => {
	it("same client-minted key in both stores; paying A's session never settles B (webhook, part E, order page)", async () => {
		const { a, b } = await twoStores();
		const K = orderKey(7);
		expect((await placeOrder({ key: K, lines: linesFor(1) }, a.ctx)).ok).toBe(true);
		// B's first create fails transiently: its order has no session yet (the case the review found).
		a.stripe.failNextCreate(503);
		expect((await placeOrder({ key: K, lines: linesFor(1) }, b.ctx)).ok).toBe(false);
		const sa = [...a.stripe.sessions.values()].find((x) => x.metadata["order_id"] === K)!;
		a.stripe.complete(sa.id);
		// The account's webhook reaches B too.
		const ev = await a.stripe.event("checkout.session.completed", sa.id);
		expect((await deliver(b.ctx, ev)).json).toMatchObject({ outcome: "unknown_order" });
		await sweep(b.ctx);
		const ob = await b.order(K);
		expect(ob.status).not.toBe("paid");
		expect((await b.stock("p1")).onHand).toBe(5);
		// A is settled normally.
		await deliver(a.ctx, ev);
		expect((await a.order(K)).status).toBe("paid");
	});
	it("the idempotency key and metadata carry the store tag", async () => {
		const { a, b } = await twoStores();
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, a.ctx);
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, b.ctx);
		const [ta, tb] = [(await a.order(orderKey(1))).store, (await b.order(orderKey(1))).store];
		expect(ta).not.toBe(tb);
		expect(a.stripe.creates.map((c) => c.idem)).toEqual([
			`otta-core-${ta}-${orderKey(1)}`,
			`otta-core-${tb}-${orderKey(1)}`,
		]);
		expect(a.stripe.sessions.size).toBe(2);
	});
});

describe("a non-card session whose expire is not confirmed never pins stock or stalls the sweep", () => {
	it("open after a failed expire: no URL, replays stop, sweep B expires it and releases", async () => {
		const s = await makeShop(nProducts(1, 5));
		let state = "open";
		let tag = "";
		let lostOnce = false; // the first expire is lost
		s.http.on("*", "https://api.stripe.com/v1/checkout/sessions", (req) => {
			if (req.method === "POST" && !req.url.endsWith("/expire"))
				tag = new URLSearchParams(req.body).get("metadata[otta_store]") ?? "";
			const sess = {
				id: "cs_m",
				object: "checkout.session",
				url: "https://checkout.stripe.test/m",
				status: state,
				payment_status: "unpaid",
				amount_total: 1000,
				currency: "usd",
				payment_intent: null,
				metadata: { order_id: orderKey(1), otta_store: tag },
				expires_at: 1,
				payment_method_types: ["card", "klarna"],
			};
			if (req.method === "POST" && req.url.endsWith("/expire")) {
				// The first expire is lost (503); later ones work, as Stripe's would.
				if (state === "open" && !lostOnce) {
					lostOnce = true;
					return { status: 503, json: { error: { message: "timeout" } } };
				}
				state = "expired";
				return { json: { ...sess, status: "expired" } };
			}
			return { json: sess };
		});
		const r1 = await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		expect(r1).toMatchObject({ ok: false, code: "CARD_NOT_OFFERED" });
		expect(JSON.stringify(r1)).not.toContain("checkout.stripe.test");
		const o = await s.order(orderKey(1));
		expect([o.status, o.stock, o.stockPending, o.stripeSessionId, o.checkoutUrl]).toEqual([
			"pending",
			"held",
			0,
			"cs_m",
			null,
		]);
		// A replay never gets a URL and never calls create again.
		const before = s.http.requests.length;
		expect((await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx)).ok).toBe(false);
		expect(s.http.requests.length).toBe(before);
		// Part A has nothing to do (no sweep flag); part B expires it after the window.
		await sweep(s.ctx, Date.now() + 45 * 60_000);
		// The expiry pass decides (expired, releasing); the next run's part A releases.
		expect((await s.order(orderKey(1))).status).toBe("expired");
		await sweep(s.ctx, Date.now() + 50 * 60_000);
		const after = await s.order(orderKey(1));
		expect([after.status, after.stock]).toEqual(["expired", "released"]);
		expect((await s.stock("p1")).holds).toEqual({});
	});
});

describe("a paging position Stripe does not know is dropped", () => {
	it("after a key switch, part E resets the position and records payments again", async () => {
		const s = await makeShop(nProducts(1, 5));
		s.kv.seedSettings({ _scanAfter: "cs_from_the_old_account" });
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		s.stripe.complete(s.stripe.only().id);
		s.http.on("GET", "https://api.stripe.com/v1/checkout/sessions?status=complete", (req) =>
			req.url.includes("starting_after=cs_from_the_old_account")
				? {
						status: 400,
						json: {
							error: {
								type: "invalid_request_error",
								code: "resource_missing",
								message: "No such checkout.session",
							},
						},
					}
				: {
						json: {
							object: "list",
							data: [...s.stripe.sessions.values()].filter((x) => x.status === "complete"),
							has_more: false,
						},
					},
		);
		await sweep(s.ctx);
		expect(s.kv.dump()["settings:_scanAfter"]).toBe("");
		await sweep(s.ctx);
		expect((await s.order(orderKey(1))).status).toBe("paid");
	});
});

describe("the payment-recording pass never starves the upkeep", () => {
	it("with thousands of foreign sessions, prune, the health stamp and the stamp cleanup still run, and paging stops early", async () => {
		const s = await makeShop(nProducts(1, 5));
		await placeOrder({ key: orderKey(1), lines: linesFor(1) }, s.ctx);
		const ours = s.stripe.only();
		// Older foreign sessions than any of our pending orders: one page is enough.
		for (let i = 0; i < 1000; i++)
			s.stripe.sessions.set(`cs_old_${i}`, {
				...ours,
				id: `cs_old_${i}`,
				status: "complete",
				payment_status: "paid",
				metadata: { order_id: "x", otta_store: "y" },
				created: (ours.created ?? 0) - 3600 - i,
			});
		await s.ctx.kv.set("chk:stale", Date.now() - 7_200_000);
		s.resetCalls();
		await sweep(s.ctx);
		const lists = s.calls().sequence.filter((x) => x === "http.fetch").length;
		expect(lists).toBe(1);
		expect(s.kv.dump()["health:lastSweep"]).toBeTruthy();
		expect("chk:stale" in s.kv.dump()).toBe(false);
	});
});
