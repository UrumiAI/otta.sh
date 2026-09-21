import { describe, expect, test } from "vitest";
import type { ProductSummaryWire } from "../src/admin/admin-products-surface.js";
import { resolveStockContext } from "../src/admin/products-read.js";

/**
 * `resolveStockContext`'s `filterUnavailable` branch, tested DIRECTLY.
 *
 * WHY THIS FILE EXISTS. INC-D3a retired the stub HTTP surface the old
 * `products-console-route` cases used to inject a failed settings read with, and
 * the three `filterUnavailable` cases were deleted alongside it on the stated
 * grounds that `threshold === null` is unreachable in process. THAT RATIONALE IS
 * WRONG, and the branch it removed cover from is live:
 * `readLowStockThreshold` returns `null` on ANY throw from the settings read —
 * the in-process client throws a typed store error where the http one threw on a
 * non-2xx — and `products-console-route.ts` feeds that `null` straight into
 * `resolveStockContext`, whose `filterUnavailable` is computed from exactly that
 * condition. What became unreachable is the TRANSPORT-LEVEL injection, not the
 * state.
 *
 * So the coverage comes back at the seam that never needed a transport in the
 * first place. `resolveStockContext` is exported, pure, and takes its three
 * inputs as arguments: no sandbox, no HTTP, no store. A case here asserts the
 * decision itself rather than a fixture's ability to stage it, which is strictly
 * stronger than what was deleted.
 */

/** A list row with a known on-hand count — `unreadable` is false for any page
 *  containing one, which keeps these cases about `filterUnavailable` alone. */
function row(productId: string, onHand: number | null): ProductSummaryWire {
	return {
		productId,
		sku: `SKU-${productId}`,
		title: `Product ${productId}`,
		priceCents: 1999,
		currency: "USD",
		productKind: "physical",
		active: true,
		onHand,
		deletedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

const PAGE: readonly ProductSummaryWire[] = [row("p-1", 2), row("p-2", 40)];

describe("resolveStockContext: filterUnavailable", () => {
	test("(a) a low-stock request that could not be honoured leaves the page unfiltered AND withholds the total", () => {
		// The operator asked for "Low stock only" on a FRESH request and the
		// settings read failed, so the outgoing request carried no predicate at
		// all: the page is every row. Two things must follow together, and the
		// second is the one that is easy to drop — a `total` shown here would
		// caption an unfiltered page as though the request had been honoured,
		// because that count is of a set nobody narrowed.
		const resolved = resolveStockContext(PAGE, {
			wantsLowStock: true,
			threshold: null,
			total: 7,
			continuation: false,
		});

		expect(resolved.stock.filterUnavailable).toBe(true);
		expect(resolved.total).toBeUndefined();
		// `unreadable` travels ALONGSIDE, never folded in: these rows carry real
		// counts, so the on-hand COLUMN is readable even though the filter is not
		// available.
		expect(resolved.stock.unreadable).toBe(false);
		expect(resolved.stock.threshold).toBeNull();
	});

	test("(b) a CONTINUATION whose settings read fails is still a FILTERED page — the cursor is the predicate's evidence", () => {
		// THE FLAG IS NOT RE-DERIVED ON A CONTINUATION, and this is the direction
		// that goes wrong when it is. The predicate that produced these rows rode
		// inside the opaque cursor page one minted, so THIS request's settings read
		// says nothing about whether the page is filtered. Deriving
		// `filterUnavailable` from it would raise "the Low stock only filter was
		// not applied" over a page the store genuinely filtered AND withhold a
		// total that really is of the filtered set — two false statements bought by
		// consulting the wrong evidence.
		const resolved = resolveStockContext(PAGE, {
			wantsLowStock: true,
			threshold: null,
			total: 7,
			continuation: true,
		});

		expect(resolved.stock.filterUnavailable).toBe(false);
		expect(resolved.total).toBe(7);
		// The Low BAND is still lost, and that is the honest independent fact: the
		// threshold is null and the banner reports that cause on its own.
		expect(resolved.stock.threshold).toBeNull();
	});

	test("(c) E-1: a failed settings read costs the Low band and NOTHING else", () => {
		// The degradation property stated as a comparison rather than asserted
		// piecemeal. Take one page and resolve it twice — once with the threshold
		// read, once with the read failed — on a request that did NOT ask for
		// "Low stock only". Every decision this function makes must come out
		// IDENTICAL apart from the threshold itself: same page, same total, no
		// "filter not applied" claim, no unreadable claim. A settings fault is
		// never allowed to take a figure or a row with it.
		const read = resolveStockContext(PAGE, {
			wantsLowStock: false,
			threshold: 5,
			total: 7,
			continuation: false,
		});
		const failed = resolveStockContext(PAGE, {
			wantsLowStock: false,
			threshold: null,
			total: 7,
			continuation: false,
		});

		expect(failed.total).toBe(read.total);
		expect(failed.total).toBe(7);
		expect(failed.stock.filterUnavailable).toBe(read.stock.filterUnavailable);
		expect(failed.stock.filterUnavailable).toBe(false);
		expect(failed.stock.unreadable).toBe(read.stock.unreadable);
		expect(failed.stock.unreadable).toBe(false);
		// The one difference, and the whole cost of the fault: the band's number.
		expect(read.stock.threshold).toBe(5);
		expect(failed.stock.threshold).toBeNull();
	});

	test("a resolved threshold means the predicate RAN — the page is filtered and its total describes it", () => {
		// The positive control the three cases above are the degradations of:
		// `filterUnavailable` has ONE cause, and a readable threshold is not it.
		const resolved = resolveStockContext(PAGE, {
			wantsLowStock: true,
			threshold: 5,
			total: 1,
			continuation: false,
		});

		expect(resolved.stock.filterUnavailable).toBe(false);
		expect(resolved.total).toBe(1);
	});

	test("an unreadable on-hand COLUMN never forces filterUnavailable, and never touches the total", () => {
		// The fold that the retired client-side narrowing used to perform and that
		// must not come back: a page can be genuinely low-stock-filtered by real
		// `on_hand` values while its own DISPLAY column comes back with no key at
		// all. The two facts are independent and are reported independently.
		const noColumn = PAGE.map((p) => {
			const { onHand: _dropped, ...rest } = p;
			return rest as unknown as ProductSummaryWire;
		});

		const resolved = resolveStockContext(noColumn, {
			wantsLowStock: true,
			threshold: 5,
			total: 4,
			continuation: false,
		});

		expect(resolved.stock.unreadable).toBe(true);
		expect(resolved.stock.filterUnavailable).toBe(false);
		expect(resolved.total).toBe(4);
	});
});
