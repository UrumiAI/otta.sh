/**
 * B-X1's read repair under concurrency, on Postgres — the only dialect where a
 * legacy row can break a query, and the only one that can race.
 *
 * The repair runs INSIDE a read that failed: the guard pages the collection with
 * no `where`/`orderBy` (the one query shape the host never casts to `jsonb`),
 * rewrites each unreadable row by compare-and-set, and re-runs the read once. Two
 * properties matter, and both are about writes the repair must not damage:
 *
 * 1. Many concurrent readers hitting the same broken collection all answer, and
 *    each row is repaired, not duplicated or lost.
 * 2. A legitimate writer racing the repair on the SAME document is never undone:
 *    the repair's compare-and-set loses to it and re-reads, so the order ends
 *    `paid` AND repaired — never `pending` (the repair overwriting the payment) and
 *    never paid-but-still-unreadable.
 */
import {
	cents,
	currency,
	findIllFormedText,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
} from "@otta-sh/domain";
import type { CreateOrderInput } from "@otta-sh/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { collectionOf } from "../src/index.js";
import { resetHealStateForTests } from "../src/well-formed-storage.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

const USD = currency("USD");
const ROUNDS = 6;
const READERS = 12;
const BAD = 5;

function orderInput(id: string): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: `cart-${id}`,
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: `${id}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId(`p-${id}`),
				sku: sku(`SKU-${id}`),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: reservationId(`res-${id}`),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
		shippingAddress: {
			name: "Asha Rao",
			line1: "12 Park Street",
			line2: null,
			city: "Kolkata",
			region: null,
			postalCode: "700016",
			country: "IN",
			email: null,
			phone: null,
		},
	};
}

describe.skipIf(!PG_ENABLED)("ill-formed text: read repair under concurrency [postgres]", () => {
	let db: Awaited<ReturnType<typeof makePgStorage>>;

	beforeAll(async () => {
		db = await makePgStorage(ORDER_LAYOUT, 16);
	});
	afterAll(async () => {
		await db?.close();
	});
	beforeEach(async () => {
		await db.reset();
		resetHealStateForTests();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	/** Five pending orders, each rewritten raw with a different poison. */
	async function plant(h: ReturnType<typeof makeOrderHarness>): Promise<string[]> {
		const raw = db.storage["orders"];
		if (raw === undefined) throw new Error("orders collection missing");
		const ids: string[] = [];
		for (let i = 0; i < BAD; i++) {
			const id = `ord-bad-${String(i)}`;
			await h.store.createFromCart(orderInput(id));
			const stored = (await raw.get(id)) as Record<string, unknown>;
			const address = stored["shippingAddress"] as Record<string, unknown>;
			const poison = ["\uD800", "\uDC00", "\u0000", "\uDE00\uD83D", "x\uDBFF"][i] ?? "\uD800";
			await raw.put(id, { ...stored, shippingAddress: { ...address, city: poison } });
			ids.push(id);
		}
		await h.store.createFromCart(orderInput("ord-clean"));
		return ids;
	}

	test(`${String(READERS)} concurrent readers over ${String(BAD)} legacy rows all answer, every round`, async () => {
		for (let round = 0; round < ROUNDS; round++) {
			await db.reset();
			const h = makeOrderHarness(db.storage);
			const bad = await plant(h);
			const results = await Promise.allSettled(
				Array.from({ length: READERS }, (_, k) =>
					k % 2 === 0
						? h.store.listOrders({}, { limit: 50 }).then((r) => r.orders.length)
						: h.store.listExpirable("2099-01-01T00:00:00.000Z").then((r) => r.length),
				),
			);
			for (const r of results) {
				expect(
					r.status,
					`round ${String(round)}: ${String((r as PromiseRejectedResult).reason)}`,
				).toBe("fulfilled");
				if (r.status === "fulfilled") expect(r.value).toBe(BAD + 1);
			}
			for (const id of bad) {
				const doc = await h.orders.get(id);
				expect(doc, id).not.toBeNull();
				expect(findIllFormedText(doc), id).toBeNull();
			}
		}
	});

	test("a payment racing the repair on the same order is never undone", async () => {
		for (let round = 0; round < ROUNDS; round++) {
			await db.reset();
			const h = makeOrderHarness(db.storage);
			const bad = await plant(h);
			const [paid, ...reads] = await Promise.all([
				Promise.all(bad.map((id) => h.store.markPaid(orderId(id)))),
				...Array.from({ length: READERS }, () => h.store.listOrders({}, { limit: 50 })),
			]);
			expect(paid.every(Boolean), `round ${String(round)}`).toBe(true);
			for (const r of reads) expect(r.orders).toHaveLength(BAD + 1);
			for (const id of bad) {
				const order = await h.store.getById(orderId(id));
				expect(order?.state, `${id} round ${String(round)}`).toBe("paid");
				expect(findIllFormedText(await h.orders.get(id)), id).toBeNull();
			}
			// And the sweep's list now sees only the one clean pending order.
			expect(await h.store.listExpirable("2099-01-01T00:00:00.000Z")).toEqual(["ord-clean"]);
		}
	});

	test("increments racing the repair lose nothing (review B, repro A7)", async () => {
		// A delta `updateIf` on a legacy row, beside where/orderBy queries and counts
		// over a collection holding several: the heal is a compare-and-set from a
		// fresh read, and a failed `updateIf` had no effect, so its retry is safe.
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (let round = 0; round < ROUNDS; round++) {
			await db.reset();
			resetHealStateForTests();
			const raw = db.storage["orders"];
			if (raw === undefined) throw new Error("orders collection missing");
			await raw.put("stock", { state: "s", n: 0, note: "bad\uD800" });
			for (let i = 0; i < 20; i++) {
				await raw.put(`o${String(i)}`, { state: "s", n: 1, note: i % 3 === 0 ? "x\u0000" : "ok" });
			}
			const c = collectionOf<Record<string, unknown>>(db.storage, "orders");
			const N = 30;
			const ops: Promise<unknown>[] = [];
			for (let i = 0; i < N; i++) {
				ops.push(c.updateIf("stock", { where: {}, delta: { n: { inc: 1 } } } as never));
				ops.push(c.query({ where: { state: "s" }, orderBy: { createdAt: "asc" } }));
				ops.push(c.count({ state: "s" }));
			}
			const settled = await Promise.allSettled(ops);
			expect(
				settled.filter((s) => s.status === "rejected"),
				`round ${String(round)}`,
			).toEqual([]);
			const final = (await c.get("stock")) as { n: number; note: string };
			expect(final.n, `round ${String(round)}`).toBe(N);
			expect(final.note).toBe("bad\uFFFD");
		}
	}, 120_000);
});
