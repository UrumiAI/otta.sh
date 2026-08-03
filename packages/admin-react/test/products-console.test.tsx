/**
 * The Pricing & inventory console's server-free half (INC-21).
 *
 * The screen itself is gated by Playwright
 * (`sites/staging/e2e/products-console.spec.ts`) — it has to be, because the
 * behaviours INC-21 delivers are a click, a confirm dialog and a focus ring,
 * none of which a Node test can see. What a Node test CAN cover, and what
 * Playwright covers badly, is everything on either side of the browser: the
 * pure functions that decide what the screen says, the exact shape each write
 * puts on the wire, and the failure paths that are unreachable from a live
 * stack without breaking it on purpose.
 *
 * THE WIRE SHAPES ARE THE INTERESTING HALF HERE, in a way they were not on
 * Orders. Four of this screen's five writes become `form_submit`s on the other
 * side, and the plugin decides which payload keys ride in the carrier — so a
 * key this screen forgets to send is a watermark the handler never sees, and a
 * key it sends that it should not is a field the wire would carry. Both are
 * asserted below rather than left to an end-to-end run to notice.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const {
	PRODUCTS_ACT_SUBJECT,
	fetchProductDetail,
	fetchProducts,
	isFailure,
	performAction,
	OTTA_ADMIN_ROUTE,
} = await import("../src/console-api.js");
const { activeFilterParts, UNTITLED } = await import("../src/products/products-list.js");
const { CopyIdButton } = await import("../src/ui.js");
const {
	LOW_STOCK_FILTER_DESCRIPTION,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	PRODUCTS_NOUN,
	listOutcome,
	PRODUCTS_EMPTY,
	PRODUCTS_NO_MATCH,
} = await import("@otta-sh/admin-presentation");
const { OTTA_CONSOLE_ADMIN_PAGES, PRODUCTS_PAGE } = await import("../src/index.js");
const admin = await import("../src/admin.js");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** The envelope the plugin's route answers with. */
function envelope(data: unknown): Response {
	return jsonResponse({ data });
}

function lastBody(): Record<string, unknown> {
	const init = apiFetch.mock.calls.at(-1)?.[1];
	return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
	apiFetch.mockReset();
});

describe("the screen is declared, and the console can actually render it", () => {
	test("the descriptor declares `/products` and `./admin` has a component for it", () => {
		// A path declared with no component under the same key makes the sidebar
		// SILENTLY drop the entry — no error, no warning, just a screen nobody can
		// reach. That is the failure this pins, and it is the same pin
		// `console-plugin.test.ts` makes for the shell.
		expect(OTTA_CONSOLE_ADMIN_PAGES.map((page) => page.path)).toContain("/products");
		expect(Object.keys(admin.pages as Record<string, unknown>)).toContain(PRODUCTS_PAGE.path);
	});

	test("the sidebar label carries NO disambiguating suffix — there is nothing left to disambiguate", () => {
		// It read `Pricing & inventory (new)` while both descriptors declared
		// `/products`, because two entries of that name with nothing to tell them
		// apart would have been the worst outcome of the two-descriptor
		// arrangement. INC-R3 retired the Block Kit screen, so the suffix expires
		// with the thing it distinguished this one FROM (ADR-0015 Decision 1).
		expect(PRODUCTS_PAGE.label).toBe("Pricing & inventory");
	});
});

describe("the active-filter summary counts what is not at its default", () => {
	test("nothing set is nothing active", () => {
		expect(activeFilterParts({}, "any")).toEqual([]);
	});

	test("the sentinel is not a filter", () => {
		// `any` is a real word rather than `""` precisely so it can be rendered in
		// a select trigger — which means it also has to be recognised as "no
		// constraint" here, or an untouched panel would report one active filter.
		expect(activeFilterParts({ status: "any", productKind: "any" }, "any")).toEqual([]);
	});

	test("the COMBINED status select contributes one part, as it does on Block Kit", () => {
		// `active` and `archived` share one control (a soft-deleted row is always
		// inactive), so L-3 counts them once. The raw token is what the Block Kit
		// summary renders, and matching it is the point.
		expect(activeFilterParts({ status: "archived" }, "any")).toEqual(["status: archived"]);
		expect(activeFilterParts({ status: "true" }, "any")).toEqual(["status: true"]);
	});

	test("every authored field contributes at most one part", () => {
		expect(
			activeFilterParts(
				{ status: "false", productKind: "digital", lowStock: true, search: "APR" },
				"any",
			),
		).toEqual(["status: false", "kind: digital", "stock: low only", "search: APR"]);
	});

	test("an empty search box is not a filter", () => {
		expect(activeFilterParts({ search: "" }, "any")).toEqual([]);
	});
});

