import { describe, expect, test } from "vitest";
import { idempotencyKey } from "../money/ids.js";
import { type InventoryStore, ReservationNotFoundError } from "../ports/inventory-store.js";

/** Order-insensitive membership compare: pg RETURNING order ≠ IN order ≠ fake. */
const sorted = (xs: string[]): string[] => xs.toSorted();

export interface InventoryStoreHarness {
	store: InventoryStore;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
	/**
	 * Optional: create a HELD reservation with a stamped hold deadline
	 * (`expires_at`) and return its id — the cart-flow precondition
	 * `adoptMany`/`adopt` require (a bare `reserve` leaves `expires_at` NULL, and
	 * the guarded flip is `WHERE … expires_at > :now`). Every adapter here (fake +
	 * each DB dialect) implements it; the adoptMany cases skip if absent.
	 */
	holdWithExpiry?(sku: string, qty: number, key: string, expiresAt: string): Promise<string>;
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

		// PR B (reservation 404): an id that was NEVER created — as distinct from
		// one that existed and lost its hold (ReservationCommitLostError) — throws
		// the typed ReservationNotFoundError, so the HTTP boundary can map it to a
		// 404 instead of a bare 500.
		test("commit(unknownId) rejects with ReservationNotFoundError", async () => {
			const h = await makeStore();
			await expect(h.store.commit("no-such-reservation")).rejects.toThrow(ReservationNotFoundError);
		});

