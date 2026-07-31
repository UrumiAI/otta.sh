import {
	customerId as toCustomerId,
	DuplicateCustomerEmailError,
	type Clock,
	type CreateCustomerInput,
	type Customer,
	type CustomerId,
	type CustomerStore,
	type Email,
	type IdGen,
	type UpdateCustomerInput,
} from "@otta-sh/domain";
import type { Kysely, Selectable } from "kysely";
import type { CustomersTable, Database } from "./schema.js";

export interface KyselyCustomerStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `CustomerStore` over Kysely (§4/§7), dialect-agnostic across better-sqlite3
 * and pg. `email` is UNIQUE + lower-normalized (the domain `Email` brand), so
 * `create` on a duplicate throws `DuplicateCustomerEmailError` (via
 * `ON CONFLICT DO NOTHING` returning 0 rows) and `getByEmail` is
 * case-insensitive. Zero dependency on EmDash `ctx.users` (headline case 2).
 */
export class KyselyCustomerStore implements CustomerStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyCustomerStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async create(input: CreateCustomerInput): Promise<Customer> {
		const id = this.#idGen.newId();
		const now = this.#clock.now().toISOString();
		const inserted = await this.#db
			.insertInto("customers")
			.values({
				id,
				email: input.email,
				display_name: input.displayName ?? null,
				email_verified_at: null,
				created_at: now,
			})
			.onConflict((oc) => oc.column("email").doNothing())
			.returning("id")
			.executeTakeFirst();
		if (inserted === undefined) throw new DuplicateCustomerEmailError(input.email);
		const created = await this.get(toCustomerId(id));
		if (created === null) throw new Error("customer vanished immediately after create");
		return created;
	}

	async get(id: CustomerId): Promise<Customer | null> {
		const row = await this.#db
			.selectFrom("customers")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row === undefined ? null : toCustomer(row);
	}

	async getByEmail(email: Email): Promise<Customer | null> {
		const row = await this.#db
			.selectFrom("customers")
			.selectAll()
			.where("email", "=", email)
			.executeTakeFirst();
		return row === undefined ? null : toCustomer(row);
	}

	async update(id: CustomerId, patch: UpdateCustomerInput): Promise<Customer | null> {
		const set: Partial<CustomersTable> = {};
		if (patch.displayName !== undefined) set.display_name = patch.displayName;
		if (patch.emailVerifiedAt !== undefined) set.email_verified_at = patch.emailVerifiedAt;
		if (Object.keys(set).length > 0) {
			const updated = await this.#db
				.updateTable("customers")
				.set(set)
				.where("id", "=", id)
				.returning("id")
				.executeTakeFirst();
			if (updated === undefined) return null;
		}
		return this.get(id);
	}
}

function toCustomer(row: Selectable<CustomersTable>): Customer {
	return {
		id: toCustomerId(row.id),
		email: row.email as Email,
		displayName: row.display_name,
		emailVerifiedAt: row.email_verified_at,
		createdAt: row.created_at,
	};
}
