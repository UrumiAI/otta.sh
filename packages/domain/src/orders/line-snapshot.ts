import type { ProductId, ReservationId, Sku } from "../money/ids.js";
import type { CreateOrderLineInput } from "../ports/order-store.js";
import type { PricedLine } from "../pricing/quote-input.js";

/** A priced line plus what only an order line carries. */
export interface SnapshotLine extends PricedLine {
	productId: ProductId;
	/** The sku the buyer chose — the cart line's, not re-read from the row. */
	sku: Sku;
	/** The row's title cache, already checked non-null by the caller. */
	title: string;
	/** The line's hold, if it has one. Kept only on a physical line. */
	reservationId: ReservationId | null;
}

/**
 * The order line snapshot (§4; ADR-0028 Decision 5 step 6): the price, currency,
 * title and fulfilment kind frozen onto `order_items` at purchase, so a later
 * product edit never rewrites the order. This is the ONLY mapping from a product
 * row to an order line — every order goes through it, so they freeze the same
 * fields in the same shape.
 *
 * A physical line adopts its hold; a digital line carries none (§6), whatever
 * the caller passed.
 */
export function snapshotOrderLine(line: SnapshotLine): CreateOrderLineInput {
	const physical = line.productKind === "physical";
	return {
		productId: line.productId,
		sku: line.sku,
		title: line.title,
		unitPrice: line.price.amount,
		currency: line.price.currency,
		quantity: line.qty,
		fulfillmentKind: line.productKind,
		reservationId: physical ? line.reservationId : null,
	};
}
