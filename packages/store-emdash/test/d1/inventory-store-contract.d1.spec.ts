/**
 * The domain's `inventoryStoreContract` against `EmdashInventoryStore`, on **D1**.
 *
 * The contract suite IS the spec, and this file runs it in full against the
 * dialect Otta actually ships on — zero skips, the same cases the fake, the SQL
 * adapter and the two Node tiers run. If it is green here, the adapter's document
 * model works on D1's SQLite build and not only on `better-sqlite3`'s.
 *
 * The harness wiring is the Node suite's, re-stated rather than imported: the
 * Node file binds itself to `describeEachDialect`, which imports `better-sqlite3`
 * and `pg` at module scope and therefore cannot load inside `workerd` at all.
 * The parts that would rot if they drifted — the collection layout, the document
 * helpers, the contract itself — are all imported, so what is duplicated here is
 * only the ~60 lines of test-surface plumbing between them.
 */
import { idempotencyKey } from "@otta-sh/domain";
import type { InventoryStoreHarness } from "@otta-sh/domain/testing";
import { CountingIdGen, FixedClock, inventoryStoreContract } from "@otta-sh/domain/testing";
import { describe, expect, it } from "vitest";
import type { InventoryDoc, ReservationKeyDoc, StorageAccess } from "../../src/index.js";
import {
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	normalizeInventoryDoc,
	RESERVATION_KEYS_COLLECTION,
} from "../../src/index.js";
import { INVENTORY_LAYOUT } from "../inventory-collections.js";
import { useD1Storage } from "./describe-d1.js";

/**
 * The dialect harness plus the one crash-window hook the contract asks for.
 *
 * `abandonPending` is not decoration: the contract's W1 case reads the hook off
 * the harness and RETURNS EARLY if it is absent, so a harness without it passes
 * that case while asserting nothing. It must be here, or the claim that this file
 * runs the same cases as the Node tiers is false for exactly one case.
 */
interface EmdashHarness extends InventoryStoreHarness {
	/**
	 * Crash window W1, faithfully: the reserve key's claim document written, its
	 * inventory `compareAndSet` never run — no hold, no reverse-lookup entry.
	 */
	abandonPending(sku: string, qty: number, key: string): Promise<void>;
	/** The id recorded by the last `abandonPending`, so a case can assert reuse. */
	abandonedReservationId(): string | undefined;
}

function buildHarness(storage: StorageAccess): EmdashHarness {
	const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	const keys = collectionOf<ReservationKeyDoc>(storage, RESERVATION_KEYS_COLLECTION);
	const idGen = new CountingIdGen("res");
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new EmdashInventoryStore({ storage, idGen, clock });
	let abandoned: string | undefined;
	return {
		store,
		async seed(sku, qty) {
			// The test-surface stock write: unlike `seedOnHand` it OVERWRITES the
			// count, and unlike a bare `put` it preserves the live holds and the
			// applied-movement ring.
			const current = await inventory.getVersioned(sku);
			if (current === null) {
				await inventory.compareAndSet(sku, null, newInventoryDoc(sku, qty));
				return;
			}
			await inventory.compareAndSet(sku, current.revision, {
				...normalizeInventoryDoc(current.value),
				onHand: qty,
			});
		},
		async onHand(sku) {
			const doc = await inventory.get(sku);
			return doc?.onHand ?? 0;
		},
		async holdWithExpiry(sku, qty, key, expiresAt) {
			// A held reservation with the cart's hold deadline stamped on it — the
			// precondition `adopt`/`adoptMany`'s `expiresAt > now` guard needs, since
			// a bare `reserve` leaves it unstamped.
			//
			// It calls the store's OWN `stampHoldDeadline`, the same `held`-scoped
			// guarded write the cart adapter's attach guard uses, rather than patching
			// the document by hand: a hand patch could stamp a hold the real stamp
			// would have refused, and this hook's whole job is to build a state the
			// production path can produce.
			const reserved = await store.reserve(sku, qty, idempotencyKey(key));
			if (!reserved.ok) throw new Error(`holdWithExpiry reserve failed for ${sku}`);
			const stamped = await store.stampHoldDeadline(reserved.reservationId, expiresAt);
			if (!stamped) throw new Error(`could not stamp the hold under key ${key}`);
			return reserved.reservationId;
		},
		async abandonPending(sku, qty, key) {
			// The claim the store itself would have written, and nothing else: the id
			// comes from the SAME `IdGen` the store draws from, so a heal that reuses
			// it demonstrably read the claim rather than minting a fresh id.
			abandoned = idGen.newId();
			const written = await keys.compareAndSet(key, null, {
				state: "claimed",
				sku,
				qty,
				reservationId: abandoned,
				claimedAt: clock.now().toISOString(),
			});
			if (!written.applied) throw new Error(`idempotency key ${key} is already claimed`);
		},
		abandonedReservationId() {
			return abandoned;
		},
	};
}

const bound = useD1Storage(INVENTORY_LAYOUT);
inventoryStoreContract(async () => buildHarness(bound.storage), { dialect: "d1" });

// The contract's W1 case asserts that the heal happened and that it decremented
// once; it cannot assert WHICH id the heal answered with, because the hook's return
// type is part of no port. That half is what makes the hook worth having, so it is
// asserted here.
describe("the reserve claim's crash window (W1) on D1", () => {
	it("completes an abandoned claim with the RECORDED reservation id, decrementing exactly once", async () => {
		const h = buildHarness(bound.storage);
		await h.seed("SKU-W1", 5);
		await h.abandonPending("SKU-W1", 2, "k-w1");
		const recorded = h.abandonedReservationId();
		expect(recorded).toBeDefined();
		// Nothing but the claim exists yet: no hold, no decrement.
		expect(await h.onHand("SKU-W1")).toBe(5);

		const healed = await h.store.reserve("SKU-W1", 2, idempotencyKey("k-w1"));
		// Minting a second id here would be a second reservation for one key.
		expect(healed).toEqual({ ok: true, reservationId: recorded });
		expect(await h.onHand("SKU-W1")).toBe(3);
		// And the completed reservation is a real one: committable by its id.
		if (!healed.ok) throw new Error("unreachable");
		await h.store.commit(healed.reservationId);
		expect(await h.onHand("SKU-W1")).toBe(3);
	});
});
