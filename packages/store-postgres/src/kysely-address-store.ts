import type {
	Address,
	AddressKind,
	AddressStore,
	Clock,
	CreateAddressInput,
	CustomerId,
	IdGen,
	UpdateAddressInput,
} from "@otta-sh/domain";
import type { Kysely, Selectable } from "kysely";
import type { AddressesTable, Database } from "./schema.js";

export interface KyselyAddressStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `AddressStore` over Kysely (§4/§7), dialect-agnostic. **Customer-scoped**:
 * every read/write filters by `customer_id`, so `update`/`delete` on a foreign
 * address id are a miss (null / false), never a cross-customer leak (headline
 * case 3). `is_default` is portable 0/1 (better-sqlite3 can't bind a JS boolean).
 */
export class KyselyAddressStore implements AddressStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyAddressStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async list(customerId: CustomerId): Promise<Address[]> {
		const rows = await this.#db
			.selectFrom("addresses")
			.selectAll()
			.where("customer_id", "=", customerId)
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		return rows.map(toAddress);
	}

	async create(customerId: CustomerId, input: CreateAddressInput): Promise<Address> {
		const id = this.#idGen.newId();
		const now = this.#clock.now().toISOString();
		await this.#db
			.insertInto("addresses")
			.values({
				id,
				customer_id: customerId,
				kind: input.kind,
				name: input.name,
				line1: input.line1,
				line2: input.line2 ?? null,
				city: input.city,
				region: input.region ?? null,
				postal_code: input.postalCode,
				country: input.country,
				is_default: input.isDefault === true ? 1 : 0,
				created_at: now,
			})
			.execute();
		const created = await this.#getScoped(customerId, id);
		if (created === null) throw new Error("address vanished immediately after create");
		return created;
	}

	async update(
		customerId: CustomerId,
		addressId: string,
		patch: UpdateAddressInput,
	): Promise<Address | null> {
		const set: Partial<AddressesTable> = {};
		if (patch.kind !== undefined) set.kind = patch.kind;
		if (patch.name !== undefined) set.name = patch.name;
		if (patch.line1 !== undefined) set.line1 = patch.line1;
		if (patch.line2 !== undefined) set.line2 = patch.line2;
		if (patch.city !== undefined) set.city = patch.city;
		if (patch.region !== undefined) set.region = patch.region;
		if (patch.postalCode !== undefined) set.postal_code = patch.postalCode;
		if (patch.country !== undefined) set.country = patch.country;
		if (patch.isDefault !== undefined) set.is_default = patch.isDefault ? 1 : 0;
		if (Object.keys(set).length > 0) {
			const updated = await this.#db
				.updateTable("addresses")
				.set(set)
				.where("id", "=", addressId)
				.where("customer_id", "=", customerId) // scoped
				.returning("id")
				.executeTakeFirst();
			if (updated === undefined) return null;
		}
		return this.#getScoped(customerId, addressId);
	}

	async delete(customerId: CustomerId, addressId: string): Promise<boolean> {
		const deleted = await this.#db
			.deleteFrom("addresses")
			.where("id", "=", addressId)
			.where("customer_id", "=", customerId) // scoped
			.returning("id")
			.executeTakeFirst();
		return deleted !== undefined;
	}

	async #getScoped(customerId: CustomerId, addressId: string): Promise<Address | null> {
		const row = await this.#db
			.selectFrom("addresses")
			.selectAll()
			.where("id", "=", addressId)
			.where("customer_id", "=", customerId)
			.executeTakeFirst();
		return row === undefined ? null : toAddress(row);
	}
}

function toAddress(row: Selectable<AddressesTable>): Address {
	return {
		id: row.id,
		customerId: row.customer_id as CustomerId,
		kind: row.kind as AddressKind,
		name: row.name,
		line1: row.line1,
		line2: row.line2,
		city: row.city,
		region: row.region,
		postalCode: row.postal_code,
		country: row.country,
		isDefault: row.is_default === 1,
		createdAt: row.created_at,
	};
}
