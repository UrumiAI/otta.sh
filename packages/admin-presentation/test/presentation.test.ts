/**
 * `@otta-sh/admin-presentation` on its own terms.
 *
 * WHAT THIS FILE IS FOR, given that the code it covers is not new. The plugin's
 * existing suites (`format-money.test.ts`, `money-parity.test.ts`, the type
 * test, and all 18 workerd sandbox files) still exercise every one of these
 * functions through `@otta-sh/plugin`'s re-exports — that is the drift proof,
 * and it is why the extraction did not need a new copy of those assertions.
 *
 * What they cannot cover is the thing the extraction ADDS: a second consumer
 * that reaches these functions directly, in a browser, with no plugin in the
 * graph. So this file asserts the properties that are CROSS-SURFACE — the ones
 * whose whole value is that both admin tiers get the same answer — plus the
 * package's own boundary conditions:
 *
 *  - money renders from integer minor units with no float in the path (G1);
 *  - the date dialect is the one INC-13 settled on, UTC-pinned, minutes only;
 *  - §1.3's prefix relationship holds — a row prefix is always a `startsWith`
 *    prefix of the confirm dialog's fixed 8, which is what lets an operator
 *    match `#7e4c` on the React list against `#7e4ce728` in a refund confirm;
 *  - the status vocabulary marks exactly the four states the domain's state
 *    machine gives no outbound transition, and `completed` is not one of them.
 */
import { describe, expect, test } from "vitest";
import {
	ABSENT,
	CANCEL_BANNER,
	DATE_LOCALE,
	LABEL_BUDGET,
	MARK_REFUNDED_CONFIRM,
	NOTHING_ON_PAGE,
	NO_CHANGES_TO_SAVE,
	NO_TAX_CLASS,
	ORDERS_EMPTY,
	ORDERS_LOAD_MORE_FAILED_TITLE,
	ORDERS_NOUN,
	ORDERS_NO_MATCH,
	ORDERS_STALE_CLEARED_NOTE,
	ORDER_STATES,
	PAGE_ZERO,
	PRICE_PENDING_CONTEXT,
	REFUND_ADDITIVE_NOTE,
	REFUND_REVIEW_STEP_PREFIX,
	RESOLVE_RECONCILIATION_NOTE,
	RETRYING_LABEL,
	RETRY_LABEL,
	SCAN_FURTHER,
	SHORT_ID_CONFIRM_LEN,
	SHORT_ID_MIN,
	TERMINAL_ORDER_STATES,
	UNNAMED_REFUND_RECIPIENT,
	addStockConfirm,
	buyerReferenceText,
	canonicalMoneyInput,
	cancelConfirmText,
	cents,
	currency,
	dayOf,
	dimensionsSummary,
	endOfDay,
	formatDate,
	formatDay,
	formatAmount,
	formatMoney,
	formatOptionalAmount,
	formatTimestamp,
	PRODUCT_SECTION_ORDER,
	SPLIT_DISCARD_CONTEXT,
	dirtyGroupLabel,
	dirtySectionLabels,
	identityGroupLabel,
	leaveWithoutSavingConfirm,
	listOutcome,
	tabUnsavedLabel,
	majorUnits,
	onHandCell,
	orderStateCell,
	parseOnHandWatermark,
	parseStockQty,
	priceChangeSummary,
	priceGroupLabel,
	pricePendingLine,
	priceSavedNotice,
	refundConfirmText,
	refundTooHighText,
	removeStockConfirm,
	rowCountLine,
	shippingGroupLabel,
	shortIdFixed,
	shortIdsFor,
	startOfDay,
	statusLabel,
	statusTone,
	stockTone,
	stockDegradation,
	taxClassLabel,
	taxClassOptions,
} from "../src/index.js";

const USD = currency("USD");

describe("the words a failed load is answered with (F1, F2)", () => {
	test("the retry label and its in-flight form are authored here, not at the call sites", () => {
		// Three screens offer a retry — two lists and the product detail — and a
		// label spelled per screen is exactly the drift this package exists to
		// prevent.
		expect(RETRY_LABEL).toBe("Retry");
		expect(RETRYING_LABEL).toBe("Retrying…");
		// The in-flight form is the same word: an operator watching the button must
		// see it change state, not change subject.
		expect(RETRYING_LABEL.startsWith("Retry")).toBe(true);
	});

	test("the stale sentence says the rows went AND why, in the past tense", () => {
		// The rows are already gone by the time this is read, and the operator
		// watched them go. It has to read as the screen refusing to state something
		// it no longer knows, not as data loss.
		expect(ORDERS_STALE_CLEARED_NOTE).toBe(
			"The orders that were here have been cleared — they were from an earlier request and may no longer be current.",
		);
	});

	test("a continuation failure makes the SMALLER claim", () => {
		// The service's refusal is about the whole collection; on page two the rows
		// already on screen disprove that. What failed is the next page.
		expect(ORDERS_LOAD_MORE_FAILED_TITLE).toBe("Couldn't load more orders");
		expect(ORDERS_LOAD_MORE_FAILED_TITLE).toContain("more");
	});
});

