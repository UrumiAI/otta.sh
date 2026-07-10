/**
 * Request-scoped micro-batching loader (Phase 2 §4.3.2, DataLoader pattern).
 *
 * Lookups issued within one render pass — whether one-by-one (PDP, or a
 * hypothetical per-item invocation) or page-at-a-time (PLP `loadMany`) —
 * are collected across a microtask tick and flushed as ONE batched call, so
 * N+1 avoidance does not depend on the outer wiring's invocation
 * granularity. An id the batch omitted resolves to `null` (absence, never a
 * per-id error — §4.2) and the absence is remembered for the rest of the
 * pass.
 *
 * Lifecycle: ONE instance per incoming request/render (the route handlers
 * construct a fresh loader per invocation). There is deliberately NO
 * cross-request cache in v1 (plan §8 risk 3, pre-approved: intra-render
 * dedupe only) — and no cache here may ever feed Phase 3's reserve path
 * (§4.4): reservation always hits the live service.
 */
import type { CatalogProductCommerce } from "./commerce-view.js";

export type CommerceBatchFetch = (productIds: string[]) => Promise<CatalogProductCommerce[]>;

export interface CommerceBatchLoaderOptions {
	/** Per-call id cap (§4.3.3) — mirrors the service's request-size guard
	 *  (COMMERCE_BATCH_ID_CAP=100) so a pathological pass can never build an
	 *  unbounded request body; a page under the PLP cap (48) always fits in
	 *  one call. */
	maxBatchSize?: number;
}

export const DEFAULT_MAX_BATCH_SIZE = 100;

interface Waiter {
	resolve: (value: CatalogProductCommerce | null) => void;
	reject: (reason: unknown) => void;
}

export class CommerceBatchLoader {
	readonly #fetchBatch: CommerceBatchFetch;
	readonly #maxBatchSize: number;
	/** Per-id promise cache — in-flight AND settled lookups of this render. */
	#cache = new Map<string, Promise<CatalogProductCommerce | null>>();
	#pending = new Map<string, Waiter>();
	#flushScheduled = false;

	constructor(fetchBatch: CommerceBatchFetch, options: CommerceBatchLoaderOptions = {}) {
		this.#fetchBatch = fetchBatch;
		this.#maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
	}

	load(productId: string): Promise<CatalogProductCommerce | null> {
		const cached = this.#cache.get(productId);
		if (cached !== undefined) return cached;

		const promise = new Promise<CatalogProductCommerce | null>((resolve, reject) => {
			this.#pending.set(productId, { resolve, reject });
		});
		this.#cache.set(productId, promise);
		this.#scheduleFlush();
		return promise;
	}

	/** Page-shaped lookup: duplicates collapse; result maps EVERY requested id
	 *  (missing ⇒ null) so PLP rendering never branches on map misses. */
	async loadMany(productIds: string[]): Promise<Map<string, CatalogProductCommerce | null>> {
		const unique = [...new Set(productIds)];
		const views = await Promise.all(unique.map((id) => this.load(id)));
		return new Map(unique.map((id, i) => [id, views[i] ?? null]));
	}

	#scheduleFlush(): void {
		if (this.#flushScheduled) return;
		this.#flushScheduled = true;
		queueMicrotask(() => {
			this.#flushScheduled = false;
			void this.#flush();
		});
	}

	async #flush(): Promise<void> {
		const batch = [...this.#pending.entries()];
		this.#pending.clear();
		for (let i = 0; i < batch.length; i += this.#maxBatchSize) {
			const chunk = batch.slice(i, i + this.#maxBatchSize);
			try {
				const items = await this.#fetchBatch(chunk.map(([id]) => id));
				const byId = new Map(items.map((item) => [item.productId, item]));
				for (const [id, waiter] of chunk) {
					waiter.resolve(byId.get(id) ?? null);
				}
			} catch (err) {
				for (const [id, waiter] of chunk) {
					// A transport failure is not an answer: evict so a retry
					// within the same pass can refetch instead of replaying the
					// rejection from the cache.
					this.#cache.delete(id);
					waiter.reject(err);
				}
			}
		}
	}
}
