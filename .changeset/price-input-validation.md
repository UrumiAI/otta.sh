---
"@urumi/plugin": minor
---

Reject invalid product-data input before the CMS save instead of diverging
silently. Typing a decimal (`24.99`) or a negative price into the "Product
data" widget's minor-units Price field used to show a green "Saved" toast while
the commerce service kept the old price — the CMS stored a number nothing
downstream would ever honour, with no error anywhere.

A new `content:beforeSave` hook now validates the widget's `commerce` bag before
anything is written. When a value is wrong it **strips the invalid bag from the
save payload** — so the last-good price survives untouched — and surfaces a
merchant-facing message in the editor's save toast, naming the offending value
and the required form. Valid input is untouched and costs nothing.

Only **present-and-wrong** values block: a decimal / negative / NaN / unsafe
price, a malformed currency, a blank or malformed SKU, a non-integer stock or
dimension, an unknown product kind. Absent, empty and cleared values are always
clean, so unpriced products stay saveable and clearing the price is always a way
back to a saveable state. A price of `0` is valid. The Price field's label now
says *whole number, no decimals* explicitly.

Merchant-visible notes:

- **Products whose stored data already holds a bad value become unsaveable until
  it is fixed** (the editor resubmits the stored bag). Recovery is one gesture:
  correct the price or clear the field, then save.
- **Autosave will show a repeated "Autosave failed" toast** (~every 2 s) while a
  genuinely invalid value sits in the field. That is the intended feedback; the
  real cure is upstream support for per-field errors in em-dash's Block Kit
  field widget.

The plugin now declares the `content:write` capability — em-dash requires it to
register a `content:beforeSave` hook at all, and silently skips the hook without
it. The grant is broader than the one narrow behaviour we use; the bounds and
the trade are recorded in ADR-0012.
