/**
 * Applying what Stripe says about a Checkout Session to its order.
 *
 * The session view comes either from a signature-verified webhook or from a
 * fresh Stripe retrieve (sweep), so it is trusted. Decisions (one CAS each):
 *   complete + paid, amount & currency match  pending -> paid (commit holds)
 *   complete + paid, mismatch                 pending -> review (hold kept, L5)
 *   complete + paid on expired/canceled       -> paid + attention (commit from on-hand)
 *   expired                                   pending -> expired (release holds)
 * Anything else, or a repeat, changes nothing.
 *
 * Holds are released only once Stripe says the session EXPIRED, and a
 * card-only session cannot be paid after that (S-b), so stock is never
 * released for a session that can still take money.
 */
import type { PluginContext } from "emdash/plugin";
import type { OrderDoc } from "./model.js";
import { completeStock, orders, ORDER_ID, updateOrder, type Versioned } from "./orders.js";
import type { SessionView } from "./stripe.js";

export type SettleOutcome = "paid" | "review" | "expired" | "noop" | "unknown_order";

/**
 * L5, the amount check: verify what WE priced, record what Stripe added.
 *  - Currency always matches exactly.
 *  - Promotion codes off (the order's snapshot): amount_total equals our total,
 *    exactly as before. Any discount or tax Stripe applied is a mismatch.
 *  - Promotion codes on: amount_subtotal equals our subtotal, shipping equals
 *    ours, no tax, and amount_total = total - amount_discount with
 *    0 <= discount <= total. A fully discounted session totals 0 (Stripe
 *    reports it as "paid"; "no_payment_required" must also total 0).
 */
export function priceCheck(d: OrderDoc, s: SessionView): { ok: boolean; discount: number | null } {
	if (s.currency !== d.currency) return { ok: false, discount: s.amountDiscount };
	if (!d.promoCodes)
		return {
			ok: s.paymentStatus === "paid" && s.amountTotal === d.total,
			discount: s.amountDiscount ?? 0,
		};
	const disc = s.amountDiscount ?? 0;
	const ok =
		s.amountSubtotal === d.subtotal &&
		(s.amountShipping ?? 0) === d.shipping &&
		(s.amountTax ?? 0) === 0 &&
		Number.isSafeInteger(disc) &&
		disc >= 0 &&
		disc <= d.total &&
		s.amountTotal === d.total - disc &&
		// A fully discounted session: real Stripe reports payment_status "paid",
		// amount_total 0 and no PaymentIntent (seen in test mode at API 2025-03-31,
		// 2026-09-30 and 2026-11-18); the docs also allow "no_payment_required".
		(s.paymentStatus === "paid" || s.amountTotal === 0);
	return { ok, discount: disc };
}

export async function applySession(
	ctx: PluginContext,
	s: SessionView,
	cur?: Versioned | null,
	/**
	 * false: decide only (status CAS, sweep flag set) and leave the stock work to
	 * sweep part A. The sweep's expiry pass uses it so its cost does not grow with
	 * the order's size.
	 */
	completeNow = true,
): Promise<SettleOutcome> {
	const id = s.orderId;
	if (id === null || !ORDER_ID.test(id)) return "unknown_order";
	const start = cur ?? (await orders(ctx).getVersioned(id));
	if (!start) return "unknown_order";
	// Another Core store on the same Stripe account (same client-minted id): not ours.
	if (s.storeTag !== start.value.store) return "unknown_order";

	let outcome: SettleOutcome = "noop";
	// "no_payment_required" is a fully discounted session: only an order created
	// with promotion codes on can be one (checked against the order below).
	const paid =
		s.status === "complete" &&
		(s.paymentStatus === "paid" || s.paymentStatus === "no_payment_required");
	const expired = s.status === "expired";
	if (!paid && !expired) {
		// Still open / unpaid: nothing to decide, but finish any interrupted stock work.
		await completeStock(ctx, id, start);
		return "noop";
	}

	const next = await updateOrder(
		ctx,
		id,
		(d): OrderDoc | null => {
			outcome = "noop";
			if (d.stripeSessionId !== null && d.stripeSessionId !== s.id) {
				// Not this order's session (cannot happen with one idempotency key per order).
				if (d.attention !== null) return null;
				return { ...d, attention: `FOREIGN_SESSION:${s.id}` };
			}
			const withSession = { ...d, stripeSessionId: s.id };
			if (expired) {
				if (d.status !== "pending") return null;
				outcome = "expired";
				return { ...withSession, status: "expired", stock: "releasing", stockPending: 1 };
			}
			if (d.status === "paid" || d.status === "fulfilled") return null;
			// This exact payment is already on the order (a redelivery after the
			// merchant resolved it): never reopen or re-take it. A fully discounted
			// session has no PaymentIntent, so the session itself identifies it.
			if (d.paymentIntentId !== null && d.paymentIntentId === s.paymentIntentId) return null;
			if (d.paidAt !== null && d.stripeSessionId === s.id) return null;
			if (s.paymentStatus === "no_payment_required" && !d.promoCodes) return null;
			const check = priceCheck(d, s);
			const payment = {
				paymentIntentId: s.paymentIntentId,
				amountPaid: s.amountTotal,
				discount: check.discount,
				email: s.email ?? d.email,
				shippingAddress: s.shippingAddress,
				paidAt: new Date().toISOString(),
			};
			const mismatch = !check.ok;
			const mismatchNote = `AMOUNT_MISMATCH:${s.amountTotal ?? "?"} ${s.currency ?? "?"}`;
			if (d.status === "review") {
				// Under review with no payment recorded yet (session was unreachable):
				// record the money so the person resolving it sees it. Settles nothing.
				if (d.paymentIntentId !== null) return null;
				return {
					...withSession,
					...payment,
					attention: `${d.attention ?? "REVIEW"} PAID${mismatch ? ` ${mismatchNote}` : ""}`,
				};
			}
			if (d.status === "pending") {
				if (mismatch) {
					// L5: settle nothing. The holds stay (every hold exists once a
					// session does), the sweep flag clears, a person resolves it.
					outcome = "review";
					return {
						...withSession,
						...payment,
						status: "review",
						stock: "held",
						stockPending: 0,
						attention: mismatchNote,
					};
				}
				outcome = "paid";
				return { ...withSession, ...payment, status: "paid", stock: "committing", stockPending: 1 };
			}
			// Money arrived for an order that is no longer open (expired/canceled):
			// its holds are released or being released, so the sale is UNHELD and
			// comes off on-hand (may oversell; flagged). L5 still applies first.
			const late = `PAID_WHILE_${d.status.toUpperCase()}`;
			if (mismatch) {
				outcome = "review";
				return {
					...withSession,
					...payment,
					status: "review",
					unheldSale: true,
					attention: `${late} ${mismatchNote}`,
				};
			}
			outcome = "paid";
			return {
				...withSession,
				...payment,
				status: "paid",
				stock: "committing",
				stockPending: 1,
				unheldSale: true,
				attention: late,
			};
		},
		start,
	);
	if (next && completeNow) await completeStock(ctx, id, next);
	// The order is decided: the order page's lookup stamp (kv chk:<id>) has no use
	// any more. Deleted here so it is cleaned on every path (1 call, best effort).
	if (outcome !== "noop") {
		try {
			await ctx.kv.delete(`chk:${id}`);
		} catch {}
	}
	return outcome;
}
