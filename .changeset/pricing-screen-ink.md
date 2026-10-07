---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

Pricing & inventory: mark the exceptions, not every row

The two products screens now draw the states an operator has to act on
differently from the states they do not. A soft-deleted product, one that is
not for sale, an out-of-stock count and a low count each wear a bordered pill;
a healthy, priced, in-stock product stays the bare phrase it was. An unknown
count is still a plain em dash — absence is not an exception, and it never
becomes a zero.

The tone is derived from the record by two new pure helpers beside the existing
status formatters (`statusTone`, `stockTone`), so the ink cannot drift from the
words or from what the other surface decides about the same product. Only the
accent's border is coloured; the text stays at the inherited colour, which is
what lets one pill serve the light and dark themes without a conditional.

Alongside it: the list's title and price now anchor each row while the sku and
status recede, the price column is end-aligned to its tabular figures, the
drill-in link takes a solid underline on hover and on keyboard focus (a rule
the orders list now shares), the product detail opens on Price rather than
Identity, and a failed first load withdraws the filter panel instead of leaving
two option-less selects behind.
