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
 * integer; a rate that is not an integer in [0, 1000%]; a bad label; a shipping
 * line when no shipping was asked about; a total that is not a safe integer.
 */
export function validateTaxResult(request: TaxRequest, raw: unknown): TaxResult | null {
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
	for (const { lineId } of request.lines) {
		const line = byId.get(lineId);
		if (line === undefined) return null;
		total += line.taxCents;
		lines.push({ lineId, ...line });
	}

	const rawShipping = raw["shipping"];
	let shipping: TaxLine | null = null;
	if (rawShipping !== null && rawShipping !== undefined) {
		if (request.shipping === null || !isRecord(rawShipping)) return null;
		shipping = taxLineOf(rawShipping);
		if (shipping === null) return null;
		total += shipping.taxCents;
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
