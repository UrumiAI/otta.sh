# 0038. The Reports page draws charts, with money as pre-formatted strings

- Status: accepted
- Date: 2026-10-20
- Amends: `docs/admin/ADMIN-CONSOLE.md` R-19, §2 (`columns`, `chart`), X-15 and §12.5

## Context

The admin console spec forbade `chart` on every screen (R-19): em-dash's chart renderer strips
`formatter`, `rich`, `graphic` and `axisPointer` from a custom ECharts option as XSS vectors, and a
Block Kit response is JSON, so no formatting function can reach it. A `timeseries` chart therefore
prints raw numbers — integer minor units (9900, not $99.00) — on its axis and in its tooltip, and
plotting major units would put a display float on the money path. Reports rendered a 30-row
revenue table instead.

The merchant asked for a Shopify-style analytics page: graphs, clean and attractive.

What the installed renderer (`@emdash-cms/blocks` 1.0.1, `blocks/chart.tsx`) actually allows:
LineChart, BarChart and PieChart, with the Aria, AxisPointer, Grid and Tooltip components. No
legend, title, dataset or markLine.

## Decision

1. **Reports may use `chart` (`chart_type: "custom"` only) and `columns`.** No other screen may.
2. **Money a chart shows is a string formatted by `formatMoney`; money it plots stays integer
   minor units.** Two ECharts mechanisms need no formatter:
   - a series carries a third data dimension holding the formatted text, and `encode.tooltip` /
     `encode.label` points at it, so tooltips and bar labels print `$30.00`;
   - the money axis is a hidden value axis (0 to `max` in equal integer steps) with a category
     axis of formatted tick labels (`$0`, `$25`, …) laid over it; with `boundaryGap: false` the
     N labels sit exactly on the N value ticks.
3. **No option key the renderer strips**, and nothing that needs an unregistered component —
   series meaning is stated in a `context` line, not a legend.
4. The block contract's X-15 enforces 1 and 3 on Reports (`test/helpers/block-contract.ts`).

To draw orders over time, `PeriodBucket` gained `revenueOrderCount` — the existing
`reporting_daily.revenueOrders` counter, so no new write and no per-order scan.

## Consequences

- Reports: period presets, KPI cards with the change against the previous period of equal length
  (two more reads of the same rollup), a sales line with a dashed comparison line, an orders bar
  chart, a status donut and a top-products bar chart. Low stock stays a table.
- A multi-currency period cannot share one money axis, so its per-day sales stay a sparse table.
- `columns` are a fixed 2-up split with no responsive breakpoint, so the paired charts are cramped
  on a narrow screen.
- A canvas chart is less accessible than a table: screen readers get only ECharts' aria
  auto-description. The exact figures still appear as text — in the cards, the bar labels, the
  donut's slice names and the tooltips.
- A product title that looks like HTML renders escaped in the top-products chart (cosmetic, and the
  renderer's doing; nothing is interpreted).
- If a later renderer registers `LegendComponent` or allows a safe formatter, the context-line
  legend and the category-axis trick can be simplified; the money rule stays.
