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
const { activeFilterParts, clearAnswer, visibleDegradation, UNTITLED } =
	await import("../src/products/products-list.js");
const {
	CopyIdButton,
	WARN_ACCENT,
	CONSOLE_STYLES,
	INTERACTIVE_DESCENDANT_SELECTOR,
	ROW_ID_ATTRIBUTE,
	rowActivationId,
} = await import("../src/ui.js");
const {
	IdentityFields,
	LeaveConfirm,
	PriceGroup,
	ProductTabs,
	ShippingFields,
	changedFields,
	changedPriceFields,
	leaveNeedsConfirm,
	nextFormKeys,
	nextWritePhase,
	sectionForAction,
	writeControls,
} = await import("../src/products/product-detail.js");
type WriteEvent = import("../src/products/product-detail.js").WriteEvent;
type WritePhase = import("../src/products/product-detail.js").WritePhase;
const {
	LOW_STOCK_FILTER_DESCRIPTION,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	PRODUCTS_NOUN,
	listOutcome,
	PRODUCTS_EMPTY,
	PRODUCTS_NO_MATCH,
	priceSavedNotice,
} = await import("@otta-sh/admin-presentation");
const { OTTA_CONSOLE_ADMIN_PAGES, PRODUCTS_PAGE } = await import("../src/index.js");
const admin = await import("../src/admin.js");

/** A priced, in-stock, live product — the ordinary case the Price group's four
 *  states are argued about. Synthetic throughout. */
const PRICED = {
	productId: "prod-1",
	sku: "APR-LIN-NAT",
	title: "Linen apron",
	priceCents: 900,
	currency: "USD",
	taxClass: "standard",
	compareAtCents: null,
	compareAtCurrency: null,
	unitCostCents: null,
	unitCostCurrency: null,
	inventoryPolicy: "deny",
	weightGrams: 420,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "physical",
	active: true,
	deletedAt: null,
	onHand: 12,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
} as const;

/** The tabs and both panels, with recognisable stand-ins for the two real ones
 *  — what is under test is which of them is in the DOM, not what they contain. */
function renderTabs(tab: number, unsaved: readonly boolean[]): string {
	return renderToStaticMarkup(
		<ProductTabs
			labels={["Product", "Stock"]}
			tab={tab}
			unsaved={unsaved}
			onSelect={() => undefined}
			panels={[<p key="p">the product forms</p>, <p key="s">the stock forms</p>]}
		/>,
	);
}

/** The one rendered tag carrying `data-testid`, so a style assertion is about
 *  the field it names and not about "somewhere in the group". */
function tagFor(html: string, testId: string): string {
	const found = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
	if (found === null) throw new Error(`no element with data-testid="${testId}"`);
	return found[0];
}

/** The three sections' dirty record, clean. */
const NO_SECTION_DIRTY = { identity: false, price: false, shipping: false } as const;
const noop = (): undefined => undefined;

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

