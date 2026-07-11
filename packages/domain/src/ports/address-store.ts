import type { CustomerId } from "../money/ids.js";
import type { Address, AddressKind } from "../customers/model.js";

export interface CreateAddressInput {
	kind: AddressKind;
	name: string;
	line1: string;
	line2?: string | null;
	city: string;
	region?: string | null;
	postalCode: string;
	country: string;
	isDefault?: boolean;
}

export interface UpdateAddressInput {
	kind?: AddressKind;
	name?: string;
	line1?: string;
	line2?: string | null;
	city?: string;
	region?: string | null;
	postalCode?: string;
	country?: string;
	isDefault?: boolean;
}

/**
 * The `AddressStore` port (Phase 5 §7). **Every method takes the owning
 * `customerId`** — there is deliberately no "get by address id alone" — so a
 * Postgres adapter bug cannot cross-tenant leak, and the service re-derives the
 * same id from the session (§4). `update`/`delete` scope by `(id, customerId)`,
 * so a foreign address id is a miss (null / false), never another customer's row.
 */
export interface AddressStore {
	list(customerId: CustomerId): Promise<Address[]>;
	create(customerId: CustomerId, input: CreateAddressInput): Promise<Address>;
	update(
		customerId: CustomerId,
		addressId: string,
		patch: UpdateAddressInput,
	): Promise<Address | null>;
	delete(customerId: CustomerId, addressId: string): Promise<boolean>;
}
