/**
 * The Orders console's server-free half.
 *
 * The screen itself is gated by Playwright (`sites/staging/e2e/orders-console.spec.ts`)
 * — it has to be, because the behaviours INC-20 delivers are a click, a
 * clipboard write and a focus ring, none of which a Node test can see. What a
 * Node test CAN cover, and what Playwright covers badly, is everything on either
 * side of the browser: the pure functions that decide what the screen says, and
 * the failure paths that are unreachable from a live stack without breaking it
 * on purpose.
 *
 * The failure paths are the ones an operator actually meets. A session that
 * expired in another tab is a **401**; a role that lost `plugins:manage` is a
 * **403**. Both come back from a route that is up and working. INC-19 rendered
 * the status and recorded remediation copy as deferred to this increment; these
 * tests are that deferral being closed — not "the screen said something", but
 * "the screen said what to DO".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RefundsSummary } from "../src/console-api.js";
import type { RefundRefusal } from "../src/orders/order-detail.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { fetchOrderDetail, fetchOrders, isFailure, performAction, OTTA_ADMIN_ROUTE } =
	await import("../src/console-api.js");
const { activeFilterParts, clearAnswer, ordersChrome, ordersFailureCard, pageAfterFailure } =
	await import("../src/orders/orders-list.js");
const {
	Notice,
	CopyIdButton,
	INTERACTIVE_DESCENDANT_SELECTOR,
	ROW_ACTIVATION_SLOP_PX,
	ROW_ID_ATTRIBUTE,
	Table,
	rowActivationId,
} = await import("../src/ui.js");
type RowActivationNode = import("../src/ui.js").RowActivationNode;
const { RefundsPanel, checkRefundInput, refundPanelMode } =
	await import("../src/orders/order-detail.js");
const {
	BANNER_BUDGET,
	FULLY_REFUNDED_NOTE,
	ORDERS_LOAD_MORE_FAILED_TITLE,
	ORDERS_STALE_CLEARED_NOTE,
	REFUNDS_GROUP_EMPTY_LABEL,
	REFUND_AMOUNT_INVALID,
	REFUND_BY_REQUIRED,
	RETRYING_LABEL,
	RETRY_LABEL,
	formatAmount,
	reconciliationAlertSentence,
	refundTooHighInline,
	refundsGroupLabel,
} = await import("@otta-sh/admin-presentation");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	apiFetch.mockReset();
});

describe("the active-filter summary counts what is not at its default", () => {
	test("nothing set is nothing active", () => {
		expect(activeFilterParts({}, "Any time")).toEqual([]);
	});

	test("a relative period is ONE part, named by its label", () => {
		expect(activeFilterParts({ period: "last30" }, "Last 30 days")).toEqual([
			"period: Last 30 days",
		]);
	});

	test("a custom period is TWO parts — the days themselves, not the word", () => {
		// The two dates ARE the period in the custom shape; restating "custom"
		// beside them would be a third part naming a control rather than a value.
		expect(
			activeFilterParts({ period: "custom", from: "2026-07-01", to: "2026-07-31" }, "Custom…"),
		).toEqual(["from: 2026-07-01", "to: 2026-07-31"]);
	});

	test("every authored field contributes at most one part", () => {
		expect(
			activeFilterParts({ status: "paid", period: "last7", search: "alice" }, "Last 7 days"),
		).toEqual(["status: paid", "period: Last 7 days", "search: alice"]);
	});
});

describe("a failed load stops showing the previous answer (F1)", () => {
	// The defect: the table rendered under `outcome.kind === "rows"` while the
	// notice and the count line beside it both acknowledged the failure, so
	// eighteen rows from before the failure survived it unmarked. What replaces
	// it is not one clearing but three answers, because a page-two failure
	// disproves nothing that is already on screen.
	const SERVED = { title: "HTTP 502 · Orders could not be loaded", description: "Bad gateway." };
	const VOCABULARY = {
		statuses: ["paid"],
		statusAny: "any",
		periods: [{ key: "last30", label: "Last 30 days" }],
		cancellationReasons: [],
		oneClickCancellationReasons: [],
		reconciliationOutcomes: [],
		pageLimit: 25,
	};
	const LOADED = {
		orders: [{ id: "7e4ce728" }] as never,
		nextCursor: "cursor-2",
		total: 18,
		vocabulary: VOCABULARY,
		firstPage: true,
	};

	test("COLD — nothing ever loaded: the error card alone", () => {
		const card = ordersFailureCard({ ...SERVED, continuation: false }, false);
		expect(card.kind).toBe("cold");
		// No rows, no count line, no Load more...
		expect(card.answerVisible).toBe(false);
		// ...and no filter bar (F3): the Period vocabulary comes from the page that
		// just failed, so the bar would offer an EMPTY menu beside a hard-coded
		// "All statuses". There is nothing to filter with until one arrives.
		expect(card.filtersVisible).toBe(false);
		expect(card.title).toBe(SERVED.title);
		expect(card.inline).toBe(false);
	});

	test("STALE — a first page failed under rows: the answer goes, the filters stay", () => {
		const card = ordersFailureCard({ ...SERVED, continuation: false }, true);
		expect(card.kind).toBe("stale");
		expect(card.answerVisible).toBe(false);
		// The operator's typed filters are INPUT, not answer.
		expect(card.filtersVisible).toBe(true);
		// The server's own words survive...
		expect(card.title).toBe(SERVED.title);
		expect(card.description).toContain(SERVED.description);
		// ...and the sentence that says the rows went, and why, follows them.
		expect(card.description).toContain(ORDERS_STALE_CLEARED_NOTE);
		// Focus was inside a row that no longer exists.
		expect(card.focusRetry).toBe(true);
	});

	test("PARTIAL — page two failed: every row and the count stand", () => {
		const card = ordersFailureCard({ ...SERVED, continuation: true }, true);
		expect(card.kind).toBe("partial");
		expect(card.answerVisible).toBe(true);
		// The whole-collection title is DROPPED: the rows above disprove it. What
		// failed is the next page, and that is the whole of the claim.
		expect(card.title).toBe(ORDERS_LOAD_MORE_FAILED_TITLE);
		expect(card.title).not.toBe(SERVED.title);
		expect(card.description).toBe(SERVED.description);
		// Where `Load more` was, not above the rows it did not invalidate.
		expect(card.inline).toBe(true);
		expect(card.focusRetry).toBe(false);
	});

	test("cold vs. stale is `was anything ever loaded`, never `are there rows now`", () => {
		// By the time the card is read the rows are already gone, so counting them
		// would report every stale failure as a cold one and take the filter bar
		// with it.
		expect(ordersFailureCard({ ...SERVED, continuation: false }, true).kind).toBe("stale");
		expect(ordersFailureCard({ ...SERVED, continuation: false }, false).kind).toBe("cold");
	});

	test("clearing drops the answer and keeps the vocabulary the filters are built from", () => {
		const cleared = clearAnswer(LOADED);
		expect(cleared?.orders).toEqual([]);
		// The count goes WITH the rows — `18 orders` over an error card is the same
		// false claim in fewer words.
		expect(cleared?.total).toBeUndefined();
		// And so does `Load more`, which would ask for page two of an answer that
		// no longer exists.
		expect(cleared?.nextCursor).toBeNull();
		// The Period menu's options are not the answer and survive (F3).
		expect(cleared?.vocabulary).toBe(VOCABULARY);
		expect(clearAnswer(null)).toBeNull();
	});

	test("a page BEHIND a successful one fails without clearing anything", () => {
		// The transition, not just the card: "on failure, clear the page" is right
		// for cold and stale and destroys the partial case, so which failure clears
		// is a value a test can read rather than a branch buried in the effect.
		// Page two failed — the same page object comes back, rows, count and cursor
		// untouched.
		expect(pageAfterFailure(LOADED, true)).toBe(LOADED);
		// Page one failed under those rows — the answer goes.
		expect(pageAfterFailure(LOADED, false)?.orders).toEqual([]);
		expect(pageAfterFailure(LOADED, false)?.total).toBeUndefined();
		expect(pageAfterFailure(LOADED, false)?.nextCursor).toBeNull();
		expect(pageAfterFailure(null, false)).toBeNull();
	});

	test("A LOAD IN PROGRESS IS NOT A FAILURE — the first fetch keeps the filter bar", () => {
		// Mount: no page has landed and nothing has failed. Deriving the bar from
		// "has a page landed" would take it off the screen on every mount and drop
		// it back in when the first response arrives, which is a layout shift on a
		// screen that never failed.
		const loading = ordersChrome({ failure: null, everLoaded: false, retrying: false });
		expect(loading.card).toBeNull();
		expect(loading.filtersVisible).toBe(true);
		expect(loading.answerVisible).toBe(true);

		// It is the COLD FAILURE that takes the bar, and only it (F3) — the Period
		// menu it would draw has no options.
		const cold = ordersChrome({
			failure: { ...SERVED, continuation: false },
			everLoaded: false,
			retrying: false,
		});
		expect(cold.filtersVisible).toBe(false);
		expect(cold.answerVisible).toBe(false);

		// A stale failure keeps the bar; the operator's typed filters are input.
		const stale = ordersChrome({
			failure: { ...SERVED, continuation: false },
			everLoaded: true,
			retrying: false,
		});
		expect(stale.filtersVisible).toBe(true);
		expect(stale.answerVisible).toBe(false);
	});

	test("the retry reports ITS OWN click, and nothing else the screen is loading", () => {
		// `retrying` is the only in-flight input there is: the screen-wide load flag
		// cannot reach this decision. The filter bar stays interactive in the stale
		// and partial states, so an "Apply filters" the operator pressed must not
		// make the untouched Retry beside it read "Retrying…".
		const failure = { ...SERVED, continuation: false };
		const idle = ordersChrome({ failure, everLoaded: true, retrying: false });
		expect(idle.retry.label).toBe(RETRY_LABEL);
		expect(idle.retry.disabled).toBe(false);
		expect(idle.retry.busy).toBe(false);
		// Focus was inside a row that no longer exists.
		expect(idle.retry.autoFocus).toBe(true);

		const inFlight = ordersChrome({ failure, everLoaded: true, retrying: true });
		expect(inFlight.retry.label).toBe(RETRYING_LABEL);
		expect(inFlight.retry.disabled).toBe(true);
		expect(inFlight.retry.busy).toBe(true);

		// A continuation failure renders where `Load more` was, and nothing was
		// unmounted under the operator's focus.
		expect(
			ordersChrome({
				failure: { ...SERVED, continuation: true },
				everLoaded: true,
				retrying: false,
			}).retry.autoFocus,
		).toBe(false);
	});

	test("the retry sits on the error card, and says so while it is in flight", () => {
		const inFlight = renderToStaticMarkup(
			<Notice
				variant="error"
				title="Orders could not be loaded"
				description="Bad gateway."
				action={{ label: RETRYING_LABEL, onClick: () => {}, disabled: true, busy: true }}
				testId="orders-failure"
			/>,
		);
		expect(inFlight).toContain(RETRYING_LABEL);
		expect(inFlight).toContain("disabled");
		// `disabled` alone says "unavailable"; `aria-busy` is what says "mid-flight".
		expect(inFlight).toContain('aria-busy="true"');

		const idle = renderToStaticMarkup(
			<Notice
				variant="error"
				title="Orders could not be loaded"
				description="Bad gateway."
				action={{ label: RETRY_LABEL, onClick: () => {} }}
				testId="orders-failure"
			/>,
		);
		expect(idle).toContain(RETRY_LABEL);
		expect(idle).not.toContain('aria-busy="true"');
		// Every interactive element gets the focus ring the console's one
		// stylesheet defines; a Retry the keyboard cannot see is not a way out.
		expect(idle).toContain("otta-focusable");
	});
});

describe("a refusal reaches the screen as a sentence, never as a blank pane", () => {
	test.each([
		[401, /session is no longer valid/i],
		[403, /plugins:manage/],
		[500, /Reload to try again/i],
	])("HTTP %i carries remediation, not just a status", async (status, remediation) => {
		apiFetch.mockResolvedValue(
			jsonResponse(
				{ success: false, error: { code: "NOPE", message: "Denied by policy" } },
				status,
			),
		);
		const result = await fetchOrders({});
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		// The status is stated...
		expect(result.title).toContain(`HTTP ${String(status)}`);
		// ...the SERVER's own message survives...
		expect(result.description).toContain("Denied by policy");
		// ...and so does the thing the operator can act on, which is the half
		// INC-19 deferred to this increment.
		expect(result.description).toMatch(remediation);
	});

	test("a request that never completed says so instead of claiming a status", async () => {
		apiFetch.mockRejectedValue(new Error("Failed to fetch"));
		const result = await fetchOrderDetail("7e4ce728");
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		expect(result.title).toMatch(/could not be reached/i);
		expect(result.description).toContain("Failed to fetch");
		expect(result.title).not.toContain("HTTP");
	});

	test("the plugin's own 200-with-a-refusal is passed through, copy and all", async () => {
		// G5: the plugin answers 200 and puts the outcome in the body. Its copy is
		// better than anything this layer could invent, so it must not be replaced.
		apiFetch.mockResolvedValue(
			jsonResponse({
				success: true,
				data: { ok: false, title: "Order not found", description: "No order matches that id." },
			}),
		);
		const result = await fetchOrderDetail("nope");
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		expect(result.title).toBe("Order not found");
	});

	test("a response of an unexpected shape is a refusal, not a crash", async () => {
		apiFetch.mockResolvedValue(jsonResponse({ success: true, data: { blocks: [] } }));
		const result = await fetchOrders({});
		expect(isFailure(result)).toBe(true);
	});

	test("a non-JSON error body still yields the status and the remediation", async () => {
		// A proxy or gateway in front of the admin answers HTML, not the plugin's
		// envelope. `readFailure` runs `getErrorMessage` over that body; it must
		// fall back rather than throw, and the operator must still get both halves
		// — which status refused, and what to do about it.
		apiFetch.mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 }));
		const result = await fetchOrders({});
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		expect(result.title).toContain("HTTP 502");
		expect(result.description).toMatch(/Reload to try again/i);
		// The raw markup is never what the operator reads.
		expect(result.description).not.toContain("<html>");
	});

	test("a 200 whose body is not JSON is a transport failure, not a crash", async () => {
		// `post()` only reaches `response.json()` once the status is ok, so this
		// branch is unreachable from the refusal paths above: a truncated or
		// re-written 200 lands here, and an unhandled parse error would take the
		// screen down instead of stating anything.
		apiFetch.mockResolvedValue(
			new Response("not json at all", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const result = await fetchOrders({});
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		expect(result.title).toMatch(/could not be reached/i);
		expect(result.title).not.toContain("HTTP");
	});
});

describe("the one data path (ADR-0014 Decision 3)", () => {
	test("every call goes to `otta`'s admin route, and nowhere else", async () => {
		apiFetch.mockResolvedValue(
			jsonResponse({ success: true, data: { ok: true, orders: [], nextCursor: null } }),
		);
		await fetchOrders({ status: "paid" });
		await fetchOrderDetail("7e4ce728");
		await performAction("orders:refund", { orderId: "7e4ce728" });

		expect(apiFetch).toHaveBeenCalledTimes(3);
		for (const [url, init] of apiFetch.mock.calls) {
			// `otta`, never `otta-console`: the console holds no routes of its own.
			expect(url).toBe(OTTA_ADMIN_ROUTE);
			expect(url).toContain("/plugins/otta/admin");
			expect(init?.method).toBe("POST");
		}
	});

	test("a write forwards the action id and value UNTOUCHED", async () => {
		// Everything in `value` — the id, the watermark, the amount in minor units
		// — is re-validated against live truth by the Block Kit handler on the
		// other side. This layer must not helpfully reshape any of it.
		apiFetch.mockResolvedValue(jsonResponse({ success: true, data: { ok: true, notice: null } }));
		const value = {
			orderId: "7e4ce728-0000-4000-8000-000000000001",
			amountCents: "1999",
			refundedSoFarCents: "0",
			currency: "USD",
			reason: "",
			refundedBy: "ops",
		};
		await performAction("orders:refund", value);
		const body = JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body["action_id"]).toBe("orders:refund");
		expect(body["value"]).toEqual(value);
	});

	test("a read sends the filter as the plugin's own form shape", async () => {
		apiFetch.mockResolvedValue(
			jsonResponse({ success: true, data: { ok: true, orders: [], nextCursor: null } }),
		);
		await fetchOrders({ status: "paid", period: "last30", search: "alice" }, "cursor-1");
		const body = JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body["resource"]).toBe("orders.list");
		expect(body["cursor"]).toBe("cursor-1");
		expect(body["filter"]).toEqual({ status: "paid", period: "last30", search: "alice" });
	});
});

describe("presentation primitives that carry an accessibility promise", () => {
	test("a notice announces itself — the content arrives after the interaction", () => {
		const html = renderToStaticMarkup(
			<Notice variant="error" title="Not refunded" description="Nothing was changed." />,
		);
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("Not refunded");
		expect(html).toContain("Nothing was changed.");
	});

	test("the copy button names the id it copies, so a column of them is navigable", () => {
		const id = "7e4ce728-0000-4000-8000-000000000001";
		const html = renderToStaticMarkup(<CopyIdButton id={id} />);
		// A screen reader moving down this column otherwise hears "copy, copy,
		// copy" with no way to tell which row it is on.
		expect(html).toContain(`aria-label="Copy full order id ${id}"`);
		// And the FULL id is what it holds — §1.3's React tier in one attribute.
		expect(html).toContain(`data-full-id="${id}"`);
		expect(html).toContain("otta-focusable");
	});
});

describe("the copy button survives an origin without a clipboard", () => {
	test("a missing `navigator.clipboard` renders the fallback instead of throwing", () => {
		// ON A NON-SECURE ORIGIN `navigator.clipboard` IS UNDEFINED — the plain-HTTP
		// staging box an operator is most likely to be on. The first cut called
		// `.writeText()` on it unconditionally, so the failure was a SYNCHRONOUS
		// TypeError: no promise existed, `.catch()` never ran, the error escaped,
		// and the label stayed `Copy` — the button silently doing nothing, which is
		// the worst of the three outcomes on a screen where the copied value goes
		// into a refund.
		const clipboard = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", {
			value: {},
			configurable: true,
		});
		try {
			const html = renderToStaticMarkup(<CopyIdButton id="7e4ce728-0000" />);
			// It renders at all — the throw would have taken the whole row with it.
			expect(html).toContain('data-full-id="7e4ce728-0000"');
		} finally {
			if (clipboard !== undefined) Object.defineProperty(globalThis, "navigator", clipboard);
			else Reflect.deleteProperty(globalThis as object, "navigator");
		}
	});
});

describe("the React detail renders the SHARED reconciliation sentence", () => {
	// THE OTHER HALF OF THE CROSS-SURFACE PIN. `orders-console-route.sandbox.test.ts`
	// asserts the BLOCK KIT render contains `reconciliationAlertSentence(...)`;
	// nothing asserted it here, and this side had a hand-copied template with the
	// same words and none of the budget trim. Two pins, one function, so a change
	// to either screen's wording fails a test on both.
	const FLAG = "captured 1380 vs authorised 1200";

	test("the banner is the shared function's output, character for character", () => {
		const html = renderToStaticMarkup(
			<Notice
				variant="alert"
				title="Needs reconciliation"
				description={reconciliationAlertSentence(FLAG)}
			/>,
		);
		expect(html).toContain("Needs reconciliation");
		// The flag the SERVICE produced reaches the operator...
		expect(html).toContain(FLAG);
		// ...and so does the instruction that follows it.
		expect(html).toContain("Resolve it under Fulfilment");
	});

	test("a long flag is TRIMMED to the banner budget, not rendered whole", () => {
		// The budget is the reason this had to be shared rather than copied: the
		// sentence's length is service data, so a screen that interpolates it
		// itself has no budget at all. `fitBanner` lives inside the shared
		// function, so both surfaces get the trim by construction.
		const sentence = reconciliationAlertSentence("x".repeat(500));
		expect(sentence.length).toBe(BANNER_BUDGET);
		expect(sentence.endsWith("…")).toBe(true);
	});
});

/** A refunds summary at a given ceiling and remainder, consistent in its other
 *  totals so the panel's own money lines cannot be what an assertion reads. */
