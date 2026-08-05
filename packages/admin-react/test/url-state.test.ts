/**
 * The address bar as the screen's state (F22, F23).
 *
 * Every function under test is PURE — string in, string or value out — which is
 * the whole reason the filter and tab plumbing was split this way. The half that
 * touches `window.history` is not testable here at all: `happy-dom` does not
 * model a session history, so pushing, popping and traversing entries do not
 * behave as a browser's do. Anything about history TRAVERSAL is proven in a real
 * browser instead, and deliberately has no test in this file — a green here
 * would mean nothing.
 */
import { describe, expect, it } from "vitest";
import {
	ORDER_TAB_SLUGS,
	orderTabQuery,
	ordersFilterQuery,
	readOrderTab,
	readOrdersFilter,
} from "../src/orders/orders-screen.js";
import {
	PRODUCT_TAB_SLUGS,
	productTabQuery,
	productsFilterQuery,
	readProductTab,
	readProductsFilter,
} from "../src/products/products-screen.js";

describe("readOrdersFilter", () => {
	it("reads an empty query as the default filter, not as an error", () => {
		expect(readOrdersFilter("")).toEqual({});
		expect(readOrdersFilter("?")).toEqual({});
	});

	it("reads each parameter the orders list writes", () => {
		expect(
			readOrdersFilter("?status=paid&period=custom&from=2026-01-01&to=2026-02-01&q=ada"),
		).toEqual({
			status: "paid",
			period: "custom",
			from: "2026-01-01",
			to: "2026-02-01",
			search: "ada",
		});
	});

	it("ignores a date range that no custom period asked for", () => {
		// `from`/`to` are only part of the filter when the period is `custom` —
		// the same rule the panel itself applies, so a decoded filter is one the
		// list could have produced.
		expect(readOrdersFilter("?period=last7&from=2026-01-01&to=2026-02-01")).toEqual({
			period: "last7",
		});
	});

	it("falls back to the default for a value the panel could not have submitted", () => {
		// A URL is user input. An unrecognised status or period travelling to the
		// service would leave the request asking for something the panel above it
		// says it is not asking for.
		expect(readOrdersFilter("?status=banana")).toEqual({});
		expect(readOrdersFilter("?period=nonsense")).toEqual({});
		expect(readOrdersFilter("?status=PAID")).toEqual({});
		// The sentinel is the panel's word for "no constraint", never a filter.
		expect(readOrdersFilter("?status=any&period=any")).toEqual({});
		// A custom range hanging off a rejected period goes with it.
		expect(readOrdersFilter("?period=nonsense&from=2026-01-01&to=2026-02-01")).toEqual({});
		// One bad parameter costs that parameter and nothing else.
		expect(readOrdersFilter("?status=banana&period=last30&q=ada")).toEqual({
			period: "last30",
			search: "ada",
		});
	});

	it("treats an empty value as absent", () => {
		expect(readOrdersFilter("?status=&q=")).toEqual({});
	});

	it("ignores a parameter it does not own", () => {
		expect(readOrdersFilter("?order=abc&cursor=xyz&nonsense=1")).toEqual({});
	});
});

describe("ordersFilterQuery", () => {
	it("writes nothing for the default filter", () => {
		expect(ordersFilterQuery("", {})).toBe("");
	});

	it("round-trips every field it wrote", () => {
		const filter = {
			status: "failed",
			period: "custom",
			from: "2026-01-01",
			to: "2026-02-01",
			search: "ada lovelace",
		};
		expect(readOrdersFilter(`?${ordersFilterQuery("", filter)}`)).toEqual(filter);
	});

	it("encodes rather than concatenating — a search term may hold anything", () => {
		const query = ordersFilterQuery("", { search: "a&b=c d" });
		expect(query).toBe("q=a%26b%3Dc+d");
		expect(readOrdersFilter(`?${query}`)).toEqual({ search: "a&b=c d" });
	});

	it("writes no date range for a period that did not ask for one", () => {
		// The twin of the decode rule above, and the side that actually reaches the
		// address bar: a preset resolves its own window, so a `from` still sitting
		// in the draft from an abandoned custom range must not be written beside
		// it. Writing it produces a link whose dates the screen it opens ignores.
		const query = ordersFilterQuery("", {
			period: "last30",
			from: "2026-01-01",
			to: "2026-02-01",
		});
		const params = new URLSearchParams(query);
		expect(params.get("period")).toBe("last30");
		expect(params.get("from")).toBeNull();
		expect(params.get("to")).toBeNull();
	});

	it("clears a stale date range left in the address by a custom period", () => {
		// Switching custom → preset must take the old dates OUT of the URL, not
		// merely stop adding them.
		const query = ordersFilterQuery("?period=custom&from=2026-01-01&to=2026-02-01", {
			period: "last7",
		});
		expect(query).toBe("period=last7");
	});

	it("drops a filter that has gone back to its default", () => {
		expect(ordersFilterQuery("?status=paid&q=ada", {})).toBe("");
	});

	it("keeps the drill-in parameter and anything else it does not own", () => {
		const query = ordersFilterQuery("?order=abc&status=paid", { search: "ada" });
		const params = new URLSearchParams(query);
		expect(params.get("order")).toBe("abc");
		expect(params.get("status")).toBeNull();
		expect(params.get("q")).toBe("ada");
	});
});

