/**
 * A product RESTORE (#447) under real concurrency. Postgres only: better-sqlite3
 * serializes every writer onto one connection and cannot race.
 *
 * A soft delete releases the row's sku; a restore takes it back if it is still free.
 * Another product asking for the same sku at the same moment contends for the same
 * released claim document, so exactly one of them may win it. Whatever the
 * interleaving, at most one live row may name the sku, and the claim must name that
 * row — otherwise two products sell one stock count.
 *
 * The deterministic version of the nastier window (a restore landing between a soft
 * delete's tombstone and its release) is in `tombstone-release-race.dialects.test.ts`,
 * because a free-running race reaches that window too rarely to prove anything; this
 * file races the calls for real and checks the invariant over the orders that occur.
 */
import { idempotencyKey, productId, sku, type ProductId } from "@urumi-ai/otta-domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	collectionOf,
	EmdashProductCommerceStore,
	PRODUCT_COMMERCE_COLLECTION,
	SKU_OWNERS_COLLECTION,
	type ProductCommerceDoc,
	type SkuOwnerDoc,
	type StorageAccess,
} from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { TickingClock } from "./ticking-clock.js";

const POOL = 8;

/** A few milliseconds' lag, so the other racer can reach the claim first. */
function lag(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Every outcome must be a success or the port's typed sku refusal. */
function expectTyped(r: PromiseSettledResult<unknown> | undefined, label: string): void {
	if (r?.status !== "rejected") return;
	const err = r.reason as Error & { code?: string };
	expect(err.code, `${label}: never a deadlock — ${err.message}`).not.toBe("40P01");
	expect(err.name, `${label}: typed refusal — ${err.message}`).toBe("SkuConflictError");
}

describe.skipIf(!PG_ENABLED)("product restore concurrency [postgres]", () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;
	let products: EmdashProductCommerceStore;

	beforeAll(async () => {
		const db = await makePgStorage(PRODUCT_COMMERCE_LAYOUT, POOL);
		storage = db.storage;
		close = db.close;
		products = new EmdashProductCommerceStore({
			storage,
			clock: new TickingClock("2026-07-10T00:00:00.000Z"),
		});
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	/** The ids among `ids` whose LIVE row names `s`. */
	async function liveHolders(s: string, ids: readonly string[]): Promise<string[]> {
		const docs = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
		const held: string[] = [];
		for (const id of ids) {
			const doc = await docs.get(id);
			if (doc?.lifecycle === "live" && doc.sku === s) held.push(id);
		}
		return held;
	}

	async function claimOf(s: string): Promise<SkuOwnerDoc | null> {
		return collectionOf<SkuOwnerDoc>(storage, SKU_OWNERS_COLLECTION).get(s);
	}

	test("a RESTORE racing ANOTHER product's upsert of the restored row's sku: at most one live row holds it, and the claim names that row", async () => {
		const LOOPS = 60;
		let restoreKept = 0;
		let claimantTookIt = 0;

		for (let loop = 0; loop < LOOPS; loop++) {
			const a = `rr-a-${String(loop)}`;
			const b = `rr-b-${String(loop)}`;
			const s = `RR-${String(loop)}`;
			await products.upsert({ productId: productId(a), sku: sku(s) }, idempotencyKey(`seed-${a}`));
			await products.softDelete(productId(a), idempotencyKey(`del-${a}`));

			const restore = (): Promise<void> =>
				products.restore(productId(a), idempotencyKey(`restore-${a}`), "2026-07-11T00:00:00.000Z", {
					documentConfirmed: true,
				});
			// Unlagged, the restore reaches the released claim first; lagged by even a
			// tick, the claimant does. Alternating gives both orders, and the lag is
			// short enough that the two calls still overlap.
			const [restored, claimed] = await Promise.allSettled([
				loop % 2 === 0 ? restore() : lag(loop % 3).then(restore),
				products.upsert({ productId: productId(b), sku: sku(s) }, idempotencyKey(`claim-${b}`)),
			]);

			const label = `loop ${String(loop)}`;
			// A restore never refuses: a lost sku is cleared, not thrown.
			expect(restored?.status, `${label}: the restore resolves`).toBe("fulfilled");
			expectTyped(claimed, label);

			const holders = await liveHolders(s, [a, b]);
			expect(holders, `${label}: exactly one live row holds the sku`).toHaveLength(1);
			const claim = await claimOf(s);
			expect(claim?.live, `${label}: the claim is live`).toBe(true);
			expect(claim?.ownerId, `${label}: the claim names the holder`).toBe(holders[0]);
			if (holders[0] === a) restoreKept++;
			else claimantTookIt++;
		}

		// Both interleavings occurred, so both branches were asserted, not just written.
		expect(restoreKept, "the restore-first branch fired").toBeGreaterThan(0);
		expect(claimantTookIt, "the claimant-first branch fired").toBeGreaterThan(0);
	}, 300_000);

	test("a soft delete, a restore and another product's upsert of the sku, all at once: at most one live row holds it, and the claim agrees", async () => {
		const LOOPS = 60;

		for (let loop = 0; loop < LOOPS; loop++) {
			const a = `rd-a-${String(loop)}`;
			const b = `rd-b-${String(loop)}`;
			const s = `RD-${String(loop)}`;
			const pa: ProductId = productId(a);
			await products.upsert({ productId: pa, sku: sku(s) }, idempotencyKey(`seed-${a}`));

			// The restore can only apply after the soft delete's tombstone. This race does
			// not reliably hit the tombstone→release window (the seam file pins that one);
			// it checks the invariant holds over whatever interleavings do occur.
			const settled = await Promise.allSettled([
				products.softDelete(pa, idempotencyKey(`del-${a}`)),
				products.restore(pa, idempotencyKey(`restore-${a}`), "2026-07-11T00:00:00.000Z", {
					documentConfirmed: true,
				}),
				products.upsert({ productId: productId(b), sku: sku(s) }, idempotencyKey(`claim-${b}`)),
			]);
			const label = `loop ${String(loop)}`;
			expect(settled[0]?.status, `${label}: the soft delete resolves`).toBe("fulfilled");
			expect(settled[1]?.status, `${label}: the restore resolves`).toBe("fulfilled");
			expectTyped(settled[2], label);

			const holders = await liveHolders(s, [a, b]);
			expect(holders.length, `${label}: never two live rows on one sku`).toBeLessThanOrEqual(1);
			const claim = await claimOf(s);
			if (holders.length === 1) {
				expect(claim?.live, `${label}: the holder's claim is live`).toBe(true);
				expect(claim?.ownerId, `${label}: the claim names the holder`).toBe(holders[0]);
			}
			// And whoever holds it, nobody else can take it now.
			if (holders.length === 1) {
				const c = `rd-c-${String(loop)}`;
				await expect(
					products.upsert({ productId: productId(c), sku: sku(s) }, idempotencyKey(`late-${c}`)),
					`${label}: a third product is refused`,
				).rejects.toMatchObject({ name: "SkuConflictError" });
			}
		}
	}, 300_000);
});
