/**
 * The crash tier: every window `EmdashInventoryStore` has, opened deliberately on
 * REAL storage, and proved to heal with exactly-once semantics.
 *
 * How a seam is built here, and why it is built this way:
 *
 * 1. A real storage collection is wrapped by `test/helpers/fault-injection.ts`.
 *    The wrapper delegates every method to the real repository; it only parks a
 *    chosen call or throws on it. Nothing is faked, so the document the replay
 *    heals is the document the host would really have left behind.
 * 2. A crash is `failCall(…, { mode: "after" })` or `{ mode: "instead" }` — the
 *    preceding write lands for real, and the continuation is lost. Every case
 *    **reads the documents back** before replaying, so "A durably landed" is
 *    asserted, not assumed.
 * 3. Then the replay runs on a CLEAN store, and the case asserts the heal: one
 *    hold, one decrement, one recorded answer, and the same reservation id.
 * 4. Every case carries the assertion that would FAIL if the write order were
 *    reversed. Those assertions are the point of the file; a case that only
 *    proved "a replay works" would pass under the forbidden order too.
 *
 * Seam (h) — a late same-key caller arriving after the hold was committed and
 * pruned — is NOT duplicated here: it is the gated case
 * "refuses to write a second hold when a peer's hold was committed and pruned
 * mid-flight" in `inventory-store-contract.dialects.test.ts`, which opens the same
 * window with the same helper.
 *
 * The contention budget at the bottom is Postgres-only, for the reason the race
 * suite states: one process over better-sqlite3 serializes writers and can never
 * make a compare-and-set lose.
 */
import type { ReserveResult } from "@otta-sh/domain";
import {
	idempotencyKey,
	ReservationCommitLostError,
	ReservationNotHeldError,
} from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	AppliedMovement,
	HoldEntry,
	InventoryDoc,
	MovementClaimDoc,
	ReservationIndexDoc,
	ReservationKeyDoc,
	StorageAccess,
	StorageCollection,
} from "../src/index.js";
import {
	adjustClaimId,
	APPLIED_MOVEMENT_RING_SIZE,
	CAS_MAX_ATTEMPTS,
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	INVENTORY_MOVEMENTS_COLLECTION,
	isStorageContentionError,
	newInventoryDoc,
	normalizeInventoryDoc,
	RESERVATION_INDEX_COLLECTION,
	RESERVATION_KEYS_COLLECTION,
	stockClaimId,
	uuidIdGen,
} from "../src/index.js";
import { describeEachDialect, makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	isUpdateWrite,
	onId,
	parkCall,
	settleOne,
	withCollection,
} from "./helpers/fault-injection.js";
import { INVENTORY_LAYOUT } from "./inventory-collections.js";

/** Every store in this file shares one frozen clock, so timestamps are legible. */
const NOW = "2026-07-10T00:00:00.000Z";

/**
 * The asserted contention budget for a compare-and-set step on one hot inventory
 * aggregate — a **permanent** budget, because R2 has no structural fix: the
 * aggregate is written by read-modify-write and will retry under load.
 *
 * It is set from measurement plus headroom, and it is deliberately STRICTLY below
 * {@link CAS_MAX_ATTEMPTS}: a run that merely reached the ceiling would mean some
 * shopper was one lost race away from a retryable failure. Measured on the two
 * shapes the budget suite runs (M units, N concurrent single-unit reserves):
 *
 * | shape | measured max attempts |
 * |---|---|
 * | M=5, N=50, 20 loops | 5–6 across repeated runs |
 * | M=1, N=100, 1 loop | 2 |
 *
 * The depth tracks M, not N — only M writes can ever succeed before the guard
 * turns every remaining caller into a clean `OUT_OF_STOCK` with no write at all, so
 * the worst case is M+1 attempts (lose M times, then win), which is what both rows
 * show. A crowd ten times larger does not move the number; more UNITS on
 * one hot sku would.
 *
 * That is also the honest limit of this budget: it covers the shapes where the
 * writes are bounded by the units. The merchant shape in
 * `restock-concurrency.pg.test.ts` — twenty guarded removals racing twenty reserves
 * on one document, where a REFUSED removal still writes its ledger entry — does
 * reach {@link CAS_MAX_ATTEMPTS} and does surface typed retryable failures; that
 * case asserts the invariants that survive them (no over-consumption, exact
 * conservation, never negative) and reports the count, because a contention failure
 * writes nothing.
 *
 * Raising this constant is a change to the budget: measure first, then move it, and
 * update the table above and the package README together.
 */
export const CAS_ATTEMPT_BUDGET = 8;

