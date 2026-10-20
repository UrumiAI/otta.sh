/**
 * The Reports page's PERIOD — which whole UTC days the figures cover, and which
 * equal-length run of days they are compared with.
 *
 * Pure functions of the interaction and of "today", so every rule here is a unit
 * test rather than a sandbox case: the presets (Shopify's date-range menu, adapted
 * to whole UTC days), the custom From/To period with its 400-day cap, and the
 * comparison period the KPI deltas and the dashed "previous period" line read.
 *
 * WHOLE DAYS, BOTH ENDS INCLUSIVE, TODAY INCLUDED. "Last 30 days" is 30 day
 * documents ending with today's, so the default and a hand-typed identical period
 * are the SAME query (see `startOfDay`/`endOfDay`, the console's one bounds rule).
 */
import { dayOf, DAY_MS, endOfDay, startOfDay } from "@urumi.ai/otta-admin-presentation";

/** The period select's change — a REAL action (it fires on every pick), so it is
 *  registered in `REPORTS_ACTION_IDS` beside the From/To form's submit. */
export const REPORTS_PERIOD_ACTION_ID = "reports:period";

/** The domain's own cap (`MAX_REPORT_RANGE_DAYS`), checked here so an over-wide
 *  custom period renders the page with a banner naming the limit instead of the
 *  generic fail-closed screen. */
export const MAX_RANGE_DAYS = 400;

/** What a bare page load shows. */
export const DEFAULT_PRESET = "30d" satisfies ReportsPreset;

export type ReportsPreset = "today" | "7d" | "30d" | "90d" | "365d" | "mtd" | "ytd" | "custom";

/** The select's options, in menu order. `custom` opens the From/To form. */
export const REPORTS_PRESETS: ReadonlyArray<{ id: ReportsPreset; label: string }> = [
	{ id: "today", label: "Today" },
	{ id: "7d", label: "Last 7 days" },
	{ id: "30d", label: "Last 30 days" },
	{ id: "90d", label: "Last 90 days" },
	{ id: "365d", label: "Last 365 days" },
	{ id: "mtd", label: "Month to date" },
	{ id: "ytd", label: "Year to date" },
	{ id: "custom", label: "Custom range" },
];

/** A preset by its id OR its label. The select's option VALUE is the label, not
 *  the id: em-dash's select trigger renders the raw value (spec R-17a/F-6c), so the
 *  value is what the operator reads — "Last 30 days", never "30d". */
const PRESET_BY_KEY: ReadonlyMap<string, ReportsPreset> = new Map(
	REPORTS_PRESETS.flatMap((p) => [
		[p.id, p.id],
		[p.label, p.id],
	]),
);

/** The select's option value for a preset — its label (see {@link PRESET_BY_KEY}). */
export function presetValue(preset: ReportsPreset): string {
	return REPORTS_PRESETS.find((p) => p.id === preset)?.label ?? preset;
}

/** A run of whole UTC days: the ISO instants the reads take, the `YYYY-MM-DD`
 *  days the labels and the form show, and how many days it spans. */
export interface ReportPeriod {
	from: string;
	to: string;
	fromDay: string;
	toDay: string;
	days: number;
}

/**
 * The period this render answers for, resolved ONCE and threaded into every read,
 * every card and every chart — so those can never disagree.
 *
 * `isDefault` is true only for the untouched default (a bare load), which is what
 * a problem banner falls back to. `problem` is set when a submitted custom period
 * was unusable: the page then renders the DEFAULT period plus that reason as a
 * banner (never a 4xx: G5, and never a silent substitution).
 */
export interface ResolvedRange extends ReportPeriod {
	preset: ReportsPreset;
	isDefault: boolean;
	/** The equal-length run of days immediately before — what the deltas and the
	 *  comparison line are measured against. */
	previous: ReportPeriod;
	problem?: string;
}

/** The interaction fields this module reads. Every field is `unknown`: it is
 *  whatever the host delivered, and is narrowed here. */
export interface ReportsRangeInput {
	type?: unknown;
	action_id?: unknown;
	value?: unknown;
	preset?: unknown;
	from?: unknown;
	to?: unknown;
	values?: unknown;
}

/** A day pair → the period, both bounds whole days. */
export function periodFromDays(fromDay: string, toDay: string): ReportPeriod {
	return {
		from: startOfDay(fromDay),
		to: endOfDay(toDay),
		fromDay,
		toDay,
		days: dayCount(fromDay, toDay),
	};
}

/** A preset → its days, ending with `today` (a `YYYY-MM-DD`, UTC). */
export function presetRange(preset: Exclude<ReportsPreset, "custom">, today: string): ReportPeriod {
	switch (preset) {
		case "today":
			return periodFromDays(today, today);
		case "7d":
			return trailing(7, today);
		case "30d":
			return trailing(30, today);
		case "90d":
			return trailing(90, today);
		case "365d":
			return trailing(365, today);
		case "mtd":
			return periodFromDays(`${today.slice(0, 7)}-01`, today);
		case "ytd":
			return periodFromDays(`${today.slice(0, 4)}-01-01`, today);
	}
}

/** The equal-length run of whole days that ends the day before `period` starts. */
export function previousPeriod(period: { fromDay: string; toDay: string }): ReportPeriod {
	const days = dayCount(period.fromDay, period.toDay);
	const toDay = shiftDay(period.fromDay, -1);
	return periodFromDays(shiftDay(toDay, -(days - 1)), toDay);
}

