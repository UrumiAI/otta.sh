/**
 * The window between a TOMBSTONE and the sku RELEASE that follows it (#447, PR #481).
 *
 * `softDelete` (and `deactivateVariant`, its variant twin) commits the tombstone and
 * only THEN releases the sku claim, as a second write: two documents, no atomicity.
 * Before restore existed nothing could turn a tombstoned row live again inside that
 * window. Now `restore` (and a variant resurrect) can: it re-claims the sku, which is
 * still live and ours, heartbeats it, and commits the row live with the sku. A release
 * that then re-read the claim and freed it "because it is live and ours" would free
 * the claim the restored row stands on, and the next product to ask for the sku would
 * get it — two live rows on one sku and one stock count, an oversell.
 *
 * So the release is pinned to the claim revision read BEFORE the tombstone write, and
 * skipped on any mismatch. These cases park the release write in a store built over a
 * wrapped `sku_owners` collection, run the restore in the window, and then ask the
 * question that matters: may ANOTHER product take the sku? It must not.
 *
 * The last case pins the price of skipping: a claim left live on a row that really is
 * tombstoned is freed by the lease (`CLAIM_ABANDON_AFTER_MS`), not held forever.
 */
import { idempotencyKey, productId, sku, SkuConflictError } from "@urumi-ai/otta-domain";
import { expect, test } from "vitest";
import { SKU_OWNERS_COLLECTION, type SkuOwnerDoc } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { isUpdateWrite, onId, parkCall, withCollection } from "./helpers/fault-injection.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

/** The sku-claim lease the store runs with by default. */
const LEASE_MS = 60_000;

describeEachDialect("tombstone → release window", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	/** A harness whose STORE parks its first update write on `skuOwnerId`'s claim. */
	function parkingReleaseOf(skuOwnerId: string) {
		const raw = bound.collection<SkuOwnerDoc>(SKU_OWNERS_COLLECTION);
		const parked = parkCall(raw, onId(skuOwnerId, isUpdateWrite));
		const harness = makeProductCommerceHarness(bound.storage, {
			storageForStore: withCollection(bound.storage, SKU_OWNERS_COLLECTION, parked.collection),
		});
		return { parked, harness };
	}

	async function claimOf(s: string): Promise<SkuOwnerDoc | null> {
		return bound.collection<SkuOwnerDoc>(SKU_OWNERS_COLLECTION).get(s);
	}

	test("a restore inside softDelete's tombstone→release window keeps its sku claim: another product's upsert of that sku is refused", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		await h.store.upsert(
			{ productId: productId("prod-a"), sku: sku("RACE-X") },
			idempotencyKey("seed-a"),
		);
		await h.seedStock("RACE-X", 5);

		const { parked, harness: deleting } = parkingReleaseOf("RACE-X");
		const deleted = deleting.store.softDelete(productId("prod-a"), idempotencyKey("del-a"));
		await parked.arrived;
		// The tombstone has landed; the release has not.
		expect((await h.products.get("prod-a"))?.lifecycle).toBe("deleted");

		await h.store.restore(
			productId("prod-a"),
			idempotencyKey("restore-a"),
			"2026-07-10T01:00:00.000Z",
			{ documentConfirmed: true },
		);
		const restored = await h.products.get("prod-a");
		expect(restored?.lifecycle).toBe("live");
		expect(restored?.sku).toBe("RACE-X");

		parked.release();
		await deleted;

		// The restored row still stands on a live claim of its own…
		const claim = await claimOf("RACE-X");
		expect(claim?.live).toBe(true);
		expect(claim?.ownerId).toBe("prod-a");
		// …so another product cannot take the sku, and the stock is not shared.
		await expect(
			h.store.upsert({ productId: productId("prod-b"), sku: sku("RACE-X") }, idempotencyKey("b")),
		).rejects.toBeInstanceOf(SkuConflictError);
		expect((await h.products.get("prod-b"))?.sku ?? null).toBeNull();
	});

	test("a variant resurrect inside deactivateVariant's orphan→release window keeps its sku claim: another product's upsert of that sku is refused", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		await h.store.upsert({ productId: productId("prod-v") }, idempotencyKey("seed-v"));
		const declared = await h.store.upsertVariant(
			{ productId: productId("prod-v"), variantKey: "large", title: "Large" },
			idempotencyKey("declare-v"),
		);
		const priced = await h.store.updateVariantFields(
			{ productId: productId("prod-v"), variantKey: "large", sku: sku("RACE-V") },
			idempotencyKey("sku-v"),
			declared.updatedAt.toISOString(),
		);
		expect(priced.ok).toBe(true);

		const { parked, harness: orphaning } = parkingReleaseOf("RACE-V");
		const orphaned = orphaning.store.deactivateVariant(
			productId("prod-v"),
			"large",
			idempotencyKey("orphan-v"),
			"2026-07-10T01:00:00.000Z",
		);
		await parked.arrived;
		expect((await h.products.get("prod-v"))?.variants["large"]?.orphanedAt).not.toBeNull();

		const back = await h.store.upsertVariant(
			{
				productId: productId("prod-v"),
				variantKey: "large",
				title: "Large",
				contentUpdatedAt: "2026-07-10T02:00:00.000Z",
			},
			idempotencyKey("resurrect-v"),
		);
		expect(back.orphanedAt).toBeNull();
		expect(back.sku).toBe("RACE-V");

		parked.release();
		await orphaned;

		const claim = await claimOf("RACE-V");
		expect(claim?.live).toBe(true);
		expect(claim?.ownerId).toBe("prod-v");
		expect(claim?.variantKey).toBe("large");
		await expect(
			h.store.upsert({ productId: productId("prod-w"), sku: sku("RACE-V") }, idempotencyKey("w")),
		).rejects.toBeInstanceOf(SkuConflictError);
	});

	test("a claim renewed inside the window on a row that STAYS tombstoned is not held forever: the lease frees it for another product", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		await h.store.upsert(
			{ productId: productId("prod-s"), sku: sku("STALE-X") },
			idempotencyKey("seed-s"),
		);

		const { parked, harness: deleting } = parkingReleaseOf("STALE-X");
		const deleted = deleting.store.softDelete(productId("prod-s"), idempotencyKey("del-s"));
		await parked.arrived;

		// A late sync of the SAME product, naming the same sku, lands in the window: it
		// re-asserts (and so renews) the claim, but the row stays tombstoned. The release
		// then sees a revision it did not read and skips — the conservative answer, since
		// it cannot tell this renewal from a restore's.
		await h.store.upsert(
			{ productId: productId("prod-s"), sku: sku("STALE-X"), title: "late save" },
			idempotencyKey("late-save-s"),
		);
		expect((await h.products.get("prod-s"))?.lifecycle).toBe("deleted");

		parked.release();
		await deleted;
		expect((await claimOf("STALE-X"))?.live).toBe(true);

		// Inside the lease the claim reads as in-flight, so it is refused…
		await expect(
			h.store.upsert({ productId: productId("prod-t"), sku: sku("STALE-X") }, idempotencyKey("t1")),
		).rejects.toBeInstanceOf(SkuConflictError);

		// …and once the lease lapses nothing backs it (the owner is tombstoned), so it
		// is taken over.
		h.clock.advance(LEASE_MS);
		const taken = await h.store.upsert(
			{ productId: productId("prod-t"), sku: sku("STALE-X") },
			idempotencyKey("t2"),
		);
		expect(taken.sku).toBe("STALE-X");
		const claim = await claimOf("STALE-X");
		expect(claim?.live).toBe(true);
		expect(claim?.ownerId).toBe("prod-t");
	});
});
