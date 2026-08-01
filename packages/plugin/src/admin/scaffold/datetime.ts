/**
 * The admin console's ONE date dialect (INC-13).
 *
 * WHY THIS FILE EXISTS. The console had grown three answers to "what time did
 * this happen?" and they disagreed on screen:
 *
 *  - `fields` rendered the raw wire value — `2026-07-10T01:00:00Z` — under a
 *    label suffixed `(UTC)`. That is a machine's format printed at a human: an
 *    operator reading it has to parse a date out of punctuation, and cannot
 *    compare it at a glance to anything else on the page.
 *  - Table columns rendered `relative_time` ("3 weeks ago"), which the ORDER
 *    DETAIL then restated as an absolute instant — so the same field, `Placed`,
 *    read as two different things one click apart.
 *  - Two screens had each independently grown a date formatter
 *    (`orders-page.ts`'s `HEADER_DATE`/`headerDate` and `reports-page.ts`'s
 *    `DATE_LOCALE`/`formatDay`) plus a private copy of the same three day
 *    helpers. Same Intl options, same UTC pinning, same locale chosen for the
 *    same reason, written twice by accident. Each carried a comment pointing at
 *    the other and naming this module as the absorber.
 *
 * This module is that absorber. Everything the console renders as a date or a
 * timestamp comes from here, so a change to the dialect is one edit and cannot
 * land on one screen only.
 *
 * THE FORMAT: `8 Jul 2026, 10:30 UTC`.
 *
 *  - DAY-MONTH-YEAR, spelled month. `8 Jul 2026` cannot be misread the way a
 *    numeric `7/8/2026` can — the ambiguity is not a nit when the value decides
 *    whether an order is inside a refund window. `en-GB` is the locale for that
 *    SHAPE, not for its country.
 *  - MINUTES, never seconds. Seconds are noise on every surface here (M-6 said
 *    as much when it asked for ISO trimmed to seconds; a human-readable
 *    rendering can go one step further), and `hourCycle: "h23"` keeps midnight
 *    as `00:00` rather than a locale-dependent `24:00`.
 *  - THE ZONE IS PART OF THE VALUE, not of the label. It comes from Intl's own
 *    `timeZoneName`, which is why the `(UTC)` suffix that every one of these
 *    labels used to carry is gone: ICU writes the zone itself and the label goes
 *    back to naming the event (`Placed`, `Shipped`, `Cancelled`). The gain is
 *    that the zone is now one more thing {@link DATE_LOCALE} governs instead of
 *    English hard-coded into seven label strings — see the localization note.
 *  - UTC-PINNED, ALWAYS (M-6). No surface in this console converts a timestamp
 *    to a local zone. A value carrying an offset (`…+05:00`) is formatted as
 *    the instant it denotes, in UTC — which is a rendering, not a conversion,
 *    and is strictly better than the old pass-through that put a non-UTC offset
 *    on screen for X-13 to flag.
 *
 * LOCALIZATION (G6) — READ THE CLAIM NARROWLY. THE CONSOLE IS NOT LOCALIZED.
 * {@link DATE_LOCALE} is pinned to `en-GB` and nothing threads a viewer locale
 * to it; every operator sees `8 Jul 2026, 10:30 UTC` regardless of their own.
 * What this module delivers is SINGLE-POINT LOCALIZABILITY: because every
 * string comes from `Intl.DateTimeFormat` rather than hand-assembled month
 * names or a concatenated `(UTC)`, the day when a real locale IS threaded
 * through, one constant moves and the numerals, month, separators, ordering AND
 * the zone label all follow. A hard-coded suffix would have had to be found and
 * translated in seven label strings across three screens instead.
 *
 * THE SPEC'S FORMAT IS A CLAIM ABOUT `en-GB`, NOT ABOUT ICU. Probed on the
 * option bag below, a trailing literal `UTC` is NOT universal:
 *
 *    en-GB  `8 Jul 2026, 10:30 UTC`          the pinned rendering
 *    el-GR  `8 Ιουλ 2026, 10:30 (Συντονισμένη Παγκόσμια Ώρα)`   spelled out
 *    fa-IR  `۱۷ تیر ۱۴۰۵، ۱۰:۳۰ (UTC)`        parenthesised
 *    zh-TW  `2026年7月8日 10:30 [UTC]`          bracketed
 *    vi-VN  `10:30 UTC 8 thg 7, 2026`         time run FIRST
 *
 * So `8 Jul 2026, 10:30 UTC` holds exactly as long as the locale stays pinned.
 * Whoever threads a real locale must revisit the acceptance criterion itself —
 * the right reading of it is "the zone is stated in the value", which all five
 * satisfy, not "the string ends in the characters U-T-C", which three do not.
 *
 * BIDI — what is NOT delivered. This module does not wrap its output in
 * `U+2068 FSI` / `U+2069 PDI`. ICU bidi-balances WITHIN the string it returns,
 * but a formatted timestamp is composed into surrounding text at several call
 * sites (a `fields` value beside its label; a banner sentence such as
 * `Deleted on <value>. It cannot be edited…`), and on an RTL page such a
 * composition can reorder the LTR run against the surrounding text at the seam.
 * Isolating it is a console-wide decision — every value composed into a label
 * has the same exposure, not just dates — and it is a recorded follow-up, not
 * something this module should solve locally with a bespoke wrapper only dates
 * get.
 *
 * IO-FREE — pure `Intl` + string work, safe inside the workerd sandbox (G7).
 */

