/**
 * The bounds-currency rules for a percentage coupon, as the TYPED refusals the
 * rules client throws (`CommerceInputError` on field `currency`, with one of
 * these reasons). The rules client is the ONE place they are decided; the
 * Coupons screen maps each reason to its own copy and decides nothing itself,
 * so the two cannot drift.
 *
 *  - {@link COUPON_CURRENCY_REFUSAL.boundsNeedCurrency}: a NEW cap or minimum
 *    spend is an amount, so it needs a currency.
 *  - {@link COUPON_CURRENCY_REFUSAL.currencyNeedsBounds}: a currency on a
 *    percentage coupon with neither would restrict it to that currency's carts
 *    for nothing (a cap OR a minimum is enough, on create and on edit alike).
 *  - {@link COUPON_CURRENCY_REFUSAL.legacyBounds}: binding a currency to a
 *    coupon whose cap / minimum predate currencies would silently re-read them.
 *
 * A code that is not in the currency table at all is refused with the generic
 * `UNSUPPORTED_CURRENCY_REASON` (`commerce/commerce-input.ts`), shared with the
 * shipping screens.
 */
export const COUPON_CURRENCY_REFUSAL = {
	boundsNeedCurrency: "is required on a percentage coupon with a cap or minimum spend",
	currencyNeedsBounds: "is only needed with a cap or minimum spend",
	legacyBounds: "cannot be bound to a coupon whose cap or minimum spend predate currencies",
} as const;
