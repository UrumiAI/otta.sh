---
"@otta-sh/domain": patch
---

`computeQuote`'s `taxLocated` (and the order tax snapshot's `located`) is now also true when
the tax calculator charged tax without a matched zone — an outside calculator answering for
the ship-to on a store with no shipping zones (#436). The checkout review and the order page
then show the tax charged instead of "Not calculated". The built-in rate table charges nothing
without a zone, so its quotes are unchanged; orders already placed keep their stored flag.
