---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
"@otta-sh/plugin": patch
---

Fix the Pricing & inventory list stating a page-scoped "Low stock only" count as if it described the whole catalogue.

`listOutcome` inferred a count line was "complete" — and dropped its "on this page" / "loaded so far" qualifier — whenever the render held the first page and no next cursor remained. That inference holds for a service-side filter, where the fetched page and the filtered set are the same collection, but "Low stock only" narrows an already-fetched page client-side, so the fetch being done says nothing about whether the narrowed set is. Whenever a narrowed result happened to fit on one page (or a scan reached the end of the catalogue), the count could lose its qualifier and read as a whole-catalogue claim.

`listOutcome` now takes a **required** `countScope: "service-filtered" | "narrowed-after-fetch"` in place of an opt-in boolean, so a caller cannot omit it and quietly inherit the larger, whole-set-capable default. Setting `"narrowed-after-fetch"` keeps the qualifier regardless of `firstPage`/`hasNext`, and refuses to honour a `total` even if one is present — both enforced inside `listOutcome`, not left to the caller. `orders-list.tsx` and `@otta-sh/plugin`'s Block Kit `listResult` (and its one caller, Coupons) state `"service-filtered"` explicitly; no behaviour change for either, since neither narrows a fetched page.

The Pricing & inventory list sets `"narrowed-after-fetch"` from whether the low-stock narrowing **actually applied to the page being rendered**, not from whether the operator checked the box: the plugin can leave a request unnarrowed (`stock.filterUnavailable`, when the low-stock threshold can't be read) while still returning every product and the service's own exact `total`, and the count now reads "products" — with that real total — on exactly that page, never "low-stock products" beside a total that describes a different set of rows.
