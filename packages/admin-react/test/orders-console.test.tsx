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

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { fetchOrderDetail, fetchOrders, isFailure, performAction, OTTA_ADMIN_ROUTE } =
	await import("../src/console-api.js");
const { activeFilterParts, clearAnswer, ordersFailureCard } =
	await import("../src/orders/orders-list.js");
const { Notice, CopyIdButton } = await import("../src/ui.js");
const {
	BANNER_BUDGET,
	ORDERS_LOAD_MORE_FAILED_TITLE,
	ORDERS_STALE_CLEARED_NOTE,
	RETRYING_LABEL,
	RETRY_LABEL,
	reconciliationAlertSentence,
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
		const vocabulary = {
			statuses: ["paid"],
			statusAny: "any",
			periods: [{ key: "last30", label: "Last 30 days" }],
			cancellationReasons: [],
			oneClickCancellationReasons: [],
			reconciliationOutcomes: [],
			pageLimit: 25,
		};
		const cleared = clearAnswer({
			orders: [{ id: "7e4ce728" }] as never,
			nextCursor: "cursor-2",
			total: 18,
			vocabulary,
			firstPage: true,
		});
		expect(cleared?.orders).toEqual([]);
		// The count goes WITH the rows — `18 orders` over an error card is the same
		// false claim in fewer words.
		expect(cleared?.total).toBeUndefined();
		// And so does `Load more`, which would ask for page two of an answer that
		// no longer exists.
		expect(cleared?.nextCursor).toBeNull();
		// The Period menu's options are not the answer and survive (F3).
		expect(cleared?.vocabulary).toBe(vocabulary);
		expect(clearAnswer(null)).toBeNull();
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
