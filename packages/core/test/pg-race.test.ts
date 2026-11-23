/**
 * The Postgres race tier: Otta Core's no-oversell and exactly-once guarantees
 * under REAL concurrency. Every racer is its own context over its own Kysely
 * instance with its own `pg` pool (one connection), all on one database, so
 * the compare-and-set conflicts happen in Postgres (a conditional UPDATE that
 * waits on the row lock and re-checks the revision), not in the JS event loop.
 *
 * Skipped unless PG_CONNECTION_STRING is set (SQLite has one connection and
 * cannot race). PG_RACE_ITERATIONS overrides the iteration count (default 30).
 */
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { placeOrder } from "../src/checkout.js";
import type { OrderDoc } from "../src/model.js";
import { applyStock, held, type StockOp } from "../src/stock.js";
import { sweep } from "../src/sweep.js";
import {
	deliver,
	invariants,
	joinShop,
	makeShop,
	orderKey,
	type ProductSeed,
	type Shop,
} from "./fixtures.js";
import { createTestDb, DIALECT, type HostDb } from "./harness.js";

const ITER = Number(process.env["PG_RACE_ITERATIONS"] ?? 30);
const T = 300_000;
const HOUR = 3_600_000;

/** Lost compareAndSet calls observed across all racers, per scenario (evidence the DB raced). */
const lost: Record<string, Record<string, number>> = {};
const tally: Record<string, Record<string, number>> = {};
const bump = (m: Record<string, Record<string, number>>, k: string, sub: string, n = 1) => {
	m[k] ??= {};
	m[k][sub] = (m[k][sub] ?? 0) + n;
};
afterAll(() => {
	if (DIALECT === "postgres")
		console.log("[pg-race] lost CAS:", JSON.stringify(lost), "outcomes:", JSON.stringify(tally));
});

interface World {
	base: Shop;
	racers: Shop[];
	drop(): Promise<void>;
}

/** One fresh database, a seeding shop, and `n` racing contexts with one connection each. */
async function world(products: ProductSeed[], n: number): Promise<World> {
	const tdb = await createTestDb();
	const base = await makeShop(products, { db: tdb.db });
	const racers: Shop[] = [];
	for (let i = 0; i < n; i++) {
		const db: HostDb = tdb.connect(1);
		await sql`select 1`.execute(db); // open the connection now, so the race starts together
		racers.push(await joinShop(base, db));
	}
	return { base, racers, drop: () => tdb.drop() };
}

function countLost(scenario: string, shops: Shop[]) {
	for (const s of shops)
		for (const [c, n] of Object.entries(s.casLost())) bump(lost, scenario, c, n);
}

const jitter = (maxMs: number) =>
	new Promise((r) => setTimeout(r, Math.floor(Math.random() * (maxMs + 1))));

