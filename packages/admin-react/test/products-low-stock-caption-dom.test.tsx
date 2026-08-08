/**
 * @vitest-environment happy-dom
 *
 * "Low stock only" is a SERVER-SIDE predicate now: the plugin resolves the
 * store's threshold and carries it on the outgoing request, so the service's
 * exact count is of the SAME set the page is drawn from whenever the
 * predicate actually ran. That inverts the caption rule the client-side
 * narrowing used to enforce (withhold `total` while narrowing) — the total
 * must now be SHOWN whenever the page is genuinely filtered, and withheld
 * only on the one case where nothing was filtered at all: the threshold could
 * not be resolved, so the outgoing request never carried a predicate
 * (`stock.filterUnavailable`).
 *
 * THIS FILE PINS BOTH DIRECTIONS OF THAT RULE, end to end through a real
 * mount — a static render cannot see it, because the caption is a function of
 * the effect's response landing in state, not of the component's props alone
 * — plus the degradation banner's two INDEPENDENT causes: a genuinely-filtered
 * page can still have its own `onHand` DISPLAY column come back unreadable on
 * the wire, and that must raise "stock levels are unavailable" WITHOUT also
 * claiming the filter was not applied, which is exactly the bug a shared
 * `canFilter` boolean used to produce.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { ProductsList } = await import("../src/products/products-list.js");
type ProductSummary = import("../src/console-api.js").ProductSummary;

function product(over: Partial<ProductSummary> & { productId: string }): ProductSummary {
	return {
		sku: `SKU-${over.productId}`,
		title: `Title ${over.productId}`,
		priceCents: 1_999,
		currency: "USD",
		productKind: "physical",
		active: true,
		onHand: 2,
		deletedAt: null,
		createdAt: "2026-03-04T10:15:00.000Z",
		...over,
	};
}

const VOCABULARY = {
	any: "any",
	statuses: [{ value: "any", label: "Any status" }],
	kinds: [{ value: "any", label: "Any kind" }],
};

function envelope(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

async function mountLowStockList(): Promise<HTMLElement> {
	const node = <ProductsList onOpen={() => undefined} initialFilter={{ lowStock: true }} />;
	mounted = await mount(node);
	// The first page arrives through a promise chain the mount's own `act` does
	// not outlive — a second flush is what puts the response on screen.
	await mounted.rerender(node);
	return mounted.container;
}

test("FILTERED AND SHOWN: a resolved threshold is a real predicate, and its total is stated", async () => {
	// The plugin resolved a threshold, carried it on the request, and the
	// service's count is of the SAME (low-stock) set the page is drawn from —
	// so `total` travels and the caption states it, under the low-stock noun.
	apiFetch.mockResolvedValue(
		envelope({
			ok: true,
			products: [product({ productId: "p1", onHand: 2 }), product({ productId: "p2", onHand: 0 })],
			nextCursor: "cur-2",
			total: 8,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: VOCABULARY,
		}),
	);
	const container = await mountLowStockList();

	const intro = container.querySelector('[data-testid="products-intro"]')?.textContent ?? "";
	expect(intro).toContain("8 low-stock products");
	// No degradation banner: neither cause is true.
	expect(container.querySelector('[data-testid="products-stock-degraded"]')).toBeNull();
});

test("DEGRADED AND WITHHELD: an unresolved threshold carries no predicate, and its total is withheld", async () => {
	// The plugin could not read the threshold, so the outgoing request never
	// carried a predicate at all — the page is genuinely every product, and a
	// `total` here (even a real, service-reported one) would caption an
	// UNFILTERED page as though "Low stock only" had been honoured. The
	// service still counts the unfiltered set behind the scenes, but the
	// plugin's own contract withholds it from the wire on this scope — this
	// mount is fed exactly the shape the updated plugin now sends: no `total`
	// key at all.
	apiFetch.mockResolvedValue(
		envelope({
			ok: true,
			products: [product({ productId: "p1" }), product({ productId: "p2" })],
			nextCursor: "cur-2",
			stock: { threshold: null, unreadable: false, filterUnavailable: true },
			vocabulary: VOCABULARY,
		}),
	);
	const container = await mountLowStockList();

	const intro = container.querySelector('[data-testid="products-intro"]')?.textContent ?? "";
	// PAGE-SCOPED, ORDINARY NOUN — the smaller, true claim this render can back
	// up on its own, never "low-stock" for rows that are every product.
	expect(intro).toContain("2 products on this page");
	expect(intro).not.toContain("low-stock");

	const banner =
		container.querySelector('[data-testid="products-stock-degraded"]')?.textContent ?? "";
	expect(banner).toContain("the Low stock only filter was not applied");
	// THE OTHER CAUSE DID NOT FIRE — the on-hand DISPLAY column read fine here,
	// and folding the two together is exactly the bug this screen must not
	// have.
	expect(banner).not.toContain("Stock levels are unavailable");
});

test("a page can be GENUINELY filtered while its own on-hand column is unreadable — two independent causes, not one", async () => {
	// THE BUG THE OLD `canFilter` BOOLEAN PRODUCED. The threshold WAS resolved
	// (5) and the request DID carry the predicate, so the service applied it
	// and its `total` describes the filtered rows — none of that depends on
	// whether the WIRE PROJECTION of `onHand` on this particular page came
	// back readable, which is a fact discovered only after the fetch. The old
	// narrowing conflated the two into one `filterUnavailable`; here the
	// filter is honoured (shown total, low-stock noun) and the banner reports
	// only the on-hand degradation, never a false "filter was not applied".
	const { onHand: _a, ...noStock1 } = product({ productId: "p1" });
	const { onHand: _b, ...noStock2 } = product({ productId: "p2" });
	apiFetch.mockResolvedValue(
		envelope({
			ok: true,
			products: [noStock1, noStock2],
			nextCursor: "cur-2",
			total: 41,
			stock: { threshold: 5, unreadable: true, filterUnavailable: false },
			vocabulary: VOCABULARY,
		}),
	);
	const container = await mountLowStockList();

	const intro = container.querySelector('[data-testid="products-intro"]')?.textContent ?? "";
	expect(intro).toContain("41 low-stock products");

	const banner =
		container.querySelector('[data-testid="products-stock-degraded"]')?.textContent ?? "";
	expect(banner).toContain("Stock levels are unavailable");
	// THE OTHER CAUSE DID NOT FIRE — the filter genuinely ran, and saying
	// otherwise over a list that IS filtered is the defect this guards.
	expect(banner).not.toContain("the Low stock only filter was not applied");
});

test("the whole-catalog zero state is earned ONLY when low stock is the sole filter", async () => {
	// THE PREDICATES ARE ANDed. "Low stock only" plus a search that matches
	// nothing returns zero rows on a catalog that may be full of low-stock
	// products, and blaming the threshold there sends the operator to Settings
	// to fix a filter. The stock sentence is a whole-catalog claim, so it is
	// spent only when nothing else could have emptied the page.
	apiFetch.mockResolvedValue(
		envelope({
			ok: true,
			products: [],
			nextCursor: null,
			total: 0,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: VOCABULARY,
		}),
	);
	const node = (
		<ProductsList onOpen={() => undefined} initialFilter={{ lowStock: true, search: "nothing" }} />
	);
	mounted = await mount(node);
	await mounted.rerender(node);

	const shown = mounted.container.querySelector('[data-testid="products-no-match"]')?.textContent;
	expect(shown).toContain("No products match these filters");
	expect(shown).not.toContain("No products are low on stock");
	expect(shown).not.toContain("at or below the low-stock threshold");
});

test("with low stock as the ONLY filter, the zero state does claim the catalog", async () => {
	// The converse, so the guard above cannot be satisfied by never using the
	// stock copy at all. It also pins the WORDING: "no product is at or below
	// the threshold" is what the predicate found, where "every product is above
	// it" would be false of a product with no inventory row — unknown stock is
	// not a stock level.
	apiFetch.mockResolvedValue(
		envelope({
			ok: true,
			products: [],
			nextCursor: null,
			total: 0,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: VOCABULARY,
		}),
	);
	const container = await mountLowStockList();

	const shown = container.querySelector('[data-testid="products-no-match"]')?.textContent;
	expect(shown).toContain("No products are low on stock");
	expect(shown).toContain("No product in the catalog is at or below the low-stock threshold.");
	expect(shown).not.toContain("Every product in the catalog is above");
});

test("a live checkbox toggle re-fetches with the predicate, and the caption follows the new response", async () => {
	// End to end through the control itself, not just a seeded `initialFilter`:
	// ticking "Low stock only" re-queries, and the caption reflects whichever
	// response actually lands rather than the checkbox's own state.
	apiFetch.mockResolvedValueOnce(
		envelope({
			ok: true,
			products: [
				product({ productId: "p1" }),
				product({ productId: "p2" }),
				product({
					productId: "p3",
				}),
			],
			nextCursor: null,
			total: 3,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: VOCABULARY,
		}),
	);
	const node = <ProductsList onOpen={() => undefined} />;
	mounted = await mount(node);
	await mounted.rerender(node);

	const checkbox = mounted.container.querySelector<HTMLInputElement>(
		'[data-testid="filter-low-stock"]',
	);
	if (checkbox === null) throw new Error("no low-stock checkbox rendered");

	apiFetch.mockResolvedValue(
		envelope({
			ok: true,
			products: [product({ productId: "low-1", onHand: 1 })],
			nextCursor: null,
			total: 1,
			stock: { threshold: 5, unreadable: false, filterUnavailable: false },
			vocabulary: VOCABULARY,
		}),
	);
	await React.act(async () => {
		// The property SETTER, not a bare assignment — React's checkbox
		// listener reads the fiber's own tracked value, and a plain
		// `checkbox.checked = true` can leave that tracker disagreeing with
		// the DOM the same way it does for a text input's `value`.
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(
			checkbox,
			true,
		);
		checkbox.dispatchEvent(new Event("click", { bubbles: true }));
		checkbox.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(checkbox.checked).toBe(true);
	await fire(
		mounted.container.querySelector('[data-testid="apply-filters"]') as HTMLElement,
		"click",
	);

	const sent = JSON.parse(String(apiFetch.mock.calls.at(-1)?.[1]?.body ?? "{}")) as {
		filter?: { lowStock?: boolean };
	};
	expect(sent.filter?.lowStock).toBe(true);

	const intro =
		mounted.container.querySelector('[data-testid="products-intro"]')?.textContent ?? "";
	expect(intro).toContain("1 low-stock product");
});
