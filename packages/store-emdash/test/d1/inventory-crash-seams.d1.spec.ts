/**
 * The crash seams, on **D1**.
 *
 * **What this file is, and what it is not.** INC-A3's crash tier lives in
 * `test/inventory-crash-seams.dialects.test.ts` — eighteen cases across seven
 * seams. That file CANNOT be run over this harness unchanged, and the reason is
 * structural rather than semantic: its suite body is a closure passed to
 * `describeEachDialect`, and that module imports `better-sqlite3` and `pg` at
 * module scope, neither of which exists inside `workerd`. Importing it here fails
 * before a case runs, and the body is not exported separately. Making the whole
 * suite dialect-portable means splitting the Node harness into a driver-agnostic
 * binder plus two driver modules, which is a change to the Node tiers and belongs
 * in its own change rather than riding along with this one.
 *
 * So this file ports the seams whose failure would be a DIALECT failure rather
 * than a logic failure, chosen so that every distinct mechanism the crash tier
 * relies on is exercised at least once on D1:
 *
 * - **(a)** and **(c)** — `failCall` in `"instead"` mode: a real write lands, the
 *   next one throws. Between them they cover both write shapes on the key
 *   document, a create (`expectedRevision === null`) and an update.
 * - **(e)** — `parkCall`: a real call held open while the test observes the
 *   intermediate state. Ordering — the terminal answer before the prune — is
 *   tested nowhere else, and this is also the one case that proves a
 *   partially-applied D1 write sequence is observable at all.
 * - **(g)** — the cross-SKU `commitMany` path, three aggregates in one batch, with
 *   the crash landing on the second. Per-SKU durability across a batch is a
 *   property of how the adapter sequences statements, and D1 is the dialect where
 *   "no transaction spans the batch" is literally true.
 *
 * Seams (b), (d-release), (f) and (g-adoptMany) are NOT ported. They exercise the
 * same two injection mechanisms over the same primitives on different documents;
 * once the primitives are proved on D1 (`storage-access.d1.spec.ts`) and the
 * mechanisms are proved here, what those cases add is logic coverage, which the
 * Node tiers already give on every commit. They are named here so the gap is a
 * recorded decision rather than a silent omission.
 */
import { idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { describe, expect, it } from "vitest";
import type {
	HoldEntry,
	InventoryDoc,
	ReservationIndexDoc,
	ReservationKeyDoc,
	StorageAccess,
	StorageCollection,
} from "../../src/index.js";
import {
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	normalizeInventoryDoc,
	RESERVATION_INDEX_COLLECTION,
	RESERVATION_KEYS_COLLECTION,
	uuidIdGen,
} from "../../src/index.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	isUpdateWrite,
	onId,
	parkCall,
	withCollection,
} from "../helpers/fault-injection.js";
import { INVENTORY_LAYOUT } from "../inventory-collections.js";
import { useD1Storage } from "./describe-d1.js";

/** Every store in this file shares one frozen clock, so timestamps are legible. */
const NOW = "2026-07-10T00:00:00.000Z";

const bound = useD1Storage(INVENTORY_LAYOUT);

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

const claimedDoc = async (
	key: string,
): Promise<Extract<ReservationKeyDoc, { state: "claimed" }>> => {
	const doc = await keys().get(key);
	if (doc === null || doc.state !== "claimed") {
		throw new Error(`reservation key ${key} is not in the claimed state`);
	}
	return doc;
};

describe("(a) the claim landed and the inventory compare-and-set never ran [d1]", () => {
	it("replays to the RECORDED id with one hold and exactly one decrement", async () => {
		await seed("SKU-A", 5);
		const key = idempotencyKey("k-a");

		// The claim write lands for real; the very next write — the reverse-lookup
		// entry — throws, so the inventory compare-and-set is never reached.
		const crash = failCall(raw(RESERVATION_INDEX_COLLECTION), isClaimWrite, { mode: "instead" });
		await expect(
			storeWith(RESERVATION_INDEX_COLLECTION, crash.collection).reserve("SKU-A", 2, key),
		).rejects.toThrow(InjectedCrashError);
		expect(crash.failed()).toBe(1);

		// Read it back: the claim is DURABLE on D1 and it is all there is.
		const claim = await claimedDoc(key);
		expect(claim.sku).toBe("SKU-A");
		expect(claim.qty).toBe(2);
		expect(await reverseIndex().get(claim.reservationId)).toBeNull();
		expect(await onHand("SKU-A")).toBe(5);
		expect(await holdCount("SKU-A")).toBe(0);

		const healed = await makeStore().reserve("SKU-A", 2, key);
		// THE REVERSED-ORDER ASSERTION: the healed reserve answers with the id the
		// CLAIM recorded. Had the units moved before the claim was written, nothing
		// would link the decrement to this key.
		expect(healed).toEqual({ ok: true, reservationId: claim.reservationId });
		expect(await onHand("SKU-A")).toBe(3);
		expect(await holdCount("SKU-A")).toBe(1);

		// And it stays once-only however many replayers arrive.
		expect(await makeStore().reserve("SKU-A", 2, key)).toEqual(healed);
		expect(await onHand("SKU-A")).toBe(3);
		expect(await holdCount("SKU-A")).toBe(1);
	});
});

