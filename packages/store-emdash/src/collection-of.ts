import type { StorageAccess, StorageCollection } from "./storage-access.js";

/**
 * The ONE audited narrowing in this package.
 *
 * `StorageAccess` is keyed by collection name and says nothing about which
 * document type lives under which key — it cannot: the host builds `ctx.storage`
 * from the descriptor's declared collections, and the descriptor carries index
 * names, not TypeScript types. So somewhere a `StorageCollection<unknown>` has to
 * become a `StorageCollection<Order>`, and the only question is whether that
 * happens once, in a function with a name, or silently at every call site with a
 * cast an adapter author can get wrong per collection.
 *
 * It happens here. An adapter asks for the collection it owns, states the
 * document type once, and gets a missing-collection failure as an error naming
 * the collection rather than as `undefined.get is not a function` several frames
 * later — a real outcome, because `ctx.storage` only holds what the descriptor
 * declared, and the descriptor is edited in a different file from the adapter.
 */
export function collectionOf<T>(storage: StorageAccess, name: string): StorageCollection<T> {
	const collection = storage[name];
	if (collection === undefined) {
		throw new Error(
			`storage collection '${name}' is not declared — add it to the plugin descriptor's storage config`,
		);
	}
	// Safe by the argument above: the runtime object is the host's collection for
	// `name`, and `T` is the caller's statement of what it stores there.
	return collection as StorageCollection<T>;
}
