---
"@otta-sh/plugin": patch
---

Reports: naming the stat cards that did not fit no longer uses a regular expression that ran in quadratic time on long runs of spaces or `(` (CodeQL js/polynomial-redos). The names it produces are unchanged.
