import type { Cents, Currency } from "../money/cents.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";
import { resolveShippingRate } from "./shipping.js";
import type { ShippingMethodType } from "./types.js";

/** One delivery option of a zone, priced for this cart. `amountCents: null`
 *  ⇒ the method has no rate in the cart's currency (it cannot be chosen). */
export interface ShippingOption {
	methodId: string;
	name: string;
	type: ShippingMethodType;
	amountCents: Cents | null;
}

/**
 * The delivery options of the zone a quote matched (ADR-0021), each priced
 * through `resolveShippingRate` against the DISCOUNTED subtotal — the same
 * figure the quote's own shipping line uses, so an option's price is what
 * choosing it will charge. Ordered by name, then id.
 *
 * Reads: exactly one `listMethods` plus one `getRate` per method (D12). The
 * port has no batch rate read; a zone has a handful of methods.
 */
export async function quoteShippingOptions(
	deps: { shippingRules: ShippingRulesStore },
	input: { zoneId: string; currency: Currency; discountedSubtotal: Cents },
): Promise<ShippingOption[]> {
	const methods = await deps.shippingRules.listMethods(input.zoneId);
	const options: ShippingOption[] = [];
	for (const method of methods) {
		const rate = await deps.shippingRules.getRate(method.id, input.currency);
		options.push({
			methodId: method.id,
			name: method.name,
			type: method.type,
			amountCents:
				rate === null
					? null
					: resolveShippingRate(
							{
								zoneId: method.zoneId,
								methodId: method.id,
								type: method.type,
								amountCents: rate.amountCents,
								minSubtotalCents: rate.minSubtotalCents,
							},
							input.discountedSubtotal,
						),
		});
	}
	return options.toSorted((a, b) =>
		a.name === b.name ? (a.methodId < b.methodId ? -1 : 1) : a.name < b.name ? -1 : 1,
	);
}
