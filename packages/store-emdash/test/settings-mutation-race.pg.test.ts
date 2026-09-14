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
 * 2. N concurrent updates carrying DISTINCT keys all record what they applied. The
 *    surviving value is one of them (last writer wins, as it did in SQL), and no
 *    caller is told it applied something it did not: the recorded result and the
 *    applied value agree, because a caller that loses the pinned write re-merges over
 *    the new base and rewrites its own claim before trying again.
 */
import { idempotencyKey, type OperationalSettings } from "@otta-sh/domain";
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
 * than twenty-four. The same-key shape is document-bound and measures far lower: the
 * claim admits one caller and the rest read its result.
 *
 * Measured at **1** for the same-key stampede at N=16 — the claim's winner never loses
 * a revision, and every peer resolves on its first attempt — and at **8** for the
 * distinct-key crowd at N=10, which is the crowd bound showing itself.
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

	test("N concurrent updates with distinct keys each record what they applied, and one survives", async () => {
		const N = 10;
		const LOOPS = 8;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const results = await Promise.all(
					Array.from({ length: N }, (_unused, i) =>
						settleOne(
							fx.harness.settingsStore.update(
								{ holdTtlMinutes: i + 1 },
								idempotencyKey(`key-${String(i)}`),
							),
						),
					),
				);
				expect(
					results.filter((r) => r instanceof Error),
					`loop ${String(loop)}: failures`,
				).toHaveLength(0);
				// Every caller was told what its own patch produced, and its claim says the
				// same: the recorded result is never a value the caller did not apply.
				for (let i = 0; i < N; i++) {
					expect(results[i], `loop ${String(loop)}: result ${String(i)}`).toEqual({
						holdTtlMinutes: i + 1,
						lowStockThreshold: 5,
					});
					const claim = await fx.harness.mutations.get(`key-${String(i)}`);
					expect(claim?.holdTtlMinutes, `loop ${String(loop)}: claim ${String(i)}`).toBe(i + 1);
				}
				expect(await fx.harness.mutations.count(), `loop ${String(loop)}: claims`).toBe(N);
				expect(await fx.harness.settings.count(), `loop ${String(loop)}: singletons`).toBe(1);
				// The surviving value is one of the ten, never a blend of them.
				const applied: OperationalSettings = await fx.harness.settingsStore.get();
				expect(results, `loop ${String(loop)}: the survivor is one of the results`).toContainEqual(
					applied,
				);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);
});