describe("the list ladder is the SHARED one, page-scoped when the narrowing is on", () => {
	test("a low-stock page with another page behind it SCANS rather than emptying", () => {
		// The ordinary case on a real catalog: page 1 of a healthy store holds no
		// low-stock rows at all. An empty state here would sit on top of
		// `Load more` and dead-end the filter on a sentence that is also false.
		const outcome = listOutcome({
			count: 0,
			filtered: true,
			firstPage: true,
			hasNext: true,
			noun: PRODUCTS_NOUN,
			empty: PRODUCTS_EMPTY,
			noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
		});
		expect(outcome.kind).toBe("scan");
		expect(outcome.kind === "scan" && outcome.scanNote).toBe(PRODUCTS_LOW_STOCK_NO_MATCH.scanNote);
	});

	test("a WITHHELD total leaves the count describing the page, not the catalog", () => {
		// The plugin omits `total` while "Low stock only" is on, because the
		// service counted the unnarrowed set. The React list must then say the
		// smaller, true thing rather than inventing one.
		const outcome = listOutcome({
			count: 3,
			filtered: true,
			firstPage: true,
			hasNext: true,
			noun: PRODUCTS_NOUN,
			empty: PRODUCTS_EMPTY,
			noMatch: PRODUCTS_LOW_STOCK_NO_MATCH,
		});
		expect(outcome.countLine).toBe("3 products on this page");
	});

	test("a total that IS forwarded describes the whole filtered set", () => {
		const outcome = listOutcome({
			count: 25,
			filtered: false,
			firstPage: true,
			hasNext: true,
			total: 137,
			noun: PRODUCTS_NOUN,
			empty: PRODUCTS_EMPTY,
			noMatch: PRODUCTS_NO_MATCH,
		});
		expect(outcome.countLine).toBe("137 products");
	});

	test("an empty catalog offers no way IN, because products originate in the CMS", () => {
		const outcome = listOutcome({
			count: 0,
			filtered: false,
			firstPage: true,
			hasNext: false,
			noun: PRODUCTS_NOUN,
			empty: PRODUCTS_EMPTY,
			noMatch: PRODUCTS_NO_MATCH,
		});
		expect(outcome.kind === "empty" && outcome.offer).toBe("way-in");
		expect(outcome.kind === "empty" && outcome.title).toBe("No products yet");
	});
});

describe("the one data path (ADR-0014 Decision 3)", () => {
	test("every products call goes to `otta`'s admin route, and nowhere else", async () => {
		apiFetch.mockResolvedValue(envelope({ ok: true, products: [], nextCursor: null }));
		await fetchProducts({});
		await fetchProductDetail("prod-1");
		for (const call of apiFetch.mock.calls) expect(call[0]).toBe(OTTA_ADMIN_ROUTE);
	});

	test("a read sends the filter as the plugin's own form shape", async () => {
		apiFetch.mockResolvedValue(envelope({ ok: true, products: [], nextCursor: null }));
		await fetchProducts({ status: "archived", lowStock: true, search: "APR" }, "cur-2");
		const body = lastBody();
		expect(body["type"]).toBe("otta_console_read");
		expect(body["resource"]).toBe("products.list");
		expect(body["filter"]).toEqual({ status: "archived", lowStock: true, search: "APR" });
		expect(body["cursor"]).toBe("cur-2");
	});

	test("a write forwards the action id and value UNTOUCHED", async () => {
		// The plugin re-assembles the carrier from these exact keys, so anything
		// this layer normalised would be a watermark the handler never sees.
		apiFetch.mockResolvedValue(envelope({ ok: true, notice: null }));
		await performAction(
			"products:restock",
			{ productId: "prod-1", onHand: "42", qty: "12" },
			PRODUCTS_ACT_SUBJECT,
		);
		const body = lastBody();
		expect(body["type"]).toBe("otta_console_act");
		expect(body["action_id"]).toBe("products:restock");
		expect(body["value"]).toEqual({ productId: "prod-1", onHand: "42", qty: "12" });
	});

	test("a refusal NAMES THIS SCREEN, not the other one", async () => {
		// A console with two migrated screens can refuse on either, and "Orders are
		// unavailable" on Pricing & inventory sends an operator to look at the
		// wrong thing.
		apiFetch.mockResolvedValue(jsonResponse({}, 403));
		const result = await fetchProducts({});
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		expect(result.title).toBe("Pricing & inventory is unavailable (HTTP 403)");
		expect(result.description).toContain("plugins:manage");
	});

	test("a session that expired says how to fix it, not merely that it failed", async () => {
		apiFetch.mockResolvedValue(jsonResponse({}, 401));
		const result = await fetchProductDetail("prod-1");
		expect(isFailure(result) && result.description).toContain("Reload this page to sign in again");
	});

	test("the plugin's own 200-with-a-refusal is passed through, copy and all", async () => {
		// G5: the plugin answers its OWN refusals at HTTP 200, and its copy is
		// better than anything this layer could invent.
		apiFetch.mockResolvedValue(
			envelope({
				ok: false,
				title: "Product not found",
				description: "No product matches that id.",
			}),
		);
		const result = await fetchProductDetail("nope");
		expect(isFailure(result) && result.title).toBe("Product not found");
	});
});

describe("presentation primitives this screen relies on", () => {
	test("the SKU copy button names a SKU, not an order id", () => {
		// §1.3 exempts a natural key, so this screen copies a SKU rendered in full
		// rather than the full form of a truncated uuid. A screen-reader user must
		// hear the right noun.
		const html = renderToStaticMarkup(<CopyIdButton id="APR-LIN-NAT" what="SKU" />);
		expect(html).toContain('aria-label="Copy SKU APR-LIN-NAT"');
		expect(html).toContain('data-full-id="APR-LIN-NAT"');
	});

	test("the Orders wording is still the default, so INC-20's contract is untouched", () => {
		const html = renderToStaticMarkup(<CopyIdButton id="7e4ce728" />);
		expect(html).toContain('aria-label="Copy full order id 7e4ce728"');
	});

	test("a product with no title reads as `(untitled)`, never as its id", () => {
		expect(UNTITLED).toBe("(untitled)");
	});

	test("the low-stock control's description is page-scoped", () => {
		// The filter narrows the FETCHED PAGE, so a description promising "every
		// low-stock product" would be a claim the screen cannot keep.
		expect(LOW_STOCK_FILTER_DESCRIPTION).toContain("applies per page");
	});
});