describe("the package imports nothing", () => {
	test("every module is dependency-free", async () => {
		// The two consumers are a browser bundle and a workerd bundle produced
		// from a bare scratch copy; a single import of anything would break one
		// of them, and it would break it at RUNTIME rather than here. Reading the
		// sources is the cheapest way to make that structural claim testable.
		const { readdirSync, readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
		const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(4);
		for (const name of files) {
			const source = readFileSync(srcDir + name, "utf8");
			for (const specifier of source.matchAll(/from\s+"([^"]+)"/g)) {
				expect(specifier[1], `${name} imports ${String(specifier[1])}`).toMatch(/^\.\//);
			}
		}
	});
});

describe("money (G1)", () => {
	test("renders integer minor units, never a float", () => {
		expect(formatMoney(cents(1999), USD, "en-US")).toBe("$19.99");
		expect(formatMoney(cents(5), USD, "en-US")).toBe("$0.05");
		expect(formatMoney(cents(0), USD, "en-US")).toBe("$0.00");
	});

	test("honours the currency's own minor-unit count", () => {
		// JPY has none. A hard-coded /100 would print ¥19.99 for 1999 yen.
		expect(formatMoney(cents(1999), currency("JPY"), "en-US")).toBe("¥1,999");
	});

	test("majorUnits is locale-independent and schema.org-shaped", () => {
		expect(majorUnits(cents(1999), USD)).toBe("19.99");
		expect(majorUnits(cents(1999), currency("JPY"))).toBe("1999");
	});

	test("the mints reject what the brands promise they reject", () => {
		// A float LITERAL does not compile at all — `cents(4.99)` is a type error,
		// which is the primary guard and is pinned by
		// `packages/plugin/test/format-money.type-test.ts`. Here the values go in
		// dynamically, which is how a wire-parsed amount actually arrives, so what
		// is under test is the RUNTIME half of the same rule.
		const float: number = Number.parseFloat("4.99");
		expect(() => cents(float)).toThrow(RangeError);
		expect(() => cents(-1)).toThrow(RangeError);
		expect(() => currency("usd")).toThrow(RangeError);
		expect(() => currency("DOLLARS")).toThrow(RangeError);
	});
});

describe("the console's one date dialect (INC-13)", () => {
	test("a wire timestamp renders as the dialect, UTC-pinned", () => {
		expect(formatTimestamp("2026-07-08T10:30:00Z")).toBe("8 Jul 2026, 10:30 UTC");
	});

	test("an offset is RENDERED in UTC, not passed through", () => {
		// 15:30+05:00 is 10:30Z. The old pass-through put a non-UTC offset on
		// screen; this is a rendering of the instant, which is the M-6 rule.
		expect(formatTimestamp("2026-07-08T15:30:00+05:00")).toBe("8 Jul 2026, 10:30 UTC");
	});

	test("midnight is 00:00, never 24:00", () => {
		expect(formatTimestamp("2026-07-08T00:00:00Z")).toBe("8 Jul 2026, 00:00 UTC");
	});

	test("formatDate is a strict PREFIX of formatTimestamp on the same instant", () => {
		// This is what collapsed the order detail's habit of stating "placed"
		// twice in two formats — the H1 and the identity strip say the same
		// words, the strip just says more of them. It must survive the move.
		const iso = "2026-07-08T10:30:00Z";
		expect(formatTimestamp(iso).startsWith(formatDate(iso))).toBe(true);
	});

	test("an unparseable value stays visible instead of becoming an invented date", () => {
		expect(formatTimestamp("not-a-date")).toBe("not-a-date");
		// `formatDate` caps instead of passing through — it feeds the order
		// detail's H1, the largest type on the page, where unbounded unrecognised
		// text is a worse failure than a stub. 10 is `YYYY-MM-DD`'s width.
		expect(formatDate("2026-13-99T00:00:00Z")).toBe("2026-13-99");
		expect(formatDate("a".repeat(200))).toHaveLength(10);
	});

	test("day bounds are whole days, both ends inclusive", () => {
		expect(startOfDay("2026-07-08")).toBe("2026-07-08T00:00:00.000Z");
		expect(endOfDay("2026-07-08")).toBe("2026-07-08T23:59:59.999Z");
		// A full datetime passes through rather than being re-anchored.
		expect(startOfDay("2026-07-08T09:00:00.000Z")).toBe("2026-07-08T09:00:00.000Z");
	});

	test("formatDay drops the year only when asked", () => {
		expect(formatDay("2026-07-01", false)).toBe("1 Jul");
		expect(formatDay("2026-07-01", true)).toBe("1 Jul 2026");
	});

	test("dayOf is the UTC calendar day", () => {
		expect(dayOf(new Date("2026-07-08T23:59:59.999Z"))).toBe("2026-07-08");
	});

	test("the locale is the single localizable point, and it is pinned", () => {
		expect(DATE_LOCALE).toBe("en-GB");
	});
});

describe("short ids (§1.3) — the property is CROSS-SURFACE", () => {
	test("a computed prefix is the floor when nothing collides", () => {
		const ids = ["7e4ce728-aaaa-4000-8000-000000000001", "91b02f13-bbbb-4000-8000-000000000002"];
		const prefixes = shortIdsFor(ids);
		expect(prefixes.get(ids[0] as string)).toBe("7e4c");
		expect(prefixes.get(ids[1] as string)).toBe("91b0");
	});

	test("it extends one character at a time, and only for the ids that collide", () => {
		const collide = [
			"7e4ca000-0000-4000-8000-000000000001",
			"7e4cb000-0000-4000-8000-000000000002",
		];
		const other = "91b02f13-0000-4000-8000-000000000003";
		const prefixes = shortIdsFor([...collide, other]);
		expect(prefixes.get(collide[0] as string)).toBe("7e4ca");
		expect(prefixes.get(collide[1] as string)).toBe("7e4cb");
		// The uninvolved id keeps the floor — a collision does not renumber the page.
		expect(prefixes.get(other)).toBe("91b0");
	});

	test("it is deterministic in the SET, not in the order", () => {
		const ids = ["7e4ca000-x", "7e4cb000-y", "91b02f13-z"];
		const forward = shortIdsFor(ids);
		const reversed = shortIdsFor(ids.toReversed());
		expect([...forward.entries()].toSorted()).toEqual([...reversed.entries()].toSorted());
	});

	test("`min` raises the floor and cannot lower it", () => {
		const ids = ["7e4ce728-aaaa", "91b02f13-bbbb"];
		expect(shortIdsFor(ids, 2).get(ids[0] as string)).toBe("7e4c");
		expect(shortIdsFor(ids, 8).get(ids[0] as string)).toBe("7e4ce728");
		expect(shortIdsFor(ids, Number.NaN).get(ids[0] as string)).toBe("7e4c");
	});

	test("THE LOAD-BEARING ONE: a row prefix is a startsWith prefix of the confirm prefix", () => {
		// The React list row, the Block Kit row and the picker all show a
		// computed prefix; a refund confirm shows the fixed 8. An operator must
		// be able to see at a glance that they are the same order. That is only
		// true because the fixed length is longer than the floor, and it must
		// stay true for every id on a page — including colliding ones.
		const page = [
			"7e4ce728-0000-4000-8000-000000000001",
			"7e4ce728-1111-4000-8000-000000000002", // agrees with the first for 8 chars
			"91b02f13-0000-4000-8000-000000000003",
			"91b02f14-0000-4000-8000-000000000004",
		];
		const prefixes = shortIdsFor(page);
		for (const id of page) {
			const row = prefixes.get(id) as string;
			const confirm = shortIdFixed(id, SHORT_ID_CONFIRM_LEN);
			// Either the row prefix is inside the confirm's 8, or the page held two
			// ids agreeing on 8 characters and the row prefix is the longer of the
			// two — in which case the confirm is a prefix of IT. Both directions
			// keep the two visually matchable; a pair that shares neither would not.
			expect(
				row.startsWith(confirm) || confirm.startsWith(row),
				`${row} and ${confirm} do not line up`,
			).toBe(true);
		}
	});

	test("the two lengths keep their relationship", () => {
		expect(SHORT_ID_CONFIRM_LEN).toBeGreaterThan(SHORT_ID_MIN);
	});

	test("duplicates and short ids are total, not special cases", () => {
		const prefixes = shortIdsFor(["abcdef", "abcdef", "xy"]);
		expect(prefixes.get("abcdef")).toBe("abcd");
		expect(prefixes.get("xy")).toBe("xy");
	});
});

describe("the order-status vocabulary", () => {
	test("the exception set is exactly the states with no outbound transition", () => {
		// Read off `domain/src/orders/state-machine.ts`: failed, expired,
		// cancelled and refunded have `[]`. `completed` does NOT — a completed
		// order can still be refunded — and the day someone "tidies" it into this
		// set is the day the console starts calling a live order closed.
		expect([...TERMINAL_ORDER_STATES].toSorted()).toEqual([
			"cancelled",
			"expired",
			"failed",
			"refunded",
		]);
		expect(TERMINAL_ORDER_STATES.has("completed")).toBe(false);
	});

	test("a terminal state says the one thing the state machine guarantees", () => {
		expect(orderStateCell("cancelled")).toBe("cancelled · closed");
		expect(orderStateCell("refunded")).toBe("refunded · closed");
	});

	test("the happy path is the bare word", () => {
		expect(orderStateCell("paid")).toBe("paid");
		expect(orderStateCell("completed")).toBe("completed");
	});

	test("an unrecognised state renders bare rather than acquiring the loud rendering", () => {
		expect(orderStateCell("quantum")).toBe("quantum");
	});

	test("every declared state renders, and only the four are marked", () => {
		const marked = ORDER_STATES.filter((state) => orderStateCell(state) !== state);
		expect(marked.toSorted()).toEqual(["cancelled", "expired", "failed", "refunded"]);
	});
});

describe("the list outcome ladder — FIVE outcomes, and both surfaces read them here", () => {
	const noun = ORDERS_NOUN;
	const empty = ORDERS_EMPTY;
	const noMatch = ORDERS_NO_MATCH;
	const base = { noun, empty, noMatch } as const;

	test("1. rows: the table renders, and page 1 with no next page states a TOTAL", () => {
		const outcome = listOutcome({
			...base,
			count: 17,
			filtered: false,
			firstPage: true,
			hasNext: false,
		});
		expect(outcome.kind).toBe("rows");
		expect(outcome.countLine).toBe("17 orders");
	});

	test("1b. rows on a later page, or with a page behind them, are PAGE-SCOPED", () => {
		// There is no total-count API, so any other shape can only say how many
		// are on this page. Claiming a total there is the one way the count lies.
		expect(
			listOutcome({ ...base, count: 25, filtered: false, firstPage: true, hasNext: true })
				.countLine,
		).toBe("25 orders on this page");
		expect(
			listOutcome({ ...base, count: 9, filtered: false, firstPage: false, hasNext: false })
				.countLine,
		).toBe("9 orders on this page");
	});

	test("2. zero, unfiltered, FIRST page: the collection is empty and offers the way in", () => {
		const outcome = listOutcome({
			...base,
			count: 0,
			filtered: false,
			firstPage: true,
			hasNext: false,
		});
		expect(outcome.kind).toBe("empty");
		if (outcome.kind !== "empty") return;
		expect(outcome.title).toBe("No orders yet");
		expect(outcome.offer).toBe("way-in");
		expect(outcome.countLine).toBeUndefined();
	});

	test("2b. zero, unfiltered, NOT the first page: page-scoped wording, nothing to click", () => {
		// THE REGRESSION THE REVIEW CAUGHT. "No orders yet" here is a claim about
		// the WHOLE COLLECTION that this render has not earned — page 1 had rows —
		// and it is reachable in a live store, not only in theory.
		const outcome = listOutcome({
			...base,
			count: 0,
			filtered: false,
			firstPage: false,
			hasNext: false,
		});
		expect(outcome.kind).toBe("empty");
		if (outcome.kind !== "empty") return;
		expect(outcome.title).toBe(PAGE_ZERO.title);
		expect(outcome.title).not.toBe(empty.title);
		expect(outcome.offer).toBe("none");
	});

	test("3. zero WITH a page behind it: NO empty state, a scan note instead", () => {
		// THE OTHER REGRESSION. An empty state here sits on top of `Load more` and
		// strands the operator mid-scan on a page that is not the end of anything.
		const outcome = listOutcome({
			...base,
			count: 0,
			filtered: false,
			firstPage: true,
			hasNext: true,
		});
		expect(outcome.kind).toBe("scan");
		if (outcome.kind !== "scan") return;
		expect(outcome.scanNote).toBe(`${NOTHING_ON_PAGE} ${SCAN_FURTHER}`);
	});

	test("3b. zero, FILTERED, with a page behind it leads with the filter's own words", () => {
		const outcome = listOutcome({
			...base,
			count: 0,
			filtered: true,
			firstPage: true,
			hasNext: true,
		});
		expect(outcome.kind).toBe("scan");
		if (outcome.kind !== "scan") return;
		expect(outcome.scanNote).toBe(`${noMatch.emptyText} ${SCAN_FURTHER}`);
		expect(outcome.scanNote).not.toContain(NOTHING_ON_PAGE);
	});

	test("4. zero, filtered, last page: the operator's own filter, plus the undo", () => {
		const outcome = listOutcome({
			...base,
			count: 0,
			filtered: true,
			firstPage: true,
			hasNext: false,
		});
		expect(outcome.kind).toBe("empty");
		if (outcome.kind !== "empty") return;
		expect(outcome.title).toBe("No orders match these filters");
		expect(outcome.offer).toBe("clear-filters");
	});

	test("4b. a filtered miss is NOT page-gated — the undo is right on any page", () => {
		// The asymmetry with `empty` is deliberate: `noMatch` names the operator's
		// OWN filter rather than the collection, so it earns its words anywhere.
		const outcome = listOutcome({
			...base,
			count: 0,
			filtered: true,
			firstPage: false,
			hasNext: false,
		});
		expect(outcome.kind).toBe("empty");
		if (outcome.kind !== "empty") return;
		expect(outcome.title).toBe(noMatch.title);
		expect(outcome.offer).toBe("clear-filters");
	});

	test("the count is pluralized and formatted by Intl, never by String() and an s", () => {
		expect(rowCountLine(1, noun, { complete: true })).toBe("1 order");
		expect(rowCountLine(2, noun, { complete: true })).toBe("2 orders");
		// A thousands separator is the visible proof that `Intl.NumberFormat` is in
		// the path — `String(1234)` cannot produce it, and that was the first cut.
		expect(rowCountLine(1234, noun, { complete: true })).toBe("1,234 orders");
		expect(rowCountLine(0, noun, { complete: true })).toBeUndefined();
	});
});

describe("INC-23's exact count, shared by both surfaces", () => {
	const noun = ORDERS_NOUN;

	test("a `total` states the WHOLE SET on any page, with no page-scoped suffix", () => {
		// The point of the field: page 3 of 3 knows nothing about pages 1 and 2 by
		// itself, but a COUNT(*) under the same predicate does.
		expect(rowCountLine(25, noun, { complete: false, total: 137 })).toBe("137 orders");
		expect(rowCountLine(25, noun, { complete: true, total: 137 })).toBe("137 orders");
	});

	test("no `total` falls back to exactly the behaviour that shipped before it", () => {
		expect(rowCountLine(17, noun, { complete: true })).toBe("17 orders");
		expect(rowCountLine(25, noun, { complete: false })).toBe("25 orders on this page");
	});

	test("a `total` that disagrees with itself is REFUSED, not rendered", () => {
		// Validated rather than trusted: the page-scoped claim is one this render
		// can back up on its own, so it is the safe direction.
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(rowCountLine(25, noun, { complete: false, total: bad })).toBe(
				"25 orders on this page",
			);
		}
		// Below the page count would UNDERSTATE rows the operator can see.
		expect(rowCountLine(25, noun, { complete: false, total: 3 })).toBe("25 orders on this page");
		// ...but ABOVE it is the ordinary concurrent-insert case and is honoured.
		expect(rowCountLine(25, noun, { complete: false, total: 26 })).toBe("26 orders");
	});

	test("zero rows render NO count, whatever the total claims", () => {
		// "137 orders" immediately above "No orders yet" is the screen
		// contradicting itself in two adjacent blocks.
		expect(rowCountLine(0, noun, { complete: true, total: 137 })).toBeUndefined();
		expect(rowCountLine(0, noun, { complete: false, total: 0 })).toBeUndefined();
	});

	test("the LADDER threads it, so both surfaces get it from one call", () => {
		// This is the reconciliation in one assertion: INC-23 put the total logic
		// in `list-detail.ts` (Block Kit only) and INC-20 moved the count line
		// here. Threading it through `listOutcome` is what stops the React list
		// saying "25 orders on this page" beside a Block Kit screen saying "137".
		const outcome = listOutcome({
			count: 25,
			filtered: false,
			firstPage: false,
			hasNext: true,
			total: 137,
			noun,
			empty: ORDERS_EMPTY,
			noMatch: ORDERS_NO_MATCH,
		});
		expect(outcome.kind).toBe("rows");
		expect(outcome.countLine).toBe("137 orders");
	});

	test("a level that narrowed the fetched page WITHHOLDS the total, and is believed", () => {
		// Products' "Low stock only" narrows client-side, so the service's count
		// describes a different set than the rows on screen. Omitting it is the
		// contract; the ladder must then say the smaller, true thing.
		const outcome = listOutcome({
			count: 4,
			filtered: true,
			firstPage: true,
			hasNext: true,
			noun,
			empty: ORDERS_EMPTY,
			noMatch: ORDERS_NO_MATCH,
		});
		expect(outcome.countLine).toBe("4 orders on this page");
	});
});

