import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyTaxRulesStore } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const PG = process.env.PG_CONNECTION_STRING;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** A schema-isolated pg tax store whose pool holds `poolMax` connections, so N
 *  concurrent edits each take an INDEPENDENT connection (a real row race). */
async function freshStore(poolMax: number): Promise<KyselyTaxRulesStore> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	return new KyselyTaxRulesStore({ db: iso.db as Kysely<Database> });
}

/**
 * The admin-edit analogue of the no-oversell contract: the money-bearing
 * `updateRate` CAS on `rate_bps`. N admins all reviewed the SAME rate and each
 * submit a distinct new value against the SAME `expectedRateBps` — exactly ONE
 * must win, and every loser must be reported `stale` (never a silent clobber
 * that loses a tax-rate edit). This is the race a single-statement guarded
 * `UPDATE ... WHERE rate_bps = :expected` exists to serialize; better-sqlite3
 * cannot exercise it, so it is Postgres-required.
 */
describe.skipIf(PG === undefined)("tax-rate updateRate CAS race [postgres]", () => {
	test("N concurrent edits on one rate yield exactly ONE winner; losers are stale", async () => {
		const N = 24;
		const LOOPS = 12;
		const store = await freshStore(N + 4);
		await store.createClass({ id: "standard", name: "Standard" });

		for (let loop = 0; loop < LOOPS; loop++) {
			const id = `r-${loop}`;
			await store.createRate({
				id,
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});

			const results = await Promise.all(
				Array.from({ length: N }, (_unused, i) =>
					store.updateRate(id, { rateBps: 800 + i, appliesToShipping: false }, 725),
				),
			);

			const winners = results.filter((r) => r.ok);
			expect(winners, `loop ${loop}: exactly one winner`).toHaveLength(1);
			const losers = results.filter((r) => !r.ok);
			expect(losers, `loop ${loop}: N-1 losers`).toHaveLength(N - 1);
			for (const l of losers) {
				expect(l.ok).toBe(false);
				if (!l.ok) expect(l.reason, `loop ${loop}: loser is stale`).toBe("stale");
			}

			// The persisted value is the winner's, and it moved off the expected 725.
			const persisted = await store.getRate("standard", "z-us");
			const wonBps = winners[0]?.ok ? winners[0].rate.rateBps : undefined;
			expect(persisted?.rateBps, `loop ${loop}: persisted == winner`).toBe(wonBps);
			expect(persisted?.rateBps).not.toBe(725);
			await store.deleteRate(id);
		}
	}, 120_000);
});