function refundsSummary(ceilingCents: number, remainingCents: number): RefundsSummary {
	return {
		refunds: [],
		currency: "USD",
		capturedTotalCents: ceilingCents,
		refundedTotalCents: ceilingCents - remainingCents,
		ceilingCents,
		remainingCents,
		paymentMethod: "card",
		refundable: true,
	};
}

/**
 * The refunds panel alone, rendered from its props: a summary in, one of three
 * modes out, with no screen around it. Its drafts, its standing refusal and its
 * two focus refs arrive from outside, which is what lets a mode be posed here
 * directly instead of being driven to.
 *
 * THIS TIER STATES WHAT THE PANEL DOES WITH THE SUMMARY IT IS HANDED, AND ONLY
 * THAT. It cannot state that the screen hands it the right one: nothing here
 * renders through `OrderDetail`, which loads in an effect and opens on another
 * tab. The mounted screen's own wiring — the status it rings, the tab that
 * reaches this panel, the amounts it puts in it — is asserted in
 * `order-detail-dom.test.tsx`, which has a document to load into.
 */
function renderRefundsPanel(
	refunds: RefundsSummary,
	amountError: RefundRefusal | null = null,
): string {
	return renderToStaticMarkup(
		<RefundsPanel
			refunds={refunds}
			currency="USD"
			busy={false}
			askRefund={() => undefined}
			amountInput=""
			setAmountInput={() => undefined}
			refundReason=""
			setRefundReason={() => undefined}
			refundedBy=""
			setRefundedBy={() => undefined}
			amountError={amountError}
			setAmountError={() => undefined}
			amountRef={{ current: null }}
			refundedByRef={{ current: null }}
		/>,
	);
}