describe("(c) the inventory compare-and-set landed and the terminal answer was never written [d1]", () => {
	it("replays to the SAME reservation id with no second hold and one decrement", async () => {
		await seed("SKU-C", 5);
		const key = idempotencyKey("k-c");

		// The claim write is a create (`expectedRevision === null`); the terminal
		// answer is an UPDATE of the same document. Failing only the update leaves
		// the units moved and the answer unrecorded.
		const crash = failCall(raw(RESERVATION_KEYS_COLLECTION), isUpdateWrite, { mode: "instead" });
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
		// the units moved.
		expect(replay).toEqual({ ok: true, reservationId: claim.reservationId });
		expect(await onHand("SKU-C")).toBe(3);
		expect(await holdCount("SKU-C")).toBe(1);
		// The replay also finishes the interrupted job: the answer is now durable.
		expect((await keys().get(key))?.state).toBe("terminal");
	});
});

describe("(e) prune-before-terminal is the forbidden order [d1]", () => {
	/**
	 * This cannot be injected, because the store does not do it. So it is pinned
	 * from the other side: the terminal write is PARKED, and while it is parked the
	 * hold must still be LIVE. It must never be weakened into "a replay works" — a
	 * store that pruned first and recorded the outcome afterwards would pass every
	 * replay case above and fail exactly here.
	 */
	it("commit parks its terminal write: the hold is still live while parked, and the prune follows", async () => {
		await seed("SKU-E1", 5);
		const key = idempotencyKey("k-e1");
		const first = await makeStore().reserve("SKU-E1", 2, key);
		if (!first.ok) throw new Error("the seed reserve must succeed");

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
		// And the replay answer is ALREADY durable on the key document.
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

describe("(g) a partial commitMany across 3 SKUs [d1]", () => {
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

	it("commits the first SKU, leaves the rest held, and any replayer completes it exactly once", async () => {
		const ids = await seedThree();
		const [id1, id2, id3] = ids;
		if (id1 === undefined || id2 === undefined || id3 === undefined) {
			throw new Error("three reservations are required");
		}

		// The prune for the SECOND sku throws; the batch is applied per SKU, so the
		// first is already durable and the third is never reached. On D1 there is no
		// transaction spanning the batch, so "durable per SKU" is the literal truth
		// of the dialect rather than a property of how a transaction was scoped.
		const crash = failCall(raw(INVENTORY_COLLECTION), onId(SKUS[1], isUpdateWrite), {
			mode: "instead",
		});
		await expect(storeWith(INVENTORY_COLLECTION, crash.collection).commitMany(ids)).rejects.toThrow(
			InjectedCrashError,
		);

		// SKU 1 fully committed; SKU 2 terminal-but-unpruned; SKU 3 untouched.
		expect(await holdCount(SKUS[0])).toBe(0);
		expect(await onHand(SKUS[0])).toBe(8);
		expect(await holdCount(SKUS[1])).toBe(1);
		expect((await reverseIndex().get(id2))?.terminalState).toBe("committed");
		expect(await holdCount(SKUS[2])).toBe(1);
		expect((await reverseIndex().get(id3))?.terminalState).toBeUndefined();

		// THE REVERSED-ORDER ASSERTION, for the SKU caught mid-settle: its terminal
		// record exists while its hold is still live, so a same-key reserve replay is
		// answered terminally instead of decrementing again.
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
		// `commitMany` skips an id that is ALREADY terminal, so the singular `commit`
		// any replayer runs is what completes SKU 2 — exactly once.
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
});
