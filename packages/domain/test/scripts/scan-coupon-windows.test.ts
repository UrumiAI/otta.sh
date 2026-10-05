import { describe, expect, test } from "vitest";
import { parseCouponInstant } from "../../src/pricing/validate-coupon.js";
import { couponRowsFrom, unreadableCouponWindows } from "../../scripts/scan-coupon-windows.js";

const doc = (over: Record<string, unknown>) => ({
	couponId: "c-1",
	code: "SAVE10",
	startsAt: null,
	expiresAt: null,
	...over,
});

describe("scan-coupon-windows (issue #364)", () => {
	test("lists every bound parseCouponInstant cannot read, and nothing else", () => {
		const found = unreadableCouponWindows(
			[
				doc({ couponId: "ok", startsAt: "2026-10-01T00:00:00Z", expiresAt: null }),
				doc({ couponId: "zoneless", code: "LOCAL", expiresAt: "2026-12-01T00:00:00" }),
				doc({ couponId: "impossible", code: "FEB", startsAt: "2026-02-30T00:00:00Z" }),
				doc({ couponId: "garbage", code: "BAD", startsAt: "soon", expiresAt: "never" }),
			],
			parseCouponInstant,
		);
		expect(found).toEqual([
			{ couponId: "zoneless", code: "LOCAL", field: "expiresAt", value: "2026-12-01T00:00:00" },
			{ couponId: "impossible", code: "FEB", field: "startsAt", value: "2026-02-30T00:00:00Z" },
			{ couponId: "garbage", code: "BAD", field: "startsAt", value: "soon" },
			{ couponId: "garbage", code: "BAD", field: "expiresAt", value: "never" },
		]);
	});

	test("reads wrangler d1 --json output, sqlite3 -json rows and bare documents alike", () => {
		const d = doc({ couponId: "w", expiresAt: "x" });
		const wrangler = [{ results: [{ id: "w", data: JSON.stringify(d) }], success: true }];
		const sqliteRows = [{ id: "w", data: JSON.stringify(d) }];
		for (const input of [wrangler, sqliteRows, [d]]) {
			expect(couponRowsFrom(input)).toEqual([d]);
		}
	});

	test("refuses input it cannot read rather than reporting a clean scan", () => {
		expect(() => couponRowsFrom({ not: "an array" })).toThrow();
		expect(() => couponRowsFrom([{ id: "x", data: "{not json" }])).toThrow();
	});
});
