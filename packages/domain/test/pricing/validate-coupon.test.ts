import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import type { CouponRecord } from "../../src/ports/coupon-store.js";
import { validateCoupon } from "../../src/pricing/validate-coupon.js";

const USD = currency("USD");

function record(window: { startsAt?: string | null; expiresAt?: string | null }): CouponRecord {
	return {
		id: "c1",
		code: "SAVE5",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: window.startsAt ?? null,
		expiresAt: window.expiresAt ?? null,
		maxUses: null,
		maxUsesPerCustomer: null,
		usesCount: 0,
	};
}

/** Half a second past a whole second — the instant a millisecond-less bound
 *  and a `toISOString()` clock disagree about when compared as STRINGS
 *  (`"…12:00:00Z"` sorts after `"…12:00:00.500Z"`, because 'Z' > '.'). */
const NOW = "2026-10-02T12:00:00.500Z";
const ctx = { now: NOW, subtotalCents: cents(5000), currency: USD };

describe("validateCoupon — the window is compared as INSTANTS", () => {
	test("a start stored without milliseconds, 500 ms in the past, has started", () => {
		expect(validateCoupon(record({ startsAt: "2026-10-02T12:00:00Z" }), ctx).ok).toBe(true);
	});

	test("an expiry stored without milliseconds, 500 ms in the past, has ended", () => {
		expect(validateCoupon(record({ expiresAt: "2026-10-02T12:00:00Z" }), ctx)).toEqual({
			ok: false,
			reason: "COUPON_NOT_ACTIVE",
		});
	});

	test("the window stays half-open [startsAt, expiresAt) at the exact instants", () => {
		expect(validateCoupon(record({ startsAt: NOW }), ctx).ok).toBe(true);
		expect(validateCoupon(record({ expiresAt: NOW }), ctx).ok).toBe(false);
		expect(validateCoupon(record({ startsAt: "2026-10-02T12:00:01Z" }), ctx).ok).toBe(false);
		expect(validateCoupon(record({ expiresAt: "2026-10-02T12:00:01Z" }), ctx).ok).toBe(true);
	});

	test("an offset-bearing bound is the instant it denotes", () => {
		// 13:00:00+01:00 is 12:00:00Z — already started, 500 ms ago.
		expect(validateCoupon(record({ startsAt: "2026-10-02T13:00:00+01:00" }), ctx).ok).toBe(true);
	});

	test("an offset-bearing EXPIRY is the instant it denotes", () => {
		// 13:00:00+01:00 is 12:00:00Z — ended 500 ms ago.
		expect(validateCoupon(record({ expiresAt: "2026-10-02T13:00:00+01:00" }), ctx).ok).toBe(false);
		// 13:00:01+01:00 is 12:00:01Z — still live.
		expect(validateCoupon(record({ expiresAt: "2026-10-02T13:00:01+01:00" }), ctx).ok).toBe(true);
	});

	test("an offset-bearing START that has not yet arrived keeps the coupon closed", () => {
		// 07:00:01-05:00 is 12:00:01Z — half a second in the future.
		expect(validateCoupon(record({ startsAt: "2026-10-02T07:00:01-05:00" }), ctx)).toEqual({
			ok: false,
			reason: "COUPON_NOT_ACTIVE",
		});
	});
});

describe("validateCoupon — FAILS CLOSED on a bound it cannot read", () => {
	// A bound that does not parse — or names no zone, which Date.parse would read
	// as host-local time — must never switch a coupon ON: not a scheduled one now,
	// and not an ended one forever.
	for (const bad of [
		"2026-13-01",
		"2026-02-30T00:00:00Z",
		"not a date",
		"2026-10-02T12:00:00",
		"2026-10-02",
	]) {
		test(`an unreadable START (${JSON.stringify(bad)}) refuses`, () => {
			expect(validateCoupon(record({ startsAt: bad }), ctx)).toEqual({
				ok: false,
				reason: "COUPON_NOT_ACTIVE",
			});
		});
		test(`an unreadable EXPIRY (${JSON.stringify(bad)}) refuses`, () => {
			expect(validateCoupon(record({ expiresAt: bad }), ctx)).toEqual({
				ok: false,
				reason: "COUPON_NOT_ACTIVE",
			});
		});
	}

	test("an unreadable NOW refuses rather than guessing", () => {
		expect(validateCoupon(record({}), { ...ctx, now: "garbage" }).ok).toBe(false);
	});
});

describe("validateCoupon — a percentage coupon's cap / minimum spend are bound to its currency", () => {
	const JPY = currency("JPY");
	function percentage(over: Partial<CouponRecord>): CouponRecord {
		return {
			...record({}),
			code: "TENOFF",
			type: "percentage",
			amountCents: null,
			rateBps: 1000,
			capCents: cents(500),
			currency: null,
			minSubtotalCents: cents(3000),
			...over,
		};
	}

	test("bound to JPY: applies to a JPY cart (bounds in whole yen), refused for a USD cart like a fixed coupon", () => {
		const jpy = percentage({ currency: JPY });
		const ok = validateCoupon(jpy, { now: NOW, subtotalCents: cents(5000), currency: JPY });
		expect(ok).toEqual({
			ok: true,
			coupon: { type: "percentage", code: "TENOFF", bps: 1000, capCents: 500, currency: "JPY" },
		});
		expect(validateCoupon(jpy, ctx)).toEqual({ ok: false, reason: "COUPON_CURRENCY_MISMATCH" });
	});

	test("LEGACY: one with a cap and minimum but NO currency applies to any cart, amounts as stored — as before", () => {
		const legacy = percentage({ currency: null });
		for (const cur of [USD, currency("JPY"), currency("EUR")]) {
			expect(
				validateCoupon(legacy, { now: NOW, subtotalCents: cents(5000), currency: cur }),
			).toEqual({
				ok: true,
				coupon: { type: "percentage", code: "TENOFF", bps: 1000, capCents: 500 },
			});
		}
		expect(validateCoupon(legacy, { now: NOW, subtotalCents: cents(2999), currency: USD })).toEqual(
			{ ok: false, reason: "COUPON_MIN_SUBTOTAL" },
		);
	});
});
