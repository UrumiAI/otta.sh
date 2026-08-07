---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

Fix the Pricing & inventory list stating a page-scoped "Low stock only" count as if it described the whole catalogue.

`listOutcome` inferred a count line was "complete" — and dropped its "on this page" / "loaded so far" qualifier — whenever the render held the first page and no next cursor remained. That inference holds for a service-side filter, where the fetched page and the filtered set are the same collection, but "Low stock only" narrows an already-fetched page client-side and carries no `total` while it is on. Whenever a narrowed result happened to fit on one page (or a scan reached the end of the catalogue), the count silently lost its qualifier — "3 low-stock products" read as a whole-catalogue claim the filter's own documented contract forbids.

`listOutcome` gains an optional `narrowedAfterFetch` flag that keeps the qualifier regardless of `firstPage`/`hasNext`; the Pricing & inventory list sets it whenever "Low stock only" is on. Every other caller (Orders, and every Block Kit list) is unaffected — the flag defaults to off and their filters are service-side, so their existing whole-set phrasing is unchanged. The screen's separate, deliberate withholding of the exact `total` while narrowed is untouched.
