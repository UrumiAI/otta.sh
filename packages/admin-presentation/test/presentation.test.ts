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
	DATE_LOCALE,
	NOTHING_ON_PAGE,
	ORDERS_EMPTY,
	ORDERS_NOUN,
	ORDERS_NO_MATCH,
	ORDER_STATES,
	PAGE_ZERO,
	SCAN_FURTHER,
	SHORT_ID_CONFIRM_LEN,
	SHORT_ID_MIN,
	TERMINAL_ORDER_STATES,
	cents,
	currency,
	dayOf,
	endOfDay,
	formatDate,
	formatDay,
	formatMoney,
	formatTimestamp,
	listOutcome,
	majorUnits,
	orderStateCell,
	rowCountLine,
	shortIdFixed,
	shortIdsFor,
	startOfDay,
} from "../src/index.js";

const USD = currency("USD");

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