/** The single rendered tag carrying a given `data-testid`, so an assertion can
 *  read one input's or one message's own attributes without the substring
 *  search bleeding into the other input beside it. */
function tagFor(html: string, testId: string): string {
	const match = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
	if (match === null) throw new Error(`no element tagged ${testId} in: ${html}`);
	return match[0];
}

/** An attribute's value off a tag string as `tagFor` returns it — `null` when
 *  the attribute was not rendered at all, never an empty string standing in
 *  for absence. */
function attr(tag: string, name: string): string | null {
	const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
	return match === null ? null : (match[1] ?? null);
}

describe("the refunds group's sentence agrees with its own heading", () => {
	// AN ORDER THAT WAS NEVER CAPTURED WAS TOLD IT WAS FULLY REFUNDED. Captured,
	// Refunded and Remaining all read $0.00, the ledger was empty, the heading
	// said "nothing captured, nothing to refund" — and the sentence one line
	// below said "Fully refunded". The test was on the REMAINDER, which is zero
	// both when everything has been refunded and when there was never anything
	// to refund. The ceiling is what separates those two.
	test("a zero ceiling is nothing to refund, not everything refunded", () => {
		expect(refundPanelMode({ ceilingCents: 0, remainingCents: 0 })).toBe("empty");
	});

	test("a real capture that has been fully refunded still says so", () => {
		expect(refundPanelMode({ ceilingCents: 4500, remainingCents: 0 })).toBe("fully-refunded");
	});

	test("anything still refundable keeps the form", () => {
		expect(refundPanelMode({ ceilingCents: 4500, remainingCents: 1200 })).toBe("form");
	});

	// THE ORIGINAL DEFECT WAS TWO COPIES OF ONE PREDICATE, not a wrong predicate.
	// The heading and the sentence under it each decided the panel's state for
	// themselves, so they were free to disagree — and did. The trio above covers
	// the predicate; these cover the WIRING, by rendering the panel in each of its
	// three states and reading the heading and the body TOGETHER out of one piece
	// of markup. A second, independent test at either call site that answers
	// differently from `refundPanelMode` — which is the whole of the defect —
	// changes what one of them renders, and fails here.
	test("a zero ceiling renders its heading and nothing claiming a refund", () => {
		const html = renderRefundsPanel(refundsSummary(0, 0));
		expect(html).toContain(REFUNDS_GROUP_EMPTY_LABEL);
		// The defect itself: "Fully refunded" one line under "nothing captured".
		expect(html).not.toContain('data-testid="refunds-full-note"');
		expect(html).not.toContain('data-testid="refund-partial"');
	});

	test("a fully refunded capture renders both its heading and its note", () => {
		const html = renderRefundsPanel(refundsSummary(4500, 0));
		expect(html).toContain(refundsGroupLabel(formatAmount(4500, "USD"), formatAmount(4500, "USD")));
		expect(html).not.toContain(REFUNDS_GROUP_EMPTY_LABEL);
		expect(html).toContain('data-testid="refunds-full-note"');
		expect(html).toContain(FULLY_REFUNDED_NOTE);
	});

	test("a partly refunded capture renders the refund form", () => {
		const html = renderRefundsPanel(refundsSummary(4500, 1200));
		expect(html).toContain(refundsGroupLabel(formatAmount(3300, "USD"), formatAmount(4500, "USD")));
		expect(html).toContain('data-testid="refund-partial"');
		expect(html).toContain('data-testid="refund-amount"');
		expect(html).not.toContain('data-testid="refunds-full-note"');
	});

	test("the ceiling decides the state — never the captured total, which is independent (F10)", () => {
		// Every fixture above sets `capturedTotalCents` equal to `ceilingCents`, so
		// a re-derivation keyed on the captured total instead of the ceiling would
		// render identically in all three. They are independent fields on
		// `RefundsSummary`, and "never captured" is the ceiling's own claim — a
		// captured total surviving beside a zero ceiling must still read as
		// nothing to refund.
		const html = renderRefundsPanel({
			refunds: [],
			currency: "USD",
			capturedTotalCents: 4500,
			refundedTotalCents: 0,
			ceilingCents: 0,
			remainingCents: 0,
			paymentMethod: "card",
			refundable: true,
		});
		expect(html).toContain(REFUNDS_GROUP_EMPTY_LABEL);
		expect(html).not.toContain('data-testid="refunds-full-note"');
		expect(html).not.toContain('data-testid="refund-partial"');
	});

	// A WARNING ABOUT AN ACTION THE PANEL IS REFUSING TO OFFER. The capability
	// line rendered unconditionally, so an order that was never captured was told
	// that refunding here issues a REAL refund through Stripe and money moves back
	// to the buyer — one line under a heading saying there is nothing to refund.
	// It is the same `refundPanelMode` that withdraws it, not a second predicate,
	// because two copies of this decision is how the heading and the body drifted
	// apart in the first place.
	test("nothing captured means nothing is said about how a refund would move money", () => {
		const html = renderRefundsPanel(refundsSummary(0, 0));
		expect(html).not.toContain('data-testid="refund-capability"');
		expect(html).not.toContain("Stripe");
	});

	test("a real capture still states how a refund would move money", () => {
		const html = renderRefundsPanel(refundsSummary(4500, 1200));
		expect(html).toContain('data-testid="refund-capability"');
		expect(html).toContain("Stripe");
	});

	// The line is about a CAPTURE, not about a remaining balance: an order that
	// was captured and then fully refunded still has refunds on it that moved
	// real money, and the operator reading that ledger is owed the same sentence.
	test("a capture that has been fully refunded keeps the line", () => {
		expect(renderRefundsPanel(refundsSummary(4500, 0))).toContain(
			'data-testid="refund-capability"',
		);
	});
});

