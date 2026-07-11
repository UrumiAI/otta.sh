import type { CustomerId, Email } from "../money/ids.js";
import type { Customer } from "../customers/model.js";

export interface CreateCustomerInput {
	email: Email;
	displayName?: string | null;
}

export interface UpdateCustomerInput {
	displayName?: string | null;
	emailVerifiedAt?: string | null;
}

/**
 * The `CustomerStore` port (Phase 5 §7). Zero dependency on EmDash `ctx.users`
 * (headline case 2). `email` is unique + lower-normalized (the `Email` brand
 * normalizes), so `getByEmail` is case-insensitive and account-merge is
 * deterministic.
 */
export interface CustomerStore {
	/** Insert a customer; throws `DuplicateCustomerEmailError` on the email
	 *  UNIQUE conflict (the login use-case re-reads with `getByEmail`). */
	create(input: CreateCustomerInput): Promise<Customer>;
	get(id: CustomerId): Promise<Customer | null>;
	getByEmail(email: Email): Promise<Customer | null>;
	/** Patch mutable fields; returns the updated customer, or null if unknown. */
	update(id: CustomerId, patch: UpdateCustomerInput): Promise<Customer | null>;
}
