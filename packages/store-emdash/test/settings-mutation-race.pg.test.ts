/**
 * Settings-mutation idempotency under real concurrency — what the SQL got from one
 * transaction around a ledger insert and an upsert, now a claim document and a pinned
 * compare-and-set.
 *
 * It is **Postgres-required**: better-sqlite3 serializes writes in-process, so it can
 * verify the statements but cannot lose a race. Two shapes are proven:
 *
 * 1. N concurrent updates carrying ONE key apply the mutation once — one claim
 *    document, one applied value, and every caller handed the same result. This is the
 *    double-submit an operator produces by clicking Save twice.
 * 2. N concurrent updates carrying DISTINCT keys and FIELD-DISJOINT patches lose
 *    nothing. Half the crowd patches `holdTtlMinutes` and half `lowStockThreshold`, so
 *    a lost update is visible rather than indistinguishable: a writer that committed a
 *    value it decided against a stale base would carry the default it read for the
 *    other field, reverting a peer's write. Both fields must survive in the final
 *    value, and every recorded result must be a value that really was applied.
 */
import {
	DEFAULT_OPERATIONAL_SETTINGS as DEFAULTS,
	idempotencyKey,
	type OperationalSettings,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { settleOne } from "./helpers/fault-injection.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import { makeMiscHarness, type MiscHarness } from "./misc-harness.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";

/**
 * The hand-set attempt budget, at the package ceiling rather than under it.
 *
 * The settings singleton is the one document in this tier whose bound is the CROWD
 * rather than the document: distinct-key updates are last-writer-wins by port
 * contract, so nothing refuses anybody and every writer can lose its revision once
 * per peer that commits ahead of it. That is the shipping/tax rules shape
 * (`rules-cas-race.pg.test.ts`), and it is why this suite races ten writers rather
 * than twenty-four. The same-key shape is document-bound and measures far lower: every
 * caller of one key merges the same patch to the same value, so a loser re-applies an
 * identical value and then reads the single-assignment result.
 *
 * Measured at **3** for the same-key stampede at N=16 — a caller can lose the settings
 * write to a peer applying the identical value and then lose the result stamp to the
 * peer that recorded it first, which is two losses before it reads the recorded answer —
 * and at **7** for the field-disjoint crowd at N=10, which is the crowd bound showing
 * itself.
 */
const CAS_ATTEMPT_BUDGET = 24;

interface Fixture {
	harness: MiscHarness;
	maxAttempts(): number;
	reset(): Promise<void>;
	close(): Promise<void>;
}

async function fresh(poolMax: number): Promise<Fixture> {
	const db = await makePgStorage(MISC_LAYOUT, poolMax);
	let deepest = 0;
	const harness = makeMiscHarness(db.storage, {
		onCasAttempts: (_operation, attempts) => {
			deepest = Math.max(deepest, attempts);
		},
	});
	return {
		harness,
		maxAttempts: () => deepest,
		reset: () => db.reset(),
		close: () => db.close(),
	};
}

describe.skipIf(!PG_ENABLED)("settings mutation [postgres]", () => {
	test("N concurrent updates with ONE key apply once and agree on the result", async () => {
		const N = 16;
		const LOOPS = 10;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const results = await Promise.all(
					Array.from({ length: N }, () =>
						settleOne(
							fx.harness.settingsStore.update(
								{ holdTtlMinutes: 30, lowStockThreshold: 12 },
								idempotencyKey("one-key"),
							),
						),
					),
				);
				expect(
					results.filter((r) => r instanceof Error),
					`loop ${String(loop)}: failures`,
				).toHaveLength(0);
				for (const result of results) {
					expect(result, `loop ${String(loop)}`).toEqual({
						holdTtlMinutes: 30,
						lowStockThreshold: 12,
					});
				}
				// One claim, one singleton, and the value really landed.
				expect(await fx.harness.mutations.count(), `loop ${String(loop)}: claims`).toBe(1);
				expect(await fx.harness.settings.count(), `loop ${String(loop)}: singletons`).toBe(1);
				expect(await fx.harness.settingsStore.get(), `loop ${String(loop)}: applied`).toEqual({
					holdTtlMinutes: 30,
					lowStockThreshold: 12,
				});
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);

	test("N concurrent updates with FIELD-DISJOINT patches lose nothing", async () => {
		// Disjoint on purpose. A crowd patching the SAME field cannot detect a lost
		// update: whatever value survives is somebody's, and a writer that committed a
		// value decided against a stale base is indistinguishable from one that read the
		// newest. Split the crowd across the two fields and a lost update is VISIBLE —
		// the losing field reverts to its domain default, because a stale merge carries
		// the default it read rather than the value a peer had already applied.
		const N = 10;
		const LOOPS = 8;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const holdValues = [31, 32, 33, 34, 35];
				const stockValues = [41, 42, 43, 44, 45];
				const patches: Partial<OperationalSettings>[] = [
					...holdValues.map((holdTtlMinutes) => ({ holdTtlMinutes })),
					...stockValues.map((lowStockThreshold) => ({ lowStockThreshold })),
				];
				const results = await Promise.all(
					patches.map((patch, i) =>
						settleOne(fx.harness.settingsStore.update(patch, idempotencyKey(`key-${String(i)}`))),
					),
				);
				expect(
					results.filter((r) => r instanceof Error),
					`loop ${String(loop)}: failures`,
				).toHaveLength(0);

				// BOTH fields survive in the final value: neither half of the crowd was
				// overwritten back to its default by a stale merge.
				const applied: OperationalSettings = await fx.harness.settingsStore.get();
				expect(holdValues, `loop ${String(loop)}: final holdTtlMinutes`).toContain(
					applied.holdTtlMinutes,
				);
				expect(stockValues, `loop ${String(loop)}: final lowStockThreshold`).toContain(
					applied.lowStockThreshold,
				);

				// And every recorded result is a value that really was applied: its own
				// field is its own patch, and the other field is either the default it
				// legitimately read or one of the peers' values — never anything invented.
				for (let i = 0; i < N; i++) {
					const patch = patches[i];
					const claim = await fx.harness.mutations.get(`key-${String(i)}`);
					expect(claim?.patch, `loop ${String(loop)}: claim ${String(i)} intent`).toEqual(patch);
					const recorded = claim?.result;
					expect(recorded, `loop ${String(loop)}: claim ${String(i)} result`).not.toBeNull();
					expect(results[i], `loop ${String(loop)}: result ${String(i)}`).toEqual(recorded);
					if (patch?.holdTtlMinutes !== undefined) {
						expect(recorded?.holdTtlMinutes).toBe(patch.holdTtlMinutes);
						expect([DEFAULTS.lowStockThreshold, ...stockValues]).toContain(
							recorded?.lowStockThreshold,
						);
					} else {
						expect(recorded?.lowStockThreshold).toBe(patch?.lowStockThreshold);
						expect([DEFAULTS.holdTtlMinutes, ...holdValues]).toContain(recorded?.holdTtlMinutes);
					}
				}
				expect(await fx.harness.mutations.count(), `loop ${String(loop)}: claims`).toBe(N);
				expect(await fx.harness.settings.count(), `loop ${String(loop)}: singletons`).toBe(1);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);
});