		test("release(unknownId) rejects with ReservationNotFoundError", async () => {
			const h = await makeStore();
			await expect(h.store.release("no-such-reservation")).rejects.toThrow(
				ReservationNotFoundError,
			);
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

		// -- getOnHand (admin-UX Increment 2: product detail's stock read) ------

		test("getOnHand returns the current on_hand for a seeded sku", async () => {
			const h = await makeStore();
			await h.seed("SKU-GET-1", 12);
			expect(await h.store.getOnHand("SKU-GET-1")).toBe(12);
		});

		test("getOnHand on a sku with no inventory row returns 0 (mirrors the LEFT JOIN miss)", async () => {
			const h = await makeStore();
			expect(await h.store.getOnHand("SKU-NEVER-SEEDED")).toBe(0);
		});

		test("getOnHand reflects a decrement already applied by reserve", async () => {
			const h = await makeStore();
			await h.seed("SKU-GET-2", 5);
			const result = await h.store.reserve("SKU-GET-2", 2, idempotencyKey("k-get-2"));
			expect(result.ok).toBe(true);
			expect(await h.store.getOnHand("SKU-GET-2")).toBe(3);
		});

		// -- findOnHand (INC-23: the detail read that keeps "unknown" apart) ----

		test("findOnHand returns the current on_hand for a seeded sku", async () => {
			const h = await makeStore();
			await h.seed("SKU-FIND-1", 12);
			expect(await h.store.findOnHand("SKU-FIND-1")).toBe(12);
		});

		test("findOnHand distinguishes a MISSING inventory row (null) from a row at zero (0)", async () => {
			const h = await makeStore();
			await h.seed("SKU-FIND-ZERO", 0);
			// The whole reason this method exists: `getOnHand` answers `0` to both
			// of these, which is what made one product read `—` in the admin list
			// and `0` on its own detail page.
			expect(await h.store.findOnHand("SKU-FIND-ZERO")).toBe(0);
			expect(await h.store.findOnHand("SKU-FIND-NEVER-SEEDED")).toBeNull();
			// …and `getOnHand` keeps its shipped collapse, untouched.
			expect(await h.store.getOnHand("SKU-FIND-ZERO")).toBe(0);
			expect(await h.store.getOnHand("SKU-FIND-NEVER-SEEDED")).toBe(0);
		});

		test("findOnHand reflects a decrement already applied by reserve", async () => {
			const h = await makeStore();
			await h.seed("SKU-FIND-2", 5);
			const result = await h.store.reserve("SKU-FIND-2", 2, idempotencyKey("k-find-2"));
			expect(result.ok).toBe(true);
			expect(await h.store.findOnHand("SKU-FIND-2")).toBe(3);
		});

		test("findOnHand reads a row driven to zero by reserve as 0, never as unknown", async () => {
			const h = await makeStore();
			await h.seed("SKU-FIND-3", 2);
			expect((await h.store.reserve("SKU-FIND-3", 2, idempotencyKey("k-find-3"))).ok).toBe(true);
			// Selling out empties the COUNT, never the row — an out-of-stock product
			// must not start reading as "stock unknown".
			expect(await h.store.findOnHand("SKU-FIND-3")).toBe(0);
		});

		// -- restock / removeStock (admin-UX Increment 2: merchant restock) -----

		test("restock adds units to an existing sku and returns the new on_hand", async () => {
			const h = await makeStore();
			await h.seed("SKU-R1", 5);
			const res = await h.store.restock("SKU-R1", 3, idempotencyKey("r1"));
			expect(res).toEqual({ ok: true, onHand: 8 });
			expect(await h.onHand("SKU-R1")).toBe(8);
		});

		test("restock replayed with the same key adds the units exactly once", async () => {
			const h = await makeStore();
			await h.seed("SKU-R1", 5);
			const first = await h.store.restock("SKU-R1", 3, idempotencyKey("r1"));
			const replay = await h.store.restock("SKU-R1", 3, idempotencyKey("r1"));
			expect(first).toEqual({ ok: true, onHand: 8 });
			// The ledger's answer, SAID to be the ledger's: a caller must be able to
			// tell "this call added 3" from "an earlier call did".
			expect(replay).toEqual({ ...first, replayed: true });
			expect(await h.onHand("SKU-R1")).toBe(8); // added once, not twice
		});

		test("REPLAYED IS SAID ONLY OF A LEDGER ANSWER: a first movement never carries it; a replayed refusal reads as the refusal", async () => {
			// `replayed: true` is what lets an admin say "this change was already
			// applied" instead of a fresh "Added 3" for a call that moved nothing.
			const h = await makeStore();
			await h.seed("SKU-RP", 5);
			const add = await h.store.restock("SKU-RP", 3, idempotencyKey("rp-add"));
			const rem = await h.store.removeStock("SKU-RP", 2, idempotencyKey("rp-rem"));
			expect(add).toEqual({ ok: true, onHand: 8 });
			expect(rem).toEqual({ ok: true, onHand: 6 });
			expect("replayed" in add || "replayed" in rem).toBe(false);
			expect(await h.store.restock("SKU-RP", 3, idempotencyKey("rp-add"))).toEqual({
				ok: true,
				onHand: 8,
				replayed: true,
			});
			const tooMany = await h.store.removeStock("SKU-RP", 99, idempotencyKey("rp-big"));
			expect(await h.store.removeStock("SKU-RP", 99, idempotencyKey("rp-big"))).toEqual(tooMany);
			expect(await h.onHand("SKU-RP")).toBe(6);
		});

		test("restock on an unknown sku is a clean UNKNOWN_SKU failure that never creates a row", async () => {
			const h = await makeStore();
			const res = await h.store.restock("SKU-MISSING", 4, idempotencyKey("r1"));
			expect(res).toEqual({ ok: false, reason: "UNKNOWN_SKU" });
			// Never auto-created (seedOnHand is the sole create path): still 0.
			expect(await h.onHand("SKU-MISSING")).toBe(0);
		});

		test("an unknown-sku restock is OUTSIDE the idempotency scope: the key is not consumed and works once the sku exists", async () => {
			const h = await makeStore();
			const key = idempotencyKey("r1");
			const miss = await h.store.restock("SKU-LATER", 4, key);
			expect(miss).toEqual({ ok: false, reason: "UNKNOWN_SKU" });
			// The SAME key performs a fresh restock once the sku exists — proof the
			// unknown-sku rejection never consumed it (mirrors reserve's parity).
			await h.seed("SKU-LATER", 2);
			const hit = await h.store.restock("SKU-LATER", 4, key);
			expect(hit).toEqual({ ok: true, onHand: 6 });
			expect(await h.onHand("SKU-LATER")).toBe(6);
		});

		test("restock is additive over a stock already decremented by a reserve", async () => {
			const h = await makeStore();
			await h.seed("SKU-R1", 5);
			const r = await h.store.reserve("SKU-R1", 2, idempotencyKey("k1"));
			expect(r.ok).toBe(true);
			expect(await h.onHand("SKU-R1")).toBe(3);
			const res = await h.store.restock("SKU-R1", 10, idempotencyKey("r1"));
			expect(res).toEqual({ ok: true, onHand: 13 });
			expect(await h.onHand("SKU-R1")).toBe(13);
		});

		test("removeStock removes units from an existing sku and returns the new on_hand", async () => {
			const h = await makeStore();
			await h.seed("SKU-D1", 5);
			const res = await h.store.removeStock("SKU-D1", 2, idempotencyKey("d1"));
			expect(res).toEqual({ ok: true, onHand: 3 });
			expect(await h.onHand("SKU-D1")).toBe(3);
		});

		test("removeStock down to exactly zero succeeds", async () => {
			const h = await makeStore();
			await h.seed("SKU-D1", 4);
			const res = await h.store.removeStock("SKU-D1", 4, idempotencyKey("d1"));
			expect(res).toEqual({ ok: true, onHand: 0 });
			expect(await h.onHand("SKU-D1")).toBe(0);
		});

		test("removeStock beyond available is a guarded INSUFFICIENT_STOCK that removes nothing (never negative)", async () => {
			const h = await makeStore();
			await h.seed("SKU-D1", 3);
			const res = await h.store.removeStock("SKU-D1", 5, idempotencyKey("d1"));
			expect(res).toEqual({ ok: false, reason: "INSUFFICIENT_STOCK", onHand: 3 });
			expect(await h.onHand("SKU-D1")).toBe(3);
		});

		test("an INSUFFICIENT_STOCK removeStock key replays to INSUFFICIENT_STOCK — the key stays consumed (R2)", async () => {
			const h = await makeStore();
			await h.seed("SKU-D1", 3);
			const first = await h.store.removeStock("SKU-D1", 5, idempotencyKey("d1"));
			expect(first).toEqual({ ok: false, reason: "INSUFFICIENT_STOCK", onHand: 3 });
			// Even after stock rises, the SAME key deterministically replays the
			// recorded terminal result, never a fresh attempt.
			await h.store.restock("SKU-D1", 50, idempotencyKey("r-top-up"));
			const replay = await h.store.removeStock("SKU-D1", 5, idempotencyKey("d1"));
			expect(replay).toEqual(first);
			expect(await h.onHand("SKU-D1")).toBe(53); // only the restock moved it
		});

		test("removeStock replayed with the same key removes the units exactly once", async () => {
			const h = await makeStore();
			await h.seed("SKU-D1", 10);
			const first = await h.store.removeStock("SKU-D1", 4, idempotencyKey("d1"));
			const replay = await h.store.removeStock("SKU-D1", 4, idempotencyKey("d1"));
			expect(first).toEqual({ ok: true, onHand: 6 });
			expect(replay).toEqual({ ...first, replayed: true });
			expect(await h.onHand("SKU-D1")).toBe(6); // removed once, not twice
		});

		test("removeStock on an unknown sku is a clean UNKNOWN_SKU failure, key not consumed", async () => {
			const h = await makeStore();
			const key = idempotencyKey("d1");
			const miss = await h.store.removeStock("SKU-MISSING", 1, key);
			expect(miss).toEqual({ ok: false, reason: "UNKNOWN_SKU" });
			await h.seed("SKU-MISSING", 5);
			const hit = await h.store.removeStock("SKU-MISSING", 1, key);
			expect(hit).toEqual({ ok: true, onHand: 4 });
		});

		test("a stock-movement key reused for a different movement is rejected, never ok for the wrong movement", async () => {
			const h = await makeStore();
			await h.seed("SKU-D1", 10);
			const key = idempotencyKey("shared");
			const first = await h.store.restock("SKU-D1", 3, key);
			expect(first).toEqual({ ok: true, onHand: 13 });
			// Same key, DIFFERENT direction/qty ⇒ typed rejection; nothing moves.
			await expect(h.store.removeStock("SKU-D1", 3, key)).rejects.toThrow(/was recorded for/);
			await expect(h.store.restock("SKU-D1", 99, key)).rejects.toThrow(/was recorded for/);
			expect(await h.onHand("SKU-D1")).toBe(13);
		});

		// -- removeStock's expectedOnHand: the watermark, checked IN the movement --
		//
		// WHY THE STORE CHECKS IT, NOT THE CALLER. A removal is decided against the
		// count the operator SAW. A caller-side re-read can refuse a stale one, but
		// it runs BEFORE the ledger, so a retry of a removal that already applied
		// re-reads the count the removal itself produced and is refused as "stock
		// changed" — a lie about a write that landed. Checked inside the same
		// compare-and-set as the movement, the ledger answers a retry first and the
		// watermark only ever judges a FIRST attempt.
		//
		// RESTOCK TAKES NO WATERMARK, deliberately. `onHand` is the AVAILABLE count,
		// which every reserve, release and hold expiry moves; a watermarked add would
		// fail as stale through an ordinary sale. An add is a commutative increment,
		// so two operators who each add 3 to 4 end at 10 — and a removal, which can
		// strand or misjudge units, is the movement that keeps the check.

		test("removeStock with a CURRENT expectedOnHand applies", async () => {
			const h = await makeStore();
			await h.seed("SKU-W1", 9);
			const res = await h.store.removeStock("SKU-W1", 2, idempotencyKey("w1"), {
				expectedOnHand: 9,
			});
			expect(res).toEqual({ ok: true, onHand: 7 });
			expect(await h.onHand("SKU-W1")).toBe(7);
		});

		test("removeStock with a STALE expectedOnHand is a STALE_ON_HAND carrying the live count, and removes nothing", async () => {
			const h = await makeStore();
			await h.seed("SKU-W2", 30);
			const res = await h.store.removeStock("SKU-W2", 10, idempotencyKey("w2"), {
				expectedOnHand: 42,
			});
			expect(res).toEqual({ ok: false, reason: "STALE_ON_HAND", onHand: 30 });
			expect(await h.onHand("SKU-W2")).toBe(30);
		});

		test("a stale watermark is judged BEFORE the floor: STALE_ON_HAND, not INSUFFICIENT_STOCK", async () => {
			const h = await makeStore();
			await h.seed("SKU-W3", 3);
			const res = await h.store.removeStock("SKU-W3", 5, idempotencyKey("w3"), {
				expectedOnHand: 8,
			});
			expect(res).toEqual({ ok: false, reason: "STALE_ON_HAND", onHand: 3 });
		});

		test("a reserve between the operator's look and the removal makes it STALE — it never applies against a count that is not live", async () => {
			// A sale moves the available count. The removal was decided against 10,
			// so it must not land against 8 as if the operator had seen 8.
			const h = await makeStore();
			await h.seed("SKU-W4", 10);
			expect((await h.store.reserve("SKU-W4", 2, idempotencyKey("w4-sale"))).ok).toBe(true);
			const res = await h.store.removeStock("SKU-W4", 1, idempotencyKey("w4"), {
				expectedOnHand: 10,
			});
			expect(res).toEqual({ ok: false, reason: "STALE_ON_HAND", onHand: 8 });
			expect(await h.onHand("SKU-W4")).toBe(8);
		});

		test("a RETRY of an applied removal echoes its success even though the count it was taken against has moved", async () => {
			// The retry is answered by the ledger, never re-judged against the
			// watermark — the count moved BECAUSE of this very removal.
			const h = await makeStore();
			await h.seed("SKU-W5", 9);
			const pinned = { expectedOnHand: 9 };
			const first = await h.store.removeStock("SKU-W5", 2, idempotencyKey("w5"), pinned);
			const retry = await h.store.removeStock("SKU-W5", 2, idempotencyKey("w5"), pinned);
			expect(first).toEqual({ ok: true, onHand: 7 });
			expect(retry).toEqual({ ...first, replayed: true });
			expect(await h.onHand("SKU-W5")).toBe(7);
		});

		test("a STALE_ON_HAND consumes the key: a retry replays the refusal even once the count is back", async () => {
			// Same terminal discipline as INSUFFICIENT_STOCK (R2): one submission gets
			// one answer. A fresh decision is a fresh key.
			const h = await makeStore();
			await h.seed("SKU-W6", 5);
			const pinned = { expectedOnHand: 6 };
			const first = await h.store.removeStock("SKU-W6", 1, idempotencyKey("w6"), pinned);
			expect(first).toEqual({ ok: false, reason: "STALE_ON_HAND", onHand: 5 });
			await h.store.restock("SKU-W6", 1, idempotencyKey("w6-up"));
			const retry = await h.store.removeStock("SKU-W6", 1, idempotencyKey("w6"), pinned);
			expect(retry).toEqual(first);
			expect(await h.onHand("SKU-W6")).toBe(6);
		});

		test("Add, Remove, Add of the same size under three keys lands every movement", async () => {
			// The admin bug this section exists for: a key derived from (direction,
			// observed count, qty) made the third movement a replay of the first.
			const h = await makeStore();
			await h.seed("SKU-W7", 7);
			const add1 = await h.store.restock("SKU-W7", 2, idempotencyKey("w7-a"));
			const rem = await h.store.removeStock("SKU-W7", 2, idempotencyKey("w7-b"), {
				expectedOnHand: 9,
			});
			const add2 = await h.store.restock("SKU-W7", 2, idempotencyKey("w7-c"));
			expect([add1, rem, add2]).toEqual([
				{ ok: true, onHand: 9 },
				{ ok: true, onHand: 7 },
				{ ok: true, onHand: 9 },
			]);
			expect(await h.onHand("SKU-W7")).toBe(9);
		});

		test("two restocks of 3 against the same observed 4, under two keys, BOTH apply — an add is commutative", async () => {
			const h = await makeStore();
			await h.seed("SKU-W10", 4);
			await h.store.restock("SKU-W10", 3, idempotencyKey("w10-tab-a"));
			const tabB = await h.store.restock("SKU-W10", 3, idempotencyKey("w10-tab-b"));
			expect(tabB).toEqual({ ok: true, onHand: 10 });
			expect(await h.onHand("SKU-W10")).toBe(10);
		});

		test("a key reused with a DIFFERENT expectedOnHand is a mis-keyed caller, rejected and moving nothing", async () => {
			const h = await makeStore();
			await h.seed("SKU-W8", 9);
			const key = idempotencyKey("w8");
			await h.store.removeStock("SKU-W8", 2, key, { expectedOnHand: 9 });
			await expect(h.store.removeStock("SKU-W8", 2, key, { expectedOnHand: 7 })).rejects.toThrow(
				/was recorded for/,
			);
			// Pinned first, unpinned on the retry: also a different intent.
			await expect(h.store.removeStock("SKU-W8", 2, key)).rejects.toThrow(/was recorded for/);
			expect(await h.onHand("SKU-W8")).toBe(7);
		});

		test("a key recorded WITHOUT a watermark is honoured when retried WITH one — the recorded intent wins", async () => {
			// A movement claimed before watermarks existed carries none. The release
			// that wrote it already embedded the observed count in the key itself,
			// so the retry IS that movement: it echoes the recorded answer, whatever
			// watermark it now carries, and is never re-judged against one.
			const h = await makeStore();
			await h.seed("SKU-W11", 9);
			const key = idempotencyKey("w11");
			const first = await h.store.removeStock("SKU-W11", 2, key);
			const retry = await h.store.removeStock("SKU-W11", 2, key, { expectedOnHand: 4 });
			expect(retry).toEqual({ ...first, replayed: true });
			expect(await h.onHand("SKU-W11")).toBe(7);
		});

		test("expectedOnHand must be a non-negative integer", async () => {
			const h = await makeStore();
			await h.seed("SKU-W9", 7);
			for (const expectedOnHand of [-1, 1.5, Number.NaN]) {
				await expect(
					h.store.removeStock("SKU-W9", 1, idempotencyKey(`w9-${String(expectedOnHand)}`), {
						expectedOnHand,
					}),
				).rejects.toThrow(RangeError);
			}
			expect(await h.onHand("SKU-W9")).toBe(7);
		});

		// -- PR B: batched checkout ADOPT (adoptMany) ---------------------------
		//
		// The batch is the per-line singular semantics folded into ONE guarded
		// statement. Membership is asserted ORDER-INSENSITIVELY (pg RETURNING order
		// ≠ IN order ≠ fake insertion order), so every assertion sorts.
		const NOW = "2026-07-10T00:05:00.000Z";
		const FUTURE = "2026-07-10T00:15:00.000Z"; // hold deadline, > NOW
		const PAST = "2026-07-10T00:01:00.000Z"; // < NOW ⇒ an expired hold
		const LATER = "2026-07-10T01:00:00.000Z"; // > FUTURE ⇒ past the deadline

		test("adoptMany flips every held line of one order to adopted (all-success)", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-1", 10);
			const r1 = await h.holdWithExpiry("SKU-1", 1, "k1", FUTURE);
			const r2 = await h.holdWithExpiry("SKU-1", 1, "k2", FUTURE);
			const r3 = await h.holdWithExpiry("SKU-1", 1, "k3", FUTURE);
			const res = await h.store.adoptMany({
				reservationIds: [r1, r2, r3],
				orderId: "ord-1",
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(sorted(res.adopted)).toEqual(sorted([r1, r2, r3]));
			expect(res.lost).toEqual([]);
		});

		test("adoptMany partial: released / committed / expired holds land in lost; the held siblings adopt", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-1", 10);
			const held1 = await h.holdWithExpiry("SKU-1", 1, "k1", FUTURE);
			const held2 = await h.holdWithExpiry("SKU-1", 1, "k2", FUTURE);
			const releasedHold = await h.holdWithExpiry("SKU-1", 1, "k3", FUTURE);
			await h.store.release(releasedHold); // reaped before adoption
			const committedHold = await h.holdWithExpiry("SKU-1", 1, "k4", FUTURE);
			await h.store.commit(committedHold); // already consumed
			const expiredHold = await h.holdWithExpiry("SKU-1", 1, "k5", PAST); // expires_at <= now

			const res = await h.store.adoptMany({
				reservationIds: [held1, held2, releasedHold, committedHold, expiredHold],
				orderId: "ord-1",
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(sorted(res.adopted)).toEqual(sorted([held1, held2]));
			expect(sorted(res.lost)).toEqual(sorted([releasedHold, committedHold, expiredHold]));
		});

		test("adoptMany replay is idempotent — a row already adopted for THIS order stays adopted even PAST its hold deadline (never lost)", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-1", 10);
			const r1 = await h.holdWithExpiry("SKU-1", 1, "k1", FUTURE);
			const first = await h.store.adoptMany({
				reservationIds: [r1],
				orderId: "ord-1",
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(sorted(first.adopted)).toEqual([r1]);
			// Replay AFTER the hold deadline (now = LATER > FUTURE): the guarded flip
			// matches 0 rows, but the classification recognises it as adopted-for-this
			// -order and folds it back into adopted WITHOUT re-checking expires_at.
			const replay = await h.store.adoptMany({
				reservationIds: [r1],
				orderId: "ord-1",
				holdExpiresAt: FUTURE,
				now: LATER,
			});
			expect(sorted(replay.adopted)).toEqual([r1]);
			expect(replay.lost).toEqual([]);
			// The SAME row for a DIFFERENT order is a lost hold, never a cross-order adopt.
			const other = await h.store.adoptMany({
				reservationIds: [r1],
				orderId: "ord-2",
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(other.adopted).toEqual([]);
			expect(other.lost).toEqual([r1]);
		});

		test("adoptMany with no ids is a no-op ({ adopted: [], lost: [] })", async () => {
			const h = await makeStore();
			const res = await h.store.adoptMany({
				reservationIds: [],
				orderId: "ord-1",
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(res).toEqual({ adopted: [], lost: [] });
		});

		test("adoptMany on an unknown reservation id lands in lost (never throws); the valid held sibling adopts", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-1", 10);
			const held = await h.holdWithExpiry("SKU-1", 1, "k1", FUTURE);
			const res = await h.store.adoptMany({
				reservationIds: [held, "no-such-reservation"],
				orderId: "ord-1",
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(sorted(res.adopted)).toEqual([held]);
			expect(sorted(res.lost)).toEqual(["no-such-reservation"]);
		});

		// -- PR B: batched settle COMMIT (commitMany) ---------------------------

		test("commitMany commits every held line of one order (all-success), idempotent on replay", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 10);
			const a = await h.store.reserve("SKU-1", 1, idempotencyKey("k1"));
			const b = await h.store.reserve("SKU-1", 1, idempotencyKey("k2"));
			if (!a.ok || !b.ok) throw new Error("seed reserves must succeed");
			const first = await h.store.commitMany([a.reservationId, b.reservationId]);
			expect(first).toEqual({ lost: [] });
			// A re-drive (already committed) is benign: still lost = [].
			const replay = await h.store.commitMany([a.reservationId, b.reservationId]);
			expect(replay).toEqual({ lost: [] });
		});

		test("commitMany partial: a released hold is lost; an already-committed hold is benign (absent); a held hold commits", async () => {
			const h = await makeStore();
			await h.seed("SKU-1", 10);
			const released = await h.store.reserve("SKU-1", 1, idempotencyKey("k1"));
			const committed = await h.store.reserve("SKU-1", 1, idempotencyKey("k2"));
			const held = await h.store.reserve("SKU-1", 1, idempotencyKey("k3"));
			if (!released.ok || !committed.ok || !held.ok) throw new Error("seed reserves must succeed");
			await h.store.release(released.reservationId); // lost before commit
			await h.store.commit(committed.reservationId); // already committed (benign replay)

			const res = await h.store.commitMany([
				released.reservationId,
				committed.reservationId,
				held.reservationId,
			]);
			expect(res.lost).toEqual([released.reservationId]);
		});

		// -- QA2 M2: the batched ORDER-SCOPED release (releaseAdoptedMany) -------
		//
		// The expiry and cancel paths release every hold an order adopted at once.
		// Per-id semantics are singular `releaseAdopted`'s; only the round trips
		// change (grouped per SKU).

		/** Hold `qty` on `sku` under `key` and adopt it for `order`. */
		async function adoptedHold(
			h: InventoryStoreHarness,
			sku: string,
			qty: number,
			key: string,
			order: string,
		): Promise<string> {
			if (!h.holdWithExpiry) throw new Error("harness has no holdWithExpiry");
			const id = await h.holdWithExpiry(sku, qty, key, FUTURE);
			const adopted = await h.store.adoptMany({
				reservationIds: [id],
				orderId: order,
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			if (adopted.adopted.length !== 1) throw new Error("seed adopt failed");
			return id;
		}

		test("releaseAdoptedMany returns every hold the order adopted, across SKUs, exactly once", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-A", 10);
			await h.seed("SKU-B", 10);
			const a1 = await adoptedHold(h, "SKU-A", 2, "ka1", "ord-1");
			const a2 = await adoptedHold(h, "SKU-A", 1, "ka2", "ord-1");
			const b1 = await adoptedHold(h, "SKU-B", 3, "kb1", "ord-1");
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([7, 7]);

			await h.store.releaseAdoptedMany([a1, b1, a2], "ord-1");
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([10, 10]);

			// A replay (a second sweep, a completer) returns nothing twice.
			await h.store.releaseAdoptedMany([a1, a2, b1], "ord-1");
			await h.store.releaseAdopted(a1, "ord-1");
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([10, 10]);
			// And the singular call agrees the holds are gone: a later commit is lost.
			expect((await h.store.commitMany([a1, b1])).lost.toSorted()).toEqual([a1, b1].toSorted());
		});

		test("releaseAdoptedMany is ORDER-SCOPED: another order's hold, a cart's held hold, a committed hold and an unknown id are untouched", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-A", 10);
			const mine = await adoptedHold(h, "SKU-A", 1, "k-mine", "ord-1");
			const theirs = await adoptedHold(h, "SKU-A", 2, "k-theirs", "ord-2");
			const cartHeld = await h.holdWithExpiry("SKU-A", 3, "k-cart", FUTURE);
			const sold = await adoptedHold(h, "SKU-A", 1, "k-sold", "ord-1");
			await h.store.commit(sold);
			expect(await h.onHand("SKU-A")).toBe(3);

			await h.store.releaseAdoptedMany(
				[mine, theirs, cartHeld, sold, "no-such-reservation"],
				"ord-1",
			);
			// Only `mine` came back: +1.
			expect(await h.onHand("SKU-A")).toBe(4);
			// The others are exactly as they were: theirs and the cart's hold still commit.
			expect((await h.store.commitMany([theirs, cartHeld])).lost).toEqual([]);
			expect(await h.onHand("SKU-A")).toBe(4);
		});

		test("releaseAdoptedMany collapses duplicate ids and is a no-op for an empty list", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-A", 10);
			const id = await adoptedHold(h, "SKU-A", 2, "k-dup", "ord-1");
			await h.store.releaseAdoptedMany([], "ord-1");
			expect(await h.onHand("SKU-A")).toBe(8);
			await h.store.releaseAdoptedMany([id, id, id], "ord-1");
			expect(await h.onHand("SKU-A")).toBe(10);
		});

		// -- review G2: the singular ORDER-SCOPED release (releaseAdopted) --------
		//
		// The per-id rule the batch above inherits, pinned on its own because
		// `createOrderFromCart` calls it directly: a lost-hold abandonment and an
		// order observed expired/cancelled/failed underneath a checkout both release
		// that order's holds one id at a time, and may run more than once for the
		// same order. The port's contract: only a hold THIS order adopted flips to
		// `released` and returns its units; every other id is a silent no-op.
		//
		// The harness reads only `on_hand` (the AVAILABLE count — a hold's units
		// leave it at reserve), so a reservation's STATE is read through the port's
		// own classifiers, each picked for what only that state answers:
		//  - adopted for order X: an `adoptMany` replay for X folds it into `adopted`
		//    (and changes nothing); for any other order it is `lost`.
		//  - committed: `commitMany` treats it as benign (`lost: []`), yet it is no
		//    longer adoptable, even for its own order.
		//  - released: `commitMany` reports it `lost`.
		//  - cart-`held` (live deadline): a FRESH order can adopt it, which no other
		//    state allows — so that probe goes last, since it mutates.

		/** `adoptMany` for one id, answering which bucket it classified the id in. */
		async function adoptOne(
			h: InventoryStoreHarness,
			id: string,
			order: string,
		): Promise<"adopted" | "lost"> {
			const res = await h.store.adoptMany({
				reservationIds: [id],
				orderId: order,
				holdExpiresAt: FUTURE,
				now: NOW,
			});
			expect(res.adopted.length + res.lost.length, "one id, one bucket").toBe(1);
			return res.adopted.includes(id) ? "adopted" : "lost";
		}

		test("releaseAdopted releases the order's adopted hold and returns its units exactly once; a replay is a no-op", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-A", 10);
			await h.seed("SKU-B", 10);
			const mine = await adoptedHold(h, "SKU-A", 3, "k-mine", "ord-1");
			// A sibling on the same SKU the call must not touch, adopted by the same order.
			const sibling = await adoptedHold(h, "SKU-A", 2, "k-sibling", "ord-1");
			// A bystander SKU, so a release that credited the wrong row would show.
			const other = await adoptedHold(h, "SKU-B", 4, "k-other", "ord-1");
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([5, 6]);
			expect(await adoptOne(h, mine, "ord-1"), "adopted before").toBe("adopted");

			await expect(h.store.releaseAdopted(mine, "ord-1")).resolves.toBeUndefined();
			// Exactly `mine`'s 3 units came back, to its own SKU only.
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([8, 6]);

			// Replays — the same order re-observed by a second call, or a crashed
			// abandonment re-driven — return nothing twice.
			await expect(h.store.releaseAdopted(mine, "ord-1")).resolves.toBeUndefined();
			await expect(h.store.releaseAdopted(mine, "ord-1")).resolves.toBeUndefined();
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([8, 6]);

			// `mine` is now `released`: no longer adoptable, and a commit calls it lost.
			expect(await adoptOne(h, mine, "ord-1"), "released, not adopted").toBe("lost");
			expect((await h.store.commitMany([mine])).lost).toEqual([mine]);
			// The siblings it did not name are still adopted for ord-1, units still out.
			expect(await adoptOne(h, sibling, "ord-1")).toBe("adopted");
			expect(await adoptOne(h, other, "ord-1")).toBe("adopted");
			expect([await h.onHand("SKU-A"), await h.onHand("SKU-B")]).toEqual([8, 6]);
		});

		test("releaseAdopted is not deadline-scoped: an order past its hold deadline still releases what it adopted", async () => {
			// The callers release an order that has EXPIRED — by definition past the
			// deadline its holds were re-pointed to. A release that also required
			// `expires_at > now` would strand those units forever (the cart sweep only
			// reaps `held`). Before every harness clock, so the hold is expired however
			// the adapter reads "now".
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			const LAPSED = "2026-07-09T00:00:00.000Z";
			await h.seed("SKU-A", 10);
			const id = await h.holdWithExpiry("SKU-A", 4, "k-lapsed", FUTURE);
			const adopted = await h.store.adoptMany({
				reservationIds: [id],
				orderId: "ord-1",
				holdExpiresAt: LAPSED,
				now: NOW,
			});
			expect(adopted).toEqual({ adopted: [id], lost: [] });
			expect(await h.onHand("SKU-A")).toBe(6);

			await h.store.releaseAdopted(id, "ord-1");
			expect(await h.onHand("SKU-A")).toBe(10);
			await h.store.releaseAdopted(id, "ord-1");
			expect(await h.onHand("SKU-A")).toBe(10);
			expect((await h.store.commitMany([id])).lost).toEqual([id]);
		});

		test("releaseAdopted is ORDER-SCOPED: another order's adopted hold is skipped, and stays its owner's to release", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-A", 10);
			const theirs = await adoptedHold(h, "SKU-A", 2, "k-theirs", "ord-2");
			expect(await h.onHand("SKU-A")).toBe(8);

			// A stale ord-1 naming ord-2's hold: silent, and nothing moves.
			await expect(h.store.releaseAdopted(theirs, "ord-1")).resolves.toBeUndefined();
			await expect(h.store.releaseAdopted(theirs, "ord-1")).resolves.toBeUndefined();
			expect(await h.onHand("SKU-A")).toBe(8);
			// Still adopted, and still ord-2's: its replay adopts, ord-1's is lost.
			expect(await adoptOne(h, theirs, "ord-2")).toBe("adopted");
			expect(await adoptOne(h, theirs, "ord-1")).toBe("lost");

			// Its owner can still release it — once.
			await h.store.releaseAdopted(theirs, "ord-2");
			expect(await h.onHand("SKU-A")).toBe(10);
			await h.store.releaseAdopted(theirs, "ord-2");
			expect(await h.onHand("SKU-A")).toBe(10);
		});

		test("releaseAdopted leaves a committed hold, a cart-held hold and an unknown id alone: no throw, no stock moved, states unchanged", async () => {
			const h = await makeStore();
			if (!h.holdWithExpiry) return;
			await h.seed("SKU-A", 10);
			// Committed by the order that adopted it: the spent units must never return.
			const sold = await adoptedHold(h, "SKU-A", 1, "k-sold", "ord-1");
			await h.store.commit(sold);
			// Still a cart's live hold: never adopted, so no order may release it.
			const cartHeld = await h.holdWithExpiry("SKU-A", 3, "k-cart", FUTURE);
			expect(await h.onHand("SKU-A")).toBe(6);

			for (let pass = 0; pass < 2; pass++) {
				await expect(h.store.releaseAdopted(sold, "ord-1")).resolves.toBeUndefined();
				await expect(h.store.releaseAdopted(cartHeld, "ord-1")).resolves.toBeUndefined();
				await expect(
					h.store.releaseAdopted("no-such-reservation", "ord-1"),
				).resolves.toBeUndefined();
				expect(await h.onHand("SKU-A"), `pass ${pass}`).toBe(6);
			}

			// `sold` is still committed: a commit replay is benign, yet even its own
			// order can no longer adopt it.
			expect((await h.store.commitMany([sold])).lost).toEqual([]);
			expect(await adoptOne(h, sold, "ord-1")).toBe("lost");
			// `cartHeld` is still a live cart hold: a fresh order can adopt it, which
			// no released/committed/adopted row allows — and once adopted, that order
			// releases its 3 units normally.
			expect(await adoptOne(h, cartHeld, "ord-3")).toBe("adopted");
			await h.store.releaseAdopted(cartHeld, "ord-3");
			expect(await h.onHand("SKU-A")).toBe(9);
		});

		test("commitMany with no ids is a no-op ({ lost: [] })", async () => {
			const h = await makeStore();
			expect(await h.store.commitMany([])).toEqual({ lost: [] });
		});

		test("commitMany on an unknown reservation id THROWS (matches singular commit's #selectById)", async () => {
			const h = await makeStore();
			await expect(h.store.commitMany(["no-such-reservation"])).rejects.toThrow(
				/unknown reservation/,
			);
		});
	});
}
