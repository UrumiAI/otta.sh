import { describe, expect, test } from "vitest";
import { idempotencyKey } from "../money/ids.js";
import type { InventoryStore } from "../ports/inventory-store.js";

export interface InventoryStoreHarness {
	store: InventoryStore;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
}

export interface InventoryStoreContractOptions {
	dialect: string;
}

/**
 * The reusable behavioral spec (Phase 0 step 0.3). Every InventoryStore
 * adapter runs the *same* tests — the fake first, then each DB dialect
 * (EmDash `describeEachDialect` pattern). The suite is the definition of
 * "done" for an adapter (DEVELOPMENT.md §1).
 *
 * `makeStore` returns a fresh, isolated store per invocation (fresh schema /
 * db), so cases never share state.
 */
export function inventoryStoreContract(
	makeStore: () => Promise<InventoryStoreHarness>,
	opts: InventoryStoreContractOptions,
): void {
	describe(`inventoryStoreContract [${opts.dialect}]`, () => {
		test("reserve within stock decrements and returns ok", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const result = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(result.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		test("reserve beyond stock returns OUT_OF_STOCK and does not decrement", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 3);
			const result = await h.store.reserve("SKU-1", 4, idempotencyKey("k1"));
			expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		test("reserve on an unknown (unseeded) sku returns OUT_OF_STOCK", async () => {
			const h = await makeStore();
			// No inventory row exists for this sku. Every adapter resolves this to
			// OUT_OF_STOCK as a pre-claim rejection (the store's `reservations.sku`
			// FK aborts the claim; the fake rejects before claiming).
			const result = await h.store.reserve("SKU-MISSING", 1, idempotencyKey("k1"));
			expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		});

		test("unknown-sku reserve is OUTSIDE R2 idempotency scope: the key is not consumed and stays usable once the sku exists", async () => {
			const h = await makeStore();
			const key = idempotencyKey("k1");
			// Unknown sku ⇒ OUT_OF_STOCK, but this is a pre-claim rejection: NO
			// reservation row is written and the key is NOT consumed (unlike a
			// genuine OUT_OF_STOCK on a known sku, which stays `failed` per R2).
			const miss = await h.store.reserve("SKU-LATER", 1, key);
			expect(miss).toEqual({ ok: false, reason: "OUT_OF_STOCK" });

			// Once the sku exists, the SAME key performs a FRESH reserve — proof the
			// key was never consumed by the unknown-sku rejection. Every adapter
			// (fake, sqlite, pg) must agree on this parity.
			await h.seed("SKU-LATER", 5);
			const hit = await h.store.reserve("SKU-LATER", 1, key);
			expect(hit.ok).toBe(true);
			expect(await h.onHand("SKU-LATER")).toBe(4);
		});

		test("reserve exactly at stock succeeds and leaves on_hand at 0", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 2);
			const result = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(result.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(0);
		});

		test("reserve replayed with same IdempotencyKey returns same reservationId and decrements once", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const first = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			const replay = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(first.ok).toBe(true);
			expect(replay).toEqual(first);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		test("a failed (OUT_OF_STOCK) key replays to OUT_OF_STOCK — the key stays consumed (R2)", async () => {
			const h = await makeStore();
			// A genuine OUT_OF_STOCK on a KNOWN sku (insufficient/zero stock) DOES
			// consume the key and stays `failed` — the R2 counterpart to the
			// unknown-sku pre-claim rejection above (which is outside R2 scope).
			await h.seed("SKU-1", 1);
			const first = await h.store.reserve("SKU-1", 5, idempotencyKey("k1"));
			expect(first).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			// Even though stock is now sufficient for a smaller qty, the SAME key
			// deterministically returns the stored terminal result.
			const replay = await h.store.reserve("SKU-1", 5, idempotencyKey("k1"));
			expect(replay).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(1);
		});

		test("distinct keys draw down independently until stock is exhausted", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 2);
			const a = await h.store.reserve("SKU-1", 1, idempotencyKey("ka"));
			const b = await h.store.reserve("SKU-1", 1, idempotencyKey("kb"));
			const c = await h.store.reserve("SKU-1", 1, idempotencyKey("kc"));
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);
			expect(c).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(0);
		});

		test("commit finalizes; release returns stock; double-commit and double-release are no-ops", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const a = await h.store.reserve("SKU-1", 2, idempotencyKey("ka"));
			const b = await h.store.reserve("SKU-1", 1, idempotencyKey("kb"));
			if (!a.ok || !b.ok) throw new Error("seeded reserves must succeed");

			await h.store.commit(a.reservationId);
			await h.store.commit(a.reservationId);
			expect(await h.onHand("SKU-1")).toBe(2);

			await h.store.release(b.reservationId);
			expect(await h.onHand("SKU-1")).toBe(3);
			await h.store.release(b.reservationId);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		test("adjust up reserves the delta and decrements on_hand", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const r = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			expect(await h.onHand("SKU-1")).toBe(3);
			const up = await h.store.adjust(r.reservationId, 4, idempotencyKey("a1"));
			expect(up).toEqual({ ok: true, reservationId: r.reservationId });
			expect(await h.onHand("SKU-1")).toBe(1);
		});

		test("adjust up beyond stock returns OUT_OF_STOCK and changes nothing", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const r = await h.store.reserve("SKU-1", 4, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			expect(await h.onHand("SKU-1")).toBe(1);
			// Delta of 2 exceeds the 1 remaining on hand.
			const up = await h.store.adjust(r.reservationId, 6, idempotencyKey("a1"));
			expect(up).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(1);
			// The reservation qty is unchanged: a later adjust *down* to 2 returns
			// exactly the 2 units held above 2 (proving qty stayed at 4).
			const down = await h.store.adjust(r.reservationId, 2, idempotencyKey("a2"));
			expect(down.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		test("adjust down returns stock and always succeeds", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const r = await h.store.reserve("SKU-1", 4, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			expect(await h.onHand("SKU-1")).toBe(1);
			const down = await h.store.adjust(r.reservationId, 1, idempotencyKey("a1"));
			expect(down).toEqual({ ok: true, reservationId: r.reservationId });
			expect(await h.onHand("SKU-1")).toBe(4);
		});

		test("adjust replayed with the same target applies the delta exactly once", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const r = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			const first = await h.store.adjust(r.reservationId, 4, idempotencyKey("a1"));
			const replay = await h.store.adjust(r.reservationId, 4, idempotencyKey("a1"));
			expect(first.ok).toBe(true);
			expect(replay).toEqual(first);
			// Decremented once (5 → 3 on reserve → 1 on adjust), not twice.
			expect(await h.onHand("SKU-1")).toBe(1);
		});

		test("adjust replay after an intervening different-key adjust is a no-op returning the recorded result and moves no stock", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 100);
			const r = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			// keyA: 2 → 3, then keyB: 3 → 5. On-hand: 100 → 98 → 97 → 95.
			const a = await h.store.adjust(r.reservationId, 3, idempotencyKey("keyA"));
			const b = await h.store.adjust(r.reservationId, 5, idempotencyKey("keyB"));
			expect(a.ok && b.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(95);

			// A LATE retry of keyA must not read the current qty (5), compute a
			// spurious 3−5 delta, and re-apply it — it returns keyA's RECORDED
			// result (ledger-first), moves no stock, and leaves the hold at 5.
			const stale = await h.store.adjust(r.reservationId, 3, idempotencyKey("keyA"));
			expect(stale).toEqual(a);
			expect(await h.onHand("SKU-1")).toBe(95);
			// The reservation still holds 5: adjusting down to 1 with a fresh key
			// returns exactly 4 units (proof qty stayed at 5, not 3).
			const down = await h.store.adjust(r.reservationId, 1, idempotencyKey("keyC"));
			expect(down.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(99);
		});

		test("an OUT_OF_STOCK adjust key replays to OUT_OF_STOCK — the key stays consumed (R2)", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 3);
			const r = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			// Increase to 6 needs delta 4 > the 1 on hand: OUT_OF_STOCK, key consumed.
			const first = await h.store.adjust(r.reservationId, 6, idempotencyKey("a1"));
			expect(first).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			// Free up stock; the SAME key still deterministically replays the
			// stored terminal result, never a fresh attempt.
			await h.seed("SKU-1", 50);
			const replay = await h.store.adjust(r.reservationId, 6, idempotencyKey("a1"));
			expect(replay).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await h.onHand("SKU-1")).toBe(50);
		});

		test("an adjust key replayed against a different reservation is rejected, never ok for the wrong hold", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 10);
			const a = await h.store.reserve("SKU-1", 2, idempotencyKey("kA"));
			const b = await h.store.reserve("SKU-1", 2, idempotencyKey("kB"));
			if (!a.ok || !b.ok) throw new Error("seed reserves must succeed");

			const first = await h.store.adjust(a.reservationId, 3, idempotencyKey("adj-1"));
			expect(first).toEqual({ ok: true, reservationId: a.reservationId });
			expect(await h.onHand("SKU-1")).toBe(5);

			// A mis-keyed caller reusing adj-1 against reservation B must get a
			// typed rejection — not an `ok` echoing B's id for a movement that was
			// recorded against A. Nothing moves.
			await expect(h.store.adjust(b.reservationId, 4, idempotencyKey("adj-1"))).rejects.toThrow(
				/recorded against reservation/,
			);
			expect(await h.onHand("SKU-1")).toBe(5);
		});

		test("reserve heals a reservation abandoned in 'pending' before finalize (crash window W1) on same-key replay", async () => {
			const h = await makeStore();
			// This case only applies to stores that expose the abandon-pending hook
			// (the fake and — via a SQL-level insert — the dialect harness). Stores
			// that cannot simulate the crash skip it explicitly.
			const abandon = (
				h as InventoryStoreHarness & {
					abandonPending?: (sku: string, qty: number, key: string) => Promise<void> | void;
				}
			).abandonPending;
			if (!abandon) return;

			await h.seed("SKU-1", 5);
			await abandon("SKU-1", 2, "k1");
			// Replay heals to `held` with the decrement applied exactly once.
			const healed = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(healed.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(3);

			// A second replay is a stable no-op (already terminal).
			const again = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(again).toEqual(healed);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		// Phase 1 §8 Risk 4 — additive create-if-absent seed, not a reserve/commit/
		// release path. Natural key = sku; no idempotencyKey (see the port doc).
		test("seedOnHand creates on_hand once for a new sku", async () => {
			const h = await makeStore();
			await h.store.seedOnHand("SKU-NEW", 7);
			expect(await h.onHand("SKU-NEW")).toBe(7);
		});

		test("seedOnHand re-seeding an existing sku is a no-op that never clobbers the current on_hand", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			await h.store.seedOnHand("SKU-1", 999);
			expect(await h.onHand("SKU-1")).toBe(5);
		});

		test("seedOnHand does not clobber on_hand already decremented by a reserve", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 5);
			const result = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(result.ok).toBe(true);
			expect(await h.onHand("SKU-1")).toBe(3);

			// A re-seed attempt (e.g. a re-save of the already-priced product) must
			// never overwrite the live, already-decremented on_hand.
			await h.store.seedOnHand("SKU-1", 999);
			expect(await h.onHand("SKU-1")).toBe(3);
		});
	});
}
