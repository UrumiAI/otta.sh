---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

Load more now extends the console's Orders and Pricing & inventory lists instead of replacing them. A successful next page merges into the rows already on screen, keyed on the record's id so a row that appears on both pages renders once with the newer read; the cursor, total and filter vocabulary take the new page's values. Applying a filter, or opening a filtered address, still starts a fresh list.

A page that fails behind one that succeeded no longer discards what was loaded: on both lists the accumulated rows, their count and the cursor behind them all stand, retrying appends to them, and the failure is reported where Load more was, under a title the rows on screen do not disprove. Once rows come from more than one response the count says how many are loaded so far rather than claiming they are on one page; the Block Kit screens, which still replace, keep their existing wording.

A cursor now travels with the filter it was issued under, so a Load more left over from a previous filter can never be sent as a continuation of a new one.

"Low stock only" also states what it filtered — the count reads "3 low-stock products", and a note beside Load more says the filter applies to each page as it loads.
