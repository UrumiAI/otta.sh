import { idempotencyKey, orderId } from "@otta-sh/domain";
import { orderNotesStoreContract } from "@otta-sh/domain/testing";
import { afterEach, describe, expect, test } from "vitest";
import { PG_ENABLED } from "./describe-each-dialect.js";
import {
	makePgOrderNotesStoreHarness,
	makeSqliteOrderNotesStoreHarness,
	teardownOrderFlow,
} from "./order-harness.js";

afterEach(teardownOrderFlow);

// The shared OrderNotesStore contract, green against the real SQL of each dialect
// (admin-UX Increment 0). SQLite verifies the DDL + queries; Postgres additionally
// runs the concurrent-replay race below (SQLite can't race).
orderNotesStoreContract(makeSqliteOrderNotesStoreHarness, { dialect: "sqlite" });

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderNotesStoreContract(makePgOrderNotesStoreHarness, { dialect: "pg" });

	// Idempotency under concurrency (Postgres-required, like the no-oversell race):
	// N concurrent appends carrying the SAME idempotency_key must land EXACTLY ONE
	// row — the `idempotency_key` UNIQUE + `ON CONFLICT DO NOTHING` guard makes the
	// duplicate-key race resolve to a single insert, every loser reloading the same
	// stored note. `better-sqlite3` serializes writes, so this is a real race only
	// on pg.
	test("concurrent appends with one idempotency_key insert exactly once (no duplicates)", async () => {
		const h = await makePgOrderNotesStoreHarness();
		const key = idempotencyKey("race-key");
		const N = 8;
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				h.store.append({
					orderId: orderId("ord-race"),
					author: "concurrent",
					body: "exactly one",
					idempotencyKey: key,
				}),
			),
		);
		// Exactly one caller performed the insert; the rest observed the replay.
		expect(results.filter((r) => r.appended)).toHaveLength(1);
		// All callers agree on the one stored note id.
		const ids = new Set(results.map((r) => r.note.id));
		expect(ids.size).toBe(1);
		// And the table holds a single note for the order.
		const notes = await h.store.listForOrder(orderId("ord-race"));
		expect(notes).toHaveLength(1);
		expect(notes[0]?.body).toBe("exactly one");
	});
});
