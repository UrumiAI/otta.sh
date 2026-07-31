---
"@otta-sh/plugin": minor
---

The admin console states every timestamp in one format, and never as a wire value
(admin-UX INC-13). A raw `2026-07-10T01:00:00Z` under a label suffixed `(UTC)` is a
machine's format printed at a human: it takes a moment to read, and it cannot be
compared at a glance to anything else on the page. Every instant the console renders is
now `10 Jul 2026, 01:00 UTC`.

- **One dialect, one module.** `scaffold/datetime.ts` is the single home for the format
  and for the console's day bounds. It absorbed the two formatters that had grown
  independently — Orders' detail-header date and Reports' `formatDay` — which were the
  same `Intl` options, the same UTC pinning and the same locale chosen for the same
  reason, written twice by accident. It absorbed the two copies of `dayOf` /
  `startOfDay` / `endOfDay` / `DAY_MS` / `DAY_PATTERN` along with them, so the
  whole-days-both-ends-inclusive convention Orders and Reports had converged on
  separately can no longer be changed on one screen alone. Reports' rendering is
  byte-identical across the move; its suite is unchanged and green, which is the proof.
- **The zone moved out of the label and into the value.** `Placed (UTC) =
  2026-07-10T01:00:00Z` becomes `Placed = 10 Jul 2026, 01:00 UTC`. The zone comes from
  `Intl`'s own `timeZoneName` rather than English concatenated into label text, and the
  label goes back to naming the event. Applies to Orders (`Placed`, `Shipped`,
  `Recorded`, `Cancelled`, `Resolved`, `Email verified`, session `Expires` / `Revoked`)
  and to Pricing & inventory (`Created`, `Updated`, and the deleted-product banner).
- **The Orders detail stopped saying "placed" twice in two formats.** Its H1 states the
  date and its identity strip states the instant; the two are now one rendering
  truncated rather than two — `formatDate` and `formatTimestamp` share one set of date
  parts, so `10 Jul 2026` is a literal prefix of `10 Jul 2026, 01:00 UTC` by
  construction, and a test pins it over a spread of instants rather than one fixture.
- **`Placed` is absolute on the Orders list.** It was `relative_time`, against a detail
  screen that stated an instant — the same field reading as two different things one
  click apart, which left the operator to work out that they were one field. Both
  render identically now, as does the same column on the customer's other-orders table.
  "3 weeks ago" is also not what someone reconciling against a payout statement or
  checking a refund window needs. The columns that remain `relative_time` — `Signed in`
  on sessions, `When` on refunds and on the timeline — are each read for an AGE and each
  stated on exactly one surface.
- **Milliseconds and offsets stop being a display concern.** A value carrying an offset
  used to pass through onto the screen for the contract check to flag; it now renders as
  the instant it denotes, in UTC. That is a rendering, not a timezone conversion — the
  console still presents exactly one zone.
- **Enforced, not asserted screen by screen.** `assertNoRawTimestamps` walks a rendered
  response's `fields` values, plain table cells and `context` lines and fails on any
  wire timestamp. It is the strictly stronger successor to the existing precision/zone
  rule and runs over every state the Orders, Pricing & inventory and Reports suites
  render. It ships as its own assertion rather than inside `assertBlockContract`
  because that helper is deliberately all-or-nothing per call and Coupons' detail is not
  yet converted; folding it in is one line once that lands.
- **This does NOT localize the console.** The locale is pinned to `en-GB` and nothing
  threads a viewer's; every operator sees the same string as before this change, in a
  different format. What it buys is single-point localizABILITY: because every string
  comes from `Intl.DateTimeFormat` — no hand-assembled month names, no concatenated
  `(UTC)` — threading a real locale later is one constant, and the zone label follows it
  along with the numerals, month, separators and ordering. A hard-coded suffix would
  have had to be found and translated in seven label strings across three screens.
- **The format is an `en-GB` fact, and the acceptance criterion inherits that.** A
  trailing literal `UTC` is not universal on this option bag: `el-GR` spells the zone
  out, `fa-IR` parenthesises it, `zh-TW` brackets it, `vi-VN` puts the whole time run
  first. `8 Jul 2026, 10:30 UTC` holds exactly as long as the locale stays pinned —
  recorded in the module and pinned by a test, so whoever threads a real locale meets
  it rather than discovering it.
- **Not delivered: bidi isolation** at the seam where a formatted value is composed into
  surrounding copy. That exposure belongs to every value composed into a label, not to
  dates specifically, and is recorded as a console-wide follow-up rather than solved
  here with a wrapper only timestamps would get.

Date-only bounds — filter periods, coupon validity windows — are unchanged and stay
days. No service, wire, or schema change.
