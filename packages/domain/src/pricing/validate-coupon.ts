import type { Cents, Currency } from "../money/cents.js";
import type { CouponRecord } from "../ports/coupon-store.js";
import type { Coupon } from "./types.js";

export type CouponValidationFailure =
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_CURRENCY_MISMATCH";

export type ValidateCouponResult =
	| { ok: true; coupon: Coupon }
	| { ok: false; reason: CouponValidationFailure };

export interface CouponValidationContext {
	/** ISO-8601 UTC `now` from the use-case's clock (never read inside the pure math). */
	now: string;
	subtotalCents: Cents;
	currency: Currency;
}

/**
 * Validate a loaded coupon record against the checkout context (Phase 6 §5) and,
 * if valid, project it to the pure `Coupon` data the engine consumes. Pure — the
 * caller supplies `now` from its clock. The exhaustion check here is a soft
 * pre-check for a clean preview/error; the ATOMIC guard is `CouponStore.redeem`
 * (§5), which is what actually prevents over-redemption under concurrency.
 */
export function validateCoupon(
	record: CouponRecord,
	ctx: CouponValidationContext,
): ValidateCouponResult {
	// Date window: [startsAt, expiresAt). Null bounds are open.
	//
	// COMPARED AS INSTANTS, never as strings: string order is chronological only
	// for fixed-width `toISOString()` text, and the bounds are operator-authored
	// text (≤64 chars) — "…12:00:00Z" sorts AFTER the clock's "…12:00:00.500Z".
	//
	// FAILS CLOSED. A non-null bound `parseCouponInstant` cannot read — garbage, an
	// impossible date, or one naming no zone (which `Date.parse` would read as
	// host-local time) — refuses the coupon. An unreadable bound must never switch
	// a coupon ON: not a scheduled one now, and not an ended one forever. An
	// unreadable `now` refuses too, rather than guessing.
	const now = parseCouponInstant(ctx.now);
	if (now === null) return { ok: false, reason: "COUPON_NOT_ACTIVE" };
	if (record.startsAt !== null) {
		const starts = parseCouponInstant(record.startsAt);
		if (starts === null || now < starts) return { ok: false, reason: "COUPON_NOT_ACTIVE" };
	}
	if (record.expiresAt !== null) {
		const expires = parseCouponInstant(record.expiresAt);
		if (expires === null || now >= expires) return { ok: false, reason: "COUPON_NOT_ACTIVE" };
	}
	if (record.minSubtotalCents !== null && ctx.subtotalCents < record.minSubtotalCents) {
		return { ok: false, reason: "COUPON_MIN_SUBTOTAL" };
	}
	if (record.maxUses !== null && record.usesCount >= record.maxUses) {
		return { ok: false, reason: "COUPON_EXHAUSTED" };
	}

	if (record.type === "fixed_amount") {
		if (record.amountCents === null || record.currency === null) {
			throw new Error(`fixed_amount coupon ${record.code} is missing amount/currency`);
		}
		if (record.currency !== ctx.currency) {
			return { ok: false, reason: "COUPON_CURRENCY_MISMATCH" };
		}
		return {
			ok: true,
			coupon: {
				type: "fixed_amount",
				code: record.code,
				amountCents: record.amountCents,
				currency: record.currency,
			},
		};
	}

	// percentage
	if (record.rateBps === null) {
		throw new Error(`percentage coupon ${record.code} is missing rateBps`);
	}
	// A cap / minimum spend bound to a currency is an amount IN that currency's
	// minor unit, so the coupon applies only to carts in it — the same refusal a
	// fixed-amount coupon gives. No bound currency (no bounds, or a coupon written
	// before bounds carried one) applies to any cart, exactly as it always did.
	if (record.currency !== null && record.currency !== ctx.currency) {
		return { ok: false, reason: "COUPON_CURRENCY_MISMATCH" };
	}
	return {
		ok: true,
		coupon: {
			type: "percentage",
			code: record.code,
			bps: record.rateBps,
			capCents: record.capCents,
			...(record.currency !== null ? { currency: record.currency } : {}),
		},
	};
}

/** An ISO-8601 date-time that NAMES ITS ZONE (`Z` or `±HH:MM`). Without one,
 *  `Date.parse` reads the text as host-local time — a different instant on every
 *  server — so a zoneless bound is as unreadable as garbage. */
const ZONED_ISO_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A coupon window bound as epoch milliseconds, or `null` when it cannot be read
 * as ONE unambiguous instant: not a zoned ISO-8601 date-time, or a calendar date
 * that does not exist (`2026-13-01`, `2026-02-30`). The single reader for every
 * place that judges or stores a coupon window — checkout (`validateCoupon`), the
 * admin's status column and the rules client's write check — so they cannot
 * disagree about what a bound means.
 */
export function parseCouponInstant(text: string): number | null {
	if (!ZONED_ISO_INSTANT.test(text)) return null;
	// `Date.parse` ROLLS an impossible day over (`2026-02-30` → 2 March) instead
	// of refusing it, so the calendar date is checked on its own first.
	const [y, m, d] = text.slice(0, 10).split("-").map(Number) as [number, number, number];
	const day = new Date(Date.UTC(y, m - 1, d));
	if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) {
		return null;
	}
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? null : ms;
}
