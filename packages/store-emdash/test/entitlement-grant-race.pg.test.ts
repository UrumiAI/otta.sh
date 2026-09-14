/**
 * Grant-once under real concurrency — what `entitlements.grant_idempotency_key`
 * UNIQUE gave for free, now the document id of the grant itself.
 *
 * It is **Postgres-required** and stays that way: better-sqlite3 serializes writes
 * in-process, so it can verify the statements but cannot lose a race. Two shapes are
 * proven, and the second is the one a pointer design can get wrong:
 *
 * 1. Of N concurrent grants carrying ONE key, exactly one grant document lands and
 *    every caller is handed the same entitlement id. A digital download that a
 *    gateway delivered twice at once must not become two entitlements.
 * 2. Of N concurrent grants for ONE scope with DIFFERENT keys, N grants land — the
 *    port allows that, and each is a real authorization — but the scope keeps ONE
 *    pointer. Which grant it names is whichever committed its pointer first, and that
 *    is deliberately not load-bearing: the gate re-validates the pointer against the
 *    grant it names, so authorization is decided by the SET of grants.
 */
import { idempotencyKey, orderId, sku } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { entitlementLookupId } from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { settleOne } from "./helpers/fault-injection.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import { makeMiscHarness, type MiscHarness } from "./misc-harness.js";

/**
 * The hand-set attempt budget both shapes are held to — tighter than
 * `CAS_MAX_ATTEMPTS`, so raising the package ceiling cannot turn a passing shape
 * green by accident.
 *
 * The bound is a property of the DOCUMENT, not of the crowd. A grant key is written
 * create-if-absent exactly once: the first writer takes it and every peer is refused
 * without contending again, then reads it back — two attempts at most. A scope
 * pointer behaves identically. So the depth does not grow with N.
 *
 * Measured at **2** for both shapes — the one-key stampede at N=24 and the
 * distinct-key crowd at N=16 — which is the read-back attempt after a refused
 * create-if-absent, and nothing more.
 */
const CAS_ATTEMPT_BUDGET = 12;

const SKU = sku("DIG-1");
const BUYER = "Buyer@Example.com";

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

describe.skipIf(!PG_ENABLED)("entitlement grant [postgres]", () => {
	test("N concurrent grants with ONE key produce one grant, one entitlement id and two pointers", async () => {
		const N = 24;
		const LOOPS = 12;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const results = await Promise.all(
					Array.from({ length: N }, () =>
						settleOne(
							fx.harness.entitlementStore.grant({
								orderId: orderId("ord-1"),
								productId: null,
								sku: SKU,
								buyerRef: BUYER,
								source: "order_paid",
								grantIdempotencyKey: idempotencyKey("one-key"),
							}),
						),
					),
				);
				const failures = results.filter((r) => r instanceof Error);
				expect(failures, `loop ${String(loop)}: failures`).toHaveLength(0);
				const ids = new Set(results.map((r) => (r as { id: string }).id));
				expect(ids.size, `loop ${String(loop)}: distinct entitlement ids`).toBe(1);
				expect(await fx.harness.grants.count(), `loop ${String(loop)}: grants`).toBe(1);
				// Two scopes, one pointer each — no caller wrote a third.
				expect(await fx.harness.lookups.count(), `loop ${String(loop)}: pointers`).toBe(2);
				expect(
					await fx.harness.entitlementStore.check({ orderId: orderId("ord-1"), sku: SKU }),
					`loop ${String(loop)}: the gate`,
				).toBe(true);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);

	test("N concurrent grants for ONE scope with distinct keys produce N grants and one pointer per scope", async () => {
		const N = 16;
		const LOOPS = 10;
		const fx = await fresh(N + 4);
		try {
			for (let loop = 0; loop < LOOPS; loop++) {
				await fx.reset();
				const results = await Promise.all(
					Array.from({ length: N }, (_unused, i) =>
						settleOne(
							fx.harness.entitlementStore.grant({
								orderId: orderId("ord-1"),
								productId: null,
								sku: SKU,
								buyerRef: BUYER,
								source: "order_paid",
								grantIdempotencyKey: idempotencyKey(`key-${String(i)}`),
							}),
						),
					),
				);
				expect(
					results.filter((r) => r instanceof Error),
					`loop ${String(loop)}: failures`,
				).toHaveLength(0);
				const ids = new Set(results.map((r) => (r as { id: string }).id));
				expect(ids.size, `loop ${String(loop)}: distinct entitlement ids`).toBe(N);
				expect(await fx.harness.grants.count(), `loop ${String(loop)}: grants`).toBe(N);
				// ONE pointer per scope, and it names a grant that really exists.
				expect(await fx.harness.lookups.count(), `loop ${String(loop)}: pointers`).toBe(2);
				for (const scope of [
					entitlementLookupId("order", "ord-1", "DIG-1"),
					entitlementLookupId("buyer", "buyer@example.com", "DIG-1"),
				]) {
					const pointer = await fx.harness.lookups.get(scope);
					expect(pointer, `loop ${String(loop)}: ${scope}`).not.toBeNull();
					expect(
						await fx.harness.grants.get(pointer?.grantKey ?? ""),
						`loop ${String(loop)}: ${scope} names a live grant`,
					).not.toBeNull();
				}
				expect(
					await fx.harness.entitlementStore.check({ buyerRef: BUYER, sku: SKU }),
					`loop ${String(loop)}: the gate`,
				).toBe(true);
			}
			expect(fx.maxAttempts()).toBeLessThanOrEqual(CAS_ATTEMPT_BUDGET);
		} finally {
			await fx.close();
		}
	}, 180_000);
});
