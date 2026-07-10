import {
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type Clock,
	type Entitlement,
	type EntitlementQuery,
	type EntitlementSource,
	type EntitlementState,
	type EntitlementStore,
	type GrantEntitlementInput,
	type IdGen,
} from "@urumi/domain";
import type { Kysely } from "kysely";
import type { Database, EntitlementsTable } from "./schema.js";

export interface KyselyEntitlementStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `EntitlementStore` over Kysely (§6), dialect-agnostic. Grant is
 * `INSERT … ON CONFLICT (grant_idempotency_key) DO NOTHING` — grant-once under
 * webhook/proof replay; check authorizes delivery (no active row ⇒ not served).
 */
export class KyselyEntitlementStore implements EntitlementStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyEntitlementStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async grant(input: GrantEntitlementInput): Promise<Entitlement> {
		const now = this.#clock.now().toISOString();
		await this.#db
			.insertInto("entitlements")
			.values({
				id: this.#idGen.newId(),
				order_id: input.orderId,
				product_id: input.productId,
				sku: input.sku,
				buyer_ref: input.buyerRef,
				state: "active",
				source: input.source,
				granted_at: now,
				grant_idempotency_key: input.grantIdempotencyKey,
			})
			.onConflict((oc) => oc.column("grant_idempotency_key").doNothing())
			.execute();

		const row = await this.#db
			.selectFrom("entitlements")
			.selectAll()
			.where("grant_idempotency_key", "=", input.grantIdempotencyKey)
			.executeTakeFirstOrThrow();
		return toDomain(row);
	}

	async check(query: EntitlementQuery): Promise<boolean> {
		let q = this.#db
			.selectFrom("entitlements")
			.select("id")
			.where("state", "=", "active")
			.where("sku", "=", query.sku);
		if (query.orderId !== undefined) q = q.where("order_id", "=", query.orderId);
		if (query.buyerRef !== undefined) q = q.where("buyer_ref", "=", query.buyerRef);
		// A query with neither scope matches nothing (delivery must be scoped).
		if (query.orderId === undefined && query.buyerRef === undefined) return false;
		const row = await q.executeTakeFirst();
		return row !== undefined;
	}
}

function toDomain(row: EntitlementsTable): Entitlement {
	return {
		id: row.id,
		orderId: toOrderId(row.order_id),
		productId: row.product_id === null ? null : toProductId(row.product_id),
		sku: toSku(row.sku),
		buyerRef: row.buyer_ref,
		state: row.state as EntitlementState,
		source: row.source as EntitlementSource,
		grantedAt: row.granted_at,
	};
}