// ── INC-21: the Pricing & inventory vocabulary ───────────────────────────────

describe("the On hand cell keeps three cases apart that must never be folded", () => {
	test("a known count is a plain number above the threshold", () => {
		expect(onHandCell(42, 5)).toBe("42");
	});

	test("ZERO is a fact, and says so", () => {
		// The one that has to be right: `0` is "out of stock", not "unknown", and
		// the word is what stops it reading as a missing value.
		expect(onHandCell(0, 5)).toBe("0 · Out of stock");
	});

	test("at or below the threshold is Low, above it is not", () => {
		// THE BOUNDARY IS `<=`. A `<` mutation changes exactly one row's answer —
		// the product sitting on the reorder point, which is the one the threshold
		// was set for — and leaves every other case green.
		expect(onHandCell(4, 5)).toBe("4 · Low");
		expect(onHandCell(5, 5)).toBe("5 · Low");
		expect(onHandCell(6, 5)).toBe("6");
	});

	test("a threshold of ZERO makes nothing low, and zero still reads out of stock", () => {
		expect(onHandCell(0, 0)).toBe("0 · Out of stock");
		expect(onHandCell(1, 0)).toBe("1");
	});

	test("no inventory record and no stock figure BOTH read as unknown, never as zero", () => {
		// `null` is "this sku has no inventory record"; `undefined` is "the
		// response carried no stock figure at all". Neither is a count, and a `0`
		// here would be a zero nobody took.
		expect(onHandCell(null, 5)).toBe("—");
		expect(onHandCell(undefined, 5)).toBe("—");
		expect(onHandCell(null, null)).toBe("—");
	});

	test("a MISSING threshold costs the Low band and nothing else", () => {
		expect(onHandCell(3, null)).toBe("3");
		expect(onHandCell(0, null)).toBe("0 · Out of stock");
	});
});

