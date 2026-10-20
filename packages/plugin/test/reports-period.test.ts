import { describe, expect, test } from "vitest";
import {
	comparisonPhrase,
	presetRange,
	presetValue,
	previousPeriod,
	REPORTS_PERIOD_ACTION_ID,
	REPORTS_PRESETS,
	resolveReportsRange,
} from "../src/admin/reports-period.js";

/** A fixed "today" so every case is a pure function of its input. */
const TODAY = "2026-10-20";

describe("reports period: presets resolve to whole UTC days ending today", () => {
	test.each([
		["today", "2026-10-20", "2026-10-20", 1],
		["7d", "2026-10-14", "2026-10-20", 7],
		["30d", "2026-09-21", "2026-10-20", 30],
		["90d", "2026-07-23", "2026-10-20", 90],
		["365d", "2025-10-21", "2026-10-20", 365],
		["mtd", "2026-10-01", "2026-10-20", 20],
		["ytd", "2026-01-01", "2026-10-20", 293],
	] as const)("%s → %s … %s (%i days, today included)", (preset, fromDay, toDay, days) => {
		const range = presetRange(preset, TODAY);
		expect(range).toEqual({
			fromDay,
			toDay,
			from: `${fromDay}T00:00:00.000Z`,
			to: `${toDay}T23:59:59.999Z`,
			days,
		});
	});

	test("every preset fits the 400-day cap, and the select offers them plus a custom range", () => {
		for (const { id } of REPORTS_PRESETS) {
			if (id === "custom") continue;
			expect(presetRange(id, "2028-12-31").days).toBeLessThanOrEqual(400);
		}
		expect(REPORTS_PRESETS.map((p) => p.id)).toEqual([
			"today",
			"7d",
			"30d",
			"90d",
			"365d",
			"mtd",
			"ytd",
			"custom",
		]);
	});

	test("month to date on the 1st is a single day, not an empty period", () => {
		expect(presetRange("mtd", "2026-11-01")).toMatchObject({
			fromDay: "2026-11-01",
			toDay: "2026-11-01",
			days: 1,
		});
	});
});

describe("reports period: the comparison period is the equal-length run immediately before", () => {
	test("30 days → the 30 days that end the day before it starts", () => {
		expect(previousPeriod({ fromDay: "2026-09-21", toDay: "2026-10-20" })).toEqual({
			fromDay: "2026-08-22",
			toDay: "2026-09-20",
			from: "2026-08-22T00:00:00.000Z",
			to: "2026-09-20T23:59:59.999Z",
			days: 30,
		});
	});

	test("a single day compares with the day before, across a month and a year boundary", () => {
		expect(previousPeriod({ fromDay: "2026-01-01", toDay: "2026-01-01" })).toMatchObject({
			fromDay: "2025-12-31",
			toDay: "2025-12-31",
			days: 1,
		});
	});

	test("the phrase names the comparison length", () => {
		expect(comparisonPhrase(30)).toBe("previous 30 days");
		expect(comparisonPhrase(1)).toBe("previous day");
	});
});

