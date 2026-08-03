/**
 * Two SCAFFOLD PRIMITIVES, on their own, before any screen that renders them —
 * the UUID display rule (D4) and the console's date dialect (INC-13). Pure
 * string and `Intl` work, so there is no IO to sandbox.
 *
 * THEY MOVED HERE, UNCHANGED (INC-R2 / ADR-0015 Decision 5). They were written
 * inside `orders-page.sandbox.test.ts` on the reasoning that "a scaffold module
 * the console's three date-rendering screens share is worth pinning once, in the
 * file that exercises the busiest of them". That file's subject — the Block Kit
 * Orders screen — has been retired; the modules these pin have not. Leaving them
 * to go with the screen would have dropped the only coverage of two primitives
 * five surviving screens still render through, which is exactly the incidental
 * loss ADR-0015 names as this effort's quiet exposure.
 */
import { describe, expect, test } from "vitest";
import {
	DATE_LOCALE,
	dayOf,
	endOfDay,
	formatDate,
	formatDay,
	formatTimestamp,
	startOfDay,
} from "../src/admin/scaffold/datetime.js";
import {
	SHORT_ID_CONFIRM_LEN,
	SHORT_ID_MIN,
	shortIdFixed,
	shortIdsFor,
} from "../src/admin/scaffold/short-id.js";

/**
 * `LIST_ID_1` / `LIST_ID_2` diverge at character 1 — the ordinary case, where
 * the 4-character floor stands. `TWIN_ID_A` / `TWIN_ID_B` agree for 5 and force
 * the prefix to extend, which is the case the rule exists for.
 */
const LIST_ID_1 = "7e4ce728-1b3f-4a5e-9c21-0d5f6a7b8c90";
const LIST_ID_2 = "b91d4a02-77c6-4e18-8f30-2a6b5c4d3e1f";
const TWIN_ID_A = "3f8a1c05-4d2e-4f61-8a70-5b6c7d8e9f01";
const TWIN_ID_B = "3f8a1d90-2e6b-4c37-9d84-1a2b3c4d5e6f";

/**
 * The D4 primitive, on its own, before the screen that renders it. Pure string
 * work — no sandbox, because there is no IO to sandbox.
 */
