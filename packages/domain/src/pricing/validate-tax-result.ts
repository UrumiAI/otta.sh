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
 * integer; a tax above its taxable amount × 1000% (the rate's own bound — a
 * units mix-up must not overcharge); a rate that is not an integer in
 * [0, 1000%]; a bad label; a NON-ZERO shipping line when no shipping was asked
 * about (a zero one is dropped); a total that is not a safe integer.
 *
 * `boundTaxToAmount: false` is for the built-in only, which must charge exactly
 * what main charged for any stored rate (its display rate is capped instead).
 */
export function validateTaxResult(
	request: TaxRequest,
	raw: unknown,
	{ boundTaxToAmount = true }: { boundTaxToAmount?: boolean } = {},
): TaxResult | null {
	const maxTaxOn = (amount: number): number =>
		boundTaxToAmount ? Math.ceil((amount * TAX_RATE_BPS_MAX) / 10_000) : Number.POSITIVE_INFINITY;
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
	for (const { lineId, amountCents } of request.lines) {
		const line = byId.get(lineId);
		if (line === undefined || line.taxCents > maxTaxOn(amountCents)) return null;
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
			if (line.taxCents > maxTaxOn(request.shipping.amountCents)) return null;
			shipping = line;
			total += line.taxCents;
		}
	}
	if (!Number.isSafeInteger(total)) return null;

	return { ok: true, currency: request.currency, lines, shipping };
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
