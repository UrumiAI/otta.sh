import { idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyInventoryStore, uuidIdGen } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const PG = process.env.PG_CONNECTION_STRING;

interface PgFixture {
	store: KyselyInventoryStore;
	db: Kysely<Database>;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/**
 * A schema-isolated pg store whose pool can hold `poolMax` connections — so N
 * concurrent reserves each acquire an INDEPENDENT connection (a real race).
 */
async function freshPgStore(poolMax: number): Promise<PgFixture> {
	const connectionString = PG;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;

	const store = new KyselyInventoryStore({
		db,
		idGen: uuidIdGen,
		clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
	});
	return {
		store,
		db,
		async seed(sku, qty) {
			await db
				.insertInto("inventory")
				.values({ sku, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
	};
}

describe.skipIf(PG === undefined)("no-oversell [postgres]", () => {
	test("no oversell: N concurrent reserves at stock M (M<N) yield exactly M ok — Postgres", async () => {
		const M = 5;
		const N = 50;
		const LOOPS = 20;
		const h = await freshPgStore(N + 4);

		for (let loop = 0; loop < LOOPS; loop++) {
			// Reset to a clean single-SKU stock of M for each independent race.
			await h.db.deleteFrom("reservations").execute();
			await h.seed("SKU-1", M);

			const results = await Promise.all(
				Array.from({ length: N }, (_unused, i) =>
					h.store.reserve("SKU-1", 1, idempotencyKey(`k-${loop}-${i}`)),
				),
			);

			const ok = results.filter((r) => r.ok).length;
			const oos = results.filter((r) => !r.ok).length;
			expect(ok, `loop ${loop}: ok count`).toBe(M);
			expect(oos, `loop ${loop}: OUT_OF_STOCK count`).toBe(N - M);
			expect(await h.onHand("SKU-1"), `loop ${loop}: final on_hand`).toBe(0);
		}
	}, 120_000);

	test("concurrent reserve calls sharing the same idempotency key never return ok before the reservation reaches a terminal state — Postgres", async () => {
		const N = 20;
		const h = await freshPgStore(N + 4);
		await h.seed("SKU-1", 1);
		const key = idempotencyKey("same-key");

		const results = await Promise.all(
			Array.from({ length: N }, () => h.store.reserve("SKU-1", 1, key)),
		);

		// The unique idempotency_key means exactly ONE reservation exists; every
		// caller resolves to that same terminal outcome, decrementing once.
		const first = results[0];
		if (first === undefined) throw new Error("no results");
		for (const r of results) expect(r).toEqual(first);
		expect(first.ok).toBe(true);
		expect(await h.onHand("SKU-1")).toBe(0);

		const rows = await h.db.selectFrom("reservations").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("held");
	}, 60_000);

	test("reserve finalize is all-or-nothing: a fault between the held flip and the decrement leaves 'pending' with on_hand unchanged (crash window W2)", async () => {
		const h = await freshPgStore(4);
		await h.seed("SKU-1", 5);
		const key = idempotencyKey("w2");

		// Inject a fault inside the finalize tx, after the `pending → held` flip
		// and before the decrement.
		h.store.hooks.beforeDecrement = () => {
			throw new Error("injected W2 fault");
		};
		await expect(h.store.reserve("SKU-1", 2, key)).rejects.toThrow("injected W2 fault");

		// The finalize tx rolled back atomically: no visible `held`, no partial
		// decrement — the reservation is back to `pending`, on_hand unchanged.
		const rows = await h.db
			.selectFrom("reservations")
			.selectAll()
			.where("idempotency_key", "=", key)
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("pending");
		expect(await h.onHand("SKU-1")).toBe(5);

		// A subsequent same-key replay heals it (W1) to the correct terminal.
		h.store.hooks.beforeDecrement = undefined;
		const healed = await h.store.reserve("SKU-1", 2, key);
		expect(healed.ok).toBe(true);
		expect(await h.onHand("SKU-1")).toBe(3);
	}, 60_000);
});
