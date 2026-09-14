---
"@otta-sh/store-emdash": minor
---

`ShippingRulesStore` and `TaxRulesStore` over the plugin-storage primitives, so the
shipping and tax configuration a checkout prices with no longer needs a SQL database
behind it.

- **One document per zone, one per tax class.** A zone carries its methods, and each
  method its rates by currency; a class carries its rates. The parent/child delete
  guards the SQL ran as `DELETE … WHERE NOT EXISTS (children)` stay atomic without a
  transaction: the emptiness test reads the very document the delete is guarded on, so
  a child created in between makes the delete refuse and the retry reports
  `in_use_by_methods` / `in_use_by_rates` rather than orphaning the child.
- **A claim document per child id.** Eight port methods take a method or rate id with
  no parent, and a document store has no primary key to make one unique across
  parents; the claim is both — created if absent, released on delete, taken over when
  it is orphaned by a crash, and loud when the child it names is really there.
- **The money edits re-verify on every attempt.** `updateRate`'s expected-value guard
  (`expectedAmountCents`, `expectedRateBps`) is re-read and re-compared whenever the
  shared document moves underneath it, so a caller that lost an edit race is told
  `stale` instead of overwriting the change it should have seen. Both contracts, a
  crowd race on Postgres and a deterministic parked-write case pin it.
- **A rate may exist without its class**, as it could in SQL — the class document
  holds the rates, and its name is what says the class was ever declared.