describe("the tone a cell is drawn in, derived from the record and never from the phrase", () => {
	const base = { active: true, deletedAt: null, sku: "S", priceCents: 1, currency: "USD" };

	test("the tone follows the LABEL's own ranking, on the same five fields", () => {
		// Matching `"deleted"` or searching a rendered phrase for `"(not priced)"`
		// would put the wording and the ink one typo apart and would break the
		// moment a phrase is translated. Both read the record.
		expect(statusTone({ ...base, deletedAt: "2026-07-01T00:00:00.000Z" })).toBe("fail");
		expect(statusTone({ ...base, active: false })).toBe("warn");
		expect(statusTone({ ...base, priceCents: null })).toBe("warn");
		expect(statusTone({ ...base, sku: null })).toBe("warn");
		expect(statusTone({ ...base, currency: null })).toBe("warn");
		expect(statusTone(base)).toBe("plain");
	});

	test("a tombstone outranks everything, as it does in the label", () => {
		expect(statusTone({ ...base, active: true, deletedAt: "2026-07-01T00:00:00.000Z" })).toBe(
			"fail",
		);
	});

	test("zero stops a sale and is the only count that fails", () => {
		expect(stockTone(0, 5)).toBe("fail");
		expect(stockTone(4, 5)).toBe("warn");
		// The threshold is INCLUSIVE, exactly as the suffix is.
		expect(stockTone(5, 5)).toBe("warn");
		expect(stockTone(6, 5)).toBe("plain");
	});

	test("an UNKNOWN count is not an exception and must never be marked as one", () => {
		// Absence is not zero and it is not low: marking it would claim the store
		// had learned something about this sku when it read nothing at all.
		expect(stockTone(null, 5)).toBe("plain");
		expect(stockTone(undefined, 5)).toBe("plain");
		expect(stockTone(null, null)).toBe("plain");
	});

	test("a MISSING threshold costs the warn band and nothing else", () => {
		expect(stockTone(3, null)).toBe("plain");
		expect(stockTone(0, null)).toBe("fail");
	});
});

