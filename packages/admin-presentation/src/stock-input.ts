/**
 * The stock-quantity INPUT boundary — an operator's typed count → a positive
 * whole number.
 *
 * A TEXT INPUT, PARSED HERE, for the same reason money is (`money-input.ts`): a
 * Block Kit `number_input` hands back a JS float, and a stock movement is a
 * count of things. The parse is deliberately strict — `/^\d+$/` on the trimmed
 * string — so `3.0`, `3 units`, `+3`, `-3` and `1e3` are all refusals with a
 * per-field message rather than quietly-coerced quantities.
 *
 * WHY IT IS SHARED (INC-21). The React Pricing & inventory screen checks the
 * quantity BEFORE it opens the remove-stock confirm dialog, exactly as the
 * React Orders screen checks a refund amount before its own — and the Block Kit
 * screen checks the same string server-side on the `-review` step. Two parsers
 * would mean an operator could see a dialog for a quantity the write then
 * refuses, on the one step that exists to let them check exactly that.
 *
 * Never throws; `null` is every non-conforming input.
 */

/** Integer minor units have `parseMinorUnitsInput`; counts have this. Returns a
 *  positive whole number, or `null` for anything else (zero included — a
 *  movement of nothing is not a movement). */
export function parseStockQty(input: string | undefined): number | null {
	if (input === undefined) return null;
	const trimmed = input.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Read an `onHand` WATERMARK out of an untrusted round-tripped payload — a
 *  plain NON-NEGATIVE integer string, or `null` for anything else.
 *
 *  Distinct from {@link parseStockQty} in exactly one way, and it matters: zero
 *  is a legal watermark (a product genuinely at zero stock) and an illegal
 *  quantity. Folding the two would either refuse to render the stock forms for
 *  an out-of-stock product or accept a movement of nothing. */
export function parseOnHandWatermark(input: string | undefined): number | null {
	if (input === undefined) return null;
	const trimmed = input.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(n) ? n : null;
}
