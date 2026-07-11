/**
 * Branded identifier types (Phase 0 step 0.2a).
 *
 * Each id gets its own unique-symbol brand so ids are not assignable to one
 * another (a ReservationId is not an IdempotencyKey), and a plain string is
 * assignable to none of them.
 */

declare const SkuBrand: unique symbol;
export type Sku = string & { readonly [SkuBrand]: true };

declare const ProductIdBrand: unique symbol;
export type ProductId = string & { readonly [ProductIdBrand]: true };

declare const IdempotencyKeyBrand: unique symbol;
export type IdempotencyKey = string & { readonly [IdempotencyKeyBrand]: true };

declare const ReservationIdBrand: unique symbol;
export type ReservationId = string & { readonly [ReservationIdBrand]: true };

declare const OrderIdBrand: unique symbol;
export type OrderId = string & { readonly [OrderIdBrand]: true };

declare const CustomerIdBrand: unique symbol;
export type CustomerId = string & { readonly [CustomerIdBrand]: true };

declare const EmailBrand: unique symbol;
/** A normalized (trimmed + lower-cased) email address, branded (Phase 5 §4). */
export type Email = string & { readonly [EmailBrand]: true };

function requireNonEmpty(value: string, label: string): string {
	if (value.length === 0) {
		throw new RangeError(`${label} must be a non-empty string`);
	}
	return value;
}

export function sku(value: string): Sku {
	return requireNonEmpty(value, "sku") as Sku;
}

export function productId(value: string): ProductId {
	return requireNonEmpty(value, "productId") as ProductId;
}

export function idempotencyKey(value: string): IdempotencyKey {
	return requireNonEmpty(value, "idempotencyKey") as IdempotencyKey;
}

export function reservationId(value: string): ReservationId {
	return requireNonEmpty(value, "reservationId") as ReservationId;
}

export function orderId(value: string): OrderId {
	return requireNonEmpty(value, "orderId") as OrderId;
}

export function customerId(value: string): CustomerId {
	return requireNonEmpty(value, "customerId") as CustomerId;
}

/**
 * Normalize + validate an email (Phase 5 §4): lower-cased and trimmed so
 * `getByEmail` and the `customers.email` UNIQUE constraint are
 * case-insensitive, and account-merge by email is deterministic. Minimal
 * shape check (a single `@` with non-empty local/domain parts) — full RFC
 * validation is deliberately out of scope.
 */
export function email(value: string): Email {
	const normalized = value.trim().toLowerCase();
	const at = normalized.indexOf("@");
	if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) {
		throw new RangeError(`email() requires a valid address, got "${value}"`);
	}
	return normalized as Email;
}