function shuffle<T>(a: T[]): T[] {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

describe.skipIf(DIALECT !== "postgres")("Postgres races", () => {
	it("is really on Postgres, and racers use separate backends", async () => {
		const w = await world([{ id: "p1", price: 10, stock: 1 }], 3);
		try {
			const pids = new Set<number>();
			for (const r of w.racers) {
				const row = await sql<{
					pid: number;
					v: string;
				}>`select pg_backend_pid() as pid, version() as v`.execute(r.db);
				expect(row.rows[0]!.v).toMatch(/^PostgreSQL/);
				pids.add(row.rows[0]!.pid);
			}
			expect(pids.size).toBe(3);
		} finally {
			await w.drop();
		}
	});

	// (a) is split: SAFETY (never oversold, every hold accounted for) and
	// LIVENESS (exactly 3 buyers hold, nobody gets an error). Both from the same runs.
	const aLive: string[] = [];
	it(
		"(a) 20 buyers race for stock 3 via placeOrder: never oversold, holds consistent",
		async () => {
			const bad: string[] = [];
			for (let k = 0; k < ITER; k++) {
				const w = await world([{ id: "p1", price: 10, stock: 3 }], 20);
				try {
					const settled = await Promise.allSettled(
						w.racers.map((s, i) =>
							placeOrder({ key: orderKey(i + 1), lines: [{ productId: "p1", qty: 1 }] }, s.ctx),
						),
					);
					countLost("a", w.racers);
					const rs = settled.map((x) =>
						x.status === "fulfilled"
							? (x.value as { ok: boolean; code?: string })
							: {
									ok: false,
									code: "THREW",
									error: String((x.reason as Error)?.message ?? x.reason),
								},
					);
					for (const r of rs) bump(tally, "a", r.ok ? "held" : r.code!);
					const winners = rs.filter((r) => r.ok).length;
					const st = await w.base.stock("p1");
					const nHolds = Object.keys(st.holds).length;
					// safety
					if (st.onHand !== 3) bad.push(`k=${k} onHand ${st.onHand}`);
					if (held(st) > st.onHand)
						bad.push(`k=${k} OVERSOLD held ${held(st)} > onHand ${st.onHand}`);
					if (nHolds !== winners) bad.push(`k=${k} holds ${nHolds} != winners ${winners}`);
					for (const [i, r] of rs.entries()) {
						const key = orderKey(i + 1);
						const o = await w.base.order(key);
						if (r.ok && !(o?.status === "pending" && o.stock === "held" && st.holds[key] === 1))
							bad.push(`k=${k} winner ${i + 1} is ${o?.status}/${o?.stock}`);
						// A loser either never got an order (refused by the stock pre-check) or
						// lost the reserve race and was canceled. Never a hold.
						if (!r.ok && (key in st.holds || (o !== null && o.status !== "canceled")))
							bad.push(
								`k=${k} loser ${i + 1} (${r.code}) is ${o?.status}/${o?.stock}, hold ${st.holds[key] ?? 0}`,
							);
					}
					bad.push(...(await invariants(w.base, { p1: 3 })).map((p) => `k=${k} ${p}`));
					// Whatever a request left half-done, the sweep finishes: no order keeps its flag.
					let runs = 0;
					const flagged = async () =>
						(await w.base.raw("orders").query({ where: { stockPending: 1 }, limit: 100 })).items
							.length;
					while ((await flagged()) > 0 && runs < 20) {
						await sweep(w.base.ctx, Date.now() + 10 * 60_000);
						runs++;
					}
					bump(tally, "a", "sweepRunsToConverge", runs);
					if ((await flagged()) > 0) bad.push(`k=${k} sweep did not converge`);
					const after = await w.base.stock("p1");
					if (after.onHand !== 3 || Object.keys(after.holds).length !== winners)
						bad.push(`k=${k} after sweep ${JSON.stringify(after.holds)}`);
					bad.push(...(await invariants(w.base, { p1: 3 })).map((p) => `k=${k} after sweep: ${p}`));
					// liveness
					if (winners !== 3) aLive.push(`k=${k} winners ${winners}`);
					for (const [i, r] of rs.entries()) {
						if (r.ok || r.code === "OUT_OF_STOCK") continue;
						const o = await w.base.order(orderKey(i + 1));
						aLive.push(
							`k=${k} buyer ${i + 1}: ${r.code}${"error" in r ? ` (${r.error})` : ""}, order ${o?.status}/${o?.stock}/pending=${o?.stockPending}`,
						);
					}
				} finally {
					await w.drop();
				}
			}
			expect(bad).toEqual([]);
		},
		T,
	);
	// Was a finding: losers threw when cancel()'s inline release lost its CAS
	// rounds on the hot stock doc. The inline release is now best effort (the sweep
	// finishes it), so every loser gets a clean OUT_OF_STOCK.
	it("(a) liveness: exactly 3 hold and every loser is a clean OUT_OF_STOCK", () => {
		expect(aLive).toEqual([]);
	});

	it(
		"(b) one webhook event delivered 10x concurrently: stock taken once, paid once",
		async () => {
			const bad: string[] = [];
			for (let k = 0; k < ITER; k++) {
				const w = await world([{ id: "p1", price: 10, stock: 5 }], 10);
				try {
					const id = orderKey(1);
					const placed = (await placeOrder(
						{ key: id, lines: [{ productId: "p1", qty: 2 }] },
						w.base.ctx,
					)) as { ok: boolean };
					expect(placed.ok).toBe(true);
					const sess = w.base.stripe.only();
					w.base.stripe.complete(sess.id);
					const ev = await w.base.stripe.event("checkout.session.completed", sess.id);
					const rs = await Promise.all(w.racers.map((s) => deliver(s.ctx, ev)));
					countLost("b", w.racers);
					const statuses = rs.map((r) => r.status);
					const paid = rs.filter((r) => r.json["outcome"] === "paid").length;
					for (const r of rs)
						bump(tally, "b", `${r.status}:${String(r.json["outcome"] ?? r.json["error"] ?? "?")}`);
					if (statuses.some((x) => x !== 200)) bad.push(`k=${k} statuses ${statuses.join(",")}`);
					if (paid !== 1) bad.push(`k=${k} paid outcomes ${paid}`);
					const st = await w.base.stock("p1");
					const o = await w.base.order(id);
					if (st.onHand !== 3 || held(st) !== 0)
						bad.push(`k=${k} stock onHand ${st.onHand} held ${held(st)}`);
					if (st.applied.filter((x) => x === `${id}:c`).length !== 1)
						bad.push(`k=${k} commit records ${JSON.stringify(st.applied)}`);
					if (Object.keys(st.sold).length !== 0) bad.push(`k=${k} unexpected unheld sale`);
					if (
						!(
							o.status === "paid" &&
							o.stock === "committed" &&
							o.stockPending === 0 &&
							o.attention === null
						)
					)
						bad.push(`k=${k} order ${o.status}/${o.stock}/${o.stockPending}/${o.attention}`);
					bad.push(...(await invariants(w.base, { p1: 5 })).map((p) => `k=${k} ${p}`));
				} finally {
					await w.drop();
				}
			}
			expect(bad).toEqual([]);
		},
		T,
	);

	it(
		"(c) webhook completion races the sweep's expire path (Stripe linearizable): exactly one wins",
		async () => {
			const bad: string[] = [];
			for (let k = 0; k < ITER; k++) {
				const w = await world([{ id: "p1", price: 10, stock: 5 }], 2);
				const [hook, sweeper] = w.racers as [Shop, Shop];
				try {
					const id = orderKey(1);
					await placeOrder({ key: id, lines: [{ productId: "p1", qty: 2 }] }, w.base.ctx);
					const sess = w.base.stripe.only();
					// The buyer pays at a random moment while the sweep (past the session
					// window) asks Stripe to expire it. The fake Stripe is linearizable:
					// whichever of pay/expire reaches it first wins, and Stripe then sends
					// the matching webhook event, which lands concurrently with the sweep.
					const buyer = (async () => {
						await jitter(6);
						const paidFirst = sess.status === "open";
						if (paidFirst) w.base.stripe.complete(sess.id);
						const type = paidFirst ? "checkout.session.completed" : "checkout.session.expired";
						return deliver(hook.ctx, await w.base.stripe.event(type, sess.id));
					})();
					const swept = (async () => {
						await jitter(2);
						return sweep(sweeper.ctx, Date.now() + 2 * HOUR);
					})();
					const [d] = await Promise.all([buyer, swept]);
					countLost("c", [hook, sweeper]);
					if (d.status !== 200) bad.push(`k=${k} webhook ${d.status} ${JSON.stringify(d.json)}`);
					const o = await w.base.order(id);
					const st = await w.base.stock("p1");
					bump(tally, "c", `${o.status}/stripe:${sess.status}`);
					if (o.status === "paid") {
						if (sess.status !== "complete") bad.push(`k=${k} paid but Stripe ${sess.status}`);
						if (
							!(
								o.stock === "committed" &&
								st.onHand === 3 &&
								held(st) === 0 &&
								o.attention === null
							)
						)
							bad.push(
								`k=${k} paid but ${o.stock} onHand ${st.onHand} held ${held(st)} attention ${o.attention}`,
							);
					} else if (o.status === "expired") {
						if (sess.status !== "expired") bad.push(`k=${k} expired but Stripe ${sess.status}`);
						if (!(o.stock === "released" && st.onHand === 5 && held(st) === 0))
							bad.push(`k=${k} expired but ${o.stock} onHand ${st.onHand} held ${held(st)}`);
					} else bad.push(`k=${k} neither won: ${o.status}/${o.stock}`);
					if (o.stockPending !== 0) bad.push(`k=${k} sweep flag left set`);
					bad.push(...(await invariants(w.base, { p1: 5 })).map((p) => `k=${k} ${p}`));
				} finally {
					await w.drop();
				}
			}
			expect(bad).toEqual([]);
		},
		T,
	);

	it(
		"(c') adversarial: a completed webhook and the sweep's EXPIRED view hit the order together; stock taken exactly once",
		async () => {
			// Stripe asserts both (a late payment on a session the sweep saw expired).
			// Exactly one transition wins the order first: paid (held commit) or
			// expired -> released, then the payment lands as an unheld sale flagged
			// PAID_WHILE_EXPIRED. Either way the units come off on-hand exactly once.
			const bad: string[] = [];
			for (let k = 0; k < ITER; k++) {
				const w = await world([{ id: "p1", price: 10, stock: 5 }], 2);
				const [hook, sweeper] = w.racers as [Shop, Shop];
				try {
					const id = orderKey(1);
					await placeOrder({ key: id, lines: [{ productId: "p1", qty: 2 }] }, w.base.ctx);
					const sess = w.base.stripe.only();
					w.base.stripe.complete(sess.id);
					const ev = await w.base.stripe.event("checkout.session.completed", sess.id);
					sess.status = "expired"; // what the sweep's retrieve now reports
					const [d, sw] = await Promise.all([
						(async () => (await jitter(3), deliver(hook.ctx, ev)))(),
						(async () => (await jitter(3), sweep(sweeper.ctx, Date.now() + 2 * HOUR)))(),
					]);
					countLost("c'", [hook, sweeper]);
					const o: OrderDoc = await w.base.order(id);
					const st = await w.base.stock("p1");
					bump(tally, "c'", `${o.status}/${o.attention ?? "-"}/sweepExpired:${sw.expired}`);
					if (d.status !== 200) bad.push(`k=${k} webhook ${d.status} ${JSON.stringify(d.json)}`);
					if (!(o.status === "paid" && o.stock === "committed" && o.stockPending === 0))
						bad.push(`k=${k} order ${o.status}/${o.stock}/${o.stockPending}`);
					if (st.onHand !== 3 || held(st) !== 0)
						bad.push(`k=${k} onHand ${st.onHand} held ${held(st)}`);
					const late = o.attention === "PAID_WHILE_EXPIRED";
					if (late !== o.unheldSale)
						bad.push(`k=${k} attention ${o.attention} but unheldSale ${o.unheldSale}`);
					if (late && st.sold[id] !== 2) bad.push(`k=${k} late sale not recorded in sold`);
					if (!late && (o.attention !== null || id in st.sold))
						bad.push(`k=${k} held sale but attention ${o.attention}`);
					bad.push(...(await invariants(w.base, { p1: 5 })).map((p) => `k=${k} ${p}`));
				} finally {
					await w.drop();
				}
			}
			expect(bad).toEqual([]);
		},
		T,
	);

	it(
		"(d) commit + release + stale reserves + a fresh reserve on one stock doc",
		async () => {
			const bad: string[] = [];
			const A = orderKey(0xa),
				B = orderKey(0xb),
				C = orderKey(0xc);
			for (let k = 0; k < ITER; k++) {
				const ops: StockOp[] = [
					{ kind: "commit", orderId: A, qty: 2 },
					{ kind: "commit", orderId: A, qty: 2 }, // duplicate (redelivery)
					{ kind: "release", orderId: B },
					{ kind: "release", orderId: B }, // duplicate
					{ kind: "reserve", orderId: A, qty: 2 }, // stale replay of A's reserve
					{ kind: "reserve", orderId: B, qty: 1 }, // stale replay of B's reserve
					{ kind: "reserve", orderId: C, qty: 1 }, // a fresh buyer
				];
				const w = await world([{ id: "p1", price: 10, stock: 5 }], ops.length);
				try {
					for (const op of [
						{ kind: "reserve", orderId: A, qty: 2 },
						{ kind: "reserve", orderId: B, qty: 1 },
					] as const)
						expect((await applyStock(w.base.ctx, "p1", op)).ok).toBe(true);
					const order = shuffle(ops.map((op, i) => ({ op, s: w.racers[i]! })));
					const rs = await Promise.all(order.map(({ op, s }) => applyStock(s.ctx, "p1", op)));
					countLost("d", w.racers);
					for (const [i, r] of rs.entries())
						if (!r.ok) bad.push(`k=${k} ${order[i]!.op.kind} ${r.code}`);
					const st = await w.base.stock("p1");
					bump(tally, "d", JSON.stringify(st.holds) === JSON.stringify({ [C]: 1 }) ? "ok" : "bad");
					if (st.onHand !== 3) bad.push(`k=${k} onHand ${st.onHand}`);
					if (JSON.stringify(st.holds) !== JSON.stringify({ [C]: 1 }))
						bad.push(`k=${k} holds ${JSON.stringify(st.holds)}`);
					if (Object.keys(st.sold).length !== 0) bad.push(`k=${k} sold ${JSON.stringify(st.sold)}`);
					for (const rec of [`${A}:c`, `${B}:x`])
						if (st.applied.filter((x) => x === rec).length !== 1)
							bad.push(`k=${k} ${rec} x${st.applied.filter((x) => x === rec).length}`);
				} finally {
					await w.drop();
				}
			}
			expect(bad).toEqual([]);
		},
		T,
	);
});