/** "previous 30 days" — what every delta says it is measured against. */
export function comparisonPhrase(days: number): string {
	return days === 1 ? "previous day" : `previous ${days} days`;
}

/**
 * Resolve the period from whichever interaction delivered it:
 *
 *  - the period select's `block_action` (`value` is a preset id);
 *  - the From/To form's `form_submit` (`values.from`/`values.to`) — custom;
 *  - a `page_load` carrying `from`/`to` (custom) or `preset`;
 *  - anything else — the default.
 *
 * EVERY branch returns a range: this page has no failure mode that may be a
 * non-2xx (G5), so an unusable custom period announces itself as `problem` and
 * renders the default instead — keeping the custom form open so the operator can
 * correct it.
 */
export function resolveReportsRange(
	input: ReportsRangeInput,
	today: string = dayOf(new Date()),
): ResolvedRange {
	const bounds = readBounds(input);
	const hasFrom = bounds.from !== undefined && bounds.from.trim().length > 0;
	const hasTo = bounds.to !== undefined && bounds.to.trim().length > 0;
	if (hasFrom || hasTo) return resolveCustom(bounds, hasFrom && hasTo, today);

	const requested = readPreset(input);
	if (requested === "custom") {
		// The form opens on the default period's days; nothing else is known — a
		// select's change carries its value and nothing about the period on screen.
		return withPrevious({
			...presetRange(DEFAULT_PRESET, today),
			preset: "custom",
			isDefault: false,
		});
	}
	const preset = requested ?? DEFAULT_PRESET;
	return withPrevious({
		...presetRange(preset, today),
		preset,
		isDefault: requested === undefined,
	});
}

function resolveCustom(
	bounds: { from?: string; to?: string },
	both: boolean,
	today: string,
): ResolvedRange {
	const fallback = (problem: string): ResolvedRange =>
		withPrevious({
			...presetRange(DEFAULT_PRESET, today),
			preset: "custom",
			isDefault: false,
			problem,
		});
	if (!both) return fallback("Enter both a From and a To date to report on a custom period.");
	const from = parseBound(bounds.from ?? "", "from");
	const to = parseBound(bounds.to ?? "", "to");
	if (from === undefined || to === undefined) {
		return fallback("Enter both dates as a calendar date, then update the period.");
	}
	// Snap to whole days FIRST, then judge the snapped period: this screen has no
	// surface that presents a time of day, so every check runs on the window
	// actually queried. Judged on the SNAPPED span, never the raw one —
	// `2025-01-01T23:59Z` to `2026-02-05T00:01Z` is 399 raw days but 401 whole ones.
	const fromDay = dayOf(from);
	const toDay = dayOf(to);
	if (fromDay > toDay) {
		return fallback("The From date falls after the To date. Swap them, then update again.");
	}
	if (dayCount(fromDay, toDay) > MAX_RANGE_DAYS) {
		return fallback(
			`A reporting period covers up to ${MAX_RANGE_DAYS} days. Choose a shorter one.`,
		);
	}
	return withPrevious({ ...periodFromDays(fromDay, toDay), preset: "custom", isDefault: false });
}

function withPrevious(range: Omit<ResolvedRange, "previous">): ResolvedRange {
	return { ...range, previous: previousPeriod(range) };
}

/** The preset a select change or a page load named, if it names a real one. */
function readPreset(input: ReportsRangeInput): ReportsPreset | undefined {
	const raw = input.action_id === REPORTS_PERIOD_ACTION_ID ? input.value : input.preset;
	return typeof raw === "string" ? PRESET_BY_KEY.get(raw) : undefined;
}

/** A `from`/`to` pair from wherever this interaction carried it: a form submit's
 *  `values`, else the route input itself. */
function readBounds(input: ReportsRangeInput): { from?: string; to?: string } {
	const values =
		typeof input.values === "object" && input.values !== null
			? (input.values as Record<string, unknown>)
			: {};
	const from = values["from"] ?? input.from;
	const to = values["to"] ?? input.to;
	return {
		...(typeof from === "string" ? { from } : {}),
		...(typeof to === "string" ? { to } : {}),
	};
}

/**
 * A submitted bound → an instant. A `date_input` yields `YYYY-MM-DD`, which is a
 * DAY: the `to` bound resolves to the END of that day, because the window is
 * inclusive and `…T00:00:00Z` would drop every order placed on the last day asked
 * for. A full ISO string (the `page_load` shape) is taken as given.
 */
function parseBound(value: string, edge: "from" | "to"): Date | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const at = new Date(edge === "from" ? startOfDay(trimmed) : endOfDay(trimmed));
	return Number.isNaN(at.getTime()) ? undefined : at;
}

function trailing(days: number, today: string): ReportPeriod {
	return periodFromDays(shiftDay(today, -(days - 1)), today);
}

/** `day` moved by `by` whole days (UTC). */
export function shiftDay(day: string, by: number): string {
	return dayOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + by * DAY_MS));
}

/** Whole days from `fromDay` to `toDay` INCLUSIVE — the unit the cap, the labels
 *  and the chart buckets all count in. */
export function dayCount(fromDay: string, toDay: string): number {
	const start = Date.parse(`${fromDay}T00:00:00.000Z`);
	const end = Date.parse(`${toDay}T00:00:00.000Z`);
	return Math.round((end - start) / DAY_MS) + 1;
}