describeEachDialect("EmdashInventoryStore crash seams", (ctx) => {
	const bound = ctx.useStorage(INVENTORY_LAYOUT);

	/** The real, undecorated collection a wrapper decorates. */
	const raw = (name: string): StorageCollection => {
		const collection = bound.storage[name];
		if (collection === undefined) throw new Error(`collection '${name}' is not declared`);
		return collection;
	};

	const inventory = (): StorageCollection<InventoryDoc> =>
		collectionOf<InventoryDoc>(bound.storage, INVENTORY_COLLECTION);
	const keys = (): StorageCollection<ReservationKeyDoc> =>
		collectionOf<ReservationKeyDoc>(bound.storage, RESERVATION_KEYS_COLLECTION);
	const reverseIndex = (): StorageCollection<ReservationIndexDoc> =>
		collectionOf<ReservationIndexDoc>(bound.storage, RESERVATION_INDEX_COLLECTION);
	const movements = (): StorageCollection<MovementClaimDoc> =>
		collectionOf<MovementClaimDoc>(bound.storage, INVENTORY_MOVEMENTS_COLLECTION);

	/** A store over the real collections, or over a decorated set of them. */
	const makeStore = (storage: StorageAccess = bound.storage): EmdashInventoryStore =>
		new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date(NOW)),
			// No real backoff: these cases are deterministic, not timing-dependent.
			sleep: async () => {},
			random: () => 0,
		});

	/** A store whose `name` collection is the given decorated one. */
	const storeWith = (name: string, collection: StorageCollection): EmdashInventoryStore =>
		makeStore(withCollection(bound.storage, name, collection));

	const seed = async (sku: string, qty: number): Promise<void> => {
		await inventory().compareAndSet(sku, null, newInventoryDoc(sku, qty));
	};
	const onHand = async (sku: string): Promise<number> => (await inventory().get(sku))?.onHand ?? 0;
	const holdsOf = async (sku: string): Promise<Record<string, HoldEntry>> => {
		const doc = await inventory().get(sku);
		return doc === null ? {} : normalizeInventoryDoc(doc).holds;
	};
	const holdCount = async (sku: string): Promise<number> => Object.keys(await holdsOf(sku)).length;
	const ringOf = async (sku: string): Promise<AppliedMovement[]> => {
		const doc = await inventory().get(sku);
		return doc?.appliedMovements ?? [];
	};

	/** Stamp a cart hold deadline on a live hold, exactly as the cart store does. */
	const stampDeadline = async (sku: string, key: string, expiresAt: string): Promise<void> => {
		const current = await inventory().getVersioned(sku);
		if (current === null) throw new Error(`no inventory document for ${sku}`);
		const doc = normalizeInventoryDoc(current.value);
		const hold = doc.holds[key];
		if (hold === undefined) throw new Error(`no hold under key ${key}`);
		await inventory().compareAndSet(sku, current.revision, {
			...doc,
			holds: { ...doc.holds, [key]: { ...hold, expiresAt } },
		});
	};

	/**
	 * Overwrite the aggregate's applied-movement ring with a FULL ring of unrelated
	 * keys — the cheap, exact equivalent of performing
	 * {@link APPLIED_MOVEMENT_RING_SIZE} further movements on this sku, which is
	 * what it takes to evict a crashed movement's witness.
	 */
	const evictRing = async (sku: string, options: { keepHolds: boolean }): Promise<void> => {
		const current = await inventory().getVersioned(sku);
		if (current === null) throw new Error(`no inventory document for ${sku}`);
		const doc = normalizeInventoryDoc(current.value);
		const saturated: AppliedMovement[] = Array.from(
			{ length: APPLIED_MOVEMENT_RING_SIZE },
			(_unused, i) => ({
				key: `evicted-filler-${String(i)}`,
				kind: "stock",
				result: { ok: true, onHand: doc.onHand },
			}),
		);
		await inventory().compareAndSet(sku, current.revision, {
			...doc,
			holds: options.keepHolds ? doc.holds : {},
			appliedMovements: saturated,
		});
	};

	const claimedDoc = async (
		key: string,
	): Promise<Extract<ReservationKeyDoc, { state: "claimed" }>> => {
		const doc = await keys().get(key);
		if (doc === null || doc.state !== "claimed") {
			throw new Error(`reservation key ${key} is not in the claimed state`);
		}
		return doc;
	};

	// The budget itself is a plain arithmetic fact, so it is checked on EVERY dialect
	// rather than only where the race can run: a budget at or above the retry loop's
	// own ceiling asserts nothing, and that mistake must not need Postgres to catch.
	it("the asserted contention budget leaves headroom under the retry ceiling", () => {
		expect(CAS_ATTEMPT_BUDGET).toBeLessThan(CAS_MAX_ATTEMPTS);
	});

	// -- (a) claim written, the inventory compare-and-set never ran -------------

	describe("(a) the claim landed and the inventory compare-and-set never ran", () => {
		it("replays to the RECORDED id with one hold and exactly one decrement", async () => {
			await seed("SKU-A", 5);
			const key = idempotencyKey("k-a");

			// The claim write lands for real; the very next write — the reverse-lookup
			// entry — throws, so the inventory compare-and-set is never reached.
			const crash = failCall(raw(RESERVATION_INDEX_COLLECTION), isClaimWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(RESERVATION_INDEX_COLLECTION, crash.collection).reserve("SKU-A", 2, key),
			).rejects.toThrow(InjectedCrashError);
			expect(crash.failed()).toBe(1);

			// Read it back: the claim is DURABLE and it is all there is.
			const claim = await claimedDoc(key);
			expect(claim.sku).toBe("SKU-A");
			expect(claim.qty).toBe(2);
			expect(await reverseIndex().get(claim.reservationId)).toBeNull();
			expect(await onHand("SKU-A")).toBe(5);
			expect(await holdCount("SKU-A")).toBe(0);

			const healed = await makeStore().reserve("SKU-A", 2, key);
			// THE REVERSED-ORDER ASSERTION: the healed reserve answers with the id the
			// CLAIM recorded. Had the units moved before the claim was written, nothing
			// would link the decrement to this key, and the replay would mint a second
			// id and decrement a second time.
			expect(healed).toEqual({ ok: true, reservationId: claim.reservationId });
			expect(await onHand("SKU-A")).toBe(3);
			expect(await holdCount("SKU-A")).toBe(1);

			// And it stays once-only however many replayers arrive.
			expect(await makeStore().reserve("SKU-A", 2, key)).toEqual(healed);
			expect(await onHand("SKU-A")).toBe(3);
			expect(await holdCount("SKU-A")).toBe(1);
		});
	});

	// -- (b) index written, the inventory compare-and-set never ran -------------

	describe("(b) the reverse-lookup entry landed and the inventory compare-and-set never ran", () => {
		it("leaves an orphan index entry that misleads no id-taking method, then heals", async () => {
			await seed("SKU-B", 5);
			const key = idempotencyKey("k-b");

			// `mode: "after"`: the index write really happens, and only the
			// continuation is lost.
			const crash = failCall(raw(RESERVATION_INDEX_COLLECTION), isClaimWrite, { mode: "after" });
			await expect(
				storeWith(RESERVATION_INDEX_COLLECTION, crash.collection).reserve("SKU-B", 2, key),
			).rejects.toThrow(InjectedCrashError);

			const claim = await claimedDoc(key);
			// THE REVERSED-ORDER ASSERTION: the index entry exists while NO hold does.
			// That is the order the design requires — an id absent from the index is
			// provably unknown — and the reversed order (hold first) would make a
			// present hold with an absent index entry possible, which is the state
			// `commitMany`'s throw-vs-`lost` asymmetry cannot classify.
			expect(await reverseIndex().get(claim.reservationId)).toEqual({
				sku: "SKU-B",
				idempotencyKey: key,
			});
			expect(await holdCount("SKU-B")).toBe(0);
			expect(await onHand("SKU-B")).toBe(5);

			// The orphan entry must not be mistaken for a live reservation by any of
			// the id-taking methods — and each must behave as the port promises, which
			// for `adopt`/`releaseAdopted`/`commitMany` means NOT throwing.
			const store = makeStore();
			await expect(store.commit(claim.reservationId)).rejects.toBeInstanceOf(
				ReservationCommitLostError,
			);
			expect(
				await store.adopt({
					reservationId: claim.reservationId,
					orderId: "ord-b",
					holdExpiresAt: "2026-07-10T00:30:00.000Z",
					now: "2026-07-10T00:05:00.000Z",
				}),
			).toEqual({ ok: false, reason: "RESERVATION_LOST" });
			expect(
				await store.adoptMany({
					reservationIds: [claim.reservationId],
					orderId: "ord-b",
					holdExpiresAt: "2026-07-10T00:30:00.000Z",
					now: "2026-07-10T00:05:00.000Z",
				}),
			).toEqual({ adopted: [], lost: [claim.reservationId] });
			expect(await store.commitMany([claim.reservationId])).toEqual({
				lost: [claim.reservationId],
			});
			await expect(store.releaseAdopted(claim.reservationId, "ord-b")).resolves.toBeUndefined();
			// None of them moved a unit or resurrected a hold.
			expect(await onHand("SKU-B")).toBe(5);
			expect(await holdCount("SKU-B")).toBe(0);

			// The same claim still heals, to the same recorded id, exactly once.
			const healed = await makeStore().reserve("SKU-B", 2, key);
			expect(healed).toEqual({ ok: true, reservationId: claim.reservationId });
			expect(await onHand("SKU-B")).toBe(3);
			expect(await holdCount("SKU-B")).toBe(1);
		});
	});

	// -- (c) the compare-and-set ran and the terminal answer was never written --

	describe("(c) the inventory compare-and-set landed and the terminal answer was never written", () => {
		it("replays to the SAME reservation id with no second hold and one decrement", async () => {
			await seed("SKU-C", 5);
			const key = idempotencyKey("k-c");

			// The claim write is a create (`expectedRevision === null`); the terminal
			// answer is an UPDATE of the same document. Failing only the update leaves
			// the units moved and the answer unrecorded.
			const crash = failCall(raw(RESERVATION_KEYS_COLLECTION), isUpdateWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(RESERVATION_KEYS_COLLECTION, crash.collection).reserve("SKU-C", 2, key),
			).rejects.toThrow(InjectedCrashError);

			// Read it back: the decrement and the hold are DURABLE, the answer is not.
			expect(await onHand("SKU-C")).toBe(3);
			const hold = (await holdsOf("SKU-C"))[key];
			if (hold === undefined) throw new Error("the hold must have landed");
			const claim = await claimedDoc(key);
			expect(hold.reservationId).toBe(claim.reservationId);
			expect((await reverseIndex().get(claim.reservationId))?.terminalState).toBeUndefined();

			const replay = await makeStore().reserve("SKU-C", 2, key);
			// THE REVERSED-ORDER ASSERTION: the same id, from the claim written BEFORE
			// the units moved. A store that moved units first would have no record of
			// which id owns this decrement.
			expect(replay).toEqual({ ok: true, reservationId: claim.reservationId });
			expect(await onHand("SKU-C")).toBe(3);
			expect(await holdCount("SKU-C")).toBe(1);
			// The replay also finishes the interrupted job: the answer is now durable.
			expect((await keys().get(key))?.state).toBe("terminal");
		});
	});

	// -- (d) terminal answer written, the prune never ran ----------------------

	describe("(d) the terminal answer landed and the prune never ran", () => {
		it("commit: the replay is a no-op success, the same-key reserve answers terminally, and the prune happens once", async () => {
			await seed("SKU-D1", 5);
			const key = idempotencyKey("k-d1");
			const first = await makeStore().reserve("SKU-D1", 2, key);
			if (!first.ok) throw new Error("the seed reserve must succeed");

			// The prune is the only inventory UPDATE in the commit path.
			const crash = failCall(raw(INVENTORY_COLLECTION), isUpdateWrite, { mode: "instead" });
			await expect(
				storeWith(INVENTORY_COLLECTION, crash.collection).commit(first.reservationId),
			).rejects.toThrow(InjectedCrashError);

			// Read it back: terminal recorded, hold STILL LIVE.
			expect(await keys().get(key)).toEqual({
				state: "terminal",
				result: first,
				reservationId: first.reservationId,
				recordedAt: NOW,
			});
			expect((await reverseIndex().get(first.reservationId))?.terminalState).toBe("committed");
			expect(await holdCount("SKU-D1")).toBe(1);
			expect(await onHand("SKU-D1")).toBe(3);

			// THE REVERSED-ORDER ASSERTION: a same-key reserve is answered from the
			// terminal document. Under prune-first-then-crash there would be neither a
			// terminal answer nor a hold, the key would look fresh, and this call would
			// decrement a second time.
			const store = makeStore();
			expect(await store.reserve("SKU-D1", 2, key)).toEqual(first);
			expect(await onHand("SKU-D1")).toBe(3);
			expect(await holdCount("SKU-D1")).toBe(1);

			// A replay of the commit is a no-op success that completes the prune.
			await expect(store.commit(first.reservationId)).resolves.toBeUndefined();
			expect(await holdCount("SKU-D1")).toBe(0);
			expect(await onHand("SKU-D1")).toBe(3); // a commit consumes the units
			// Exactly once: a further replay prunes nothing and returns nothing.
			await expect(store.commit(first.reservationId)).resolves.toBeUndefined();
			expect(await onHand("SKU-D1")).toBe(3);
			// And the terminal answer outlives the prune, which is the whole point.
			expect(await store.reserve("SKU-D1", 2, key)).toEqual(first);
			expect(await holdCount("SKU-D1")).toBe(0);
		});

		it("release: the units are returned by the completing replay exactly once", async () => {
			await seed("SKU-D2", 5);
			const key = idempotencyKey("k-d2");
			const first = await makeStore().reserve("SKU-D2", 2, key);
			if (!first.ok) throw new Error("the seed reserve must succeed");

			const crash = failCall(raw(INVENTORY_COLLECTION), isUpdateWrite, { mode: "instead" });
			await expect(
				storeWith(INVENTORY_COLLECTION, crash.collection).release(first.reservationId),
			).rejects.toThrow(InjectedCrashError);

			// Terminal recorded; the units have NOT come back yet, and the hold is live.
			expect((await reverseIndex().get(first.reservationId))?.terminalState).toBe("released");
			expect(await holdCount("SKU-D2")).toBe(1);
			expect(await onHand("SKU-D2")).toBe(3);

			const store = makeStore();
			// THE REVERSED-ORDER ASSERTION: the same-key reserve still answers with the
			// original result rather than looking fresh and taking 2 more units.
			expect(await store.reserve("SKU-D2", 2, key)).toEqual(first);
			expect(await onHand("SKU-D2")).toBe(3);

			await expect(store.release(first.reservationId)).resolves.toBeUndefined();
			expect(await holdCount("SKU-D2")).toBe(0);
			expect(await onHand("SKU-D2")).toBe(5); // restored ONCE
			// Not twice: every further replayer finds nothing to return.
			await expect(store.release(first.reservationId)).resolves.toBeUndefined();
			await expect(store.releaseAdopted(first.reservationId, "ord-d2")).resolves.toBeUndefined();
			expect(await onHand("SKU-D2")).toBe(5);
			expect(await store.reserve("SKU-D2", 2, key)).toEqual(first);
			expect(await onHand("SKU-D2")).toBe(5);
		});
	});

	// -- (e) the FORBIDDEN order, pinned ---------------------------------------

	describe("(e) prune-before-terminal is the forbidden order", () => {
		/**
		 * This cannot be injected, because the store does not do it. So it is pinned
		 * from the other side: the terminal write is PARKED, and while it is parked the
		 * hold must still be LIVE — i.e. the prune has demonstrably not run yet. Then
		 * the gate is released and the prune follows.
		 *
		 * This is the only test of the ordering rule in the whole work order. It must
		 * never be weakened into "a replay works": a store that pruned first and then
		 * recorded the outcome would pass every replay case in this file and fail
		 * exactly here.
		 */
		it("commit parks its terminal write: the hold is still live while parked, and the prune follows", async () => {
			await seed("SKU-E1", 5);
			const key = idempotencyKey("k-e1");
			const first = await makeStore().reserve("SKU-E1", 2, key);
			if (!first.ok) throw new Error("the seed reserve must succeed");

			// The terminal STATE write (the reverse-lookup update) is the last terminal
			// record the settle makes before it prunes.
			const parked = parkCall(raw(RESERVATION_INDEX_COLLECTION), isUpdateWrite);
			const settling = storeWith(RESERVATION_INDEX_COLLECTION, parked.collection).commit(
				first.reservationId,
			);
			await parked.arrived;

			// THE ORDERING ASSERTION. The terminal write has not committed yet, so the
			// prune cannot have happened: the hold is live and the count is unchanged.
			expect(await holdCount("SKU-E1")).toBe(1);
			expect(await onHand("SKU-E1")).toBe(3);
			expect((await reverseIndex().get(first.reservationId))?.terminalState).toBeUndefined();
			// And the replay answer is ALREADY durable on the key document — written
			// before anything was pruned, which is the rule.
			expect((await keys().get(key))?.state).toBe("terminal");

			parked.release();
			await settling;
			// The prune FOLLOWS the terminal write, never precedes it.
			expect(await holdCount("SKU-E1")).toBe(0);
			expect((await reverseIndex().get(first.reservationId))?.terminalState).toBe("committed");
			expect(await onHand("SKU-E1")).toBe(3);
		});

		it("release parks its terminal write: the units are still off the shelf while parked", async () => {
			await seed("SKU-E2", 5);
			const key = idempotencyKey("k-e2");
			const first = await makeStore().reserve("SKU-E2", 2, key);
			if (!first.ok) throw new Error("the seed reserve must succeed");

			const parked = parkCall(raw(RESERVATION_INDEX_COLLECTION), isUpdateWrite);
			const settling = storeWith(RESERVATION_INDEX_COLLECTION, parked.collection).release(
				first.reservationId,
			);
			await parked.arrived;

			// THE ORDERING ASSERTION: units are returned by the prune, and the prune has
			// not run, because the terminal record has not landed.
			expect(await onHand("SKU-E2")).toBe(3);
			expect(await holdCount("SKU-E2")).toBe(1);
			expect((await reverseIndex().get(first.reservationId))?.terminalState).toBeUndefined();

			parked.release();
			await settling;
			expect(await onHand("SKU-E2")).toBe(5);
			expect(await holdCount("SKU-E2")).toBe(0);
		});
	});

	// -- (f) the movement landed, the claim was never marked applied ------------

	describe("(f) the movement landed on the aggregate and its claim was never marked applied", () => {
		it("restock: the replay marks the claim applied and moves nothing twice", async () => {
			await seed("SKU-F1", 10);
			const key = idempotencyKey("k-f1");

			// The claim intent is a create; "mark applied" is an UPDATE of the same
			// document. Failing the update is exactly the one-round-trip window the
			// applied-movement ring exists to cover.
			const crash = failCall(raw(INVENTORY_MOVEMENTS_COLLECTION), isUpdateWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_MOVEMENTS_COLLECTION, crash.collection).restock("SKU-F1", 7, key),
			).rejects.toThrow(InjectedCrashError);

			// Read it back: the units moved, the claim did not record it.
			expect(await onHand("SKU-F1")).toBe(17);
			expect((await movements().get(stockClaimId(key)))?.applied).toBeUndefined();
			// THE REVERSED-ORDER ASSERTION: the aggregate itself carries the witness,
			// exactly once. Had the claim been marked applied BEFORE the aggregate
			// write, this crash would have left a key recorded as done whose units never
			// moved — and every replay would return a result the shelf never saw.
			expect((await ringOf("SKU-F1")).filter((entry) => entry.key === key)).toHaveLength(1);

			const replay = await makeStore().restock("SKU-F1", 7, key);
			expect(replay).toEqual({ ok: true, onHand: 17 });
			expect(await onHand("SKU-F1")).toBe(17); // nothing applied twice
			expect((await movements().get(stockClaimId(key)))?.applied?.result).toEqual(replay);
			// A second replay is the recorded answer, read from the claim document.
			expect(await makeStore().restock("SKU-F1", 7, key)).toEqual(replay);
			expect(await onHand("SKU-F1")).toBe(17);
		});

		it("removeStock: the replay marks the claim applied and removes nothing twice", async () => {
			await seed("SKU-F2", 10);
			const key = idempotencyKey("k-f2");

			const crash = failCall(raw(INVENTORY_MOVEMENTS_COLLECTION), isUpdateWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_MOVEMENTS_COLLECTION, crash.collection).removeStock("SKU-F2", 4, key),
			).rejects.toThrow(InjectedCrashError);

			expect(await onHand("SKU-F2")).toBe(6);
			expect((await movements().get(stockClaimId(key)))?.applied).toBeUndefined();
			expect((await ringOf("SKU-F2")).filter((entry) => entry.key === key)).toHaveLength(1);

			const replay = await makeStore().removeStock("SKU-F2", 4, key);
			expect(replay).toEqual({ ok: true, onHand: 6 });
			expect(await onHand("SKU-F2")).toBe(6);
			expect((await movements().get(stockClaimId(key)))?.applied?.result).toEqual(replay);
		});

		it("adjust: the replay is answered by the hold's own witness and moves nothing twice", async () => {
			await seed("SKU-F3", 20);
			const reserveKey = idempotencyKey("k-f3-hold");
			const held = await makeStore().reserve("SKU-F3", 2, reserveKey);
			if (!held.ok) throw new Error("the seed reserve must succeed");
			expect(await onHand("SKU-F3")).toBe(18);

			const key = idempotencyKey("k-f3-adj");
			const crash = failCall(raw(INVENTORY_MOVEMENTS_COLLECTION), isUpdateWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_MOVEMENTS_COLLECTION, crash.collection).adjust(
					held.reservationId,
					5,
					key,
				),
			).rejects.toThrow(InjectedCrashError);

			// Read it back: the hold moved to 5 and the delta left the shelf; the claim
			// has no recorded answer.
			expect(await onHand("SKU-F3")).toBe(15);
			const hold = (await holdsOf("SKU-F3"))[reserveKey];
			expect(hold?.qty).toBe(5);
			// THE REVERSED-ORDER ASSERTION, twice over: the aggregate carries BOTH
			// witnesses (the ring entry and the hold's own `lastMovementKey`), written in
			// the same commit as the units. A claim marked applied first would have
			// promised a move that never happened.
			expect(hold?.lastMovementKey).toBe(key);
			expect((await ringOf("SKU-F3")).filter((entry) => entry.key === key)).toHaveLength(1);
			expect((await movements().get(adjustClaimId(key)))?.applied).toBeUndefined();

			const replay = await makeStore().adjust(held.reservationId, 5, key);
			expect(replay).toEqual({ ok: true, reservationId: held.reservationId });
			expect(await onHand("SKU-F3")).toBe(15); // nothing applied twice
			expect((await holdsOf("SKU-F3"))[reserveKey]?.qty).toBe(5);
			expect((await movements().get(adjustClaimId(key)))?.applied?.result).toEqual(replay);
		});

		it("restock past ring eviction RE-APPLIES — the documented, ACCEPTED residual the sweeper contract bounds (do not 'fix' this test)", async () => {
			// This is not a bug being tolerated quietly; it is the residual the
			// applied-movement ring's bound leaves, stated in `inventory-documents.ts`
			// and in this package's README, together with the contract that closes it:
			//
			//   a movement claim whose `applied` is ABSENT and whose key still appears
			//   in the aggregate's ring (or on a hold) is given its `applied` record by
			//   the sweeper BEFORE that key can be evicted from the ring.
			//
			// Reaching this state therefore takes a crash plus at least
			// APPLIED_MOVEMENT_RING_SIZE further movements on ONE sku before the next
			// sweep. Asserting it is how the residual stays a known, bounded, sweeper-
			// owned fact instead of quietly widening.
			await seed("SKU-F4", 10);
			const key = idempotencyKey("k-f4");
			const crash = failCall(raw(INVENTORY_MOVEMENTS_COLLECTION), isUpdateWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_MOVEMENTS_COLLECTION, crash.collection).restock("SKU-F4", 7, key),
			).rejects.toThrow(InjectedCrashError);
			expect(await onHand("SKU-F4")).toBe(17);

			// The witness is evicted — the cheap equivalent of 256 later movements.
			await evictRing("SKU-F4", { keepHolds: true });
			expect((await ringOf("SKU-F4")).some((entry) => entry.key === key)).toBe(false);
			expect((await movements().get(stockClaimId(key)))?.applied).toBeUndefined();

			// With no witness left, the replay applies the movement a SECOND time.
			const reapplied = await makeStore().restock("SKU-F4", 7, key);
			expect(reapplied).toEqual({ ok: true, onHand: 24 });
			expect(await onHand("SKU-F4")).toBe(24);
			// It is at least self-limiting: the claim is now applied, so a THIRD
			// replay returns the recorded answer and moves nothing.
			expect(await makeStore().restock("SKU-F4", 7, key)).toEqual(reapplied);
			expect(await onHand("SKU-F4")).toBe(24);
		});

		it("adjust past ring eviction and prune throws ReservationNotHeldError rather than inventing an answer — the same ACCEPTED residual", async () => {
			await seed("SKU-F5", 20);
			const reserveKey = idempotencyKey("k-f5-hold");
			const held = await makeStore().reserve("SKU-F5", 2, reserveKey);
			if (!held.ok) throw new Error("the seed reserve must succeed");

			const key = idempotencyKey("k-f5-adj");
			const crash = failCall(raw(INVENTORY_MOVEMENTS_COLLECTION), isUpdateWrite, {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_MOVEMENTS_COLLECTION, crash.collection).adjust(
					held.reservationId,
					5,
					key,
				),
			).rejects.toThrow(InjectedCrashError);

			// Both witnesses gone: the ring evicted AND the hold pruned. Per the
			// `adjust` docblock this is the one state with no durable witness left, and
			// the store refuses to invent a recorded answer.
			await evictRing("SKU-F5", { keepHolds: false });
			await expect(makeStore().adjust(held.reservationId, 5, key)).rejects.toBeInstanceOf(
				ReservationNotHeldError,
			);
			// It refused rather than moved: the shelf is untouched by the refusal.
			expect(await onHand("SKU-F5")).toBe(15);
			expect((await movements().get(adjustClaimId(key)))?.applied).toBeUndefined();
		});
	});

	// -- (g) a partial batch across N SKUs -------------------------------------

	describe("(g) a partial commitMany / adoptMany across 3 SKUs", () => {
		const SKUS = ["SKU-G1", "SKU-G2", "SKU-G3"] as const;
		const KEYS = ["k-g1", "k-g2", "k-g3"] as const;

		/** Three SKUs, one 2-unit hold on each, deadlines stamped for adoption. */
		const seedThree = async (): Promise<string[]> => {
			const store = makeStore();
			const ids: string[] = [];
			for (const [i, sku] of SKUS.entries()) {
				await seed(sku, 10);
				const key = KEYS[i];
				if (key === undefined) throw new Error("missing key");
				const reserved = await store.reserve(sku, 2, idempotencyKey(key));
				if (!reserved.ok) throw new Error(`the seed reserve for ${sku} must succeed`);
				await stampDeadline(sku, key, "2026-07-10T00:15:00.000Z");
				ids.push(reserved.reservationId);
			}
			return ids;
		};

		it("commitMany: the first SKU commits, the rest stay held, and any replayer completes it exactly once", async () => {
			const ids = await seedThree();
			const [id1, id2, id3] = ids;
			if (id1 === undefined || id2 === undefined || id3 === undefined) {
				throw new Error("three reservations are required");
			}

			// The prune for the SECOND sku throws; the batch is applied per SKU, so the
			// first is already durable and the third is never reached.
			const crash = failCall(raw(INVENTORY_COLLECTION), onId(SKUS[1], isUpdateWrite), {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_COLLECTION, crash.collection).commitMany(ids),
			).rejects.toThrow(InjectedCrashError);

			// SKU 1 fully committed; SKU 2 terminal-but-unpruned; SKU 3 untouched.
			expect(await holdCount(SKUS[0])).toBe(0);
			expect(await onHand(SKUS[0])).toBe(8);
			expect(await holdCount(SKUS[1])).toBe(1);
			expect((await reverseIndex().get(id2))?.terminalState).toBe("committed");
			expect(await holdCount(SKUS[2])).toBe(1);
			expect((await reverseIndex().get(id3))?.terminalState).toBeUndefined();

			// THE REVERSED-ORDER ASSERTION, for the SKU caught mid-settle: its terminal
			// record exists while its hold is still live, so a same-key reserve replay
			// is answered terminally instead of decrementing again.
			const store = makeStore();
			expect(await store.reserve(SKUS[1], 2, idempotencyKey(KEYS[1]))).toEqual({
				ok: true,
				reservationId: id2,
			});
			expect(await onHand(SKUS[1])).toBe(8);
			expect(await holdCount(SKUS[1])).toBe(1);

			// A REPLAY of the same batch: every already-committed id is a no-op, and the
			// unreached SKU is finished.
			expect(await store.commitMany(ids)).toEqual({ lost: [] });
			expect(await holdCount(SKUS[2])).toBe(0);
			expect(await onHand(SKUS[2])).toBe(8);
			// `commitMany` skips an id that is ALREADY terminal, so SKU 2's orphaned
			// prune is not what completes it — the singular `commit` any replayer (and
			// the order-intent sweeper) runs is, and it completes it exactly once.
			expect(await holdCount(SKUS[1])).toBe(1);
			await expect(store.commit(id2)).resolves.toBeUndefined();
			expect(await holdCount(SKUS[1])).toBe(0);
			await expect(store.commit(id2)).resolves.toBeUndefined();

			// No units were returned anywhere: a committed hold consumes them, and
			// nothing was released twice.
			for (const sku of SKUS) {
				expect(await onHand(sku)).toBe(8);
				expect(await holdCount(sku)).toBe(0);
			}
		});

		it("adoptMany: the first SKU is adopted, and the replay adopts the rest with the adopted one idempotent", async () => {
			const ids = await seedThree();
			const input = {
				reservationIds: ids,
				orderId: "ord-g",
				holdExpiresAt: "2026-07-10T00:30:00.000Z",
				now: "2026-07-10T00:05:00.000Z",
			};

			const crash = failCall(raw(INVENTORY_COLLECTION), onId(SKUS[1], isUpdateWrite), {
				mode: "instead",
			});
			await expect(
				storeWith(INVENTORY_COLLECTION, crash.collection).adoptMany(input),
			).rejects.toThrow(InjectedCrashError);

			expect((await holdsOf(SKUS[0]))[KEYS[0]]?.state).toBe("adopted");
			expect((await holdsOf(SKUS[1]))[KEYS[1]]?.state).toBe("held");
			expect((await holdsOf(SKUS[2]))[KEYS[2]]?.state).toBe("held");

			// The replay completes the set; the already-adopted hold resolves `ok`
			// without being re-flipped, and no unit moves for any of it.
			const store = makeStore();
			const replayed = await store.adoptMany(input);
			expect(replayed.adopted.toSorted()).toEqual(ids.toSorted());
			expect(replayed.lost).toEqual([]);
			for (const [i, sku] of SKUS.entries()) {
				const key = KEYS[i];
				if (key === undefined) throw new Error("missing key");
				const hold = (await holdsOf(sku))[key];
				expect(hold?.state).toBe("adopted");
				expect(hold?.orderId).toBe("ord-g");
				expect(hold?.qty).toBe(2);
				expect(await onHand(sku)).toBe(8);
			}

			// And the batch that follows an adoption commits all three, once.
			expect(await store.commitMany(ids)).toEqual({ lost: [] });
			for (const sku of SKUS) {
				expect(await holdCount(sku)).toBe(0);
				expect(await onHand(sku)).toBe(8);
			}
		});
	});
});