describe("readProductsFilter", () => {
	it("reads an empty query as the default filter", () => {
		expect(readProductsFilter("")).toEqual({});
	});

	it("treats an empty value as absent", () => {
		// The mirror of the same assertion on `readOrdersFilter` above: a status
		// select never submits `""`, so an empty parameter is a stale or
		// hand-edited link and must resolve to the default, not to a filter for
		// the empty string.
		expect(readProductsFilter("?status=&kind=&q=")).toEqual({});
	});

	it("reads each parameter the products list writes", () => {
		// `status` carries the combined Status select's own value, not a word for
		// it: `true`/`false`/`archived` is what the panel submits.
		expect(readProductsFilter("?status=archived&kind=physical&low=1&q=mug")).toEqual({
			status: "archived",
			productKind: "physical",
			lowStock: true,
			search: "mug",
		});
		expect(readProductsFilter("?status=true").status).toBe("true");
		expect(readProductsFilter("?status=false").status).toBe("false");
		expect(readProductsFilter("?kind=digital").productKind).toBe("digital");
	});

	it("falls back to the default for a value the panel could not have submitted", () => {
		// A URL is user input. `?status=banana&kind=nonsense` used to reach the
		// service verbatim while both selects still read "any".
		expect(readProductsFilter("?status=banana&kind=nonsense")).toEqual({});
		expect(readProductsFilter("?status=active")).toEqual({});
		expect(readProductsFilter("?kind=PHYSICAL")).toEqual({});
		// The sentinel is the panel's word for "no constraint", never a filter.
		expect(readProductsFilter("?status=any&kind=any")).toEqual({});
		// One bad parameter costs that parameter and nothing else.
		expect(readProductsFilter("?status=banana&kind=digital&low=1")).toEqual({
			productKind: "digital",
			lowStock: true,
		});
	});

	it("reads the low-stock flag as on ONLY for the value it writes", () => {
		// The flag is written as `low=1` or omitted, never as `low=0`. Everything
		// else — an old `low=0`, a hand-typed `low=true`, a typo — is the default,
		// which is off.
		expect(readProductsFilter("?low=0").lowStock).toBeUndefined();
		expect(readProductsFilter("?low=true").lowStock).toBeUndefined();
		expect(readProductsFilter("?low=banana").lowStock).toBeUndefined();
		expect(readProductsFilter("?low=1").lowStock).toBe(true);
	});
});

describe("productsFilterQuery", () => {
	it("writes nothing for the default filter", () => {
		expect(productsFilterQuery("", {})).toBe("");
	});

	it("never writes the flag as off", () => {
		expect(productsFilterQuery("", { lowStock: false })).toBe("");
		expect(productsFilterQuery("", { lowStock: true })).toBe("low=1");
	});

	it("round-trips every field it wrote", () => {
		const filter = {
			status: "archived",
			productKind: "digital",
			lowStock: true,
			search: "blue mug",
		};
		expect(readProductsFilter(`?${productsFilterQuery("", filter)}`)).toEqual(filter);
	});

	it("keeps the drill-in parameter and anything else it does not own", () => {
		const params = new URLSearchParams(productsFilterQuery("?product=abc&low=1", {}));
		expect(params.get("product")).toBe("abc");
		expect(params.get("low")).toBeNull();
	});
});

describe("the tab a link was shared from", () => {
	it("lands on the first tab when no tab was named", () => {
		expect(readOrderTab("")).toBe(0);
		expect(readProductTab("")).toBe(0);
	});

	it("lands on the first tab when the slug is not one it knows", () => {
		// A renamed or removed tab must keep an old link working rather than
		// erroring — the fallback IS the compatibility story.
		expect(readOrderTab("?tab=nonsense")).toBe(0);
		expect(readOrderTab("?tab=")).toBe(0);
		expect(readOrderTab("?tab=MONEY")).toBe(0);
		expect(readProductTab("?tab=nonsense")).toBe(0);
	});

	it("resolves a slug to its tab", () => {
		expect(readOrderTab("?tab=money")).toBe(2);
		expect(readOrderTab("?tab=history")).toBe(3);
		expect(readProductTab("?tab=stock")).toBe(1);
	});

	it("names tabs by slug, never by index", () => {
		// An index reorders silently the first time someone inserts a tab.
		expect(orderTabQuery("", 2)).toBe("tab=money");
		expect(productTabQuery("", 1)).toBe("tab=stock");
	});

	it("omits the parameter for the default tab", () => {
		expect(orderTabQuery("", 0)).toBe("");
		expect(productTabQuery("", 0)).toBe("");
		expect(orderTabQuery("?tab=money", 0)).toBe("");
	});

	it("omits the parameter for a tab that does not exist", () => {
		expect(orderTabQuery("?tab=money", 99)).toBe("");
		expect(productTabQuery("", -1)).toBe("");
	});

	it("keeps the record id beside the tab — that is the point of the link", () => {
		const params = new URLSearchParams(productTabQuery("?product=abc&q=mug", 1));
		expect(params.get("product")).toBe("abc");
		expect(params.get("q")).toBe("mug");
		expect(params.get("tab")).toBe("stock");
	});

	it("round-trips every slug it publishes", () => {
		for (const [index] of ORDER_TAB_SLUGS.entries()) {
			expect(readOrderTab(`?${orderTabQuery("", index)}`)).toBe(index);
		}
		for (const [index] of PRODUCT_TAB_SLUGS.entries()) {
			expect(readProductTab(`?${productTabQuery("", index)}`)).toBe(index);
		}
	});
});
