/**
 * The two strings a refund control puts in front of an operator, shared by both
 * admin surfaces (INC-20).
 *
 * WHY THESE TWO, AND NOTHING ELSE FROM THE ORDERS SCREEN. Almost every other
 * string on that screen is composed server-side and arrives at the React tier
 * already rendered. These cannot be: a partial refund's confirm text names the
 * amount the operator just typed, so it is composed in the browser, at click
 * time, from a figure the server has not seen yet. A React screen would
 * therefore need its own copy — and "its own copy" of a REFUND CONFIRM is the
 * one place in this console where drift moves money. `refundCapabilityText`
 * travels with it because the two are read together and read as one warning.
 *
 * They live here rather than in `@otta-sh/plugin` for the reason the whole
 * package exists: `@otta-sh/admin-react` may not import the plugin (ADR-0014
 * Decision 3). Pure string work, no IO, no wire types — the signatures take
 * primitives precisely so this module never learns what an order looks like.
 */
import { SHORT_ID_CONFIRM_LEN, shortIdFixed } from "./short-id.js";

/** `confirm.text`'s hard budget (§1): exactly two sentences, ≤200 characters. */
const CONFIRM_BUDGET = 200;

/**
 * The recipient phrase when no identity names the buyer — the ONLY exported
 * form of this text, so a caller with nothing to name (no verified email, no
 * buyer reference) can pass it AS the recipient and get exactly the words
 * this function's own overflow branch below would otherwise produce, rather
 * than re-typing the literal and letting the two drift (review finding N4).
 */
export const UNNAMED_REFUND_RECIPIENT = "this order's buyer";

/**
 * `confirm.text` — exactly two sentences, ≤200 (§1): one naming the concrete
 * ORDER, amount and recipient, one naming the consequence.
 *
 * THE ORDER COMES FIRST, and it is the reason this function takes an id at all
 * (D4). Amount and recipient are the two attributes a repeat customer's orders
 * SHARE, so a dialog naming only those is a dialog that cannot tell the operator
 * which of two candidates the money is about to leave. `shortIdFixed` is used
 * rather than `shortIdsFor` because a confirm renders against one record with no
 * candidate set in hand; at 8 characters it is a visible superset of the
 * 4-character prefix the operator just read in the list row.
 *
 * THE RECIPIENT IS ALWAYS QUOTED (review finding N3). `recipient` may be
 * caller-supplied, unverified free text — this function has no way to know —
 * so it is delimited the same way regardless of source: an operator can see
 * exactly where the token begins and ends rather than reading it as an
 * unbounded run of the sentence's own prose. A quoted `UNNAMED_REFUND_RECIPIENT`
 * reads a little oddly on its own ("to 'this order's buyer'?") but keeps one
 * rule for every recipient this function is ever handed, rather than a
 * caller-visible distinction between "trusted" and "untrusted" text this
 * module has no way to enforce.
 *
 * The recipient is dropped when a long buyer handle would push the string over
 * budget — the id and the amount are never the thing that goes. Truncating a
 * confirm dialog mid-sentence would be worse than a slightly less specific one,
 * and the budget is a hard rule (X-11). This is a BACKSTOP, not the primary
 * defence against a crafted value that stays under budget while reshaping the
 * sentence around it — a short recipient never reaches this branch at all, so
 * a caller expecting a bound on a value that legitimately fits the budget
 * still owns its own clamp (`order-detail.tsx`'s `REFUND_RECIPIENT_MAX_LEN`).
 */
export function refundConfirmText(
	orderId: string,
	amount: string,
	recipient: string,
	refundable: boolean,
): string {
	const consequence = refundable
		? "This sends the money back through Stripe and cannot be reversed."
		: "This records a refund made out of band — it does not move money.";
	const order = `Order #${shortIdFixed(orderId, SHORT_ID_CONFIRM_LEN)}`;
	const named = `${order} — refund ${amount} to "${recipient}"? ${consequence}`;
	return named.length <= CONFIRM_BUDGET
		? named
		: `${order} — refund ${amount} to "${UNNAMED_REFUND_RECIPIENT}"? ${consequence}`;
}

/** The honest per-gateway capability copy (ADR-0008), each ≤200 (§1): Stripe
 *  moves money; x402 / no-secret is record-only, and says why. Takes primitives
 *  rather than a summary object so this module stays free of wire types. */
export function refundCapabilityText(refundable: boolean, paymentMethod: string | null): string {
	if (refundable) {
		return `Paid via ${paymentMethod ?? "the payment provider"} — refunding here issues a REAL refund through Stripe and money moves back to the buyer.`;
	}
	if (paymentMethod === "x402") {
		return "Paid on-chain (x402), which cannot be reversed and has no signing wallet — refunds here are RECORD-ONLY. Send the return yourself, then record it here.";
	}
	return "Automatic refunds are unavailable for this order — refunds here are RECORD-ONLY. Issue it through your payment provider, then record it here.";
}