// -- the contention budget (R2) -------------------------------------------------

/**
 * The permanent contention budget, measured on the real race.
 *
 * Postgres only, for the reason the race suite gives: better-sqlite3 serializes
 * writers in one process, so no compare-and-set can ever lose there and the depth
 * would always read 1.
 */
describe.skipIf(!PG_ENABLED)("inventory compare-and-set contention budget [postgres]", () => {
	let storage: StorageAccess;
	let close: (() => Promise<void>) | undefined;

	beforeAll(async () => {
		// As close to a connection per racer as a single test server allows. The
		// M=5/N=50 shape the budget is SET from has a connection to spare per caller,
		// so every one of its writers really contends. The harsher M=1/N=100 shape asks
		// for more clients than one server hands out (the harness also holds an admin
		// connection), so its last few callers queue for a connection rather than
		// racing — which can only make that shape's depth an UNDER-estimate, and it is
		// already the shallower of the two, so the budget does not rest on it.
		const db = await makePgStorage(INVENTORY_LAYOUT, 96);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	/**
	 * Run `racers` single-unit reserves against `units` on a fresh sku, `loops`
	 * times, and return the deepest compare-and-set depth any caller spent.
	 */
	const burst = async (
		label: string,
		units: number,
		racers: number,
		loops: number,
	): Promise<number> => {
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		let maxAttempts = 0;
		const store = new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date(NOW)),
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		});

		for (let loop = 0; loop < loops; loop++) {
			const sku = `SKU-BUDGET-${label}-${String(loop)}`;
			await inventory.compareAndSet(sku, null, newInventoryDoc(sku, units));
			const settled = await Promise.all(
				Array.from({ length: racers }, (_unused, i) =>
					settleOne(
						store.reserve(sku, 1, idempotencyKey(`b-${label}-${String(loop)}-${String(i)}`)),
					),
				),
			);
			let winners = 0;
			for (const result of settled) {
				// A contention failure is legal under the budget only if it never
				// happens — which is exactly what the budget assertion below pins.
				if (isStorageContentionError(result)) continue;
				if (result instanceof Error) throw result;
				const reserve = result as ReserveResult;
				if (reserve.ok) winners++;
				else expect(reserve.reason).toBe("OUT_OF_STOCK");
			}
			expect(winners, `${label} loop ${String(loop)}: winners`).toBe(Math.min(units, racers));
			expect(await inventory.get(sku).then((doc) => doc?.onHand)).toBe(Math.max(0, units - racers));
		}
		return maxAttempts;
	};

	it(`the flash-sale shape (5 units, 50 racers, 20 loops) stays within the budget of ${String(CAS_ATTEMPT_BUDGET)}`, async () => {
		const maxAttempts = await burst("m5n50", 5, 50, 20);
		console.info(
			`[contention-budget] shape=M5/N50 loops=20 maxCasAttempts=${String(maxAttempts)} ` +
				`budget=${String(CAS_ATTEMPT_BUDGET)} ceiling=${String(CAS_MAX_ATTEMPTS)}`,
		);
		expect(maxAttempts).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
	}, 300_000);

	it("the harsher shape (1 unit, 100 racers) stays within the budget, and is no deeper", async () => {
		const maxAttempts = await burst("m1n100", 1, 100, 1);
		console.info(
			`[contention-budget] shape=M1/N100 loops=1 maxCasAttempts=${String(maxAttempts)} ` +
				`budget=${String(CAS_ATTEMPT_BUDGET)} ceiling=${String(CAS_MAX_ATTEMPTS)}`,
		);
		expect(maxAttempts).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		// And it is NO DEEPER than the smaller crowd's shape, asserted rather than
		// merely claimed: the depth tracks the UNITS, not the crowd — only one write
		// can succeed before every other caller reads `onHand: 0` and decides cleanly
		// with no write at all — so ten times the crowd must not move the number.
		expect(maxAttempts).toBeLessThanOrEqual(6);
	}, 300_000);
});
