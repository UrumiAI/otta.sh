import { describe, expect, test } from "vitest";
import {
	addLine,
	type CartDeps,
	createCart,
	expireHolds,
	getCart,
	removeLine,
	updateLine,
} from "../cart/use-cases.js";
import { currency } from "../money/cents.js";
import { idempotencyKey, sku } from "../money/ids.js";

export interface CartStoreHarness {
	deps: CartDeps;
	seedStock(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
	/** Advance the injected Clock (fast-forward past a hold's TTL). */
	advance(ms: number): void;
}

export interface CartStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");
const PAST_TTL_MS = 16 * 60 * 1000; // > the 15-minute default hold TTL

/**
 * The reusable cart behavioral spec (§1 cases 1–8), run against the fake first,
 * then each DB dialect via `describeEachDialect`. Exercises the **use-cases**
 * end-to-end over a wired `CartStore` + `InventoryStore`, so the no-oversell
 * guarantee is proven through the cart layer, not just the raw reserve port.
 */
export function cartStoreContract(
	makeHarness: () => Promise<CartStoreHarness>,
	opts: CartStoreContractOptions,
): void {
	describe(`cartStoreContract [${opts.dialect}]`, () => {
		test("add reserves via the inventory port and records the reservationId", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const res = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.line.qty).toBe(2);
			expect(typeof res.line.reservationId).toBe("string");
			expect(await h.onHand("SKU-1")).toBe(3);

			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(1);
			expect(cart?.lines[0]?.reservationId).toBe(res.line.reservationId);
		});

		test("add out-of-stock returns OUT_OF_STOCK, writes no line, leaves stock", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 3);
			const cartId = await createCart(h.deps, USD);
			const res = await addLine(h.deps, cartId, sku("SKU-1"), null, 4, idempotencyKey("k1"));
			expect(res).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(3);
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(0);
		});

		test("add is idempotent — a replayed add returns the same line and decrements once", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			expect(first.ok && replay.ok).toBe(true);
			if (!first.ok || !replay.ok) return;
			expect(replay.line.lineId).toBe(first.line.lineId);
			expect(replay.line.reservationId).toBe(first.line.reservationId);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		test("increase delta-reserves the difference", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");
			const up = await updateLine(h.deps, cartId, add.line.lineId, 4, idempotencyKey("k2"));
			expect(up.ok).toBe(true);
			if (!up.ok) return;
			expect(up.line.qty).toBe(4);
			expect(await h.onHand("SKU-1")).toBe(1); // 5 - 4
		});

		test("increase beyond stock leaves the line unchanged and reports OUT_OF_STOCK", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 3);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");
			const up = await updateLine(h.deps, cartId, add.line.lineId, 5, idempotencyKey("k2"));
			expect(up).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(1); // unchanged from the add
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines[0]?.qty).toBe(2);
		});

		test("increase is idempotent — a retried +N applies once", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");
			await updateLine(h.deps, cartId, add.line.lineId, 4, idempotencyKey("k2"));
			await updateLine(h.deps, cartId, add.line.lineId, 4, idempotencyKey("k2"));
			expect(await h.onHand("SKU-1")).toBe(1); // decremented to 4 once, not 6
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines[0]?.qty).toBe(4);
		});

		test("adjust replay after an intervening different-key adjust is a no-op returning the recorded result and moves no stock", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 100);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("kAdd"));
			if (!add.ok) throw new Error("seed add must succeed");
			// keyA: 2 → 3, then keyB: 3 → 5. On-hand: 100 → 98 → 97 → 95.
			const a = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("keyA"));
			const b = await updateLine(h.deps, cartId, add.line.lineId, 5, idempotencyKey("keyB"));
			expect(a.ok && b.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(95);

			// A LATE retry of keyA is ledger-first: it returns keyA's recorded
			// result (qty 3, the original response), re-applies NOTHING — no stock
			// movement, no reservation/line split-brain.
			const stale = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("keyA"));
			expect(stale.ok).toBe(true);
			if (!stale.ok) return;
			expect(stale.line.qty).toBe(3); // the recorded original response
			expect(await h.onHand("SKU-1")).toBe(95); // moved nothing
			// Current truth is untouched: the line and its hold still carry 5.
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines[0]?.qty).toBe(5);
		});

		test("decrease partial-releases and always succeeds", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 4, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");
			expect(await h.onHand("SKU-1")).toBe(1);
			const down = await updateLine(h.deps, cartId, add.line.lineId, 1, idempotencyKey("k2"));
			expect(down.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(4); // returned 3
		});

		test("remove releases the whole reservation; double-remove is a no-op", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");
			expect(await h.onHand("SKU-1")).toBe(3);

			const rm = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k2"));
			expect(rm.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(5);
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(0);

			// Double-remove returns stock only once.
			const again = await removeLine(h.deps, cartId, add.line.lineId, idempotencyKey("k3"));
			expect(again.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(5);
		});

		test("expired hold is released and stock returns; a lazy read racing the sweep does not double-return", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");
			expect(await h.onHand("SKU-1")).toBe(3);

			h.advance(PAST_TTL_MS);
			// Lazy-on-read and the scheduled sweep both hit the same lapsed hold.
			const lazy = await getCart(h.deps, cartId);
			const reclaimed = await expireHolds(h.deps);
			expect(lazy?.lines).toHaveLength(0);
			expect(reclaimed).toBe(0); // the lazy read already reclaimed it
			expect(await h.onHand("SKU-1")).toBe(5); // returned exactly once
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(0);
		});
	});
}
