import { cents } from "../money/cents.js";
import {
	isValidTaxLabel,
	TAX_RATE_BPS_MAX,
	type TaxLine,
	type TaxRequest,
	type TaxResult,
} from "./tax-calculator.js";

/**
 * Check a calculator's answer against the request it answers (ADR-0030). An
 * outside calculator is trusted CODE, but its answer is still checked before it
 * can price an order: anything but an exact answer to THIS request is refused
 * (`null` ⇒ `TAX_UNAVAILABLE`). Only whitelisted fields are copied out, in the
 * request's line order, so no provider data reaches an order.
 *
 * Refused: not `ok: true`; another currency; lines that are not exactly the
 * request's (missing, extra, duplicated, unknown — matched through a `Map`, so
 * `__proto__` is just an unknown id); an amount that is not a safe non-negative
 * integer; a tax above what the 1000% rate cap allows on its amount (the rate's
 * own bound — a units mix-up must not overcharge): `amount × 10` for an amount
 * entered without tax, and for a line entered WITH tax (`pricesIncludeTax`, the
 * amount is the gross) the tax inside the gross at that rate,
 * `ceil(G × 100000 / 110000)`, which is below G, so the net can never go
 * negative — shipping is always entered without tax and keeps `amount × 10`
 * (exact integers throughout); a rate that is not an integer in
 * [0, 1000%]; a bad label; a NON-ZERO tax on a line whose product is not
 * taxable (`shipping_only` or `none`, PR 2b — never silently zeroed); a NON-ZERO
 * shipping line when no shipping was asked about (a zero one is dropped — this
 * also covers a method that is not taxable, sent as no shipping); a total that is
 * not a safe integer. The untaxed-line rule holds for the built-in too.
 *
 * `boundTaxToAmount: false` is for the built-in only, which must charge exactly
 * what main charged for any stored rate (its display rate is capped instead).
 */
export function validateTaxResult(
	request: TaxRequest,
	raw: unknown,
	{ boundTaxToAmount = true }: { boundTaxToAmount?: boolean } = {},
): TaxResult | null {
	const exceedsBound = (taxCents: number, amount: number, inclusive: boolean): boolean =>
		boundTaxToAmount && BigInt(taxCents) > maxTaxOn(amount, inclusive);
	if (!isRecord(raw) || raw["ok"] !== true || raw["currency"] !== request.currency) return null;
	const rawLines = raw["lines"];
	if (!Array.isArray(rawLines) || rawLines.length !== request.lines.length) return null;

	const byId = new Map<string, TaxLine>();
	for (const item of rawLines as unknown[]) {
		if (!isRecord(item)) return null;
		const lineId = item["lineId"];
		if (typeof lineId !== "string" || byId.has(lineId)) return null;
		const line = taxLineOf(item);
		if (line === null) return null;
		byId.set(lineId, line);
	}

	let total = 0;
	const lines: Array<{ lineId: string } & TaxLine> = [];
	for (const { lineId, amountCents, taxStatus } of request.lines) {
		const line = byId.get(lineId);
		if (line === undefined || exceedsBound(line.taxCents, amountCents, request.pricesIncludeTax)) {
			return null;
		}
		// A product that is not taxable carries no tax (PR 2b).
		if (taxStatus !== "taxable" && line.taxCents !== 0) return null;
		total += line.taxCents;
		lines.push({ lineId, ...line });
	}

	const rawShipping = raw["shipping"];
	let shipping: TaxLine | null = null;
	if (rawShipping !== null && rawShipping !== undefined) {
		if (!isRecord(rawShipping)) return null;
		const line = taxLineOf(rawShipping);
		if (line === null) return null;
		if (request.shipping === null) {
			// No shipping was asked about: a zero line says nothing and is dropped.
			if (line.taxCents !== 0) return null;
		} else {
			// Shipping is always entered without tax (ADR-0031).
			if (exceedsBound(line.taxCents, request.shipping.amountCents, false)) return null;
			shipping = line;
			total += line.taxCents;
		}
	}
	if (!Number.isSafeInteger(total)) return null;

	return { ok: true, currency: request.currency, lines, shipping };
}

/**
 * The most tax the 1000% rate cap allows on `amount`, exactly: without tax,
 * `ceil(amount × MAX / 10000)`; with tax (the amount is the gross),
 * `ceil(amount × MAX / (10000 + MAX))`. In `bigint`, so no product is rounded.
 */
function maxTaxOn(amount: number, inclusive: boolean): bigint {
	const num = BigInt(amount) * BigInt(TAX_RATE_BPS_MAX);
	const den = 10_000n + (inclusive ? BigInt(TAX_RATE_BPS_MAX) : 0n);
	return (num + den - 1n) / den;
}

function taxLineOf(item: Record<string, unknown>): TaxLine | null {
	const { rateBps, label, taxCents } = item;
	if (typeof rateBps !== "number" || !Number.isInteger(rateBps)) return null;
	if (rateBps < 0 || rateBps > TAX_RATE_BPS_MAX) return null;
	if (!isValidTaxLabel(label)) return null;
	if (typeof taxCents !== "number" || !Number.isSafeInteger(taxCents) || taxCents < 0) return null;
	return { rateBps, label, taxCents: cents(taxCents) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
