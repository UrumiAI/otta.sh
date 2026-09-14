/**
 * The money compare-and-set race for the two rules adapters — ported case for
 * case from the SQL adapter's suite of the same name, and widened by the twin
 * the SQL suite did not have.
 *
 * It is **Postgres-required** and stays that way: better-sqlite3 serializes
 * writes in-process, so it can verify the statements but cannot lose a race. What
 * is proven here is that `updateRate`'s expected-value guard picks exactly ONE
 * winner out of a crowd of admins who all read the same rate — the guard the SQL
 * ran as a single `UPDATE … WHERE rate_bps = :expected` / `WHERE amount_cents =
 * :expected`, and which here is a client-side comparison committed with a
 * revision compare-and-set on a document the whole class (or zone) shares.
 *
 * Three properties, and all three are load-bearing:
 *
 * 1. **Exactly one winner**, N−1 losers, every loser `stale`.
 * 2. **The persisted value is the winner's** — never a loser's, and never the
 *    expected value the crowd started from.
 * 3. **A loser that had to RETRY after losing the revision re-reads and
 *    re-compares** rather than re-submitting. That is what the third case makes
 *    visible: it forces a revision loss on peers that are NOT editing the money
 *    at all (a zone rename, a class rename), so the retry budget is actually
 *    spent, and the money guard must still refuse the loser. A store that
 *    retried by re-submitting would pass cases 1 and 2 and silently clobber here.
 *
 * The concurrency is the SQL suite's, unchanged (N=24, 12 loops), because that is
 * the shape that makes revision loss actually happen; the measured depth is
 * reported per case rather than per file.
 */
import { cents, currency } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { CAS_MAX_ATTEMPTS } from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { SHIPPING_RULES_LAYOUT, TAX_RULES_LAYOUT } from "./rules-collections.js";
import {
	makeShippingRulesHarness,
	makeTaxRulesHarness,
	type ShippingRulesHarness,
	type TaxRulesHarness,
} from "./rules-harness.js";

const USD = currency("USD");

/** The SQL suite's crowd and loop count, unchanged. */
const N = 24;
const LOOPS = 12;

interface Depth {
	/** The deepest compare-and-set retry any step has spent so far. */
	max(): number;
	/** The deepest retry spent by ONE named step. */
	maxFor(operation: string): number;
}

interface TaxFixture extends Depth {
	harness: TaxRulesHarness;
	close(): Promise<void>;
}

interface ShippingFixture extends Depth {
	harness: ShippingRulesHarness;
	close(): Promise<void>;
}

function observer(): { depth: Depth; onCasAttempts: (op: string, attempts: number) => void } {
	let deepest = 0;
	const perOperation = new Map<string, number>();
	return {
		depth: {
			max: () => deepest,
			maxFor: (operation) => perOperation.get(operation) ?? 0,
		},
		onCasAttempts: (operation, attempts) => {
			deepest = Math.max(deepest, attempts);
			perOperation.set(operation, Math.max(perOperation.get(operation) ?? 0, attempts));
		},
	};
}

/**
 * A schema-isolated tax store whose pool holds `poolMax` connections, so N
 * concurrent edits each take an INDEPENDENT connection (a real document race).
 */
async function freshTax(poolMax: number): Promise<TaxFixture> {
	const db = await makePgStorage(TAX_RULES_LAYOUT, poolMax);
	const { depth, onCasAttempts } = observer();
	return {
		harness: makeTaxRulesHarness(db.storage, { onCasAttempts }),
		max: depth.max,
		maxFor: depth.maxFor,
		close: () => db.close(),
	};
}

/** The same, for the shipping store. */
async function freshShipping(poolMax: number): Promise<ShippingFixture> {
	const db = await makePgStorage(SHIPPING_RULES_LAYOUT, poolMax);
	const { depth, onCasAttempts } = observer();
	return {
		harness: makeShippingRulesHarness(db.storage, { onCasAttempts }),
		max: depth.max,
		maxFor: depth.maxFor,
		close: () => db.close(),
	};
}

