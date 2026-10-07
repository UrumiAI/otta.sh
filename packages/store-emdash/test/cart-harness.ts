/**
 * The wiring every cart suite shares: a real `EmdashCartStore` over a real
 * `EmdashInventoryStore` over real plugin-storage repositories, plus the handful
 * of test-surface helpers the domain's `CartStoreHarness` asks for.
 *
 * It is deliberately NOT a fixture factory with hidden state: each call builds a
 * harness over the `StorageAccess` the dialect harness already bound for the file,
 * whose rows the per-test `reset()` has just emptied.
 *
 * The two hooks the contract needs are both composed over the real stores rather
 * than reaching into documents:
 *
 * - `seedStock` goes through the inventory store's own test-surface stock write, so
 *   re-seeding a sku that already has holds cannot clobber them.
 * - `advance` moves the injected `FixedClock`, which is what makes a hold lapse
 *   without waiting fifteen minutes.
 */
import type { CartDeps } from "@otta-sh/domain";
import type { CartStoreHarness } from "@otta-sh/domain/testing";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashCartStore,
	EmdashInventoryStore,
	INVENTORY_COLLECTION,
	type CartDoc,
	type InventoryDoc,
	type StorageAccess,
	type StorageCollection,
	CARTS_COLLECTION,
	newInventoryDoc,
	normalizeInventoryDoc,
	uuidIdGen,
} from "../src/index.js";

/** The epoch every cart suite starts from, so hold deadlines read identically. */
export const CART_EPOCH = new Date("2026-07-10T00:00:00.000Z");

export interface CartHarness extends CartStoreHarness {
	readonly clock: FixedClock;
	readonly store: EmdashCartStore;
	readonly inventory: EmdashInventoryStore;
	/** The cart documents, for the assertions the port cannot express. */
	readonly carts: StorageCollection<CartDoc>;
	readonly inventoryDocs: StorageCollection<InventoryDoc>;
}

export interface CartHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Wrap the inventory store the cart store writes through (fault injection). */
	storageForCart?: StorageAccess;
}

/** Build a cart harness over an already-bound `StorageAccess`. */
export function makeCartHarness(
	storage: StorageAccess,
	options: CartHarnessOptions = {},
): CartHarness {
	const clock = new FixedClock(new Date(CART_EPOCH.getTime()));
	const inventory = new EmdashInventoryStore({
		storage,
		idGen: uuidIdGen,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
	});
	const store = new EmdashCartStore({
		storage: options.storageForCart ?? storage,
		inventory,
		idGen: uuidIdGen,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
	});
	const inventoryDocs = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
	const deps: CartDeps = { cartStore: store, inventoryStore: inventory, clock };
	return {
		deps,
		clock,
		store,
		inventory,
		carts: collectionOf<CartDoc>(options.storageForCart ?? storage, CARTS_COLLECTION),
		inventoryDocs,
		async seedStock(sku, qty) {
			// The test-surface stock write: unlike `seedOnHand` it OVERWRITES the
			// count, and unlike a bare `put` it preserves live holds and the ring.
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
		async onHand(sku) {
			const doc = await inventoryDocs.get(sku);
			return doc?.onHand ?? 0;
		},
		advance(ms) {
			clock.advance(ms);
		},
	};
}