describe("each refund refusal names the field it is about", () => {
	// THREE REFUSALS, TWO FIELDS. A refusal that could not say which input it
	// meant could only ever focus one of them, and the third would move focus to
	// a field the operator had already filled in correctly.
	test("an unparseable amount is about the amount", () => {
		const check = checkRefundInput("nineteen", "ops", 4500, "USD");
		expect(check.ok).toBe(false);
		if (check.ok) return;
		expect(check.refusal.field).toBe("amount");
		expect(check.refusal.message).toBe(REFUND_AMOUNT_INVALID);
	});

	test("an amount over the remainder is about the amount", () => {
		const check = checkRefundInput("99.99", "ops", 4500, "USD");
		expect(check.ok).toBe(false);
		if (check.ok) return;
		expect(check.refusal.field).toBe("amount");
		// The over-ceiling copy stays the SHARED sentence, money and all.
		expect(check.refusal.message).toBe(
			refundTooHighInline(formatAmount(9999, "USD"), formatAmount(4500, "USD")),
		);
	});

	test("nobody recorded as issuing it is about `refunded by`", () => {
		const check = checkRefundInput("19.99", "   ", 4500, "USD");
		expect(check.ok).toBe(false);
		if (check.ok) return;
		expect(check.refusal.field).toBe("refundedBy");
		expect(check.refusal.message).toBe(REFUND_BY_REQUIRED);
	});

	test("a valid refund parses to exact minor units and refuses nothing", () => {
		const check = checkRefundInput("19.99", "ops", 4500, "USD");
		expect(check.ok).toBe(true);
		if (!check.ok) return;
		expect(check.amountCents).toBe(1999);
	});
});