/** THE single point the console's date rendering is localizable at — pinned
 *  today, and the one constant a future locale-aware console has to thread.
 *  `en-GB` is chosen for its day-first, spelled-month SHAPE (`8 Jul 2026`,
 *  which cannot be misread the way `7/8/2026` can), not for its country. */
export const DATE_LOCALE = "en-GB";

/** One whole day in milliseconds. Absorbed from the two private copies
 *  (`orders-page.ts`, `reports-page.ts`) that computed period bounds with it. */
export const DAY_MS = 86_400_000;

/** A bare calendar day — what a `date_input` submits, and the only shape
 *  {@link startOfDay} / {@link endOfDay} will expand. */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UTC_ONLY = { timeZone: "UTC" } as const;

/** The date half of the dialect. Shared by {@link formatTimestamp} and
 *  {@link formatDate} SO THEY CANNOT DRIFT: the date the order detail's H1
 *  shows is the same substring the identity strip shows, by construction rather
 *  than by two option objects that happen to match today. */
const DATE_PARTS = { day: "numeric", month: "short", year: "numeric" } as const;

/** The time half. `h23` rather than `hour12: false`, which in some locales
 *  yields `24:00` for midnight. */
const TIME_PARTS = {
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZoneName: "short",
} as const;

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, {
	...UTC_ONLY,
	...DATE_PARTS,
	...TIME_PARTS,
});
const DATE_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, { ...UTC_ONLY, ...DATE_PARTS });
const DAY_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, {
	...UTC_ONLY,
	day: "numeric",
	month: "short",
});

/**
 * A wire timestamp → `8 Jul 2026, 10:30 UTC`. THE console's timestamp: every
 * `fields` entry and every table cell that states an instant renders through
 * this, on the list and on the detail alike.
 *
 * A value `Date` cannot parse is returned UNCHANGED. That path is unreachable
 * for anything the service produces — every wire timestamp is RFC 3339, and
 * `Date` parses all of them — and it exists so a malformed value stays visible
 * and debuggable instead of being replaced by an invented date or a `—` that
 * would claim the field is empty when it is not. It is also, by construction,
 * the one path in the console that can still put an ISO-shaped string on
 * screen; the suites assert against it rather than assuming it away.
 */
export function formatTimestamp(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? iso : TIMESTAMP_FORMAT.format(at);
}

/**
 * The same instant, DATE ONLY — `8 Jul 2026`. Two callers, and the shared
 * reason is that a time of day would be noise in both:
 *
 *  - the order detail's H1 (`Order · <customer> · <date>`), which states a date
 *    as part of a TITLE rather than as a value, in the largest type on the page;
 *  - a coupon's validity window (`10 Jul 2026 – 1 Aug 2026`), whose bounds are
 *    whole DAYS the merchant set — so rendering an hour would invent precision
 *    the value does not have (INC-10).
 *
 * It is a strict PREFIX of {@link formatTimestamp} on the same input (both draw
 * on {@link DATE_PARTS}), which is what collapses the order detail's old habit
 * of stating "placed" twice in two formats: the H1 and the identity strip now
 * say the same words, the strip simply says more of them.
 */
export function formatDate(iso: string): string {
	const at = new Date(iso);
	// CAPPED AT 10 CHARACTERS, unlike `formatTimestamp`'s pass-through, and the
	// difference is the surface: this one feeds the order detail's H1, the
	// largest type on the page, where unbounded unrecognised text would be a
	// worse failure than a stub. 10 is the width of the `YYYY-MM-DD` this would
	// have emitted for a real-but-unparseable wire value.
	return Number.isNaN(at.getTime()) ? iso.slice(0, 10) : DATE_FORMAT.format(at);
}

/**
 * A calendar day (`YYYY-MM-DD`) → `1 Jul` or `1 Jul 2026`. Absorbed from
 * Reports, which is the only screen with a reason to drop the year: a period
 * whose ends share a year states it once (`1 Jul – 31 Jul 2026`) instead of
 * twice.
 *
 * Takes a DAY, not an instant — Reports snaps every bound to a whole day before
 * anything is rendered, and a helper that accepted both would invite a caller
 * to render a time of day on a screen that presents none.
 */
export function formatDay(day: string, withYear: boolean): string {
	const at = new Date(`${day}T00:00:00.000Z`);
	if (Number.isNaN(at.getTime())) return day;
	return withYear ? DATE_FORMAT.format(at) : DAY_FORMAT.format(at);
}

/** The `YYYY-MM-DD` (UTC) a moment falls on. */
export function dayOf(at: Date): string {
	return at.toISOString().slice(0, 10);
}

/**
 * A submitted day → the FIRST instant of it.
 *
 * Together with {@link endOfDay} this is the console's single date-bounds
 * convention: WHOLE DAYS, BOTH ENDS INCLUSIVE, so a `To` of 12 Jul includes
 * 12 Jul. Orders and Reports converged on it separately and then each kept a
 * private copy; they now share this one, so the convention cannot be changed on
 * one screen alone.
 *
 * A full datetime — which a `date_input` never submits, but a hand-made carrier
 * could carry — passes through untouched rather than being re-anchored.
 */
export function startOfDay(value: string): string {
	return DAY_PATTERN.test(value) ? `${value}T00:00:00.000Z` : value;
}

/** A submitted day → the LAST instant of it, which is what makes a `To` day
 *  part of the period the operator asked for. See {@link startOfDay}. */
export function endOfDay(value: string): string {
	return DAY_PATTERN.test(value) ? `${value}T23:59:59.999Z` : value;
}