describe("reports period: resolving the interaction", () => {
	test("a bare page load is the last 30 days, flagged as the default", () => {
		const range = resolveReportsRange({}, TODAY);
		expect(range).toMatchObject({
			preset: "30d",
			isDefault: true,
			fromDay: "2026-09-21",
			toDay: "2026-10-20",
			days: 30,
			previous: { fromDay: "2026-08-22", toDay: "2026-09-20", days: 30 },
		});
		expect(range.problem).toBeUndefined();
	});

	test("the period select's change fires a block action carrying the preset id", () => {
		const range = resolveReportsRange(
			{ type: "block_action", action_id: REPORTS_PERIOD_ACTION_ID, value: "7d" },
			TODAY,
		);
		expect(range).toMatchObject({ preset: "7d", isDefault: false, fromDay: "2026-10-14" });
		expect(range.previous).toMatchObject({ fromDay: "2026-10-07", toDay: "2026-10-13" });
	});

	test("the select's value is the preset's LABEL (its trigger shows the raw value)", () => {
		expect(
			resolveReportsRange(
				{ type: "block_action", action_id: REPORTS_PERIOD_ACTION_ID, value: "Last 90 days" },
				TODAY,
			),
		).toMatchObject({ preset: "90d", days: 90 });
		expect(presetValue("30d")).toBe("Last 30 days");
	});

	test("a page load may name a preset directly", () => {
		expect(resolveReportsRange({ preset: "90d" }, TODAY)).toMatchObject({
			preset: "90d",
			days: 90,
		});
	});

	test("an unknown preset is the default, never an error", () => {
		const range = resolveReportsRange(
			{ type: "block_action", action_id: REPORTS_PERIOD_ACTION_ID, value: "since-forever" },
			TODAY,
		);
		expect(range).toMatchObject({ preset: "30d", isDefault: true });
	});

	test("choosing Custom range opens the From/To form on the current default period", () => {
		const range = resolveReportsRange(
			{ type: "block_action", action_id: REPORTS_PERIOD_ACTION_ID, value: "custom" },
			TODAY,
		);
		expect(range).toMatchObject({
			preset: "custom",
			fromDay: "2026-09-21",
			toDay: "2026-10-20",
		});
		expect(range.problem).toBeUndefined();
	});

	test("a From/To submit is a custom period, with its own equal-length comparison", () => {
		const range = resolveReportsRange(
			{ type: "form_submit", values: { from: "2026-07-10", to: "2026-07-12" } },
			TODAY,
		);
		expect(range).toMatchObject({
			preset: "custom",
			isDefault: false,
			from: "2026-07-10T00:00:00.000Z",
			to: "2026-07-12T23:59:59.999Z",
			days: 3,
			previous: { fromDay: "2026-07-07", toDay: "2026-07-09", days: 3 },
		});
	});

	test("400 whole days is accepted; 401 falls back to the default with the cap stated, keeping the form open", () => {
		expect(resolveReportsRange({ from: "2026-01-01", to: "2027-02-04" }, TODAY)).toMatchObject({
			preset: "custom",
			days: 400,
		});
		const over = resolveReportsRange({ from: "2026-01-01", to: "2027-02-05" }, TODAY);
		expect(over).toMatchObject({ preset: "custom", fromDay: "2026-09-21", days: 30 });
		expect(over.problem).toBe("A reporting period covers up to 400 days. Choose a shorter one.");
	});

	test("the cap is judged on the SNAPPED whole days, not the raw instants", () => {
		const range = resolveReportsRange(
			{ from: "2025-01-01T23:59:00.000Z", to: "2026-02-05T00:01:00.000Z" },
			TODAY,
		);
		expect(range.problem).toBe("A reporting period covers up to 400 days. Choose a shorter one.");
	});

	test("a backwards or half-filled custom period states why and shows the default", () => {
		expect(
			resolveReportsRange({ values: { from: "2026-07-31", to: "2026-07-01" } }, TODAY).problem,
		).toMatch(/From date falls after the To date/);
		expect(resolveReportsRange({ values: { from: "2026-07-31" } }, TODAY).problem).toMatch(
			/Enter both a From and a To date/,
		);
		expect(
			resolveReportsRange({ values: { from: "not a day", to: "2026-07-01" } }, TODAY).problem,
		).toMatch(/calendar date/);
	});

	// A crafted bound at the edge of what `Date` can hold used to escape the
	// page: the previous-period shift stepped past the minimum date and
	// `toISOString` threw a RangeError into the host. Out-of-range years now land
	// on the same stated-problem banner as any other unusable period.
	test.each([
		["the minimum Date", "-271821-04-20T00:00:00.000Z", "-271821-04-20T00:00:00.000Z"],
		["the maximum Date", "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"],
		["a five-digit year", "+010000-01-01T00:00:00.000Z", "+010000-01-02T00:00:00.000Z"],
		["a year before 1970", "1969-12-30", "1969-12-31"],
	])("%s is refused with a problem, never a throw", (_name, from, to) => {
		const range = resolveReportsRange({ from, to }, TODAY);
		expect(range).toMatchObject({ preset: "custom", fromDay: "2026-09-21", days: 30 });
		expect(range.problem).toBe(
			"Choose dates between 1 Jan 1970 and 31 Dec 9999, then update the period.",
		);
		expect(range.previous).toMatchObject({ fromDay: "2026-08-22", days: 30 });
	});

	test("the edges of the accepted years still resolve, with well-formed days", () => {
		const first = resolveReportsRange({ from: "1970-01-01", to: "1970-01-03" }, TODAY);
		expect(first.problem).toBeUndefined();
		expect(first.previous).toMatchObject({ fromDay: "1969-12-29", toDay: "1969-12-31" });
		const last = resolveReportsRange({ from: "9999-12-29", to: "9999-12-31" }, TODAY);
		expect(last).toMatchObject({ fromDay: "9999-12-29", toDay: "9999-12-31", days: 3 });
		expect(last.problem).toBeUndefined();
	});
});
