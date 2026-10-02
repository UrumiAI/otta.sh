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
import { idempotencyKey, orderId as brandOrderId, sku } from "../money/ids.js";

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
		// A KEYED create is idempotent: the same key is the same cart. The storefront
		// keys the cart it starts in place of a spent one on that spent cart's id, so two
		// requests racing to replace it (a double-submitted "Add to cart") land in ONE
		// new cart instead of each minting its own and leaving the shopper in whichever
		// cookie arrived last.
		test("a keyed create returns the same cart for the same key; another key, or none, mints a fresh one", async () => {
			const h = await makeHarness();
			const key = idempotencyKey("rotate:cart-spent-1");
			const first = await h.deps.cartStore.create(USD, key);
			const again = await h.deps.cartStore.create(USD, key);
			expect(again).toBe(first);
			expect((await getCart(h.deps, first))?.state).toBe("active");
			const other = await h.deps.cartStore.create(USD, idempotencyKey("rotate:cart-spent-2"));
			const unkeyed = await createCart(h.deps, USD);
			expect(new Set([first, other, unkeyed]).size).toBe(3);
		});

		test("concurrent keyed creates converge on one cart", async () => {
			const h = await makeHarness();
			const key = idempotencyKey("rotate:cart-spent-race");
			const ids = await Promise.all([
				h.deps.cartStore.create(USD, key),
				h.deps.cartStore.create(USD, key),
				h.deps.cartStore.create(USD, key),
			]);
			expect(new Set(ids).size).toBe(1);
			expect((await getCart(h.deps, ids[0]!))?.state).toBe("active");
		});

		// The storefront retries a refused add on the replacement cart with the SAME
		// key. That is safe only because the refusal claimed nothing.
		test("an add refused CART_CHECKED_OUT records no mutation under its key", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-SPENT", 5);
			const spent = await createCart(h.deps, USD);
			await h.deps.cartStore.checkout(spent, brandOrderId("ord-spent-2"));
			const key = idempotencyKey("k-refused-add");
			expect(await addLine(h.deps, spent, sku("SKU-SPENT"), null, 1, key)).toEqual({
				ok: false,
				reason: "CART_CHECKED_OUT",
			});
			expect(await h.deps.cartStore.recordedMutation(key)).toBeNull();
			expect(await h.onHand("SKU-SPENT")).toBe(5);
		});

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

		// ── an add DECIDED out of stock retires its claim (QA U-16) ─────────
		// The add claims its key before it reserves, so a crash between the two
		// leaves a marker the sweep can follow to a dangling hold. An add whose
		// reserve was decided OUT_OF_STOCK has no hold and never will (the reserve
		// key is once-only), yet its claim stayed outstanding forever: on the
		// document store it pinned the cart's sweep deadline in the past and was
		// re-read on every tick. The use-case now retires it with `abandonClaim`.
		// What must NOT change is the replay: the same key still answers
		// OUT_OF_STOCK, writes no line and moves no stock.

		test("an out-of-stock add's same-key replay still answers OUT_OF_STOCK and moves nothing", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 3);
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(h.deps, cartId, sku("SKU-1"), null, 4, idempotencyKey("k1"));
			const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 4, idempotencyKey("k1"));
			expect(first).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(replay).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(3);
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
			// The probe that catches an adapter whose abandonClaim does nothing: the
			// claim reads back RETIRED — still not completed, so replays resume.
			expect(await h.deps.cartStore.recordedMutation(idempotencyKey("k1"))).toMatchObject({
				kind: "add",
				completed: false,
				abandoned: true,
			});

			// A fresh key for a quantity that fits is unaffected.
			const fits = await addLine(h.deps, cartId, sku("SKU-1"), null, 3, idempotencyKey("k2"));
			expect(fits.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(0);
		});

		test("abandonClaim never touches a COMPLETED add — its replay still returns the line", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!first.ok) throw new Error("seed add must succeed");

			await h.deps.cartStore.abandonClaim(cartId, idempotencyKey("k1"));

			const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			expect(replay.line.lineId).toBe(first.line.lineId);
			expect(await h.onHand("SKU-1")).toBe(3);
			const recorded = await h.deps.cartStore.recordedMutation(idempotencyKey("k1"));
			expect(recorded?.completed).toBe(true);
			expect(recorded?.abandoned).not.toBe(true);
		});

		test("abandonClaim of an unknown key, or on an unknown cart, is a quiet no-op", async () => {
			const h = await makeHarness();
			const cartId = await createCart(h.deps, USD);
			await expect(
				h.deps.cartStore.abandonClaim(cartId, idempotencyKey("never-claimed")),
			).resolves.toBeUndefined();
			await expect(
				h.deps.cartStore.abandonClaim("no-such-cart", idempotencyKey("k1")),
			).resolves.toBeUndefined();
			expect(await h.deps.cartStore.recordedMutation(idempotencyKey("never-claimed"))).toBeNull();
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

		// ── re-adding a sku that is already in the cart ─────────────────────
		// One line per sku, one reservation per physical line (phase-3 plan §4):
		// a second add of the same sku ADDS its qty to that line, moving stock by
		// delta on the line's own hold. It must never mint a second reservation
		// and orphan the first one (which only came back at TTL, via the sweep).

		test("re-adding a sku already in the cart adds to its line on the same hold — no orphan reservation", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 10);
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("k1"));
			if (!first.ok) throw new Error("seed add must succeed");

			const again = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k2"));
			expect(again.ok).toBe(true);
			if (!again.ok) return;
			expect(again.line.qty).toBe(3);
			expect(again.line.lineId).toBe(first.line.lineId);
			expect(again.line.reservationId).toBe(first.line.reservationId);
			// Held stock equals the one line's qty: 10 - 3.
			expect(await h.onHand("SKU-1")).toBe(7);

			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(1);
			expect(cart?.lines[0]?.qty).toBe(3);

			// Removing the line returns EVERYTHING the cart held — an orphaned first
			// hold would leave a unit stranded here until the sweep.
			const rm = await removeLine(h.deps, cartId, again.line.lineId, idempotencyKey("k3"));
			expect(rm.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(10);
		});

		test("a replayed re-add returns its recorded line and moves no further stock", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 10);
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("k1"));
			if (!first.ok) throw new Error("seed add must succeed");
			const again = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("k2"));
			const replay = await addLine(h.deps, cartId, sku("SKU-1"), null, 1, idempotencyKey("k2"));
			expect(again.ok && replay.ok).toBe(true);
			if (!again.ok || !replay.ok) return;
			expect(replay.line.lineId).toBe(first.line.lineId);
			expect(replay.line.qty).toBe(2);
			expect(await h.onHand("SKU-1")).toBe(8); // 1 + 1 held, once each

			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(1);
			expect(cart?.lines[0]?.qty).toBe(2);

			// The lapsed hold returns exactly the line's qty — no second hold remains.
			h.advance(PAST_TTL_MS);
			expect((await getCart(h.deps, cartId))?.lines).toHaveLength(0);
			expect(await expireHolds(h.deps)).toBe(0);
			expect(await h.onHand("SKU-1")).toBe(10);
		});

		test("a re-add beyond stock reports OUT_OF_STOCK and leaves the line and its hold untouched", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 3);
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!first.ok) throw new Error("seed add must succeed");

			const again = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k2"));
			expect(again).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(1);
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(1);
			expect(cart?.lines[0]?.qty).toBe(2);
			expect(cart?.lines[0]?.reservationId).toBe(first.line.reservationId);
		});

		test("re-adding a digital sku adds to its line and reserves nothing", async () => {
			const h = await makeHarness();
			const cartId = await createCart(h.deps, USD);
			const first = await addLine(
				h.deps,
				cartId,
				sku("EBOOK-1"),
				null,
				1,
				idempotencyKey("k1"),
				"digital",
			);
			if (!first.ok) throw new Error("seed add must succeed");
			const again = await addLine(
				h.deps,
				cartId,
				sku("EBOOK-1"),
				null,
				2,
				idempotencyKey("k2"),
				"digital",
			);
			expect(again.ok).toBe(true);
			if (!again.ok) return;
			expect(again.line.lineId).toBe(first.line.lineId);
			expect(again.line.qty).toBe(3);
			expect(again.line.reservationId).toBeNull();
			const cart = await getCart(h.deps, cartId);
			expect(cart?.lines).toHaveLength(1);
			expect(cart?.lines[0]?.qty).toBe(3);
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

		// The cron sweep runs in a time-boxed hook: its LIST must be bounded, not only
		// the flips after it, or a large backlog is read whole before any check runs.
		test("listExpired honours a limit, returning at most that many lapsed holds", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 9);
			for (const n of [1, 2, 3]) {
				const cartId = await createCart(h.deps, USD);
				const add = await addLine(
					h.deps,
					cartId,
					sku("SKU-1"),
					null,
					1,
					idempotencyKey(`lim-${String(n)}`),
				);
				if (!add.ok) throw new Error("seed add must succeed");
			}
			h.advance(PAST_TTL_MS);
			const now = h.deps.clock.now().toISOString();
			expect(await h.deps.cartStore.listExpired(now, now, { limit: 2 })).toHaveLength(2);
			expect(await h.deps.cartStore.listExpired(now, now)).toHaveLength(3);
			expect(await h.deps.cartStore.listExpired(now, now, { limit: 10 })).toHaveLength(3);
			await expect(h.deps.cartStore.listExpired(now, now, { limit: 0 })).rejects.toThrow(
				RangeError,
			);
			// Listing is read-only: nothing was released by it.
			expect(await h.onHand("SKU-1")).toBe(6);
		});

		/** One cart per sku, one unit each, every hold lapsed by `PAST_TTL_MS`. */
		async function lapsedCarts(h: CartStoreHarness, skus: readonly string[], tag: string) {
			const reservations: string[] = [];
			for (const [n, name] of skus.entries()) {
				await h.seedStock(name, 5);
				const cartId = await createCart(h.deps, USD);
				const add = await addLine(
					h.deps,
					cartId,
					sku(name),
					null,
					1,
					idempotencyKey(`${tag}-${String(n)}`),
				);
				if (!add.ok || add.line.reservationId === null) throw new Error("seed add must succeed");
				reservations.push(add.line.reservationId);
			}
			return reservations;
		}

		// HEAD-OF-LINE. A lapsed line whose reservation is no longer held (released
		// behind the cart's back, say) can never be expired. Listed under a small
		// limit, a couple of those would fill every bite forever and no live hold
		// behind them would ever be reached — so the list must not offer them.
		test("an unexpirable lapsed hold is not listed, so it cannot starve the expirable ones behind it", async () => {
			const h = await makeHarness();
			const [deadA, deadB, live] = await lapsedCarts(h, ["SKU-DA", "SKU-DB", "SKU-LIVE"], "hol");
			await h.deps.inventoryStore.release(deadA!);
			await h.deps.inventoryStore.release(deadB!);
			h.advance(PAST_TTL_MS);
			const now = h.deps.clock.now().toISOString();
			expect(await h.deps.cartStore.listExpired(now, now, { limit: 1 })).toEqual([
				{ reservationId: live },
			]);
			const all = await h.deps.cartStore.listExpired(now, now);
			expect(all.map((hold) => hold.reservationId)).toEqual([live]);
		});

		// The list itself must be stoppable: under a tight per-tick query budget a
		// run of candidates that yield nothing would otherwise be read in full.
		test("listExpired asks shouldContinue before each candidate, and stops when told", async () => {
			const h = await makeHarness();
			await lapsedCarts(h, ["SKU-S1", "SKU-S2", "SKU-S3"], "stop");
			h.advance(PAST_TTL_MS);
			const now = h.deps.clock.now().toISOString();
			expect(await h.deps.cartStore.listExpired(now, now, { shouldContinue: () => false })).toEqual(
				[],
			);
			let allowed = 1;
			const one = await h.deps.cartStore.listExpired(now, now, {
				shouldContinue: () => allowed-- > 0,
			});
			expect(one).toHaveLength(1);
		});

		test("a multi-line cart counts each of its holds against the limit", async () => {
			const h = await makeHarness();
			const cartId = await createCart(h.deps, USD);
			for (const [n, name] of ["SKU-M1", "SKU-M2", "SKU-M3"].entries()) {
				await h.seedStock(name, 5);
				const add = await addLine(
					h.deps,
					cartId,
					sku(name),
					null,
					1,
					idempotencyKey(`multi-${String(n)}`),
				);
				if (!add.ok) throw new Error("seed add must succeed");
			}
			h.advance(PAST_TTL_MS);
			const now = h.deps.clock.now().toISOString();
			expect(await h.deps.cartStore.listExpired(now, now, { limit: 2 })).toHaveLength(2);
			expect(await h.deps.cartStore.listExpired(now, now)).toHaveLength(3);
		});

		// ── the cart's `order_id` (issue #132) ───────────────────────────────
		// `checkout` is the ONLY writer of the column, and it writes it in the
		// same guarded statement that makes the cart terminal
		// (`SET state='checked_out', order_id=:orderId WHERE id=:cartId AND
		// state='active'`). The existing `state='active'` predicate IS the CAS,
		// so write-once falls out of the fence rather than needing its own
		// constraint.

		test("a fresh cart carries no order id", async () => {
			const h = await makeHarness();
			const cartId = await createCart(h.deps, USD);
			const cart = await getCart(h.deps, cartId);
			expect(cart?.orderId).toBeNull();
		});

		test("checkout stamps the order id in the same flip that makes the cart terminal", async () => {
			const h = await makeHarness();
			await h.seedStock("SKU-1", 5);
			const cartId = await createCart(h.deps, USD);
			const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
			if (!add.ok) throw new Error("seed add must succeed");

			expect(await h.deps.cartStore.checkout(cartId, brandOrderId("order-1"))).toBe(true);
			const cart = await getCart(h.deps, cartId);
			expect(cart?.state).toBe("checked_out");
			expect(cart?.orderId).toBe("order-1");
		});

		test("the order id is write-once: a second checkout returns false and does not rewrite it", async () => {
			const h = await makeHarness();
			const cartId = await createCart(h.deps, USD);
			expect(await h.deps.cartStore.checkout(cartId, brandOrderId("order-1"))).toBe(true);

			// `false` now means TWO things at once: this cart was already terminal,
			// AND this call did not record ITS order id.
			expect(await h.deps.cartStore.checkout(cartId, brandOrderId("order-2"))).toBe(false);
			expect((await getCart(h.deps, cartId))?.orderId).toBe("order-1");
		});

		test("a cart reaching terminal state THROUGH THE PORT is active iff it has no order id", async () => {
			const h = await makeHarness();
			const cartId = await createCart(h.deps, USD);
			// Assert the PAIR as a whole object, both sides of the flip: a
			// half-written flip (state moved, order id did not, or vice versa)
			// fails here even though each field on its own would still look sane.
			//
			// HONEST SCOPE: this holds for carts written through `checkout`, the
			// column's single writer — it is NOT a structural invariant, and a raw
			// UPDATE that sets `state` alone can still produce a `checked_out`
			// cart with a NULL order id (`cart-fence.dialects.test.ts` builds
			// exactly that on purpose, to keep the state fence provably
			// independent of this column). That is why there is no CHECK
			// constraint to lean on.
			const before = await getCart(h.deps, cartId);
			expect({ state: before?.state, orderId: before?.orderId }).toEqual({
				state: "active",
				orderId: null,
			});

			await h.deps.cartStore.checkout(cartId, brandOrderId("order-1"));
			const after = await getCart(h.deps, cartId);
			expect({ state: after?.state, orderId: after?.orderId }).toEqual({
				state: "checked_out",
				orderId: "order-1",
			});
		});
	});
}
