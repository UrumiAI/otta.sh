/**
 * Storefront customer identity (Phase 5 §4) — a **separate identity** from
 * EmDash's `ctx.users` (headline case 2): the commerce service owns these
 * records, and a fresh EmDash install with no `ctx.users` at all can still
 * authenticate a storefront customer.
 */

import type { CustomerId, Email } from "../money/ids.js";

export interface Customer {
	id: CustomerId;
	/** Unique, lower-normalized (`Email` brand) — the account-merge key (§9). */
	email: Email;
	displayName: string | null;
	/** Set the first time a magic-link login proves inbox ownership. */
	emailVerifiedAt: string | null;
	createdAt: string;
}

export type AddressKind = "billing" | "shipping";

export interface Address {
	id: string;
	customerId: CustomerId;
	kind: AddressKind;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	isDefault: boolean;
	createdAt: string;
}
