/**
 * The domain's `inventoryStoreContract` against `EmdashInventoryStore`, on every
 * dialect, over real `PluginStorageRepository` instances.
 *
 * The contract suite IS the spec: a change to this adapter is done when the whole
 * suite is green here, on the same cases the fake and the SQL adapter run. The
 * adapter-specific cases at the bottom cover what the port cannot express because
 * it is a property of THIS document model:
 *
 * - a reserve replay still answers from the key document after the hold has been
 *   pruned (the CONSEQUENCE of writing the outcome before the prune; the ORDER of
 *   those two writes is only observable under fault injection, which is INC-A3);
 * - the retry-exhaustion error is typed and retryable, never `OUT_OF_STOCK`.
 */
import { idempotencyKey } from "@otta-sh/domain";
import type { InventoryStoreHarness } from "@otta-sh/domain/testing";
import { CountingIdGen, FixedClock, inventoryStoreContract } from "@otta-sh/domain/testing";
import { describe, expect, it } from "vitest";
import type { InventoryDoc, ReservationKeyDoc, StorageAccess } from "../src/index.js";
import {
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	isStorageContentionError,
	newInventoryDoc,
	normalizeInventoryDoc,
	RESERVATION_KEYS_COLLECTION,
	uuidIdGen,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	alwaysLosingCollection,
	isUpdateWrite,
	parkCall,
	withCollection,
} from "./helpers/fault-injection.js";
import { INVENTORY_LAYOUT } from "./inventory-collections.js";

