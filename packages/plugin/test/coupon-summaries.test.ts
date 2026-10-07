import { describe, expect, test } from "vitest";
import {
	couponDiscountSummary,
	couponUsesSummary,
	couponWindowSummary,
} from "../src/admin/coupons-page.js";

// The Coupons console's pure display summaries (admin-UX Increment 3, slice
// 4). Money renders through the shared exact-integer minor-units formatter
// (never a float); a percentage coupon is currency-agnostic, so its cap /
// minimum render as PLAIN decimals — no invented currency symbol; a coupon
// whose economics are unset (nullable on the wire) says so instead of
// rendering a garbage "null off".

const BASE = {
	type: "fixed_amount",
	amountCents: 500 as number | null,
	rateBps: null as number | null,
	capCents: null as number | null,
	currency: "USD" as string | null,
};

describe("couponDiscountSummary", () => {
	test("fixed_amount renders symbol-bearing exact money", () => {
		expect(couponDiscountSummary(BASE)).toBe("$5.00 off");
	});

	test("fixed_amount with an unrecognized currency falls back to CODE + plain decimal, never throws into the render path", () => {
		expect(couponDiscountSummary({ ...BASE, currency: "ZZZZ" })).toBe("ZZZZ 5.00 off");
	});

	test("fixed_amount with a null currency renders a plain decimal (no invented symbol)", () => {
		expect(couponDiscountSummary({ ...BASE, currency: null })).toBe("5.00 off");
	});

	test("fixed_amount with a null amount is honestly 'unset', not 'null off'", () => {
		expect(couponDiscountSummary({ ...BASE, amountCents: null })).toBe("fixed amount (unset)");
	});

	test("percentage renders exact bps as a percent", () => {
		expect(
			couponDiscountSummary({
				type: "percentage",
				amountCents: null,
				rateBps: 725,
				capCents: null,
				currency: null,
			}),
		).toBe("7.25% off");
	});

	test("percentage with a cap appends the cap as a PLAIN decimal (currency-agnostic; two-decimal percent, the Tax console convention)", () => {
		expect(
			couponDiscountSummary({
				type: "percentage",
				amountCents: null,
				rateBps: 1000,
				capCents: 2000,
				currency: null,
			}),
		).toBe("10.00% off (cap 20.00)");
	});

	test("percentage with a null rate is honestly 'unset'", () => {
		expect(
			couponDiscountSummary({
				type: "percentage",
				amountCents: null,
				rateBps: null,
				capCents: null,
				currency: null,
			}),
		).toBe("percentage (unset)");
	});

	test("an unknown type renders verbatim (forward-safe), never guesses arithmetic", () => {
		expect(
			couponDiscountSummary({
				type: "bogo",
				amountCents: 1,
				rateBps: 1,
				capCents: null,
				currency: "USD",
			}),
		).toBe("bogo");
	});
});

describe("couponWindowSummary", () => {
	test("both bounds open", () => {
		expect(couponWindowSummary(null, null)).toBe("always");
	});
	// THE CONSOLE'S DATE DIALECT (M-6), not the wire's: a window bound is a
	// DAY, and it renders the way every other day in the console renders — the
	// date half of `formatTimestamp`, UTC-pinned, no timezone math. The
	// separator is an en dash because this is a range, not a transition.
	test("start only", () => {
		expect(couponWindowSummary("2026-07-01T00:00:00.000Z", null)).toBe("from 1 Jul 2026");
	});
	test("expiry only", () => {
		expect(couponWindowSummary(null, "2026-09-01T00:00:00.000Z")).toBe("until 1 Sept 2026");
	});
	test("both bounds", () => {
		expect(couponWindowSummary("2026-07-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z")).toBe(
			"1 Jul 2026 – 1 Sept 2026",
		);
	});
});

// The `∞` glyph is gone from all three renderings of this fact (list column,
// picker label, detail field): it does not localize, and `N of M` is already
// how the Redemptions meter reads.
describe("couponUsesSummary", () => {
	test("bounded", () => {
		expect(couponUsesSummary(3, 100)).toBe("3 of 100");
	});
	test("unlimited", () => {
		expect(couponUsesSummary(0, null)).toBe("0 uses");
	});
	test("unlimited, singular", () => {
		expect(couponUsesSummary(1, null)).toBe("1 use");
	});
});