describe("statusLabel mirrors the service's own sellability filter", () => {
	const base = { active: true, deletedAt: null, sku: "S", priceCents: 1, currency: "USD" };

	test("deleted OUTRANKS inactive", () => {
		// A tombstoned row is always inactive too, but "deleted" is the honest,
		// non-recoverable-from-here status a merchant needs to see.
		expect(statusLabel({ ...base, active: false, deletedAt: "2026-07-01T00:00:00.000Z" })).toBe(
			"deleted",
		);
		expect(statusLabel({ ...base, active: true, deletedAt: "2026-07-01T00:00:00.000Z" })).toBe(
			"deleted",
		);
	});

	test("a published row with no commerce fields is NOT a plain active", () => {
		// The CMS sync mints a row for every products document, so publishing one
		// nobody priced sets `active: true` on a row the catalog read filters out.
		expect(statusLabel({ ...base, sku: null })).toBe("active (not priced)");
		expect(statusLabel({ ...base, priceCents: null })).toBe("active (not priced)");
		expect(statusLabel({ ...base, currency: null })).toBe("active (not priced)");
	});

	test("a sellable row is one quiet word", () => {
		expect(statusLabel(base)).toBe("active");
		expect(statusLabel({ ...base, active: false })).toBe("inactive");
	});
});

describe("the stock quantity parser refuses everything that is not whole units", () => {
	test("accepts a positive whole number", () => {
		expect(parseStockQty("12")).toBe(12);
		expect(parseStockQty(" 3 ")).toBe(3);
	});

	test("refuses zero, decimals, signs and prose", () => {
		// A movement of nothing is not a movement, and `3.0` reaching a count is
		// the float this console keeps off every numeric path.
		for (const input of ["0", "3.0", "-3", "+3", "1e3", "3 units", "", "abc"]) {
			expect(parseStockQty(input), input).toBeNull();
		}
		expect(parseStockQty(undefined)).toBeNull();
	});

	test("the WATERMARK parser accepts zero, and that difference is load-bearing", () => {
		// Zero is a legal watermark (a product genuinely at zero stock) and an
		// illegal quantity. Folding the two would either hide the stock forms for
		// an out-of-stock product or accept a movement of nothing.
		expect(parseOnHandWatermark("0")).toBe(0);
		expect(parseStockQty("0")).toBeNull();
		expect(parseOnHandWatermark("-1")).toBeNull();
	});
});

describe("the stock-degradation banner carries every true fact, not the first one", () => {
	test("nothing degraded renders no banner at all", () => {
		expect(
			stockDegradation({ unreadable: false, thresholdUnreadable: false, filterUnavailable: false }),
		).toBeUndefined();
	});

	test("two degradations at once produce ONE banner naming both", () => {
		// X-31 caps a response at two top-level banners and the notice may already
		// hold one, so a second degradation cannot have its own slot — and must not
		// be silently outranked either.
		const banner = stockDegradation({
			unreadable: true,
			thresholdUnreadable: true,
			filterUnavailable: false,
		});
		expect(banner?.title).toBe(
			"Stock levels are unavailable; low-stock highlighting is unavailable.",
		);
		expect(banner?.description).toContain("open a product to read its stock");
		expect(banner?.description).toContain("Checkout & holds on Settings");
	});

	test("a filter that could not be applied says the page is UNFILTERED", () => {
		// Never silently the wrong set of rows.
		const banner = stockDegradation({
			unreadable: false,
			thresholdUnreadable: false,
			filterUnavailable: true,
		});
		expect(banner?.title).toBe("The Low stock only filter was not applied.");
		expect(banner?.description).toBe("Every product on this page is listed.");
	});
});

describe("the remove-stock confirm is composed once for both surfaces", () => {
	test("it names the concrete quantity, and agrees with itself about the unit", () => {
		const one = removeStockConfirm(1);
		expect(one.title).toBe("Remove 1 unit?");
		expect(one.text).toContain("Remove 1 unit from stock?");
		expect(one.confirm).toBe("Yes, remove 1");

		const many = removeStockConfirm(3);
		expect(many.title).toBe("Remove 3 units?");
		expect(many.text).toContain("Remove 3 units from stock?");
	});

	test("it says the consequence, not just the verb", () => {
		expect(removeStockConfirm(3).text).toContain("cannot be undone by restocking");
		expect(removeStockConfirm(3).deny).toBe("Keep as is");
	});

	test("the title stays inside the label budget however large the quantity", () => {
		expect(removeStockConfirm(999_999_999).title.length).toBeLessThanOrEqual(LABEL_BUDGET);
	});
});

describe("the add-stock confirm restates the quantity the system will act on (F5)", () => {
	test("it names the parsed quantity, the SKU and BOTH ends of the projection", () => {
		// The whole point: `100` typed where `10` was meant is valid input, so the
		// only place it can be caught is a sentence stating the number and what it
		// does to on-hand.
		const confirm = addStockConfirm(100, "GDE-CARE-PDF", 0);
		expect(confirm.title).toBe("Add 100 units?");
		expect(confirm.text).toBe(
			"Add 100 units to GDE-CARE-PDF? On hand goes from 0 to 100 and the store can sell them immediately.",
		);
		expect(confirm.confirm).toBe("Yes, add 100");
		expect(confirm.deny).toBe("Keep as is");
	});

	test("the projection is computed FROM the quantity, not restated from the field", () => {
		expect(addStockConfirm(10, "GDE-CARE-PDF", 42).text).toContain("from 42 to 52");
	});

	test("it agrees with itself about the unit, as the removal's does", () => {
		expect(addStockConfirm(1, "APR-LIN-NAT", 7).title).toBe("Add 1 unit?");
		expect(addStockConfirm(1, "APR-LIN-NAT", 7).text).toContain("Add 1 unit to APR-LIN-NAT?");
	});

	test("it says what the addition ENABLES, where the removal says what it costs", () => {
		// Levelling the two gates must not level the two sentences: the reason to
		// check an addition is that the store starts selling the units.
		expect(addStockConfirm(5, "APR-LIN-NAT", 0).text).toContain("can sell them immediately");
		expect(addStockConfirm(5, "APR-LIN-NAT", 0).text).not.toContain("cannot be undone");
	});

	test("the title stays inside the label budget however large the quantity", () => {
		expect(addStockConfirm(999_999_999, "APR-LIN-NAT", 0).title.length).toBeLessThanOrEqual(
			LABEL_BUDGET,
		);
	});
});