describe("a standing refusal accents the field it names, and only that field (F20)", () => {
	// F20 extracted this markup so the panel could be statically rendered for the
	// first time; `amountError` was `null` in every fixture above, so none of it
	// — the accent rule, the weight, the `aria-invalid`/`aria-describedby` pair —
	// had unit coverage. THREE REFUSALS, TWO FIELDS, as above: the amount input
	// carries two of them and `refunded by` carries the third, and the mark must
	// land only on the input the standing refusal actually names.
	const FORM = refundsSummary(4500, 1200);

	test("an unparseable amount marks the amount input, and only the amount input", () => {
		const check = checkRefundInput("nineteen", "ops", 4500, "USD");
		expect(check.ok).toBe(false);
		if (check.ok) return;
		const html = renderRefundsPanel(FORM, check.refusal);
		const message = tagFor(html, "refund-amount-error");
		const messageId = attr(message, "id");
		expect(messageId).not.toBeNull();
		expect(html).toContain(check.refusal.message);
		expect(message).toMatch(/font-weight:\s?600/);
		expect(message).toMatch(/border-inline-start:\s?3px solid #c53030/);
		const offending = tagFor(html, "refund-amount");
		const other = tagFor(html, "refund-by");
		expect(attr(offending, "aria-invalid")).toBe("true");
		expect(attr(offending, "aria-describedby")).toBe(messageId);
		expect(attr(other, "aria-invalid")).toBeNull();
		expect(attr(other, "aria-describedby")).toBeNull();
	});

	test("an amount over the remainder marks the amount input, and only the amount input", () => {
		const check = checkRefundInput("99.99", "ops", 4500, "USD");
		expect(check.ok).toBe(false);
		if (check.ok) return;
		const html = renderRefundsPanel(FORM, check.refusal);
		const message = tagFor(html, "refund-amount-error");
		const messageId = attr(message, "id");
		expect(messageId).not.toBeNull();
		expect(html).toContain(check.refusal.message);
		expect(message).toMatch(/font-weight:\s?600/);
		expect(message).toMatch(/border-inline-start:\s?3px solid #c53030/);
		const offending = tagFor(html, "refund-amount");
		const other = tagFor(html, "refund-by");
		expect(attr(offending, "aria-invalid")).toBe("true");
		expect(attr(offending, "aria-describedby")).toBe(messageId);
		expect(attr(other, "aria-invalid")).toBeNull();
		expect(attr(other, "aria-describedby")).toBeNull();
	});

	test("nobody recorded as issuing it marks the `refunded by` input, and only that input", () => {
		const check = checkRefundInput("19.99", "   ", 4500, "USD");
		expect(check.ok).toBe(false);
		if (check.ok) return;
		const html = renderRefundsPanel(FORM, check.refusal);
		const message = tagFor(html, "refund-amount-error");
		const messageId = attr(message, "id");
		expect(messageId).not.toBeNull();
		expect(html).toContain(check.refusal.message);
		expect(message).toMatch(/font-weight:\s?600/);
		expect(message).toMatch(/border-inline-start:\s?3px solid #c53030/);
		const offending = tagFor(html, "refund-by");
		const other = tagFor(html, "refund-amount");
		expect(attr(offending, "aria-invalid")).toBe("true");
		expect(attr(offending, "aria-describedby")).toBe(messageId);
		expect(attr(other, "aria-invalid")).toBeNull();
		expect(attr(other, "aria-describedby")).toBeNull();
	});

	test("with no standing refusal, no input carries aria-describedby or aria-invalid", () => {
		const html = renderRefundsPanel(FORM, null);
		expect(html).not.toContain('data-testid="refund-amount-error"');
		const amount = tagFor(html, "refund-amount");
		const by = tagFor(html, "refund-by");
		expect(attr(amount, "aria-invalid")).toBeNull();
		expect(attr(amount, "aria-describedby")).toBeNull();
		expect(attr(by, "aria-invalid")).toBeNull();
		expect(attr(by, "aria-describedby")).toBeNull();
	});
});
/**
 * ROW ACTIVATION (F11). The row tints on hover; these are the rules that decide
 * whether a click on it actually opens anything.
 *
 * `rowActivationId` is exercised directly rather than through a rendered table
 * because this package has no DOM test environment — and because the decision is
 * the thing worth pinning. The fake node below implements only what the guard
 * reads (`closest`, `getAttribute`, `contains`) against the REAL selector
 * constants, so a change to either one is caught here.
 */
describe("row activation guards", () => {
	interface FakeSpec {
		tag: string;
		rowId?: string;
	}

	const matches = (spec: FakeSpec, selectors: string): boolean =>
		selectors.split(",").some((raw) => {
			const selector = raw.trim();
			if (selector === `[${ROW_ID_ATTRIBUTE}]`) return spec.rowId !== undefined;
			return selector === spec.tag;
		});

	/** `chain[0]` is the event target; each entry after it is its next ancestor. */
	const nodeFor = (chain: readonly FakeSpec[], index = 0): RowActivationNode => ({
		closest(selectors: string): RowActivationNode | null {
			for (let at = index; at < chain.length; at += 1) {
				const spec = chain[at];
				if (spec !== undefined && matches(spec, selectors)) return nodeFor(chain, at);
			}
			return null;
		},
		getAttribute(name: string): string | null {
			const spec = chain[index];
			if (spec === undefined) return null;
			return name === ROW_ID_ATTRIBUTE ? (spec.rowId ?? null) : null;
		},
		contains(other: unknown): boolean {
			// The fake's "descendants" are everything earlier in the chain.
			return chain.slice(0, index + 1).includes(other as FakeSpec);
		},
	});

	const BARE_CELL: readonly FakeSpec[] = [
		{ tag: "td" },
		{ tag: "tr", rowId: "ord_9f2" },
		{ tag: "tbody" },
	];
	const STEADY = {
		modified: false,
		origin: { x: 100, y: 60 },
		point: { x: 100, y: 60 },
		selection: null,
	} as const;

	test("a click on a bare cell activates that row, and the id comes off the row", () => {
		expect(rowActivationId(nodeFor(BARE_CELL), STEADY)).toBe("ord_9f2");
		// A row with no id attribute is inert, which is what keeps the four detail
		// tables — same `Table`, no `onActivateRow` — from activating anything.
		expect(rowActivationId(nodeFor([{ tag: "td" }, { tag: "tr" }]), STEADY)).toBeNull();
		// A click that landed outside any row activates nothing.
		expect(rowActivationId(nodeFor([{ tag: "tbody" }]), STEADY)).toBeNull();
		expect(rowActivationId(null, STEADY)).toBeNull();
	});

	test("a click inside an interactive descendant is that control's, not the row's", () => {
		// This is what stops the drill-in link navigating twice and the Copy
		// button copying AND navigating.
		for (const tag of ["a", "button", "input", "select", "textarea", "summary", "label"]) {
			const chain = [{ tag: "span" }, { tag }, ...BARE_CELL];
			expect(rowActivationId(nodeFor(chain), STEADY)).toBeNull();
		}
		expect(INTERACTIVE_DESCENDANT_SELECTOR).not.toContain("code");
	});

	test("the SKU's `code` element is NOT exempt — the cell stays live", () => {
		const chain = [{ tag: "code" }, ...BARE_CELL];
		expect(rowActivationId(nodeFor(chain), STEADY)).toBe("ord_9f2");
	});

	test("a press that travelled more than 4px was a drag, not a click", () => {
		const at = (x: number, y: number) =>
			rowActivationId(nodeFor(BARE_CELL), { ...STEADY, point: { x, y } });
		expect(ROW_ACTIVATION_SLOP_PX).toBe(4);
		// Measured from the MOUSEDOWN to the CLICK. Exactly 4px is still a click —
		// a careful click on a trackpad must not be swallowed.
		expect(at(104, 60)).toBe("ord_9f2");
		expect(at(100, 56)).toBe("ord_9f2");
		expect(at(105, 60)).toBeNull();
		expect(at(103, 63)).toBeNull();
		// A click with no press behind it is not one this body saw begin.
		expect(rowActivationId(nodeFor(BARE_CELL), { ...STEADY, origin: null })).toBeNull();
	});

	test("a live selection inside the row means the merchant was selecting text", () => {
		const anchor = BARE_CELL[0];
		const withSelection = (selection: { collapsed: boolean; anchor: unknown }) =>
			rowActivationId(nodeFor(BARE_CELL), { ...STEADY, selection });
		expect(withSelection({ collapsed: false, anchor })).toBeNull();
		// A caret is not a selection, and a selection somewhere else is not this
		// row's business.
		expect(withSelection({ collapsed: true, anchor })).toBe("ord_9f2");
		expect(withSelection({ collapsed: false, anchor: { tag: "elsewhere" } })).toBe("ord_9f2");
		expect(withSelection({ collapsed: false, anchor: null })).toBe("ord_9f2");
	});

	test("a modified click on a bare cell does nothing — the row is not a link", () => {
		expect(rowActivationId(nodeFor(BARE_CELL), { ...STEADY, modified: true })).toBeNull();
	});

	test("an activatable row takes no tab stop and no role", () => {
		const html = renderToStaticMarkup(
			<Table caption="Orders" headers={["Order #"]} onActivateRow={() => undefined}>
				<tr className="otta-row" data-row-id="ord_9f2">
					<td className="otta-td">
						<a href="?order=ord_9f2">9f2</a>
					</td>
				</tr>
			</Table>,
		);
		// The link is already a tab stop that Enter already opens; a second one per
		// row would double keyboard traversal on a forty-row list.
		expect(html).not.toContain("tabindex");
		expect(html).not.toMatch(/<tr[^>]*role=/);
		expect(html).toContain(`${ROW_ID_ATTRIBUTE}="ord_9f2"`);
	});
});
