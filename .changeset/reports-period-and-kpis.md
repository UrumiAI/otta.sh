---
"@otta-sh/plugin": minor
---

Admin Reports: state the period, let the operator choose it, and fill all four
KPI tiles.

The page hardcoded a trailing 30 days, read `from`/`to` from its route input and
shipped no UI that could supply them — so an unlabelled revenue figure read
equally well as all-time or as today. Now:

- The subtitle leads with the active period in absolute dates
  (`10 Jul – 12 Jul 2026 (UTC)`), and a From/To `date_input` form changes it. Its
  submit id is registered in `REPORTS_ACTION_IDS`, so a period change can never
  fall through the dispatcher to a blank console. The form carries the bucket
  interval, so changing the period on a weekly report keeps it weekly. An
  unusable range (backwards, incomplete, wider than the service's 400-day cap)
  renders the default period with a banner saying why — always a 200.
- Every period is WHOLE DAYS, default included: `from` at the start of its day,
  `to` at the end of its. The default and a hand-entered identical period are
  therefore the same query, and "last 30 days" is exactly 30 day-rows.
- All four `stats` slots are used: Revenue, Orders, AOV and Refunded, each
  labelled with the period and, for money, its currency once. Money renders only
  through `formatMoney`; an average with no orders to average renders an
  em-dash, never `$0.00`. The refunded AMOUNT is absent from the reporting wire,
  and the tile says so rather than showing a figure it cannot know. Four filled
  slots is the SINGLE-CURRENCY case: a multi-currency window spends cards on
  revenue it cannot combine into one figure, and the cards that fall off the end
  are named in a line beneath, never dropped silently.
- Revenue by day emits the zero-revenue days, so a month of steady sales and a
  month with a three-week hole no longer render identically — for periods up to
  92 days in a single currency, where the fill shows shape rather than becoming
  the table. Otherwise the wire's sparse series renders and the group states the
  omission. The label drops the internal "(N buckets)" vocabulary.
- The low-stock group states the threshold its rows were selected by
  (`Low stock (3) — at or below 5`), read from `GET /settings`; a failed settings
  read drops the threshold from the label instead of taking the screen down.

Also corrects a false claim in this file's own documentation: Block Kit does ship
a `chart` block. It stays unused here because the renderer strips the formatters
a money axis needs, which would print raw minor units.
