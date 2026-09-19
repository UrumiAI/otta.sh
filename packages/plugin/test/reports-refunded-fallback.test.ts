import { describe, expect, test } from "vitest";
import type { RevenueBucketWire } from "../src/admin/reporting-client.js";
import { buildReportsBlocks } from "../src/admin/reports-page.js";
import { findBlocks, type LooseBlock } from "./helpers/blocks.js";

/**
 * The Refunded tile's ABSENT-`refundedCents` fallback, tested DIRECTLY.
 *
 * WHY THIS FILE EXISTS. INC-D3a deleted "Refunded falls back to the stated gap
 * against a service whose buckets carry no refundedCents key" from the reports
 * sandbox suite, on the grounds that the in-process client emits the key on
 * every bucket so the arm has no producer left. That is true of the PRODUCER and
 * false of the CODE: `refundedTileFor` still branches on an absent-or-unusable
 * figure, `refundedCents` is still optional on `RevenueBucketWire`, and the
 * branch is a pure function of the buckets handed to the renderer. A branch that
 * survives in the source with no test is a branch that can rot into rendering a
 * confident `$0.00` over an amount nobody reported — the exact failure the field
 * was added to remove (DA-7/M-1).
 *
 * WHY HERE AND NOT IN THE SANDBOX SUITE. The claim has nothing to do with
 * transport: it is "given these buckets, this tile reads thus". Restoring it as
 * a sandbox case would mean seeding a store that cannot produce the shape and
 * then asserting against the fixture instead of the renderer.
 *
 * WHERE THE SEAM IS, honestly stated: `readRefunded`, `refundedFor` and
 * `refundedTileFor` are all module-private and `reports-page.ts` is off limits
 * for this change, so nothing narrower is exported. `buildReportsBlocks` — a
 * pure `ReportsData -> BlockResponse` — is the nearest exported seam that
 * reaches the branch, and it is reached with no store, no sandbox and no HTTP.
 */

const RANGE = {
	from: "2026-07-10T00:00:00.000Z",
	to: "2026-07-12T23:59:59.999Z",
	fromDay: "2026-07-10",
	toDay: "2026-07-12",
	isDefault: false,
};

/** The page's four stat tiles. Refunded is the fourth (R-16 caps the block at
 *  four and DESIGNER §6 fixed this order). */
function statItems(blocks: readonly LooseBlock[]): Array<Record<string, unknown>> {
	const stats = findBlocks(blocks, "stats")[0] as { items?: Array<Record<string, unknown>> };
	return stats?.items ?? [];
}

function refundedTile(revenue: RevenueBucketWire[], refundedOrders = 0): Record<string, unknown> {
	const response = buildReportsBlocks({
		displayName: "Test Store",
		interval: "day",
		range: RANGE,
		revenue,
		statuses: [
			{ status: "paid", orderCount: 3 },
			...(refundedOrders > 0 ? [{ status: "refunded", orderCount: refundedOrders }] : []),
		],
		top: [],
		low: [],
	});
	const items = statItems(response.blocks as unknown as LooseBlock[]);
	expect(items).toHaveLength(4);
	return items[3] ?? {};
}

/** One day of USD revenue. `refundedCents` is attached only when asked for, so
 *  the ABSENT case is genuinely a missing key rather than an `undefined` value. */
function bucket(day: string, revenueCents: number, refundedCents?: number): RevenueBucketWire {
	return {
		bucketStart: `${day}T00:00:00.000Z`,
		currency: "USD",
		revenueCents,
		...(refundedCents === undefined ? {} : { refundedCents }),
	};
}

describe("reports: the Refunded tile's absent-refundedCents fallback", () => {
	test("a bucket carrying NO refundedCents key reads as a stated gap, never as zero", () => {
		const tile = refundedTile([bucket("2026-07-10", 3000)]);

		// The dash, and — the half that matters — a description that says what is
		// missing rather than letting the dash speak for itself.
		expect(tile["value"]).toBe("—");
		expect(String(tile["description"])).toMatch(/refunded amount not yet reported/);
		// What IS known is still said: `orders-by-status` has always carried the
		// fully-refunded count, and a missing AMOUNT does not erase it.
		expect(String(tile["description"])).toMatch(/No fully refunded orders/);
	});

	test("the stated gap still reports the fully-refunded COUNT it does know", () => {
		const tile = refundedTile([bucket("2026-07-10", 3000)], 2);

		expect(tile["value"]).toBe("—");
		expect(String(tile["description"])).toBe(
			"2 fully refunded orders; refunded amount not yet reported",
		);
	});

	test("PRESENT and zero is a FACT and renders $0.00 — the dash is reserved for the absent key", () => {
		// The distinction the whole field exists for. Same page, same currency,
		// same day; the only difference is that the key is there.
		const tile = refundedTile([bucket("2026-07-10", 3000, 0)]);

		expect(tile["value"]).toBe("$0.00");
		expect(String(tile["description"])).not.toMatch(/not yet reported/);
	});

	test("a present figure is summed across the window and formatted as money", () => {
		const tile = refundedTile([bucket("2026-07-10", 3000, 250), bucket("2026-07-11", 5500, 0)]);

		expect(tile["value"]).toBe("$2.50");
	});

	test("the gap is ALL-OR-NOTHING: one bucket missing the key dashes the whole window, never a partial sum", () => {
		// A partial sum would be a number smaller than the truth wearing the same
		// formatting as a complete one (M-1) — strictly worse than the dash.
		const tile = refundedTile([bucket("2026-07-10", 3000, 250), bucket("2026-07-11", 5500)]);

		expect(tile["value"]).toBe("—");
		expect(String(tile["description"])).toMatch(/refunded amount not yet reported/);
	});

	test("a PRESENT but unusable figure lands on the same stated gap, never formatted", () => {
		// The narrower "the key is there and I cannot use it" case: a float where
		// integer minor units belong (the bug this codebase is built to refuse), and
		// a negative refund, which is not a thing this page can render. Both are
		// read as absent rather than shown.
		for (const unusable of [19.99, -250, Number.NaN]) {
			const tile = refundedTile([bucket("2026-07-10", 3000, unusable)]);
			expect(tile["value"]).toBe("—");
			expect(String(tile["description"])).toMatch(/refunded amount not yet reported/);
		}
	});
});
