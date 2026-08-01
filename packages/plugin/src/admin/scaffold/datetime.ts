/**
 * The admin console's ONE date dialect (INC-13), RE-EXPORTED from
 * `@otta-sh/admin-presentation` since INC-20.
 *
 * INC-13 created this module to absorb three disagreeing answers to "what time
 * did this happen?" — a raw ISO value under a `(UTC)`-suffixed label, a
 * `relative_time` column whose detail screen restated the same field as an
 * absolute instant, and two screens that had each independently grown a private
 * date formatter. The whole point was that a change to the dialect is one edit
 * and cannot land on one screen only.
 *
 * INC-20 adds a screen the plugin cannot reach: the React Orders console in
 * `@otta-sh/admin-react`, which may not import `@otta-sh/plugin` at all
 * (ADR-0014 Decision 3 / `console-imports-no-workspace-package`). A React screen
 * with its own `Intl.DateTimeFormat` would put the console straight back to two
 * dialects, and the operator would meet the disagreement exactly where INC-13
 * found it — one click apart, on the same field. So the module moved down into a
 * package both surfaces can import.
 *
 * NOTHING ABOUT THE DIALECT CHANGED: still `8 Jul 2026, 10:30 UTC`, still
 * `en-GB` for its day-first spelled-month SHAPE rather than for its country,
 * still minutes and never seconds, still UTC-pinned on every surface, still one
 * localizable constant. See `@otta-sh/admin-presentation`'s `datetime.ts` for
 * the full rationale, the per-locale probe of what `timeZoneName: "short"`
 * actually renders, and the recorded bidi follow-up.
 *
 * This file stays as a re-export so `scaffold/datetime.js` — the path the seven
 * Block Kit screens and `scaffold/index.ts` already import — keeps working.
 */
export {
	DATE_LOCALE,
	DAY_MS,
	DAY_PATTERN,
	dayOf,
	endOfDay,
	formatDate,
	formatDay,
	formatTimestamp,
	startOfDay,
} from "@otta-sh/admin-presentation";