describe("a price save gets a before and an after (F4)", () => {
	test("the pending line names both amounts, through the money formatter", () => {
		const change = priceChangeSummary(900, 9999, "USD");
		expect(change).toBe("$9.00 → $99.99");
		expect(pricePendingLine(change)).toBe("Price $9.00 → $99.99");
	});

	test("an unchanged amount is not a change, so there is nothing to state", () => {
		// The clean form must not carry a pending block reading `$9.00 → $9.00`.
		expect(priceChangeSummary(900, 900, "USD")).toBeNull();
		expect(pricePendingLine(null)).toBeNull();
	});

	test("an absent end is stated as nothing, never as `$0.00`", () => {
		// A product priced for the FIRST time has no before; a blank field leaves
		// the price unchanged and has no after. Neither of them is a zero.
		expect(priceChangeSummary(null, 9999, "USD")).toBeNull();
		expect(priceChangeSummary(900, null, "USD")).toBeNull();
		expect(priceChangeSummary(900, 9999, null)).toBeNull();
		expect(priceChangeSummary(900, 9999, "NOT-A-CURRENCY")).toBeNull();
	});

	test("the receipt names the amounts AND what they did not touch", () => {
		const notice = priceSavedNotice("$9.00 → $99.99");
		expect(notice.title).toBe("Price updated — live on the storefront");
		expect(notice.description).toBe(
			"$9.00 → $99.99. Shoppers see the new price now; orders already placed keep the price they were charged.",
		);
	});

	test("a save with no amount change still reports, without inventing amounts", () => {
		// A compare-at or unit-cost edit is still a save, and still publishes.
		const notice = priceSavedNotice(null);
		expect(notice.description).toBe(
			"Shoppers see the new price now; orders already placed keep the price they were charged.",
		);
		expect(notice.description).not.toContain("→");
	});

	test("a group holding unsaved work says so on its own label", () => {
		// A SHUT group must not be able to hide an edit.
		const label = priceGroupLabel(900, "USD");
		expect(dirtyGroupLabel(label, true)).toBe(`${label} · unsaved`);
		expect(dirtyGroupLabel(label, false)).toBe(label);
	});

	test("the pending sentence says the save publishes IMMEDIATELY", () => {
		expect(PRICE_PENDING_CONTEXT).toContain("immediately");
		expect(NO_CHANGES_TO_SAVE).toBe("No changes to save.");
	});

	test("two spellings of one amount are one amount", () => {
		// The case that decides whether a form goes CLEAN again after its save. The
		// committed side is always the formatter's spelling; the typed side is
		// whatever was typed, and a save re-reads the former without rewriting the
		// latter. Compared as raw strings, a successful save leaves the group
		// claiming unsaved work it does not hold.
		expect(canonicalMoneyInput("99.9")).toBe(canonicalMoneyInput("99.90"));
		expect(canonicalMoneyInput(" 99.90 ")).toBe(canonicalMoneyInput("99.90"));
		expect(canonicalMoneyInput("0")).toBe(canonicalMoneyInput("0.00"));
		expect(canonicalMoneyInput("99")).toBe("99.00");
	});

	test("it normalises spelling and nothing else — a different amount stays different", () => {
		expect(canonicalMoneyInput("9.99")).not.toBe(canonicalMoneyInput("99.90"));
		// Blank is preserved as blank: on these fields blank means "leave
		// unchanged" or "clear", and never zero.
		expect(canonicalMoneyInput("")).toBe("");
		expect(canonicalMoneyInput("   ")).toBe("");
		expect(canonicalMoneyInput("")).not.toBe(canonicalMoneyInput("0.00"));
	});

	test("an unparseable entry is handed back, not swallowed", () => {
		// It is not a validator. `abc` must still read as a change from `9.00`, so
		// the write is still offered and the write's own refusal is what the
		// operator reads.
		expect(canonicalMoneyInput("abc")).toBe("abc");
		expect(canonicalMoneyInput(" 9.999 ")).toBe("9.999");
		expect(canonicalMoneyInput("abc")).not.toBe(canonicalMoneyInput("9.00"));
	});
});

describe("the D-6 group labels carry their answer, and shorten the LONGEST value", () => {
	test("an unset value is NAMED rather than left as an empty tail", () => {
		expect(identityGroupLabel(null)).toBe("Identity — no SKU");
		expect(priceGroupLabel(null, null)).toBe("Price — not priced yet");
		expect(shippingGroupLabel(null, null)).toBe(
			"Classification & shipping — no tax class · no weight",
		);
	});

	test("a priced product's label states the money and the currency", () => {
		expect(priceGroupLabel(1999, "USD")).toBe("Price — $19.99 USD");
	});

	test("an over-long value costs ITSELF, never the tail", () => {
		// `fitLabel` would eat `· 320 g` outright and leave a label that looks
		// complete. The whole point of a D-6 label is that it carries the values.
		const label = shippingGroupLabel("a-very-long-tax-class-slug-indeed-yes-really", 320);
		expect(label.length).toBeLessThanOrEqual(LABEL_BUDGET);
		expect(label.endsWith("· 320 g")).toBe(true);
		expect(label).toContain("…");
	});
});