describe.skipIf(!PG_ENABLED)("tax-rate updateRate CAS race [postgres]", () => {
	test("N concurrent edits on one rate yield exactly ONE winner; losers are stale", async () => {
		const fx = await freshTax(N + 4);
		try {
			const store = fx.harness.store;
			await store.createClass({ id: "standard", name: "Standard" });

			for (let loop = 0; loop < LOOPS; loop++) {
				const id = `r-${String(loop)}`;
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
				expect(winners, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
				const losers = results.filter((r) => !r.ok);
				expect(losers, `loop ${String(loop)}: N-1 losers`).toHaveLength(N - 1);
				for (const l of losers) {
					expect(l.ok).toBe(false);
					if (!l.ok) expect(l.reason, `loop ${String(loop)}: loser is stale`).toBe("stale");
				}

				// The persisted value is the winner's, and it moved off the expected 725.
				const persisted = await store.getRate("standard", "z-us");
				const wonBps = winners[0]?.ok === true ? winners[0].rate.rateBps : undefined;
				expect(persisted?.rateBps, `loop ${String(loop)}: persisted == winner`).toBe(wonBps);
				expect(persisted?.rateBps).not.toBe(725);
				await store.deleteRate(id);
			}
			// Reported, not asserted tightly: the depth is what the budget is measured
			// against, and it must stay inside the package ceiling.
			expect(fx.maxFor("updateTaxRate")).toBeLessThanOrEqual(CAS_MAX_ATTEMPTS);
			console.log(
				`[rules-cas-race] tax updateRate: max CAS attempts ${String(fx.maxFor("updateTaxRate"))}`,
			);
		} finally {
			await fx.close();
		}
	}, 120_000);
});

describe.skipIf(!PG_ENABLED)("shipping-rate updateRate CAS race [postgres]", () => {
	test("N concurrent edits on one rate yield exactly ONE winner; losers are stale", async () => {
		const fx = await freshShipping(N + 4);
		try {
			const store = fx.harness.store;
			await store.createZone({ id: "z-us", name: "US", regions: null });

			for (let loop = 0; loop < LOOPS; loop++) {
				const methodId = `m-${String(loop)}`;
				await store.createMethod({
					id: methodId,
					zoneId: "z-us",
					name: "Flat",
					type: "flat_rate",
				});
				await store.createRate({
					methodId,
					currency: USD,
					amountCents: cents(599),
					minSubtotalCents: null,
				});

				const results = await Promise.all(
					Array.from({ length: N }, (_unused, i) =>
						store.updateRate(
							methodId,
							USD,
							{ amountCents: cents(700 + i), minSubtotalCents: null },
							cents(599),
						),
					),
				);

				const winners = results.filter((r) => r.ok);
				expect(winners, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
				const losers = results.filter((r) => !r.ok);
				expect(losers, `loop ${String(loop)}: N-1 losers`).toHaveLength(N - 1);
				for (const l of losers) {
					expect(l.ok).toBe(false);
					if (!l.ok) expect(l.reason, `loop ${String(loop)}: loser is stale`).toBe("stale");
				}

				const persisted = await store.getRate(methodId, USD);
				const wonCents = winners[0]?.ok === true ? winners[0].rate.amountCents : undefined;
				expect(persisted?.amountCents, `loop ${String(loop)}: persisted == winner`).toBe(wonCents);
				expect(persisted?.amountCents).not.toBe(599);
				await store.deleteRate(methodId, USD);
				await store.deleteMethod(methodId);
			}
			expect(fx.maxFor("updateShippingRate")).toBeLessThanOrEqual(CAS_MAX_ATTEMPTS);
			console.log(
				`[rules-cas-race] shipping updateRate: max CAS attempts ${String(
					fx.maxFor("updateShippingRate"),
				)}`,
			);
		} finally {
			await fx.close();
		}
	}, 120_000);
});

/**
 * The retry-then-re-verify hazard, driven by a real crowd rather than a parked
 * write (which `test/rules-crash-seams.dialects.test.ts` does deterministically).
 *
 * Every peer here writes the SAME document without touching the money: renames.
 * So the money editors lose their revision repeatedly and really do spend the
 * retry budget — and the guard must still admit exactly one of them, because the
 * expected value is re-read and re-compared on each attempt. A retry that
 * re-submitted its decision would let several "win", and the final value would be
 * the last writer's rather than the single winner's.
 */
describe.skipIf(!PG_ENABLED)("rules CAS race: a retried loser re-verifies [postgres]", () => {
	test("money editors racing a storm of same-document renames still admit exactly one", async () => {
		const fx = await freshTax(N + 8);
		try {
			const store = fx.harness.store;
			await store.createClass({ id: "standard", name: "Standard" });

			for (let loop = 0; loop < LOOPS; loop++) {
				const id = `r-${String(loop)}`;
				await store.createRate({
					id,
					taxClassId: "standard",
					zoneId: "z-us",
					rateBps: 725,
					appliesToShipping: false,
				});

				const edits = Array.from({ length: N }, (_unused, i) =>
					store.updateRate(id, { rateBps: 900 + i, appliesToShipping: false }, 725),
				);
				// The contention that is NOT about money: same document, no rate touched.
				const renames = Array.from({ length: N }, (_unused, i) =>
					store.updateClass("standard", { name: `Standard ${String(i)}` }),
				);
				const [results] = await Promise.all([Promise.all(edits), Promise.all(renames)]);

				const winners = results.filter((r) => r.ok);
				expect(winners, `loop ${String(loop)}: exactly one winner`).toHaveLength(1);
				for (const l of results.filter((r) => !r.ok)) {
					if (!l.ok) expect(l.reason, `loop ${String(loop)}: loser is stale`).toBe("stale");
				}
				const persisted = await store.getRate("standard", "z-us");
				const wonBps = winners[0]?.ok === true ? winners[0].rate.rateBps : undefined;
				expect(persisted?.rateBps, `loop ${String(loop)}: persisted == winner`).toBe(wonBps);
				await store.deleteRate(id);
			}
			expect(fx.max()).toBeLessThanOrEqual(CAS_MAX_ATTEMPTS);
			console.log(
				`[rules-cas-race] rename storm: max CAS attempts ${String(fx.max())} ` +
					`(updateTaxRate ${String(fx.maxFor("updateTaxRate"))}, ` +
					`updateTaxClass ${String(fx.maxFor("updateTaxClass"))})`,
			);
		} finally {
			await fx.close();
		}
	}, 180_000);
});
