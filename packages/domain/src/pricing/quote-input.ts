import type { Currency, Money } from "../money/cents.js";
import type { ProductKind, ProductTaxStatus } from "../ports/product-commerce-store.js";
import type { QuoteCommand } from "./quote.js";
import type { TotalsLineInput } from "./types.js";

/**
 * One line to be priced, as read off its product's commerce row: the row's
 * price, tax class and kind, at the buyer's quantity. The caller has already
 * decided the row is sellable and in the order's currency — those guards and
 * their order stay with each caller, because they are not the same everywhere
 * (an order also needs a title; a cart line also needs its hold).
 */
export interface PricedLine {
	price: Money;
	qty: number;
	taxClass: string | null;
	productKind: ProductKind;
	/** The row's tax status (PR 2b); absent ⇒ `taxable`. */
	taxStatus?: ProductTaxStatus;
}

export interface QuoteInput {
	currency: Currency;
	lines: readonly PricedLine[];
	/** Where the order ships; absent ⇒ none given (the zone is derived from it). */
	destination?: QuoteCommand["destination"];
	methodId?: string;
	couponCode?: string;
}

/**
 * The quote command for these lines (ADR-0028 Decision 1).
 *
 * ONE builder, so that the checkout review, the order `createOrderFromCart`
 * places, and the x402 gate's price are the same quote of the same lines: a
 * field the pricing pipeline gains (a tax profile, say) is added here once and
 * reaches all three, rather than to one of three copies. A line's tax base is
 * its price × qty at its tax class (`"standard"` when the row names none), and
 * the order ships iff any line is physical (ADR-0021 Decision 5).
 *
 * An absent optional is ABSENT, never a key holding `undefined`: the command is
 * the same object, key for key, that each caller built inline before.
 */
export function quoteCommandFor(input: QuoteInput): QuoteCommand {
	return {
		currency: input.currency,
		lines: input.lines.map(totalsLineOf),
		requiresShipping: input.lines.some((line) => line.productKind === "physical"),
		...(input.destination !== undefined ? { destination: input.destination } : {}),
		...(input.methodId !== undefined ? { methodId: input.methodId } : {}),
		...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
	};
}

function totalsLineOf(line: PricedLine): TotalsLineInput {
	return {
		unitPriceCents: line.price.amount,
		qty: line.qty,
		taxClassId: line.taxClass ?? "standard",
		requiresShipping: line.productKind === "physical",
		// Only a status that changes the tax is carried, so a taxable line's command
		// is key for key what it was before PR 2b.
		...(line.taxStatus !== undefined && line.taxStatus !== "taxable"
			? { taxStatus: line.taxStatus }
			: {}),
	};
}
