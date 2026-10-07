/**
 * The tax calculator hook (ADR-0030). Otta ships NO tax law: the built-in
 * calculator applies the merchant's own rate table (`otta.rate-table`), and a
 * site may register an outside one (Avalara, Stripe Tax, a custom service) the
 * way WooCommerce's `woocommerce_find_rates` / `woocommerce_calc_tax` filters
 * allow. `computeQuote` is the ONE place either is called.
 *
 * Money is integer minor units throughout. `rateBps` is for DISPLAY only — a
 * calculator may round a rate like 8.875% to whole basis points; the amounts it
 * returns are authoritative and are never recomputed from the rate.
 */
import type { Cents, Currency } from "../money/cents.js";
import type { ProductTaxStatus } from "../ports/product-commerce-store.js";
import type { TaxClassId } from "./types.js";

/** How long an outside calculator may take before the checkout is refused. */
export const DEFAULT_TAX_CALCULATOR_TIMEOUT_MS = 5_000;
/** Upper bound of a display rate: 1000%. */
export const TAX_RATE_BPS_MAX = 100_000;
/** A label's length bound — the admin's own class-name bound. */
export const TAX_LABEL_MAX = 200;

export interface TaxAddress {
	/** ISO 3166-1 alpha-2, uppercased. */
	country: string;
	/** The ISO 3166-2 subdivision suffix (`CA` of `US-CA`), or null. */
	region: string | null;
	postalCode: string | null;
	city: string | null;
}

export interface TaxRequestLine {
	/** Opaque, unique within the request; the answer refers to lines by it. */
	lineId: string;
	quantity: number;
	unitPriceCents: Cents;
	/** The line's DISCOUNTED amount — the tax base. */
	amountCents: Cents;
	taxClassId: TaxClassId;
	/**
	 * WooCommerce's product tax status (PR 2b). Only a `taxable` line may carry
	 * tax: a non-zero tax on any other line is refused (`TAX_UNAVAILABLE`).
	 * `shipping_only` still counts toward a "based on cart items" shipping class.
	 */
	taxStatus: ProductTaxStatus;
	/** Whether this line is shipped (a physical good) — WooCommerce's `needs_shipping`. */
	requiresShipping: boolean;
}

export interface TaxRequest {
	/** "quote" for a review; "order" when an order is about to be placed. */
	purpose: "quote" | "order";
	currency: Currency;
	/**
	 * Whether entered prices include tax (ADR-0031): each line's `amountCents` is
	 * then a GROSS amount and its tax is the part already inside it. Shipping is
	 * always entered without tax, whatever this says.
	 */
	pricesIncludeTax: boolean;
	lines: readonly TaxRequestLine[];
	/** The chosen shipping charge; null when no method is chosen or none applies,
	 *  and also when the chosen method is not taxable (PR 2b). */
	shipping: { amountCents: Cents; methodId: string } | null;
	/** The shop's base address from the tax settings, or null when none is set. */
	origin: TaxAddress | null;
	/**
	 * The TAX location: the ship-to, or the shop's base address when the settings
	 * say "based on shop base address" or the cart is digital-only (ADR-0031);
	 * null when there is none.
	 */
	destination: TaxAddress | null;
	/** The zone the tax location matched, informational for outside calculators. */
	zoneId: string | null;
}

export interface TaxLine {
	/** Integer basis points, 0–{@link TAX_RATE_BPS_MAX}; display only. */
	rateBps: number;
	/** What the buyer sees, e.g. the tax class name. */
	label: string;
	taxCents: Cents;
}

export interface TaxResult {
	ok: true;
	currency: Currency;
	lines: ReadonlyArray<{ lineId: string } & TaxLine>;
	/** Tax on the shipping charge; null ⇒ shipping is untaxed. */
	shipping: TaxLine | null;
}

export interface TaxRefusal {
	ok: false;
	reason: "unavailable";
	detail?: string;
}

export interface TaxCalculator {
	/** Stable id, recorded on every order it prices (e.g. `acme.tax`). */
	readonly id: string;
	calculate(request: TaxRequest): Promise<TaxResult | TaxRefusal>;
}

const CALCULATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** C0, DEL and C1 controls — a label is rendered on pages, emails and invoices. */
function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** 1–64 chars of `[A-Za-z0-9._-]`, starting alphanumeric. */
export function isValidCalculatorId(id: unknown): id is string {
	return typeof id === "string" && CALCULATOR_ID.test(id);
}

/** 1–{@link TAX_LABEL_MAX} chars with no control characters. */
export function isValidTaxLabel(label: unknown): label is string {
	return (
		typeof label === "string" &&
		label.length >= 1 &&
		label.length <= TAX_LABEL_MAX &&
		!hasControlChar(label)
	);
}