describe("optional money is absent, never zero", () => {
	test("either half missing renders the em dash", () => {
		expect(formatOptionalAmount(null, "USD")).toBe("—");
		expect(formatOptionalAmount(1999, null)).toBe("—");
		expect(formatOptionalAmount(null, null)).toBe("—");
	});

	test("a real pair formats through the ONE money boundary", () => {
		expect(formatOptionalAmount(1999, "USD")).toBe("$19.99");
		// ZERO IS A PRICE, and renders as one — the distinction the `null` above
		// exists to keep.
		expect(formatOptionalAmount(0, "USD")).toBe("$0.00");
	});

	test("a NEGATIVE amount is rendered as one, and never as its absolute value", () => {
		// `cents()` is branded non-negative and throws below zero, so the sign is
		// re-applied by hand — which means it can be dropped by hand. A refund
		// ledger that renders −$5.00 as $5.00 reads as money arriving.
		// U+2212 MINUS SIGN, not a hyphen: it is what `Intl` would use and what
		// lines up in a tabular-numeral column.
		expect(formatAmount(-500, "USD")).toBe("−$5.00");
		expect(formatOptionalAmount(-500, "USD")).toBe("−$5.00");
		expect(formatAmount(-500, "USD").startsWith("\u2212")).toBe(true);
	});

	test("a currency Intl rejects renders the em dash, NEVER raw minor units", () => {
		// The branch this replaced printed `${CUR} ${minorUnits}` — a wrong number
		// dressed as a formatted total, which is exactly what G1 forbids.
		expect(formatOptionalAmount(1999, "not-a-currency")).toBe("—");
	});
});

describe("the tax-class vocabulary never drops a value the product already has", () => {
	const classes = [
		{ id: "standard", name: "Standard" },
		{ id: "reduced", name: "Reduced" },
	];

	test("a known class reads as `name (id)`", () => {
		expect(taxClassLabel("standard", classes)).toBe("Standard (standard)");
	});

	test("an unknown class reads as its id rather than vanishing", () => {
		expect(taxClassLabel("eu-standard-vat", classes)).toBe("eu-standard-vat");
	});

	test("unset reads as the em dash (the checkout treats it as standard)", () => {
		expect(taxClassLabel(null, classes)).toBe("—");
	});

	test("the select offers a clear-it sentinel that is never the empty string", () => {
		const options = taxClassOptions(null, classes);
		expect(options[0]?.value).toBe(NO_TAX_CLASS);
		expect(options[0]?.value).not.toBe("");
	});

	test("a current value the registry does not list is APPENDED, not silently dropped", () => {
		const options = taxClassOptions("eu-standard-vat", classes);
		expect(options.map((o) => o.value)).toContain("eu-standard-vat");
		// ...and it is not duplicated when the registry does list it.
		expect(taxClassOptions("standard", classes).filter((o) => o.value === "standard")).toHaveLength(
			1,
		);
	});
});

describe("dimensions show which axis is missing", () => {
	test("nothing measured is the em dash", () => {
		expect(dimensionsSummary(null, null, null)).toBe("—");
	});

	test("a partial measurement keeps the figures somebody DID record", () => {
		// A single dash here would hide two real numbers.
		expect(dimensionsSummary(120, null, 40)).toBe("120 x ? x 40");
		expect(dimensionsSummary(120, 80, 40)).toBe("120 x 80 x 40");
	});
});

describe("the Orders detail copy is shared, and says what the Block Kit screen says", () => {
	test("the cancel confirm names the reason and the consequence", () => {
		// Typographic quotes on BOTH surfaces now: the React tier's hand-copy had
		// straight ones, which is the drift this module exists to make impossible.
		expect(cancelConfirmText("Out of stock")).toBe(
			"Cancel this order as “Out of stock”? This is permanent — the order cannot be un-cancelled, and the held stock is released.",
		);
		expect(CANCEL_BANNER.description).toContain("“cancelled”");
	});

	test("the over-refund refusal names what to enter INSTEAD", () => {
		// The React tier's hand-copy stated the fact and dropped the instruction.
		expect(refundTooHighText("$900.00", "$50.00")).toBe(
			"$900.00 is more than the $50.00 that remains refundable on this order. Enter $50.00 or less.",
		);
	});

	test("the reconciliation note keeps its next step", () => {
		expect(RESOLVE_RECONCILIATION_NOTE).toContain("moves no money");
		expect(RESOLVE_RECONCILIATION_NOTE).toContain("Refund in Money if the buyer is owed one");
	});

	test("the additive-refunds warning is shared and the STEP REFERENCE is not", () => {
		// Only the Block Kit screen has a staged review step to point at, so only
		// it prefixes the step reference. Sharing the whole sentence would have put
		// a step reference on a screen that has no such step.
		expect(REFUND_ADDITIVE_NOTE).not.toContain("next step");
		expect(REFUND_REVIEW_STEP_PREFIX).toContain("next step");
	});

	test("the mark-refunded confirm separates the ledger from the money", () => {
		expect(MARK_REFUNDED_CONFIRM.text).toContain("does not move money");
	});
});

/**
 * `refundConfirmText` HAD ZERO UNIT TESTS ANYWHERE IN THE REPO (review
 * findings N6 / reviewer B) despite composing money-moving prose at click
 * time from figures a server has not seen yet — the one string in this
 * console where a silent copy-edit could drop the amount, the order id or
 * the consequence clause from a REFUND CONFIRMATION and still read as a
 * passing build everywhere else it is only exercised indirectly (through
 * `@otta-sh/admin-react`'s DOM suite, which pins the call SITE's arguments,
 * not this function's own composition).
 */
