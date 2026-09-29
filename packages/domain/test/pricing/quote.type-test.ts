/**
 * ADR-0021 Decision 1, pinned in the type system: nobody can hand the quote or
 * the order a zone. Checked by `pnpm typecheck` (this package's tsconfig
 * includes `test`, and the root `tsc -b` references it), never executed.
 */
import type { CreateOrderCommand } from "../../src/orders/create-order-from-cart.js";
import type { QuoteCommand } from "../../src/pricing/quote.js";
import { cents, currency } from "../../src/money/cents.js";
import { idempotencyKey } from "../../src/money/ids.js";

export const quoteWithZone: QuoteCommand = {
	currency: currency("USD"),
	lines: [{ unitPriceCents: cents(1), qty: 1, taxClassId: "standard" }],
	requiresShipping: true,
	// @ts-expect-error — the zone is derived from `destination`, never supplied.
	zoneId: "z-zero-tax",
};

export const orderWithZone: CreateOrderCommand = {
	cartId: "c",
	idempotencyKey: idempotencyKey("k"),
	buyerRef: "b@example.com",
	paymentMethod: "stripe",
	// @ts-expect-error — the zone is derived from `shippingAddress`, never supplied.
	shippingZoneId: "z-zero-tax",
};

// @ts-expect-error — `requiresShipping` is required: the quote must know whether anything ships.
export const quoteWithoutRequiresShipping: QuoteCommand = {
	currency: currency("USD"),
	lines: [],
};
