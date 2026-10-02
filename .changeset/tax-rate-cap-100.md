---
"@otta-sh/plugin": patch
---

A tax rate is capped at 100%. The Tax console used to accept up to 1000% (and said so),
and QA saved a 150% rate. Create and save now refuse anything above 100% ("Rate must be a
percent from 0 to 100"), and the rules client refuses a tax `rateBps` above 10000 — the
range the domain port already documents. Coupon percentages are unchanged.
