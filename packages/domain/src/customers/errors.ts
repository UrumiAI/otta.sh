/**
 * Typed customer/auth failures (never status-code-as-logic, §7). The service
 * maps these to HTTP; the domain speaks only in these unions/errors.
 */

/** `CustomerStore.create` uniqueness violation — the `customers.email` UNIQUE
 *  constraint tripped (a concurrent create raced this one). The login use-case
 *  resolves it by re-reading with `getByEmail`. */
export class DuplicateCustomerEmailError extends Error {
	constructor(email: string) {
		super(`a customer already exists for email ${email}`);
		this.name = "DuplicateCustomerEmailError";
	}
}

/** `verifyLogin` outcomes (the magic-link redeem path). */
export type LoginFailure = "EXPIRED" | "INVALID" | "CONSUMED";
