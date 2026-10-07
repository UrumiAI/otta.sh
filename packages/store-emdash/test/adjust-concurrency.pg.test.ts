/**
 * `adjust` must be exactly-once under REAL concurrency. Postgres only: one
 * process over better-sqlite3 serializes writers, so no compare-and-set can lose
 * there and nothing is being raced.
 *
 * Ported from the SQL adapter's race of the same name, with the same shapes
 * (12 same-key racers × 10 loops; four different-key racers × 10 loops) and the
 * same two invariants:
 *
 * - **a double-clicked "set the qty to 7" moves the units ONCE**, and
 * - **conservation** under different-key adjusts racing on one hold: whatever the
 *   serialization order, held + on-hand equals the seeded total, and the hold
 *   lands on one of the requested targets — which forbids both a lost update
 *   (units leaked back to the shelf) and an over-return.
 *
 * The SQL original drove `adjust` through the cart's `updateLine` use-case and
 * asserted the cart line mirrored the reservation. This adapter's cart store is a
 * later increment, so the race is driven at the port instead — which is where the
 * atomicity actually lives, and the use-case-level mirror is the cart suite's job
 * when it lands.
 *
 * What this model makes newly checkable, and is asserted here: every movement
 * claim document ends in `applied` carrying the SAME answer its callers got, and
 * the aggregate's applied-movement ring holds each key exactly once — a key
 * appearing twice, or a claim left unapplied, is a movement that could re-apply.
 *
 * One harness note: the database is per FILE and is never emptied between cases
 * (emptying it would drop the revision trigger), so every case namespaces BOTH its
 * skus and its idempotency keys. A key shared with an earlier case would replay
 * that case's recorded answer against a different sku.
 */
import { idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InventoryDoc, MovementClaimDoc, StorageAccess } from "../src/index.js";
import {
	adjustClaimId,
	CAS_MAX_ATTEMPTS,
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	INVENTORY_MOVEMENTS_COLLECTION,
	newInventoryDoc,
	normalizeInventoryDoc,
	uuidIdGen,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { INVENTORY_LAYOUT } from "./inventory-collections.js";

/** The same-key crowd, and the loop count, of the SQL original. */
const RACERS = 12;
const LOOPS = 10;
/** The different-key shape of the SQL original: one hold, four rival targets. */
const TARGETS = [2, 9, 4, 7] as const;
const SEEDED = 100;

describe.skipIf(!PG_ENABLED)("adjust concurrency [postgres]", () => {
	let storage: StorageAccess;
	let close: (() => Promise<void>) | undefined;
	let maxAttempts = 0;

	beforeAll(async () => {
		// A connection per racer, so every caller really contends.
		const db = await makePgStorage(INVENTORY_LAYOUT, RACERS + 8);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
		console.info(
			`[adjust-concurrency] maxCasAttempts=${String(maxAttempts)}/${String(CAS_MAX_ATTEMPTS)}`,
		);
	});

	const makeStore = (): EmdashInventoryStore =>
		new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		});

	it(`${String(RACERS)} concurrent same-key adjusts move the units exactly once, ${String(LOOPS)} times over`, async () => {
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		const movements = collectionOf<MovementClaimDoc>(storage, INVENTORY_MOVEMENTS_COLLECTION);
		const store = makeStore();

		for (let loop = 0; loop < LOOPS; loop++) {
			// A fresh sku per loop: each race is independent, and nothing has to
			// truncate the storage table (which would drop the revision trigger the
			// whole design depends on).
			const sku = `SKU-ADJ-SAME-${String(loop)}`;
			await inventory.compareAndSet(sku, null, newInventoryDoc(sku, SEEDED));
			const reserveKey = `same-hold-${String(loop)}`;
			const held = await store.reserve(sku, 2, idempotencyKey(reserveKey));
			if (!held.ok) throw new Error(`loop ${String(loop)}: the seed reserve must succeed`);

			// A double-(×12)-clicked "set the qty to 7": every racer shares ONE key.
			const key = idempotencyKey(`same-${String(loop)}`);
			const results = await Promise.all(
				Array.from({ length: RACERS }, () => store.adjust(held.reservationId, 7, key)),
			);

			// One key, one answer, for every racer.
			for (const result of results) {
				expect(result, `loop ${String(loop)}: every racer ok`).toEqual({
					ok: true,
					reservationId: held.reservationId,
				});
			}
			// The delta (7 − 2 = 5) applied EXACTLY once: 100 − 2 − 5 = 93.
			expect(await store.getOnHand(sku), `loop ${String(loop)}: onHand`).toBe(93);
			const doc = await inventory.get(sku);
			if (doc === null) throw new Error(`loop ${String(loop)}: missing aggregate`);
			const aggregate = normalizeInventoryDoc(doc);
			expect(aggregate.holds[reserveKey]?.qty, `loop ${String(loop)}: hold qty`).toBe(7);

			// The durable record agrees with what every caller was told, and the
			// aggregate remembers the key exactly once.
			const claim = await movements.get(adjustClaimId(key));
			if (claim?.kind !== "adjust") throw new Error(`loop ${String(loop)}: missing adjust claim`);
			expect(claim.applied?.result, `loop ${String(loop)}: recorded answer`).toEqual(results[0]);
			expect(
				(aggregate.appliedMovements ?? []).filter((entry) => entry.key === key),
				`loop ${String(loop)}: ring holds the key once`,
			).toHaveLength(1);
			expect(aggregate.holds[reserveKey]?.lastMovementKey).toBe(key);
		}
	}, 180_000);

	it("concurrent different-key adjusts on one hold settle consistently: no lost update, no over-return", async () => {
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		const movements = collectionOf<MovementClaimDoc>(storage, INVENTORY_MOVEMENTS_COLLECTION);
		const store = makeStore();

		for (let loop = 0; loop < LOOPS; loop++) {
			const sku = `SKU-ADJ-DIFF-${String(loop)}`;
			await inventory.compareAndSet(sku, null, newInventoryDoc(sku, SEEDED));
			const reserveKey = `diff-hold-${String(loop)}`;
			const held = await store.reserve(sku, 5, idempotencyKey(reserveKey));
			if (!held.ok) throw new Error(`loop ${String(loop)}: the seed reserve must succeed`);

			// Distinct user intents racing on one hold: →2, →9, →4, →7. `adjust` takes
			// an ABSOLUTE target and re-derives the delta on every attempt, so every
			// one of them applies; the last writer's target is the one that stands.
			const keys = TARGETS.map((_target, i) => idempotencyKey(`diff-${String(loop)}-${String(i)}`));
			const results = await Promise.all(
				TARGETS.map((target, i) => {
					const key = keys[i];
					if (key === undefined) throw new Error("missing key");
					return store.adjust(held.reservationId, target, key);
				}),
			);
			for (const result of results) {
				expect(result, `loop ${String(loop)}: every adjust settles ok`).toEqual({
					ok: true,
					reservationId: held.reservationId,
				});
			}

			// CONSERVATION — the invariant that forbids both a lost update (units
			// leaked back to the shelf) and an over-return: whatever the serialization
			// order, held + on-hand equals the seeded total, and the hold landed on one
			// of the requested targets rather than on a blend of them.
			const doc = await inventory.get(sku);
			if (doc === null) throw new Error(`loop ${String(loop)}: missing aggregate`);
			const aggregate = normalizeInventoryDoc(doc);
			const hold = aggregate.holds[reserveKey];
			if (hold === undefined) throw new Error(`loop ${String(loop)}: missing hold`);
			expect([...TARGETS], `loop ${String(loop)}: final qty is a requested target`).toContain(
				hold.qty,
			);
			expect(aggregate.onHand + hold.qty, `loop ${String(loop)}: conservation`).toBe(SEEDED);

			// Every key is recorded once, with the answer its caller got.
			for (const [i, key] of keys.entries()) {
				const claim = await movements.get(adjustClaimId(key));
				if (claim?.kind !== "adjust") throw new Error(`loop ${String(loop)}: missing claim`);
				expect(claim.applied?.result, `loop ${String(loop)}: claim ${String(i)}`).toEqual(
					results[i],
				);
				expect(
					(aggregate.appliedMovements ?? []).filter((entry) => entry.key === key),
					`loop ${String(loop)}: ring holds key ${String(i)} once`,
				).toHaveLength(1);
			}
		}
	}, 180_000);
});