describe("a failed load stops showing the previous answer (F2)", () => {
	// The same defect class as Orders, on a simpler screen: there is no
	// accumulated-pages case to preserve here, so EVERY failure clears.
	const page = {
		products: [{ productId: "p-1" }] as never,
		nextCursor: "cursor-2",
		total: 12,
		stock: { threshold: 3, unreadable: false, filterUnavailable: false },
		vocabulary: {
			statuses: [{ value: "true", label: "Active" }],
			kinds: [{ value: "physical", label: "Physical" }],
			any: "any",
			pageLimit: 25,
		},
		firstPage: true,
	};

	test("the table goes, and the `12 products · …` count goes with it", () => {
		const cleared = clearAnswer(page);
		expect(cleared?.products).toEqual([]);
		// A count over an error notice is the same false claim in fewer words.
		expect(cleared?.total).toBeUndefined();
		// And `Load more` would ask for page two of an answer that no longer exists.
		expect(cleared?.nextCursor).toBeNull();
	});

	test("the filter panel keeps the vocabulary it is built from", () => {
		// Clearing the page wholesale would answer a failed load by emptying both
		// selects — the operator would be left unable to retry it differently,
		// which is the cold-failure defect F3 names on the Orders bar.
		const cleared = clearAnswer(page);
		expect(cleared?.vocabulary).toBe(page.vocabulary);
		expect(cleared?.stock).toBe(page.stock);
		expect(clearAnswer(null)).toBeNull();
	});

	test("the stock alert is withdrawn with the rows it was about", () => {
		// `stock` survives the clear because the filter panel is built from it — but
		// "Stock levels are unavailable — for every row here" describes rows the
		// failure has just taken off the screen, so leaving it up would stand a
		// second stale claim beside the failure notice.
		const degradedPage = {
			...page,
			stock: { threshold: null, unreadable: true, filterUnavailable: false },
		};
		expect(visibleDegradation(degradedPage, false)?.title).toContain(
			"Stock levels are unavailable",
		);
		expect(visibleDegradation(degradedPage, true)).toBeUndefined();
		// A healthy page says nothing either way, and nothing has loaded to say it.
		expect(visibleDegradation(page, false)).toBeUndefined();
		expect(visibleDegradation(null, false)).toBeUndefined();
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

	test("a price save's four states are DERIVED, and none of them is latched (F4)", () => {
		// The one that a `touched` boolean gets wrong, and the reason this compares
		// values instead: type a character into the price and delete it again, and
		// there is nothing to save. A form that stayed dirty would offer a save that
		// writes nothing and still bumps `updatedAt`.
		const committed = { price: "9.00", currency: "USD", compareAt: "", unitCost: "" };
		expect(changedFields(committed, committed)).toEqual([]);
		expect(changedFields(committed, { ...committed, price: "99.99" })).toEqual(["price"]);
		// …and it reports WHICH field, so only the changed input takes the border.
		expect(changedFields(committed, { ...committed, compareAt: "29.99" })).toEqual(["compareAt"]);
		expect(changedFields(committed, { ...committed, price: "9.0" })).toEqual(["price"]);
		expect(changedFields(committed, { ...committed, price: "9.00" })).toEqual([]);
	});

	test("the Price group asks about AMOUNTS, so a save returns it to clean (F4)", () => {
		// The state that made the four states contradict each other. `9.9` and
		// `9.90` are one amount, but only the committed side is ever respelled by
		// the formatter: a save of `9.9` succeeds, the re-read commits `9.90`, and
		// a raw string comparison then reports the group as still holding unsaved
		// work — ` · unsaved`, a warn border and a re-armed `Save` for a write that
		// changes nothing and still bumps `updatedAt`, beside a receipt saying the
		// price was updated.
		const committed = { price: "9.90", currency: "USD", compareAt: "", unitCost: "" };
		expect(changedPriceFields(committed, { ...committed, price: "9.9" })).toEqual([]);
		expect(changedPriceFields(committed, { ...committed, price: " 9.90 " })).toEqual([]);
		// Currency is stored in one case, and `usd` is not a different currency.
		const unpriced = { price: "", currency: "USD", compareAt: "", unitCost: "" };
		expect(changedPriceFields(unpriced, { ...unpriced, currency: " usd " })).toEqual([]);
		// Still compared and still not latched, and a real edit is still an edit.
		expect(changedPriceFields(committed, committed)).toEqual([]);
		expect(changedPriceFields(committed, { ...committed, price: "99.99" })).toEqual(["price"]);
		expect(changedPriceFields(committed, { ...committed, compareAt: "29.99" })).toEqual([
			"compareAt",
		]);
		// A blank price leaves the price unchanged and a blank compare-at CLEARS
		// it; neither is the same as the amount already there, and neither is zero.
		expect(changedPriceFields(committed, { ...committed, price: "" })).toEqual(["price"]);
		expect(changedPriceFields(committed, { ...committed, price: "0.00" })).toEqual(["price"]);
		// An entry that does not parse still reads as a change, so the write still
		// happens and the write's own refusal is what the operator sees.
		expect(changedPriceFields(committed, { ...committed, price: "abc" })).toEqual(["price"]);
	});

	test("a write is released by its re-read, NOT by the write answering (F4)", () => {
		// THE RACE THIS CLOSES. The POST answers, and only the re-read after it
		// moves `updatedAt` — so a `Save` re-armed in the gap is armed against an
		// `expectedUpdatedAt` the service has already superseded, and the second
		// click reports a concurrency error for a save that in fact succeeded.
		// Asserted on the reducer because there is no DOM environment here: the
		// screen sets neither guard at a call site, it reports these events and
		// reads `busy`/`acting` back out, so the sequence below IS the behaviour.
		const SAVE = "products:save-price";
		const run = (...events: readonly WriteEvent[]): WritePhase =>
			events.reduce<WritePhase>(nextWritePhase, { step: "idle" });

		// The click: everything disabled, and exactly one button may say `Saving…`.
		expect(writeControls(run({ type: "dispatched", actionId: SAVE }))).toEqual({
			busy: true,
			acting: SAVE,
		});

		// The write has ANSWERED and the screen has not caught up with it. This is
		// the assertion that fails the moment the release moves back into the
		// write's own `.then`, which is what it is here for.
		const accepted = run({ type: "dispatched", actionId: SAVE }, { type: "accepted" });
		expect(accepted.step).toBe("rereading");
		expect(writeControls(accepted)).toEqual({ busy: true, acting: SAVE });

		// The re-read landing is the one event that re-arms the screen — and it
		// re-arms it whether the re-read succeeded or failed, because the screen
		// reports it before it checks, rather than stranding the controls.
		expect(writeControls(nextWritePhase(accepted, { type: "read-settled" }))).toEqual({
			busy: false,
			acting: null,
		});

		// A REFUSED write is released at once: nothing moved, so no re-read is
		// coming and there is no superseded watermark to be armed against.
		expect(
			writeControls(
				run({ type: "dispatched", actionId: SAVE }, { type: "refused", actionId: SAVE }),
			),
		).toEqual({ busy: false, acting: null });

		// A late or duplicated answer cannot re-arm a leg that already settled, and
		// the mount read of an idle screen disables nothing.
		expect(
			writeControls(
				run(
					{ type: "dispatched", actionId: SAVE },
					{ type: "accepted" },
					{ type: "read-settled" },
					{ type: "accepted" },
				),
			),
		).toEqual({ busy: false, acting: null });
		expect(writeControls(run({ type: "read-settled" }))).toEqual({ busy: false, acting: null });
	});

	test("a clean Price group disables Save and says why", () => {
		// The screen's one no-op write. Disabling it without the hint would be a
		// dead control; the hint without disabling it would be advice.
		const html = renderToStaticMarkup(
			<PriceGroup
				product={PRICED}
				busy={false}
				saving={false}
				receipt={null}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("No changes to save.");
		expect(html).toContain('data-testid="save-price" disabled=""');
		// Nothing pending, nothing to discard, and no receipt for a save nobody made.
		expect(html).not.toContain('data-testid="price-pending"');
		expect(html).not.toContain('data-testid="discard-price"');
		expect(html).not.toContain('data-testid="price-receipt"');
		expect(html).not.toContain("· unsaved");
	});

	test("the acting button says `Saving…` while its own write is outstanding", () => {
		// `busy` alone would put the word on all three save buttons, which reports
		// two writes that are not happening. `aria-busy` is what distinguishes
		// mid-flight from merely unavailable for a screen-reader user.
		const html = renderToStaticMarkup(
			<PriceGroup
				product={PRICED}
				busy={true}
				saving={true}
				receipt={null}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("Saving…");
		expect(html).not.toContain("Save price");
		expect(html).toContain('aria-busy="true"');
	});

	test("the receipt renders INSIDE the section, under the button, and nothing dismisses it", () => {
		// Page top is where the operator is not looking. The ordering assertion is
		// the half that matters: a receipt above the field it reports on reads as a
		// precondition rather than an outcome.
		const html = renderToStaticMarkup(
			<PriceGroup
				product={PRICED}
				busy={false}
				saving={false}
				receipt={priceSavedNotice("$9.00 → $99.99")}
				onSubmit={() => undefined}
			/>,
		);
		expect(html).toContain("Price updated — live on the storefront");
		expect(html).toContain("orders already placed keep the price they were charged");
		expect(html.indexOf('data-testid="price-receipt"')).toBeGreaterThan(
			html.indexOf('data-testid="save-price"'),
		);
		// Inside the group, not beside it.
		expect(html.startsWith("<details")).toBe(true);
	});

	test("a refusal releases the write it NAMES, and a second dispatch cannot retarget one", () => {
		// Carried from increment 2's re-review. Unreachable today — every submit is
		// `busy`-gated, so there is never a second write to be confused with — but
		// the failure is silent if that gate ever loosens: an unguarded refusal
		// releases whatever is outstanding, so a superseded write's refusal would
		// re-arm every control in the middle of a live one.
		const SAVE = "products:save-price";
		const OTHER = "products:save-shipping";
		const writing = nextWritePhase({ step: "idle" }, { type: "dispatched", actionId: SAVE });

		// A refusal for a DIFFERENT write changes nothing: the live one is still
		// writing, and still the one the button reports.
		expect(nextWritePhase(writing, { type: "refused", actionId: OTHER })).toEqual(writing);
		expect(writeControls(nextWritePhase(writing, { type: "refused", actionId: OTHER }))).toEqual({
			busy: true,
			acting: SAVE,
		});
		// Its own refusal still releases it.
		expect(nextWritePhase(writing, { type: "refused", actionId: SAVE })).toEqual({ step: "idle" });
		// And a second dispatch does not overwrite the outstanding write's id —
		// which would hand the FIRST write's answer to the second.
		expect(nextWritePhase(writing, { type: "dispatched", actionId: OTHER })).toEqual(writing);
		// A refusal arriving after everything settled releases nothing either.
		expect(nextWritePhase({ step: "idle" }, { type: "refused", actionId: SAVE })).toEqual({
			step: "idle",
		});
	});

	test("only a SECTION save re-seeds a form, and only its own (F7)", () => {
		// The `key` bump is this map. Bumped on someone else's save it would
		// destroy the drafts F6 exists to protect — the defect inverted — and a
		// stock movement owns no form on the Product tab at all.
		expect(sectionForAction("products:save-identity")).toBe("identity");
		expect(sectionForAction("products:save-price")).toBe("price");
		expect(sectionForAction("products:save-shipping")).toBe("shipping");
		expect(sectionForAction("products:restock")).toBeNull();
		expect(sectionForAction("products:remove-stock")).toBeNull();
	});

	test("a dirty IDENTITY group borders the changed field and marks its summary (F6)", () => {
		// The Price group had this treatment before this increment; Identity and
		// shipping did not. Rendered at BOTH states from the same component, so the
		// assertion is the wiring — `changedFields` being right proves nothing about
		// whether this group asks it anything.
		const props = {
			product: PRICED,
			busy: false,
			report: noop,
			onChange: noop,
			onSubmit: noop,
		} as const;
		const clean = renderToStaticMarkup(
			<IdentityFields
				{...props}
				committed={{ sku: "APR-LIN-NAT" }}
				values={{ sku: "APR-LIN-NAT" }}
			/>,
		);
		expect(clean).not.toContain("· unsaved");
		expect(tagFor(clean, "edit-sku")).not.toContain(WARN_ACCENT);

		const dirty = renderToStaticMarkup(
			<IdentityFields
				{...props}
				committed={{ sku: "APR-LIN-NAT" }}
				values={{ sku: "APR-LIN-XL" }}
			/>,
		);
		// On the SUMMARY line, so a SHUT group cannot hide the work.
		expect(dirty).toMatch(/<summary[^>]*>(?:(?!<\/summary>).)*· unsaved/s);
		// A border, never a text colour — the accent has to survive both themes.
		expect(tagFor(dirty, "edit-sku")).toContain(`2px solid ${WARN_ACCENT}`);
	});

	test("a dirty SHIPPING group borders ONLY the field that changed (F6)", () => {
		const props = {
			product: PRICED,
			taxClasses: [{ id: "standard", name: "Standard" }],
			busy: false,
			report: noop,
			onChange: noop,
			onSubmit: noop,
		} as const;
		const committed = {
			productKind: "physical",
			taxClass: "standard",
			weightGrams: "420",
			lengthMm: "",
			widthMm: "",
			heightMm: "",
		};
		const clean = renderToStaticMarkup(
			<ShippingFields {...props} committed={committed} values={committed} />,
		);
		expect(clean).not.toContain("· unsaved");
		expect(tagFor(clean, "edit-weight")).not.toContain(WARN_ACCENT);

		const dirty = renderToStaticMarkup(
			<ShippingFields
				{...props}
				committed={committed}
				values={{ ...committed, weightGrams: "500" }}
			/>,
		);
		expect(dirty).toMatch(/<summary[^>]*>(?:(?!<\/summary>).)*· unsaved/s);
		expect(tagFor(dirty, "edit-weight")).toContain(`2px solid ${WARN_ACCENT}`);
		// Six fields, one changed: marking the other five would say the operator
		// edited things they never touched.
		for (const id of ["edit-kind", "edit-tax-class", "edit-length", "edit-width", "edit-height"]) {
			expect(tagFor(dirty, id)).not.toContain(WARN_ACCENT);
		}
	});

	test("a save re-seeds its OWN form and leaves both siblings' drafts mounted (F7)", () => {
		const keys = { identity: 0, price: 3, shipping: 7 } as const;

		// The saving section remounts…
		const afterPrice = nextFormKeys(keys, "price");
		expect(afterPrice.price).toBe(4);
		// …AND THIS IS THE ASSERTION THE INCREMENT IS FOR. Bump all three and the
		// sibling forms remount against the record, discarding exactly the drafts
		// F6 exists to protect — the original defect, inverted.
		expect(afterPrice.identity).toBe(0);
		expect(afterPrice.shipping).toBe(7);

		expect(nextFormKeys(keys, "identity")).toEqual({ identity: 1, price: 3, shipping: 7 });
		expect(nextFormKeys(keys, "shipping")).toEqual({ identity: 0, price: 3, shipping: 8 });

		// A stock movement owns no form on the Product tab, and a write that was
		// refused never named a section — neither may move anything. Same OBJECT,
		// so React bails out instead of reconciling three forms for nothing.
		expect(nextFormKeys(keys, sectionForAction("products:restock"))).toBe(keys);
		expect(nextFormKeys(keys, sectionForAction("products:remove-stock"))).toBe(keys);
		expect(nextFormKeys(keys, null)).toBe(keys);
	});

	test("Back asks only when there is work to lose, and the ask NAMES it (F8)", () => {
		// The predicate the back link reads. A clean product must go straight back:
		// a dialog on every exit is the tax that teaches operators to dismiss them.
		expect(leaveNeedsConfirm(NO_SECTION_DIRTY)).toBe(false);
		expect(leaveNeedsConfirm({ ...NO_SECTION_DIRTY, identity: true })).toBe(true);
		expect(leaveNeedsConfirm({ ...NO_SECTION_DIRTY, price: true })).toBe(true);
		expect(leaveNeedsConfirm({ ...NO_SECTION_DIRTY, shipping: true })).toBe(true);

		const open = renderToStaticMarkup(
			<LeaveConfirm
				open={true}
				dirty={{ ...NO_SECTION_DIRTY, price: true }}
				onStay={noop}
				onLeave={noop}
			/>,
		);
		expect(open).toContain('data-testid="detail-leave-confirm"');
		expect(open).toContain("Leave without saving?");
		expect(open).toContain("Price");
		expect(open).toContain("Leaving this product discards them.");
		expect(open).toContain("Leave and discard");
		expect(open).toContain("Stay");
		// Derived, never hard-coded: two dirty sections are both named, in screen
		// order, and the section that is clean is not.
		const multi = renderToStaticMarkup(
			<LeaveConfirm
				open={true}
				dirty={{ identity: true, price: false, shipping: true }}
				onStay={noop}
				onLeave={noop}
			/>,
		);
		expect(multi.indexOf("Identity")).toBeGreaterThan(-1);
		// `&` arrives escaped — this is the rendered dialog, not the copy module.
		expect(multi.indexOf("Classification &amp; shipping")).toBeGreaterThan(
			multi.indexOf("Identity"),
		);
		expect(multi).not.toContain("Price");

		// Shut, it composes nothing — a sentence naming a section that has since
		// been saved must not be sitting inside the dialog waiting to be shown.
		const shut = renderToStaticMarkup(
			<LeaveConfirm
				open={false}
				dirty={{ ...NO_SECTION_DIRTY, price: true }}
				onStay={noop}
				onLeave={noop}
			/>,
		);
		expect(shut).toContain('data-testid="detail-leave-confirm"');
		expect(shut).not.toContain("Leave without saving?");
		expect(shut).not.toContain("Leave and discard");
		expect(shut).not.toContain("Price");
	});

	test("BOTH tab panels are rendered, and the inactive one is `hidden`, not gone (F6)", () => {
		// THE WHOLE OF F6. The panel used to be rendered conditionally on the
		// active tab, so a switch unmounted three forms and React discarded every
		// draft in them. `hidden` keeps the node — and therefore the state — while
		// taking it out of the accessibility tree and the tab order.
		const onProduct = renderTabs(0, [false, false]);
		// Both panels exist in both tab states — this is the assertion that fails
		// the moment anyone reaches for a conditional again.
		expect(onProduct).toContain("the product forms");
		expect(onProduct).toContain("the stock forms");
		expect(onProduct).toMatch(/id="otta-panel-1"[^>]*hidden=""/);
		expect(onProduct).not.toMatch(/id="otta-panel-0"[^>]*hidden=""/);

		const onStock = renderTabs(1, [false, false]);
		expect(onStock).toContain("the product forms");
		expect(onStock).toMatch(/id="otta-panel-0"[^>]*hidden=""/);
		expect(onStock).not.toMatch(/id="otta-panel-1"[^>]*hidden=""/);

		// The free side effect, and it is a real defect closed: each tab's
		// `aria-controls` pointed at its own panel id while only the ACTIVE panel
		// was rendered, so the inactive tab controlled nothing that existed.
		for (const html of [onProduct, onStock]) {
			const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
			expect(controls).toEqual(["otta-panel-0", "otta-panel-1"]);
			for (const id of controls) expect(html).toContain(`id="${String(id)}"`);
		}
	});

	test("a tab holding unsaved work carries a dot AND says so in its name (F6)", () => {
		const html = renderToStaticMarkup(
			<ProductTabs
				labels={["Product", "Stock"]}
				tab={1}
				unsaved={[true, false]}
				onSelect={() => undefined}
				panels={[<p key="p">forms</p>, <p key="s">stock</p>]}
			/>,
		);
		// The dot is a shape and is hidden from assistive technology — "bullet"
		// reports nothing — so the fact it stands for is the accessible name.
		expect(html).toContain('aria-label="Product — unsaved changes"');
		expect(html).toContain('data-testid="tab-product-unsaved"');
		expect(html).toContain('aria-hidden="true"');
		// The clean tab keeps its plain name and takes no dot.
		expect(html).not.toContain('aria-label="Stock');
		expect(html).not.toContain('data-testid="tab-stock-unsaved"');
	});

	test("a clean screen puts no dot on any tab", () => {
		const html = renderToStaticMarkup(
			<ProductTabs
				labels={["Product", "Stock"]}
				tab={0}
				unsaved={[false, false]}
				onSelect={() => undefined}
				panels={[<p key="p">forms</p>, <p key="s">stock</p>]}
			/>,
		);
		expect(html).not.toContain("unsaved");
		// The tablist keeps its own name; no BUTTON takes one.
		expect(html).toContain('aria-label="Product sections"');
		expect(html).not.toContain('aria-label="Product "');
		expect(html).not.toMatch(/<button[^>]*aria-label=/);
	});

	test("the low-stock control's description is page-scoped", () => {
		// The filter narrows the FETCHED PAGE, so a description promising "every
		// low-stock product" would be a claim the screen cannot keep.
		expect(LOW_STOCK_FILTER_DESCRIPTION).toContain("applies per page");
	});
});
/**
 * ROW ACTIVATION on the screen whose second column is a code (F11). The guards
 * themselves are pinned in the Orders suite; what matters here is that the SKU
 * cell survives them — it must be selectable AND activatable, and its copy
 * button must be neither.
 */
describe("row activation and the SKU cell", () => {
	const cell = (tag: string, inControl: string | null) => ({
		closest: (selectors: string) => {
			const wanted = selectors.split(",").map((raw) => raw.trim());
			if (wanted.includes(`[${ROW_ID_ATTRIBUTE}]`)) return row;
			if (inControl !== null && wanted.includes(inControl)) return row;
			return wanted.includes(tag) ? row : null;
		},
		getAttribute: () => "prod_41c",
		contains: () => false,
	});
	const row = {
		closest: () => row,
		getAttribute: (name: string) => (name === ROW_ID_ATTRIBUTE ? "prod_41c" : null),
		contains: () => false,
	};
	const STEADY = {
		modified: false,
		origin: { x: 10, y: 10 },
		point: { x: 10, y: 10 },
		selection: null,
	} as const;

	test("clicking the SKU opens the product; clicking Copy beside it does not", () => {
		// `code` is deliberately not exempt: exempting it would make the one cell a
		// merchant most needs the one cell that does nothing.
		expect(rowActivationId(cell("code", null), STEADY)).toBe("prod_41c");
		expect(rowActivationId(cell("span", "button"), STEADY)).toBeNull();
		expect(rowActivationId(cell("span", "a"), STEADY)).toBeNull();
	});

	test("the pointer stops at the row's controls", () => {
		const sheet = CONSOLE_STYLES.replace(/\s+/g, " ");
		// Scoped to rows that actually activate, so the four detail tables — same
		// `Table`, no callback, no row id — keep the default cursor.
		expect(sheet).toContain(`.otta-row[${ROW_ID_ATTRIBUTE}] { cursor: pointer; }`);
		// `!important` is load-bearing: `Button` and `CopyIdButton` set `cursor`
		// inline, and an inline declaration outranks a rule in this sheet without
		// it — leaving the pointer promising row activation on a control that
		// copies.
		expect(sheet).toContain(
			`.otta-row[${ROW_ID_ATTRIBUTE}] :is(${INTERACTIVE_DESCENDANT_SELECTOR}) ` +
				"{ cursor: auto !important; }",
		);
		expect(INTERACTIVE_DESCENDANT_SELECTOR).not.toContain("code");
	});
});
