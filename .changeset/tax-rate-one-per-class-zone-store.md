---
"@otta-sh/store-emdash": minor
---

`EmdashTaxRulesStore.createRate` refuses a second rate for one (class, zone) with
`TaxRateDuplicateError`. The check reads the class document the embed is
compare-and-set against, so concurrent creates for one slot admit exactly one; a refused
create keeps its rate-id claim as an orphan the next create of that id adopts, and a
create whose class already holds its id is an id collision. `updateRate` with
`appliesToShipping` omitted leaves the flag unchanged. `getRate` now answers the rate that applies (the
greatest id) where legacy duplicates survive, instead of the lowest id.
