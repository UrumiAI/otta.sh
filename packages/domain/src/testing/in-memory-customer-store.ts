import { customerId as toCustomerId, type CustomerId, type Email } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	CreateCustomerInput,
	CustomerStore,
	UpdateCustomerInput,
} from "../ports/customer-store.js";
import type { Customer } from "../customers/model.js";
import { DuplicateCustomerEmailError } from "../customers/errors.js";

/**
 * IO-free `CustomerStore` fake — the first adapter to pass `customerStoreContract`.
 * Models the real adapter: unique `email` (throws on conflict), lower-normalized
 * lookup (the `Email` brand already normalized), and a nullable
 * `emailVerifiedAt`.
 */
export class InMemoryCustomerStore implements CustomerStore {
	#idGen: IdGen;
	#clock: Clock;
	#byId = new Map<string, Customer>();

	constructor(options: { idGen: IdGen; clock: Clock }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async create(input: CreateCustomerInput): Promise<Customer> {
		for (const existing of this.#byId.values()) {
			if (existing.email === input.email) throw new DuplicateCustomerEmailError(input.email);
		}
		const customer: Customer = {
			id: toCustomerId(this.#idGen.newId()),
			email: input.email,
			displayName: input.displayName ?? null,
			emailVerifiedAt: null,
			createdAt: this.#clock.now().toISOString(),
		};
		this.#byId.set(customer.id, { ...customer });
		return { ...customer };
	}

	async get(id: CustomerId): Promise<Customer | null> {
		const c = this.#byId.get(id);
		return c === undefined ? null : { ...c };
	}

	async getByEmail(emailAddr: Email): Promise<Customer | null> {
		for (const c of this.#byId.values()) {
			if (c.email === emailAddr) return { ...c };
		}
		return null;
	}

	async update(id: CustomerId, patch: UpdateCustomerInput): Promise<Customer | null> {
		const c = this.#byId.get(id);
		if (c === undefined) return null;
		if (patch.displayName !== undefined) c.displayName = patch.displayName;
		if (patch.emailVerifiedAt !== undefined) c.emailVerifiedAt = patch.emailVerifiedAt;
		return { ...c };
	}
}
