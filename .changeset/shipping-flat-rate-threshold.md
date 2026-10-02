---
"@otta-sh/plugin": patch
---

A free-shipping threshold on a flat-rate method's rate is refused with the reason. The
domain charges a flat rate whatever the subtotal and reads the threshold only for a
free-shipping method, so the console used to store a threshold that checkout never
applied and report "Rate created". Creating or saving such a rate now says "A flat-rate
method always charges its rate, so a free-shipping threshold would never apply". Blank
thresholds, and free-shipping methods, are unchanged.

The rules client enforces the same rule (`createRate`/`updateRate` refuse a non-null
`minSubtotalCents` on a flat-rate method's rate), and switching a free-shipping method to
flat rate saves with a notice that its rates' thresholds no longer apply.
