/**
 * No oversell on **D1** — in the M=5 / N=50 shape the Postgres race uses.
 *
 * **Read this before reading the assertions: what "concurrency" means here.**
 * Miniflare runs a test file in ONE `workerd` isolate on ONE thread, and D1
 * statements from that isolate are dispatched one at a time. So the fifty
 * `reserve` calls below are **interleaved, not simultaneous**: every caller runs
 * until its next `await`, yields, and resumes later, so at any instant exactly one
 * statement is in flight. That is the same limitation
 * `test/no-oversell.pg.test.ts` records for `better-sqlite3`, arrived at from the
 * other direction — there the driver serializes, here the runtime does.
 *
 * **What this therefore does NOT prove:** that `compareAndSet` is atomic under
 * genuinely simultaneous writers. Nothing on a single isolate can prove that, and
 * the Postgres tier is where it is proved. A staging site on real D1 has one
 * isolate per request and many at once, so the race this file cannot run is real
 * in production.
 *
 * **What it does prove, and why it is worth 250 reserves per run:** the invariant
 * holds under *interleaving*, which is a weaker condition than simultaneity but
 * strictly stronger than the sequential path the contract suite walks. Every
 * caller here reads the aggregate, yields, and writes against a revision another
 * caller may already have replaced — so the retry loop, the guard that turns a
 * genuine shortfall into `OUT_OF_STOCK`, and the revision comparison itself are
 * all exercised on D1's own SQLite build. If `compareAndSet` on D1 ever agreed
 * with a stale revision — the exact failure a missing trigger or a mis-read
 * `RETURNING` would cause — the winner count would exceed M here, on the first
 * loop. The loop count is 5 rather than the Postgres tier's 20 because the
 * interleaved shape is deterministic: it does not need repetition to catch a
 * flake, only enough to catch a systematic dialect error.
 *
 * The maximum compare-and-set depth observed is printed, because that number is
 * the contention budget this design accepts — and on this tier it is a floor for
 * the real dialect, not a measurement of it.
 */
import { idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InventoryDoc, StorageAccess } from "../../src/index.js";
import {
	CAS_MAX_ATTEMPTS,
	collectionOf,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	isStorageContentionError,
	newInventoryDoc,
	normalizeInventoryDoc,
	uuidIdGen,
} from "../../src/index.js";
import { INVENTORY_LAYOUT } from "../inventory-collections.js";
import { openD1 } from "./describe-d1.js";

const M = 5;
const N = 50;
const LOOPS = 5;

describe("no oversell under interleaving [d1]", () => {
	let storage: StorageAccess;
	let close: (() => Promise<void>) | undefined;

	beforeAll(async () => {
		// This file owns its binding outright: no per-test `DELETE`, because each
		// loop takes a fresh sku and truncating would drop nothing it needs but
		// would also buy nothing.
		const open = await openD1(INVENTORY_LAYOUT);
		storage = open.storage;
		close = open.close;
	});

	afterAll(async () => {
		const open = close;
		close = undefined;
		await open?.();
	});

	it(`${String(N)} interleaved reserves against ${String(M)} units yield exactly ${String(M)} winners, ${String(LOOPS)} times over`, async () => {
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		let maxAttempts = 0;
		let contentionErrors = 0;
		const store = new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		});

		const winnersPerLoop: number[] = [];
		for (let loop = 0; loop < LOOPS; loop++) {
			// A fresh sku per loop: each race is independent, and nothing has to
			// delete from the table (which would drop nothing here, but the Postgres
			// tier's reason — keeping the revision triggers — holds on D1 too).
			const sku = `SKU-RACE-${String(loop)}`;
			await inventory.compareAndSet(sku, null, newInventoryDoc(sku, M));

			const settled = await Promise.all(
				Array.from({ length: N }, (_unused, i) =>
					store.reserve(sku, 1, idempotencyKey(`k-${String(loop)}-${String(i)}`)).then(
						(value) => value,
						(err: unknown) => err,
					),
				),
			);

			let winners = 0;
			let outOfStock = 0;
			let contendedHere = 0;
			for (const result of settled) {
				if (isStorageContentionError(result)) {
					contendedHere++;
					continue;
				}
				if (result instanceof Error) throw result;
				const reserve = result as Awaited<ReturnType<typeof store.reserve>>;
				if (reserve.ok) {
					winners++;
				} else {
					// The ONLY acceptable non-ok reason: contention has its own type and
					// must never be collapsed into "the item is gone".
					expect(reserve.reason).toBe("OUT_OF_STOCK");
					outOfStock++;
				}
			}
			contentionErrors += contendedHere;

			expect(winners, `loop ${String(loop)}: winners`).toBe(M);
			expect(winners + outOfStock + contendedHere, `loop ${String(loop)}: accounted`).toBe(N);
			winnersPerLoop.push(winners);

			const doc = await inventory.get(sku);
			if (doc === null) throw new Error(`loop ${String(loop)}: missing inventory document`);
			expect(doc.onHand, `loop ${String(loop)}: final onHand`).toBe(0);
			// Every winner left its hold behind: M holds, M units accounted for.
			expect(
				Object.keys(normalizeInventoryDoc(doc).holds),
				`loop ${String(loop)}: holds`,
			).toHaveLength(M);
		}

		console.info(
			`[no-oversell/d1] loops=${String(LOOPS)} winnersPerLoop=${winnersPerLoop.join(",")} ` +
				`maxCasAttempts=${String(maxAttempts)}/${String(CAS_MAX_ATTEMPTS)} ` +
				`contentionErrors=${String(contentionErrors)}`,
		);
		expect(winnersPerLoop).toEqual(Array.from({ length: LOOPS }, () => M));
		// STRICTLY below the ceiling, for the same reason the Postgres tier says so:
		// a run that merely reached it would mean some caller was one lost attempt
		// away from a contention failure.
		expect(maxAttempts).toBeLessThan(CAS_MAX_ATTEMPTS);
	}, 300_000);

	it("interleaved reserves sharing ONE idempotency key produce one hold, one decrement and one reservation id", async () => {
		// Every caller is started before the first await, so they all enter the claim
		// path before any of them has written: exactly one mints an id and the other
		// nineteen complete THAT claim.
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		const store = new EmdashInventoryStore({
			storage,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		});
		const sku = "SKU-SAME-KEY";
		await inventory.compareAndSet(sku, null, newInventoryDoc(sku, 10));
		const key = idempotencyKey("one-key");

		const results = await Promise.all(Array.from({ length: 20 }, () => store.reserve(sku, 1, key)));

		const first = results[0];
		if (first === undefined) throw new Error("no results");
		for (const result of results) expect(result).toEqual(first);
		if (!first.ok) throw new Error("the shared key must resolve to one ok reserve");

		// ONE unit left the shelf, under ONE hold, with ONE id.
		const doc = await inventory.get(sku);
		if (doc === null) throw new Error("missing inventory document");
		expect(doc.onHand).toBe(9);
		const holds = Object.entries(normalizeInventoryDoc(doc).holds);
		expect(holds).toHaveLength(1);
		expect(holds[0]?.[0]).toBe(key);
		expect(holds[0]?.[1].reservationId).toBe(first.reservationId);

		// And the one reservation is reachable by that id: it commits, and commit
		// consumes the units rather than returning them.
		await store.commit(first.reservationId);
		expect((await inventory.get(sku))?.onHand).toBe(9);
	}, 120_000);
});
