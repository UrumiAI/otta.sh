/**
 * `resolveReconciliation` under concurrency, on the document adapter — the
 * store-postgres suite of the same name, re-pointed at `EmdashOrderStore`. Postgres
 * only: better-sqlite3 serializes writes in one process, so it verifies the shape
 * and never the contention.
 *
 * The resolve is a compare-and-CLEAR, and the guard is EQUALITY against the flag the
 * operator reviewed (never a bare "is flagged"). The SQL got its once-only from
 * `WHERE reconciliation_flag = :expectedFlag RETURNING id`; here the same comparison
 * lives inside the order document's compare-and-set, where the revision adds a
 * SECOND guard. N concurrent resolvers must still yield exactly ONE winner, and the
 * disposition the winner returned must be the one that persisted.
 *
 * The N / LOOPS numbers and every original assertion are unchanged. Two assertions
 * are ADDED, because the document model makes them checkable: the losers' returned
 * order carries the winner's disposition (they re-read it, so a torn write would show
 * there too), and no loser's `resolvedBy` was written.
 *
 * The pool is sized so each of the N callers can hold its OWN connection; a pool
 * narrower than the crowd serializes the writers and weakens the race.
 */
import { idempotencyKey, orderId as toOrderId } from "@otta-sh/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CAS_MAX_ATTEMPTS, type StorageAccess } from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

const N = 30;
const LOOPS = 15;
const FLAG = "commit lost for reservation res-1";

const PG_SUITE = PG_ENABLED
	? "resolveReconciliation race [postgres]"
	: "resolveReconciliation race [postgres] — skipped: PG_CONNECTION_STRING is not set";

describe.skipIf(!PG_ENABLED)(PG_SUITE, () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;
	let maxAttempts = 0;

	beforeAll(async () => {
		const db = await makePgStorage(ORDER_LAYOUT, N + 6);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		console.info(
			`[resolve-reconciliation-race] max compare-and-set attempts observed: ${String(maxAttempts)} of ${String(CAS_MAX_ATTEMPTS)}`,
		);
		await close?.();
	});

	test("N concurrent resolves on one flagged order yield exactly ONE winner; the disposition is written once", async () => {
		const h = makeOrderHarness(storage, {
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		});

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `ord-race-${String(loop)}`;
			// The document analogue of the original's direct `orders` + `order_totals`
			// insert: a bare, already-flagged `paid` order.
			await h.seedOrder({
				id,
				state: "paid",
				currency: "USD",
				buyerRef: "buyer@example.com",
				createdAt: "2026-07-10T00:00:00.000Z",
				totalCents: 1000,
				paymentMethod: "stripe",
				reconciliationFlag: FLAG,
			});

			// Each caller carries a distinct outcome/reason so we can prove WHICH one the
			// single winner persisted (only the guarded-flip winner may write).
			const results = await Promise.all(
				Array.from({ length: N }, (_unused, i) =>
					h.store.resolveReconciliation({
						orderId: toOrderId(id),
						// Every caller reviewed the SAME live flag — the race is on the clear.
						expectedFlag: FLAG,
						outcome: i % 2 === 0 ? "fulfilled" : "refunded",
						reason: `caller ${String(i)}`,
						resolvedBy: `admin-${String(i)}`,
						idempotencyKey: idempotencyKey(`res-${String(loop)}-${String(i)}`),
					}),
				),
			);

			const winners = results.filter((r) => r.resolved);
			expect(winners, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
			expect(
				results.filter((r) => !r.resolved),
				`loop ${String(loop)}: losers`,
			).toHaveLength(N - 1);

			// The persisted disposition matches the winner's exactly, and the flag is
			// cleared — no torn write, no double-resolve.
			const after = await h.store.getById(toOrderId(id));
			expect(after?.reconciliationFlag, `loop ${String(loop)}: flag cleared`).toBeNull();
			const wonReason = winners[0]?.order?.reconciliationResolution?.reason;
			expect(after?.reconciliationResolution?.reason, `loop ${String(loop)}: winner's reason`).toBe(
				wonReason,
			);
			expect(after?.reconciliationResolution?.resolvedBy).toBe(
				winners[0]?.order?.reconciliationResolution?.resolvedBy,
			);
			expect(after?.state, `loop ${String(loop)}: state untouched`).toBe("paid");

			// ADDED: every loser re-read the SAME single disposition, and no loser's own
			// `resolvedBy` was ever written — the guard refused before the write, so a
			// loser's reason can never appear on the order.
			const persistedBy = after?.reconciliationResolution?.resolvedBy;
			for (const loser of results.filter((r) => !r.resolved)) {
				expect(loser.order?.reconciliationResolution?.resolvedBy).toBe(persistedBy);
			}
			expect(
				results.filter((r) => r.resolved).map((r) => r.order?.reconciliationResolution?.resolvedBy),
			).toEqual([persistedBy]);
		}
	}, 180_000);
});
