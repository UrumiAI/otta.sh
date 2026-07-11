import type { CustomerId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	AddressStore,
	CreateAddressInput,
	UpdateAddressInput,
} from "../ports/address-store.js";
import type { Address } from "../customers/model.js";

/**
 * IO-free `AddressStore` fake — the first adapter to pass `addressBookContract`.
 * Models the real adapter's **customer-scoped** signatures: every read/write is
 * filtered by `customerId`, so a foreign address id is a miss, never a
 * cross-customer leak (headline case 3).
 */
export class InMemoryAddressStore implements AddressStore {
	#idGen: IdGen;
	#clock: Clock;
	#byId = new Map<string, Address>();

	constructor(options: { idGen: IdGen; clock: Clock }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async list(customerId: CustomerId): Promise<Address[]> {
		return [...this.#byId.values()]
			.filter((a) => a.customerId === customerId)
			.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
			.map((a) => ({ ...a }));
	}

	async create(customerId: CustomerId, input: CreateAddressInput): Promise<Address> {
		const address: Address = {
			id: this.#idGen.newId(),
			customerId,
			kind: input.kind,
			name: input.name,
			line1: input.line1,
			line2: input.line2 ?? null,
			city: input.city,
			region: input.region ?? null,
			postalCode: input.postalCode,
			country: input.country,
			isDefault: input.isDefault ?? false,
			createdAt: this.#clock.now().toISOString(),
		};
		this.#byId.set(address.id, { ...address });
		return { ...address };
	}

	async update(
		customerId: CustomerId,
		addressId: string,
		patch: UpdateAddressInput,
	): Promise<Address | null> {
		const a = this.#byId.get(addressId);
		if (a === undefined || a.customerId !== customerId) return null; // scoped
		if (patch.kind !== undefined) a.kind = patch.kind;
		if (patch.name !== undefined) a.name = patch.name;
		if (patch.line1 !== undefined) a.line1 = patch.line1;
		if (patch.line2 !== undefined) a.line2 = patch.line2;
		if (patch.city !== undefined) a.city = patch.city;
		if (patch.region !== undefined) a.region = patch.region;
		if (patch.postalCode !== undefined) a.postalCode = patch.postalCode;
		if (patch.country !== undefined) a.country = patch.country;
		if (patch.isDefault !== undefined) a.isDefault = patch.isDefault;
		return { ...a };
	}

	async delete(customerId: CustomerId, addressId: string): Promise<boolean> {
		const a = this.#byId.get(addressId);
		if (a === undefined || a.customerId !== customerId) return false; // scoped
		this.#byId.delete(addressId);
		return true;
	}
}
