/**
 * A `ctx.storage` under load: every method of every collection throws the
 * store's "too busy" refusal, the way an exhausted compare-and-set budget (or a
 * retryable host serialization abort) reaches a route.
 *
 * Throwing on READS too is deliberate — a route's first storage touch is often a
 * read, and the point is to prove the route boundary maps the refusal wherever
 * in the handler it surfaces.
 */
import { StorageContentionError } from "@otta-sh/store-emdash";
import type { StorageAccess } from "../../src/types.js";

export function busyStorage(
	storage: StorageAccess,
	busy: () => unknown = () => new StorageContentionError("test:busy", 24),
): StorageAccess {
	return new Proxy(storage, {
		get(target, collection, receiver) {
			const real = Reflect.get(target, collection, receiver) as unknown;
			if (typeof real !== "object" || real === null) return real;
			return new Proxy(real, {
				get(inner, method, innerReceiver) {
					const value = Reflect.get(inner, method, innerReceiver) as unknown;
					if (typeof value !== "function") return value;
					return () => Promise.reject(busy());
				},
			});
		},
	});
}