/** The dialect harness plus the one crash-window seam this model actually has. */
interface EmdashHarness extends InventoryStoreHarness {
	/**
	 * Crash window W1, faithfully: the reserve key's claim document written, its
	 * inventory `compareAndSet` never run — no hold, no reverse-lookup entry.
	 *
	 * This is the window the store actually reads on every `reserve`, so a same-key
	 * replay enters the completion path, decrements exactly once, and resolves to
	 * the reservation id RECORDED in the claim rather than minting a second one. The
	 * claim carries the id this harness's own `IdGen` hands out next, which is the
	 * same source the store draws from — so the completion demonstrably reuses it.
	 */
	abandonPending(sku: string, qty: number, key: string): Promise<void>;
	/** The id recorded by the last `abandonPending`, so a case can assert reuse. */
	abandonedReservationId(): string | undefined;
	/** How many live holds the aggregate carries, for the prune assertions. */
	holdCount(sku: string): Promise<number>;
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
			// applied-movement ring (a case seeds mid-flight and then asserts on an
			// existing hold and on a recorded movement).
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
		async holdCount(sku) {
			const doc = await inventory.get(sku);
			return doc === null ? 0 : Object.keys(normalizeInventoryDoc(doc).holds).length;
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

describeEachDialect("EmdashInventoryStore", (ctx) => {
	const bound = ctx.useStorage(INVENTORY_LAYOUT);
	inventoryStoreContract(async () => buildHarness(bound.storage), { dialect: ctx.dialect });
});

// -- what the port cannot express, because it is this model's own property ------

describeEachDialect("EmdashInventoryStore document model", (ctx) => {
	const bound = ctx.useStorage(INVENTORY_LAYOUT);
	const harness = (): EmdashHarness => buildHarness(bound.storage);

	describe("the reserve claim's crash window (W1)", () => {
		it("completes an abandoned claim with the RECORDED reservation id, decrementing exactly once", async () => {
			const h = harness();
			await h.seed("SKU-1", 5);
			await h.abandonPending("SKU-1", 2, "k1");
			const recorded = h.abandonedReservationId();
			expect(recorded).toBeDefined();
			// No hold and no reverse-lookup entry exist yet: the claim is all there is.
			expect(await h.holdCount("SKU-1")).toBe(0);
			expect(await h.onHand("SKU-1")).toBe(5);

			const healed = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			// A completion reuses the claimed id; minting a second one would be a
			// second reservation for one key.
			expect(healed).toEqual({ ok: true, reservationId: recorded });
			expect(await h.onHand("SKU-1")).toBe(3);
			expect(await h.holdCount("SKU-1")).toBe(1);
			// And the completed reservation is a real one: committable by its id.
			if (!healed.ok) throw new Error("unreachable");
			await h.store.commit(healed.reservationId);
			expect(await h.onHand("SKU-1")).toBe(3);
		});

		it("leaves no reservation id and no index entry behind when the claim resolves OUT_OF_STOCK", async () => {
			const h = harness();
			await h.seed("SKU-1", 1);
			const failed = await h.store.reserve("SKU-1", 5, idempotencyKey("k1"));
			expect(failed).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			// The terminal key document is the only thing written: the pre-read decided
			// the outcome before any id was minted, so there is no orphan to sweep.
			const recorded = await collectionOf<ReservationKeyDoc>(
				bound.storage,
				RESERVATION_KEYS_COLLECTION,
			).get("k1");
			expect(recorded).toEqual({
				state: "terminal",
				result: { ok: false, reason: "OUT_OF_STOCK" },
				reservationId: null,
				recordedAt: "2026-07-10T00:00:00.000Z",
			});
		});
	});

	describe("the inventory CAS's own window", () => {
		it("refuses to write a second hold when a peer's hold was committed and pruned mid-flight", async () => {
			// The window, injected deterministically. A completer that is already past
			// its claim read gets its `compareAndSet` held open; meanwhile a peer
			// completes the SAME claim, commits it and PRUNES the hold. The blocked
			// caller then wakes to find no hold under its key and enough stock to take
			// again — and a committed prune returns no units, so a second decrement
			// here would be permanent, silent stock loss. Re-reading the key document
			// on an attempt that finds no hold is what stops it.
			const h = harness();
			await h.seed("SKU-WINDOW", 5);

			const raw = bound.storage[INVENTORY_COLLECTION];
			if (raw === undefined) throw new Error("the inventory collection is not declared");
			// The gate is the shared fault-injection helper: one real call parked
			// until the peer has finished, everything else straight through.
			const gated = parkCall(raw, isUpdateWrite);
			const blocked = new EmdashInventoryStore({
				storage: withCollection(bound.storage, INVENTORY_COLLECTION, gated.collection),
				idGen: new CountingIdGen("blocked"),
				clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
				sleep: async () => {},
				random: () => 0,
			});

			const key = idempotencyKey("k-window");
			const slow = blocked.reserve("SKU-WINDOW", 2, key);
			await gated.arrived;

			// The peer finishes the very same claim, then commits and prunes it.
			const peer = await h.store.reserve("SKU-WINDOW", 2, key);
			if (!peer.ok) throw new Error("the peer reserve must succeed");
			await h.store.commit(peer.reservationId);
			expect(await h.onHand("SKU-WINDOW")).toBe(3);
			expect(await h.holdCount("SKU-WINDOW")).toBe(0);

			gated.release();
			// One answer, one decrement, no resurrected hold.
			expect(await slow).toEqual(peer);
			expect(await h.onHand("SKU-WINDOW")).toBe(3);
			expect(await h.holdCount("SKU-WINDOW")).toBe(0);
		});
	});

	describe("a reserve replay after the hold is pruned", () => {
		it("answers from the key document after commit — the window a prune-first order would open", async () => {
			const h = harness();
			await h.seed("SKU-1", 5);
			const key = idempotencyKey("k1");
			const first = await h.store.reserve("SKU-1", 2, key);
			if (!first.ok) throw new Error("seed reserve must succeed");
			await h.store.commit(first.reservationId);
			expect(await h.onHand("SKU-1")).toBe(3);
			expect(await h.holdCount("SKU-1")).toBe(0); // the hold really is gone

			// The hold can no longer answer, so only the terminal key document can.
			// Had the prune run first and the outcome never been written, this replay
			// would look fresh and decrement a second time.
			const replay = await h.store.reserve("SKU-1", 2, key);
			expect(replay).toEqual(first);
			expect(await h.onHand("SKU-1")).toBe(3);
			expect(await h.holdCount("SKU-1")).toBe(0); // and no new hold was created
		});

		it("answers from the key document after release", async () => {
			const h = harness();
			await h.seed("SKU-1", 5);
			const key = idempotencyKey("k1");
			const first = await h.store.reserve("SKU-1", 2, key);
			if (!first.ok) throw new Error("seed reserve must succeed");
			await h.store.release(first.reservationId);
			expect(await h.onHand("SKU-1")).toBe(5);

			const replay = await h.store.reserve("SKU-1", 2, key);
			expect(replay).toEqual(first);
			expect(await h.onHand("SKU-1")).toBe(5);
			expect(await h.holdCount("SKU-1")).toBe(0);
		});

		it("answers from the key document after an adopted hold was committed by commitMany", async () => {
			const h = harness();
			if (h.holdWithExpiry === undefined) throw new Error("harness must stamp deadlines");
			await h.seed("SKU-1", 5);
			const reservationId = await h.holdWithExpiry("SKU-1", 2, "k1", "2026-07-10T00:15:00.000Z");
			const adopted = await h.store.adoptMany({
				reservationIds: [reservationId],
				orderId: "ord-1",
				holdExpiresAt: "2026-07-10T00:30:00.000Z",
				now: "2026-07-10T00:05:00.000Z",
			});
			expect(adopted.adopted).toEqual([reservationId]);
			expect(await h.store.commitMany([reservationId])).toEqual({ lost: [] });
			expect(await h.onHand("SKU-1")).toBe(3);

			const replay = await h.store.reserve("SKU-1", 2, idempotencyKey("k1"));
			expect(replay).toEqual({ ok: true, reservationId });
			expect(await h.onHand("SKU-1")).toBe(3);
			expect(await h.holdCount("SKU-1")).toBe(0);
		});

		it("keeps a committed reservation's terminal state after its hold is pruned", async () => {
			const h = harness();
			await h.seed("SKU-1", 5);
			const r = await h.store.reserve("SKU-1", 1, idempotencyKey("k1"));
			if (!r.ok) throw new Error("seed reserve must succeed");
			await h.store.commit(r.reservationId);
			// A double commit stays a benign no-op, and a release of a committed hold
			// stays the loud refusal — both facts survive the prune because the
			// reverse-lookup document carries the terminal state.
			await h.store.commit(r.reservationId);
			await expect(h.store.release(r.reservationId)).rejects.toThrow(/in state committed/);
			expect(await h.onHand("SKU-1")).toBe(4);
		});
	});

	describe("duplicate ids in a batch", () => {
		it("reports each id once in adoptMany and commitMany", async () => {
			const h = harness();
			if (h.holdWithExpiry === undefined) throw new Error("harness must stamp deadlines");
			await h.seed("SKU-1", 10);
			const held = await h.holdWithExpiry("SKU-1", 1, "k1", "2026-07-10T00:15:00.000Z");
			const adopted = await h.store.adoptMany({
				reservationIds: [held, held, "no-such-reservation", "no-such-reservation"],
				orderId: "ord-1",
				holdExpiresAt: "2026-07-10T00:30:00.000Z",
				now: "2026-07-10T00:05:00.000Z",
			});
			expect(adopted.adopted).toEqual([held]);
			expect(adopted.lost).toEqual(["no-such-reservation"]);

			const released = await h.store.reserve("SKU-1", 1, idempotencyKey("k2"));
			if (!released.ok) throw new Error("seed reserve must succeed");
			await h.store.release(released.reservationId);
			const committed = await h.store.commitMany([
				held,
				held,
				released.reservationId,
				released.reservationId,
			]);
			expect(committed.lost).toEqual([released.reservationId]);
		});
	});

	describe("retry exhaustion", () => {
		it("surfaces a contended document as a typed retryable error, NEVER as OUT_OF_STOCK", async () => {
			// What this pins is exhaustion -> typed error, not concurrency: the race
			// itself is the Postgres suite's job. The decorator makes every
			// `compareAndSet` on the aggregate lose by landing a real competing write
			// first, so the store's revision is genuinely stale every time — the
			// storage underneath is the real repository, and the losing write really
			// loses.
			const raw = bound.storage[INVENTORY_COLLECTION];
			if (raw === undefined) throw new Error("the inventory collection is not declared");
			const alwaysLoses = alwaysLosingCollection(raw);

			const seeder = harness();
			await seeder.seed("SKU-1", 50);
			const store = new EmdashInventoryStore({
				storage: withCollection(bound.storage, INVENTORY_COLLECTION, alwaysLoses),
				idGen: uuidIdGen,
				clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
				maxCasAttempts: 3,
				// No real backoff: the retry budget is what is under test, not the wait.
				sleep: async () => {},
				random: () => 0,
			});

			const failure = await store.reserve("SKU-1", 1, idempotencyKey("k1")).then(
				(value) => value,
				(err: unknown) => err,
			);
			expect(isStorageContentionError(failure)).toBe(true);
			// The distinction that matters: a shopper who could have bought is told to
			// retry, never that the item is out of stock.
			expect(failure).not.toEqual({ ok: false, reason: "OUT_OF_STOCK" });
			expect(await seeder.onHand("SKU-1")).toBe(50);
			expect(await seeder.holdCount("SKU-1")).toBe(0);
		});
	});
});