describe("refundConfirmText — the refund confirm's one sentence, exercised directly", () => {
	const ORDER_ID = "7e4ce728-abcd-4000-8000-000000000000";
	const SHORT_ORDER = `Order #${shortIdFixed(ORDER_ID, SHORT_ID_CONFIRM_LEN)}`;

	test("names the order, the amount and the recipient, and states the Stripe consequence when refundable", () => {
		expect(refundConfirmText(ORDER_ID, "$42.00", "avery@example.test", true)).toBe(
			`${SHORT_ORDER} — refund $42.00 to "avery@example.test"? This sends the money back through Stripe and cannot be reversed.`,
		);
	});

	test("states the record-only consequence when not refundable, not the Stripe one", () => {
		const text = refundConfirmText(ORDER_ID, "$42.00", "avery@example.test", false);
		expect(text).toContain("This records a refund made out of band — it does not move money.");
		expect(text).not.toContain("Stripe");
	});

	test("the order id is the fixed 8-character short id, not the full uuid", () => {
		expect(refundConfirmText(ORDER_ID, "$1.00", "x@y.test", true)).toContain(SHORT_ORDER);
		expect(refundConfirmText(ORDER_ID, "$1.00", "x@y.test", true)).not.toContain(ORDER_ID);
	});

	test("a real recipient is always quoted (finding N3) — an operator can see where the token begins and ends", () => {
		expect(refundConfirmText(ORDER_ID, "$1.00", "avery@example.test", true)).toContain(
			'to "avery@example.test"?',
		);
	});

	/**
	 * Round 3, finding 2: quotes mark UNTRUSTED input and nothing else.
	 * `UNNAMED_REFUND_RECIPIENT` is authored by this module, not a caller, so
	 * it must never appear quoted — wrapping it the same way would claim a
	 * provenance it does not have, and (paired with `order-detail.tsx`
	 * escaping every real recipient before it reaches here) would make
	 * "quoted" stop meaning anything.
	 */
	test("UNNAMED_REFUND_RECIPIENT is never quoted, however it reaches this function", () => {
		// Passed directly, as a caller with no identity at all does.
		expect(refundConfirmText(ORDER_ID, "$1.00", UNNAMED_REFUND_RECIPIENT, true)).toContain(
			`to ${UNNAMED_REFUND_RECIPIENT}?`,
		);
		expect(refundConfirmText(ORDER_ID, "$1.00", UNNAMED_REFUND_RECIPIENT, true)).not.toContain(
			`"${UNNAMED_REFUND_RECIPIENT}"`,
		);
	});

	test("a recipient long enough to overflow the budget is dropped for the shared, UNQUOTED fallback phrase", () => {
		const longRecipient = "x".repeat(180);
		const text = refundConfirmText(ORDER_ID, "$1.00", longRecipient, true);
		expect(text).not.toContain(longRecipient);
		expect(text).toContain(`to ${UNNAMED_REFUND_RECIPIENT}?`);
		expect(text).not.toContain(`"${UNNAMED_REFUND_RECIPIENT}"`);
		expect(text.length).toBeLessThanOrEqual(200);
	});

	test("a recipient that keeps the sentence inside budget is never replaced", () => {
		expect(refundConfirmText(ORDER_ID, "$1.00", "short@x.test", true)).toContain(
			'to "short@x.test"?',
		);
	});
});

/**
 * `buyerReferenceText` — the one function the list's Customer cell and the
 * detail heading both read through (review findings N6/N7/N8; reviewer B).
 * ADR-0015 retired the Block Kit Orders screen, so this is not a
 * cross-surface guard the way `orderStateCell` still is; it is what keeps
 * the React list and the React detail from drifting from EACH OTHER.
 */
describe("buyerReferenceText — the readable buyer reference, never the uuid", () => {
	test("renders an ordinary reference as-is", () => {
		expect(buyerReferenceText("avery.stone@example.com")).toBe("avery.stone@example.com");
	});

	test("TRIMS incidental leading/trailing whitespace — the returned value, not merely the emptiness check (finding N8)", () => {
		// The earlier cut trimmed ONLY to decide whether the value counted as
		// absent, then returned the untrimmed original — invisible in rendered
		// HTML, and exactly the kind of whitespace an operator's copy-paste into
		// a downstream field should never carry.
		expect(buyerReferenceText("  avery.stone@example.com  ")).toBe("avery.stone@example.com");
		expect(buyerReferenceText("\tguest_checkout_772\n")).toBe("guest_checkout_772");
	});

	test("an empty string renders the shared em dash, never a blank string", () => {
		expect(buyerReferenceText("")).toBe(ABSENT);
	});

	test("a whitespace-only string renders the shared em dash, not a blank-looking space", () => {
		expect(buyerReferenceText("   ")).toBe(ABSENT);
	});

	test("null and undefined both render the shared em dash", () => {
		expect(buyerReferenceText(null)).toBe(ABSENT);
		expect(buyerReferenceText(undefined)).toBe(ABSENT);
	});
});

describe("the words that describe unsaved work (F6, F8, F9)", () => {
	test("the sibling-save line describes what the screen DOES, not the opposite (F9)", () => {
		// The one sanctioned wording change in this build. It used to tell the
		// operator that saving one section "clears unsaved edits in the others" and
		// to save before opening another — while the actual loss was a TAB SWITCH,
		// which unmounted all three forms, and a sibling save cleared nothing. Both
		// halves are now true as written.
		expect(SPLIT_DISCARD_CONTEXT).not.toContain("clears unsaved edits in the others");
		expect(SPLIT_DISCARD_CONTEXT).toContain("switch tabs");
		expect(SPLIT_DISCARD_CONTEXT).toContain("kept");
		// …and it names the one path that still discards, which is the one that now
		// asks first.
		expect(SPLIT_DISCARD_CONTEXT).toContain("leaving this product");
	});

	test("the leave confirm NAMES the sections holding work, at one, two and three", () => {
		// "You have unsaved changes" on a screen with three independent forms
		// behind two tabs leaves the operator to hunt. Every count has to read as
		// English, so the list is composed rather than authored per case.
		const one = leaveWithoutSavingConfirm(["Price"]);
		expect(one.title).toBe("Leave without saving?");
		expect(one.text).toBe(
			"The Price section has unsaved changes. Leaving this product discards them.",
		);
		expect(one.confirm).toBe("Leave and discard");
		expect(one.deny).toBe("Stay");

		expect(leaveWithoutSavingConfirm(["Price", "Classification & shipping"]).text).toBe(
			"The Price and Classification & shipping sections have unsaved changes. Leaving this product discards them.",
		);
		expect(leaveWithoutSavingConfirm(["Identity", "Price", "Classification & shipping"]).text).toBe(
			"The Identity, Price and Classification & shipping sections have unsaved changes. Leaving this product discards them.",
		);
		// Not reachable from the screen — the dialog opens only when something is
		// dirty — but it degrades to a sentence rather than to "The  sections".
		expect(leaveWithoutSavingConfirm([]).text).toContain("This product has unsaved changes.");
	});

	test("dirty sections are named in SCREEN order, not in the order they went dirty", () => {
		expect(dirtySectionLabels({ identity: false, price: true, shipping: false })).toEqual([
			"Price",
		]);
		expect(dirtySectionLabels({ identity: true, price: false, shipping: true })).toEqual([
			"Identity",
			"Classification & shipping",
		]);
		expect(dirtySectionLabels({ identity: false, price: false, shipping: false })).toEqual([]);
		expect(PRODUCT_SECTION_ORDER).toEqual(["identity", "price", "shipping"]);
	});

	test("a tab's dot has a NAME, because a bullet announces as nothing useful", () => {
		expect(tabUnsavedLabel("Product")).toBe("Product — unsaved changes");
		// The suffix a shut group's summary takes is the same fact in the same
		// register, and it is still the group's, not the tab's.
		expect(dirtyGroupLabel("Price — $9.00 USD", true)).toBe("Price — $9.00 USD · unsaved");
	});
});
