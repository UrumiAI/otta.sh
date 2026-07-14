import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	Entitlement,
	EntitlementQuery,
	EntitlementStore,
	GrantEntitlementInput,
} from "../ports/entitlement-store.js";

/**
 * IO-free `EntitlementStore` fake — passes `entitlementStoreContract`. Grant is
 * idempotent under `grantIdempotencyKey` UNIQUE; check authorizes delivery.
 */
export class InMemoryEntitlementStore implements EntitlementStore {
	#idGen: IdGen;
	#clock: Clock;
	#byGrantKey = new Map<string, Entitlement>();

	constructor(options: { idGen: IdGen; clock: Clock }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async grant(input: GrantEntitlementInput): Promise<Entitlement> {
		const existing = this.#byGrantKey.get(input.grantIdempotencyKey);
		if (existing !== undefined) return { ...existing }; // grant-once

		const entitlement: Entitlement = {
			id: this.#idGen.newId(),
			orderId: input.orderId,
			productId: input.productId,
			sku: input.sku,
			buyerRef: input.buyerRef,
			state: "active",
			source: input.source,
			grantedAt: this.#clock.now().toISOString(),
		};
		this.#byGrantKey.set(input.grantIdempotencyKey, entitlement);
		return { ...entitlement };
	}

	async check(query: EntitlementQuery): Promise<boolean> {
		for (const e of this.#byGrantKey.values()) {
			if (e.state !== "active" || e.sku !== query.sku) continue;
			if (query.orderId !== undefined && e.orderId !== query.orderId) continue;
			// buyer_ref carries email semantics — fold case so the session scope's
			// lower-normalized Email matches a mixed-case checkout ref (mirrors
			// OrderStore.linkGuestOrders; the Kysely adapter folds with lower()).
			if (
				query.buyerRef !== undefined &&
				e.buyerRef.toLowerCase() !== query.buyerRef.toLowerCase()
			) {
				continue;
			}
			if (query.orderId === undefined && query.buyerRef === undefined) continue;
			return true;
		}
		return false;
	}

	// -- test surface ---------------------------------------------------------

	/** Revoke every entitlement for an order (contract revoke case). */
	revokeByOrder(orderId: string): void {
		for (const e of this.#byGrantKey.values()) {
			if (e.orderId === orderId) e.state = "revoked";
		}
	}

	all(): Entitlement[] {
		return [...this.#byGrantKey.values()].map((e) => ({ ...e }));
	}
}
