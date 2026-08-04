---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

A failed load in the admin console stops showing the previous answer.

The Orders list rendered its table under `outcome.kind === "rows"` while the
count line and the failure notice beside it both acknowledged the failure, so
rows fetched before a failed reload survived it unmarked and recovery was a
manual page reload. It now answers a failure in one of three ways:

- **cold** (nothing ever loaded) — the error card alone: no count line, and no
  filter bar, whose Period menu takes its options from the page that just
  failed and would otherwise render empty;
- **stale** (a first page failed under rows) — the rows, the count and
  `Load more` are cleared in state; the filter bar and the filter summary stay,
  because the operator's typed filters are input rather than answer. The card
  carries the service's own words plus a sentence saying the rows went and why,
  and focus moves to Retry, which was inside a row that no longer exists;
- **partial** (a page behind a successful one failed) — every accumulated row
  and the count stand, and the card renders where `Load more` was, titled for
  the page that failed rather than the collection the rows disprove.

Pricing & inventory clears its table and count on the same terms (it has no
accumulated-pages case), and the product detail offers a retry beside Back.
Retry re-runs the same filter at the same cursor through the existing
generation counter — no new request shape — and does not clear the failure
until the response resolves, so nothing flashes back in the meantime.
