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
