---
"@otta-sh/domain": minor
---

`TaxRequest` gains an optional, non-enumerable `signal: AbortSignal`, aborted when Otta
stops waiting for an outside tax calculator (its timeout). A calculator doing IO should
pass it to `fetch`. `purpose: "order"` is now documented as non-committing: it is asked
before the order exists and may be asked again on a same-key retry, so a calculator must
not file a transaction on it.
