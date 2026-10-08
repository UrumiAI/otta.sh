/**
 * The start of the reconciliation flag `refundOrder` writes when the provider's
 * pre-flight reports the payment ALREADY refunded (refunded outside Otta, e.g. in
 * the Stripe dashboard). It is the evidence that lets Mark refunded close such an
 * order (QA2 M4, ADR-0026 amended 2026-10-03). Its own module so `refund-order.ts`
 * and `transition.ts`, which already imports from it, share it without a cycle.
 */
import { currencyDigits } from "../money/currencies.js";

export const PROVIDER_REFUNDED_FLAG_PREFIX = "Provider shows this payment fully refunded";

/** The start of the flag for a PARTIAL provider refund: informational only — it
 *  never unlocks Mark refunded, because money is still held. */
export const PROVIDER_PARTLY_REFUNDED_FLAG_PREFIX = "Not refunded in full";

/** The currency's minor-unit digits: the currency table's (`money/currencies.ts`
 *  — JPY 0, USD 2, BHD 3), the same exponent the admin parses and displays
 *  with; for a code outside the table (an order stored before it), ICU's own
 *  table as before, and 2 when ICU cannot say. */
function minorUnitDigits(currency: string): number {
	const listed = currencyDigits(currency);
	if (listed !== undefined) return listed;
	try {
		return (
			new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
				.maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
}

/** Integer minor units as a plain decimal with the currency code ("3.50 USD",
 *  "1500 JPY", "1.234 BHD"), for an operator-facing flag. Integer string math,
 *  in the currency's real minor-unit exponent (review round 2). */
export function flagAmount(minor: number, currency: string): string {
	const digits = minorUnitDigits(currency);
	const sign = minor < 0 ? "-" : "";
	const abs = String(Math.abs(minor));
	if (digits === 0) return `${sign}${abs} ${currency}`;
	const padded = abs.padStart(digits + 1, "0");
	return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)} ${currency}`;
}

/**
 * The reconciliation flag a provider's "already refunded" pre-flight answer
 * leaves on the order, or `null` when it leaves none:
 *  - refunded IN FULL at the provider ⇒ the unlocking flag, which also tells the
 *    operator to mark the order refunded BEFORE resolving it (resolving removes it);
 *  - refunded IN PART ⇒ an informational flag naming both amounts;
 *  - no figures ⇒ nothing: unknown is not refunded.
 */
export function providerRefundedFlag(
	provider: { refunded: number; captured: number } | undefined,
	currency: string,
): string | null {
	if (provider === undefined || provider.captured <= 0) return null;
	if (provider.refunded >= provider.captured) {
		return `${PROVIDER_REFUNDED_FLAG_PREFIX} (${flagAmount(provider.refunded, currency)} of ${flagAmount(provider.captured, currency)}) — Otta issued nothing. If it was refunded outside Otta, use Mark refunded BEFORE resolving this flag: resolving it first removes that option.`;
	}
	return `${PROVIDER_PARTLY_REFUNDED_FLAG_PREFIX} — partially refunded at the provider: ${flagAmount(provider.refunded, currency)} of ${flagAmount(provider.captured, currency)}. Otta issued nothing, and money is still held: refund the rest in your provider's dashboard (or adjust the amount in Money → Refunds), then try again.`;
}

/** Is `flag` one this module wrote — a newer provider answer may replace it. */
export function isProviderRefundFlag(flag: string): boolean {
	return (
		flag.startsWith(PROVIDER_REFUNDED_FLAG_PREFIX) ||
		flag.startsWith(PROVIDER_PARTLY_REFUNDED_FLAG_PREFIX)
	);
}