describe("short ids (D4)", () => {
	const UUIDS = [LIST_ID_1, LIST_ID_2, TWIN_ID_A, TWIN_ID_B];

	test("floors at 4 characters and stops there when 4 already separates the set", () => {
		expect(SHORT_ID_MIN).toBe(4);
		const prefixes = shortIdsFor([LIST_ID_1, LIST_ID_2]);
		expect([...prefixes.values()]).toEqual(["7e4c", "b91d"]);
	});

	test("extends ONLY for the ids that collide, one character at a time", () => {
		const prefixes = shortIdsFor(UUIDS);
		// The twins agree for five characters and need six; their neighbours are
		// unaffected and stay at the floor.
		expect(prefixes.get(TWIN_ID_A)).toBe("3f8a1c");
		expect(prefixes.get(TWIN_ID_B)).toBe("3f8a1d");
		expect(prefixes.get(LIST_ID_1)).toBe("7e4c");
		expect(prefixes.get(LIST_ID_2)).toBe("b91d");
	});

	test("is TOTAL and UNIQUE over its input — every id has an entry, and no two distinct ids share a prefix", () => {
		const ids = [...UUIDS, "3f8a1c05-4d2e-4f61-8a70-000000000000", "ab", "abc", "abcdef"];
		const prefixes = shortIdsFor(ids);
		for (const id of ids) {
			expect(prefixes.get(id), `no prefix for ${id}`).toBeDefined();
			expect(id.startsWith(prefixes.get(id)!)).toBe(true);
		}
		expect(new Set(prefixes.values()).size).toBe(new Set(ids).size);
	});

	test("is deterministic and order-independent — a re-render in another order cannot renumber the page", () => {
		const forward = shortIdsFor(UUIDS);
		const reversed = shortIdsFor(UUIDS.toReversed());
		for (const id of UUIDS) expect(reversed.get(id)).toBe(forward.get(id));
		expect(shortIdsFor(UUIDS)).toEqual(forward);
	});

	test("a duplicated id is one candidate, not a collision with itself", () => {
		const prefixes = shortIdsFor([LIST_ID_1, LIST_ID_1, LIST_ID_2]);
		expect(prefixes.size).toBe(2);
		expect(prefixes.get(LIST_ID_1)).toBe("7e4c");
	});

	test("an explicit `min` moves the floor; ids shorter than it are returned whole", () => {
		expect(shortIdsFor([LIST_ID_1, LIST_ID_2], 8).get(LIST_ID_1)).toBe("7e4ce728");
		expect(shortIdsFor(["ab", "cd"], 4).get("ab")).toBe("ab");
	});

	test("`min` can only RAISE the floor — a caller cannot opt out of the 4-character minimum", () => {
		// SHORT_ID_MIN is a rule about what an operator can recognise, not a
		// default: at min 1 a page of orders renders `#7`, `#b`.
		for (const min of [1, 2, 0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(shortIdsFor([LIST_ID_1, LIST_ID_2], min).get(LIST_ID_1)).toBe("7e4c");
		}
		// Above the minimum a fractional floor truncates rather than rounding up.
		expect(shortIdsFor([LIST_ID_1, LIST_ID_2], 8.9).get(LIST_ID_1)).toBe("7e4ce728");
	});

	test("shortIdFixed takes 8 by default and never pads a shorter id", () => {
		expect(SHORT_ID_CONFIRM_LEN).toBe(8);
		expect(shortIdFixed(LIST_ID_1)).toBe("7e4ce728");
		expect(shortIdFixed(LIST_ID_1, 4)).toBe("7e4c");
		expect(shortIdFixed("ord-1")).toBe("ord-1");
	});

	test("the fixed length is a superset of any computed prefix ≤ 8 — the property the confirm dialog leans on", () => {
		for (const [id, prefix] of shortIdsFor(UUIDS)) {
			expect(shortIdFixed(id).startsWith(prefix)).toBe(true);
		}
	});
});

/**
 * The INC-13 primitive, on its own, before the screens that render it. Pure
 * `Intl` + string work — no sandbox, because there is no IO to sandbox, and the
 * same reason the D4 primitive above is tested here: a scaffold module the
 * console's three date-rendering screens share is worth pinning once, in the
 * file that exercises the busiest of them.
 */
describe("the console's date dialect (INC-13)", () => {
	const PLACED = "2026-07-08T10:30:35.000Z";

	test("a wire timestamp renders as `8 Jul 2026, 10:30 UTC`", () => {
		expect(formatTimestamp(PLACED)).toBe("8 Jul 2026, 10:30 UTC");
	});

	test("the zone is IN the value — so no label has to carry a `(UTC)` suffix", () => {
		expect(formatTimestamp(PLACED).endsWith(" UTC")).toBe(true);
	});

	test("seconds and milliseconds are dropped; midnight is 00:00, never 24:00", () => {
		expect(formatTimestamp("2026-07-08T10:30:59.999Z")).toBe("8 Jul 2026, 10:30 UTC");
		expect(formatTimestamp("2026-07-10T00:00:00Z")).toBe("10 Jul 2026, 00:00 UTC");
	});

	test("UTC-PINNED (M-6): an offset value renders as the instant it denotes, in UTC", () => {
		// The old pass-through put `+05:00` on screen for X-13 to flag. Formatting
		// the instant is a RENDERING, not a timezone conversion — the console still
		// presents exactly one zone.
		expect(formatTimestamp("2026-07-08T15:30:00+05:00")).toBe("8 Jul 2026, 10:30 UTC");
	});

	test("the H1's date is a literal PREFIX of the full timestamp, by construction", () => {
		// What collapses the order detail's old habit of stating "placed" twice in
		// two formats. Asserted over a spread of instants, not one lucky fixture.
		for (const iso of [PLACED, "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z"]) {
			expect(formatTimestamp(iso).startsWith(formatDate(iso))).toBe(true);
		}
		expect(formatDate(PLACED)).toBe("8 Jul 2026");
	});

	test("`formatDay` with a year is the SAME rendering as `formatDate` on that day", () => {
		// Reports' absorbed helper and Orders' absorbed helper are now one dialect;
		// this is the assertion that says so rather than two matching option bags.
		expect(formatDay("2026-07-08", true)).toBe(formatDate("2026-07-08T00:00:00.000Z"));
		expect(formatDay("2026-07-08", true)).toBe("8 Jul 2026");
		expect(formatDay("2026-07-08", false)).toBe("8 Jul");
	});

	/**
	 * The option bag `formatTimestamp` is built on. It stands in for the module
	 * under OTHER locales, which the module itself takes no parameter for — there
	 * is no product reason for one, and inventing test-only API to avoid this
	 * duplication would be the worse trade. The stand-in is only honest while it
	 * matches, so the test below pins it against the module's real output FIRST;
	 * change `datetime.ts`'s options and that assertion fails.
	 */
	const OPTIONS: Intl.DateTimeFormatOptions = {
		timeZone: "UTC",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	};
	const render = (locale: string): string =>
		new Intl.DateTimeFormat(locale, OPTIONS).format(new Date(PLACED));

	test("the pinned locale is the ONLY thing standing between this and a localized console", () => {
		// THE GUARD. Same options + `DATE_LOCALE` reproduce `formatTimestamp`
		// exactly — which is what lets the probe below speak for the module.
		expect(render(DATE_LOCALE)).toBe(formatTimestamp(PLACED));
		// And the honest half: the console is NOT localized. The locale is pinned
		// and nothing threads a viewer's. What the module buys is that when one IS
		// threaded, this constant is the whole change — including the zone label,
		// which would otherwise be English concatenated into seven label strings.
		expect(DATE_LOCALE).toBe("en-GB");
	});

	test("G6: the zone label is TRANSLATED by ICU — so the spec's literal `UTC` is an en-GB fact", () => {
		// The property that makes `DATE_LOCALE` a single point of change: nothing
		// in the output is hand-assembled, the zone included.
		expect(render("ar-EG")).toMatch(/[\u0660-\u0669\u06f0-\u06f9]/); // own digits, RTL
		expect(render("el-GR")).not.toContain("UTC"); // spelled out in Greek
		// Which means a TRAILING LITERAL `UTC` is not universal — el-GR spells it
		// out, fa-IR parenthesises it, zh-TW brackets it, vi-VN puts the whole time
		// run first. INC-13's `8 Jul 2026, 10:30 UTC` holds exactly as long as the
		// locale stays pinned; whoever threads a real one must revisit the
		// criterion, whose defensible reading is "the zone is stated in the value".
		expect(render(DATE_LOCALE).endsWith("UTC")).toBe(true);
		for (const locale of ["el-GR", "fa-IR", "zh-TW", "vi-VN"]) {
			expect(render(locale).endsWith("UTC")).toBe(false);
		}
	});

	test("an unparseable value is returned UNCHANGED rather than invented or blanked", () => {
		// The one path that can still put an ISO-shaped string on screen. It is
		// unreachable for wire data (every RFC 3339 timestamp parses) and is pinned
		// here rather than assumed away.
		expect(formatTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
		expect(formatDay("not-a-day", true)).toBe("not-a-day");
		// `formatDate` CAPS it at 10 characters where the other two pass through:
		// it feeds the order detail's H1, the largest type on the page, and
		// unbounded unrecognised text there is a worse failure than a stub.
		expect(formatDate("not-a-timestamp")).toBe("not-a-time");
		expect(formatDate("x".repeat(400))).toHaveLength(10);
	});

	test("the day bounds are WHOLE DAYS, both ends inclusive — one convention, two screens", () => {
		expect(dayOf(new Date("2026-07-08T23:59:59.999Z"))).toBe("2026-07-08");
		expect(startOfDay("2026-07-08")).toBe("2026-07-08T00:00:00.000Z");
		expect(endOfDay("2026-07-08")).toBe("2026-07-08T23:59:59.999Z");
		// A full datetime passes through un-re-anchored.
		expect(startOfDay("2026-07-08T09:00:00.000Z")).toBe("2026-07-08T09:00:00.000Z");
		expect(endOfDay("2026-07-08T09:00:00.000Z")).toBe("2026-07-08T09:00:00.000Z");
	});
});
