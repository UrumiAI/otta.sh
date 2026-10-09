/**
 * The shopper-facing NAME of an order: what was bought, never the order id.
 *
 * WHY THIS EXISTS. An order id is a UUID. To the buyer it names nothing — it is
 * a machine's key printed at a person — so no customer surface shows it: the
 * confirmation page, the account pages and the order emails all name the order
 * by its products instead. The id is still the order's identity everywhere a
 * machine reads it (URLs, Stripe metadata, idempotency keys, cookies, the
 * email dispatcher's `data.orderId`, logs) and on the admin console, which is
 * for the merchant, not the buyer.
 *
 * ONE FUNCTION, so the storefront and the emails cannot drift into two
 * spellings of the same order. The storefront reaches it through
 * `@otta-sh/plugin`'s re-export; the email renderer calls it directly.
 *
 * THE FORMAT:
 *  - one line → `"<title>"`, or `"<title> × <qty>"` when bought more than once;
 *  - several lines → `"<first title> and <N-1> more"` — the count is of LINES
 *    (distinct things bought), not units, and it covers every other line,
 *    including one whose title is blank, because that line was still bought;
 *  - a blank or missing title is skipped when choosing the title to show (the
 *    first USABLE title leads), and with no usable title at all the label is
 *    `"Your order"` — never the id, never an empty string.
 *
 * The input is the narrowest shape every caller can map to. The three callers'
 * line types disagree on the quantity's NAME (`qty` on the storefront's
 * `PublicOrderView`, `quantity` on the account wire and the email data), and
 * the mapping belongs at the call site rather than in a wider signature here.
 * `title` is optional and nullable because the email data crossed a JSON
 * boundary and is read defensively.
 *
 * THE TITLE IS NORMALISED BEFORE IT IS USED, because the label reaches email
 * SUBJECTS and page `<title>`s, and a merchant's title is free text. A CR/LF (or
 * any control character) in a subject is a header a provider rejects — and the
 * outbox would retry, forever, an email that can never send — so every control
 * character and every whitespace run becomes one space, the ends are trimmed,
 * and the result is clamped to {@link ORDER_LABEL_TITLE_MAX_LENGTH} code points
 * with an ellipsis (`Array.from`, so an astral character is never cut into a
 * lone surrogate — the same rule as the Stripe adapter's `clip`). It lives HERE,
 * not in each caller, so the emails and the pages cannot disagree about it.
 *
 * WHAT THIS DELIBERATELY IS NOT:
 *  - It is not Stripe's PaymentIntent `description` ("2 × Otta Tee, 1 × Otta
 *    Mug"), which `@otta-sh/payments-stripe` formats on its own. That one is
 *    merchant/Stripe-facing, lists every line, and must stay byte-identical
 *    across retries for Stripe's idempotency — so it is left alone and differs
 *    from this on purpose.
 *  - It does not make two orders distinguishable. A buyer who orders the same
 *    product twice would get two emails with the same label; the short order
 *    NUMBER (`orderNumber`, "#3F9A2" — ADR-0033) printed beside it on every
 *    customer surface is what tells them apart.
 *  - It is English. "and N more" / "Your order" are fixed strings; localising
 *    them needs a formatter (plural rules, word order), not a translated copy
 *    of this function.
 *
 * Pure and total: no locale, no IO. Plain-text out — a caller rendering HTML
 * escapes it like any other value.
 */
export interface OrderLabelLine {
	title?: string | null;
	quantity: number;
}

/** What an order with nothing nameable in it is called. */
export const ORDER_LABEL_FALLBACK = "Your order";

/** The most code points of a title the label keeps (the ellipsis included).
 *  Long enough for any real product name; short enough that a subject line and
 *  a browser tab stay readable whatever the merchant typed. */
export const ORDER_LABEL_TITLE_MAX_LENGTH = 80;

/** C0 controls, DEL and the C1 block — none of them is text, and CR/LF among
 *  them is a header break. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Invisible format characters: zero-width space/joiners and marks, the bidi
 *  embeddings, overrides and isolates, and the BOM. A right-to-left override
 *  would visually reorder a subject line. They are REMOVED, not spaced — one
 *  inside a word ("Ot\u200Bta") must not split it. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

export function orderLabel(lines: readonly OrderLabelLine[]): string {
	let title: string | null = null;
	for (const line of lines) {
		title = usableTitle(line);
		if (title !== null) break;
	}
	if (title === null) return ORDER_LABEL_FALLBACK;
	if (lines.length > 1) return `${title} and ${lines.length - 1} more`;
	// "× 1" says nothing; a quantity that is not a whole number above one is
	// malformed data, and printing it would put a wrong figure in front of the
	// buyer — the title alone is still true.
	const quantity = lines[0]?.quantity ?? 1;
	return Number.isSafeInteger(quantity) && quantity > 1 ? `${title} × ${quantity}` : title;
}

function usableTitle(line: OrderLabelLine): string | null {
	if (typeof line.title !== "string") return null;
	const title = line.title
		.replace(INVISIBLE, "")
		.replace(CONTROL, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (title.length === 0) return null;
	const points = Array.from(title);
	if (points.length <= ORDER_LABEL_TITLE_MAX_LENGTH) return title;
	// trimEnd: a cut that lands just after a space must not read "Otta …".
	return `${points
		.slice(0, ORDER_LABEL_TITLE_MAX_LENGTH - 1)
		.join("")
		.trimEnd()}…`;
}
