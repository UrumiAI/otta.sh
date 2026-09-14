/**
 * The wiring every product-commerce suite shares: a real
 * `EmdashProductCommerceStore` over real plugin-storage repositories, plus the
 * four test-surface hooks the domain's `ProductCommerceStoreHarness` asks for.
 *
 * Each hook writes the SAME documents the adapters write, never a parallel
 * fixture:
 *
 * - `seedStock` overwrites one `inventory` document's count while PRESERVING its
 *   live holds and its rings, which is what lets a case seed stock after seeding a
 *   hold (and in either order) without clobbering the other.
 * - `seedHold` writes a real `held` hold into the inventory document — the very
 *   map THE SKU-RENAME RULE's step-0 refusal reads, so the contract's refusal
 *   cases exercise the guard rather than a flag. It models the hold row only, not
 *   the `onHand` decrement a real `reserve` would also make: the rule branches on
 *   a hold EXISTING, and the decrement's arithmetic belongs to the inventory
 *   contract.
 * - `seedProduct` writes a product document directly, so the admin-list cases can
 *   pin an EXACT `createdAt` per row without going through `upsert`'s
 *   idempotency-key dance.
 */
import {
	cents,
	currency,
	idempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import type { ProductCommerceStoreHarness } from "@otta-sh/domain/testing";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	newInventoryDoc,
	newShellProductDoc,
	normalizeInventoryDoc,
	PRODUCT_COMMERCE_COLLECTION,
	publishKeyFor,
	SKU_OWNERS_COLLECTION,
	type InventoryDoc,
	type ProductCommerceDoc,
	type SkuOwnerDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";

/** The epoch every product-commerce suite starts from. */
export const PRODUCT_EPOCH = new Date("2026-07-10T00:00:00.000Z");

export interface ProductCommerceHarness extends ProductCommerceStoreHarness {
	readonly clock: FixedClock;
	readonly store: EmdashProductCommerceStore;
	/** The product documents, for the assertions the port cannot express. */
	readonly products: StorageCollection<ProductCommerceDoc>;
	readonly skuOwners: StorageCollection<SkuOwnerDoc>;
	readonly inventoryDocs: StorageCollection<InventoryDoc>;
	/** One sku's on-hand count, `null` when it has no inventory document. */
	onHandOf(sku: string): Promise<number | null>;
}

export interface ProductCommerceHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Page ceiling for the admin list's bounded scan. */
	maxListPages?: number;
	/** Wrap the storage the STORE writes through (fault injection). */
	storageForStore?: StorageAccess;
}

/** Monotonic source for hold ids, so one sku may carry several holds. */
let holdSeedSeq = 0;

/** Build a product-commerce harness over an already-bound `StorageAccess`. */
export function makeProductCommerceHarness(
	storage: StorageAccess,
	options: ProductCommerceHarnessOptions = {},
): ProductCommerceHarness {
	const clock = new FixedClock(new Date(PRODUCT_EPOCH.getTime()));
	const store = new EmdashProductCommerceStore({
		storage: options.storageForStore ?? storage,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
		maxListPages: options.maxListPages,
	});
	// The RAW collections, deliberately unwrapped by any fault injection: a seed is
	// a fixture, and a test that injected a fault into its own setup would be
	// asserting against a state the store never produces.
	const inventoryDocs = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	const products = collectionOf<ProductCommerceDoc>(storage, PRODUCT_COMMERCE_COLLECTION);
	const skuOwners = collectionOf<SkuOwnerDoc>(storage, SKU_OWNERS_COLLECTION);

	return {
		clock,
		store,
		products,
		skuOwners,
		inventoryDocs,
		async onHandOf(sku) {
			const doc = await inventoryDocs.get(sku);
			return doc === null ? null : doc.onHand;
		},
		async seedStock(sku, qty) {
			const current = await inventoryDocs.getVersioned(sku);
			if (current === null) {
				await inventoryDocs.compareAndSet(sku, null, newInventoryDoc(sku, qty));
				return;
			}
			await inventoryDocs.compareAndSet(sku, current.revision, {
				...normalizeInventoryDoc(current.value),
				onHand: qty,
			});
		},
		async seedHold(sku, qty) {
			const seq = holdSeedSeq++;
			const reserveKey = `hold-key-${sku}-${String(seq)}`;
			const current = await inventoryDocs.getVersioned(sku);
			const base =
				current === null ? newInventoryDoc(sku, 0) : normalizeInventoryDoc(current.value);
			await inventoryDocs.compareAndSet(sku, current?.revision ?? null, {
				...base,
				holds: {
					...base.holds,
					[reserveKey]: {
						reservationId: `hold-${sku}-${String(seq)}`,
						qty,
						state: "held",
						expiresAt: null,
						orderId: null,
						createdAt: PRODUCT_EPOCH.toISOString(),
					},
				},
			});
		},
		async seedProduct(row) {
			const at = row.createdAt;
			const shell = newShellProductDoc(toProductId(row.id), at);
			const deletedAt = row.deletedAt ?? null;
			const doc: ProductCommerceDoc = {
				...shell,
				lifecycle: deletedAt === null ? "live" : "deleted",
				sku: row.sku === undefined || row.sku === null ? null : toSku(row.sku),
				price:
					row.priceCents === undefined || row.priceCents === null
						? null
						: money(cents(row.priceCents), currency(row.currency ?? "USD")),
				title: row.title ?? null,
				productKind: row.productKind ?? "physical",
				active: row.active ?? false,
				publishKey: publishKeyFor(row.active ?? false),
				deletedAt,
				idempotencyKey: idempotencyKey(`seed-${row.id}`),
				createdAt: at,
				updatedAt: at,
			};
			await products.put(row.id, doc);
			// A seeded row still OWNS its sku: the claim document is the live-sku
			// uniqueness rule, so a fixture that skipped it would let a later write take
			// a sku a live row already holds — the exact state the rule forbids.
			if (doc.sku !== null && doc.lifecycle === "live") {
				await skuOwners.put(doc.sku, {
					sku: doc.sku,
					ownerKind: "product",
					ownerId: doc.productId,
					variantKey: null,
					live: true,
					claimedAt: at,
				});
			}
		},
	};
}
