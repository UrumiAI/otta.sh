---
"@otta-sh/plugin": minor
---

Tax admin: creating a second rate for a class in a zone it already covers is refused with
a message naming the existing rate ("Class "standard" already has a rate for "United
States": "std-us" (7.25%) …"). Duplicates stored before this are flagged on the class's
rates page — a warning naming each pair, and `duplicate: only <id> applies` on the
ignored row — and stay editable and deletable. `RulesCreateResult`'s failure arm gains an
optional `duplicateTaxRate`.

**Duplicate tax rates keep their totals.** Only the rate that applies is charged; an
ignored duplicate's "applies to shipping" still counts toward shipping tax, as before
(issue #447), and its row says so. The class's rates page flags every duplicate, and
deleting the one you don't want resolves it. Orders already placed are unaffected.

Tax rate edits are now also guarded on the "applies to shipping" flag: a tab that loaded
before another tab changed the flag gets the "changed since you loaded it — reload" notice
instead of reverting it. Submitting the same edit twice is "Rate saved" both times.

`TaxRateEdit` gains a required `expectedAppliesToShipping` (the flag the editor loaded);
`InProcessAdminRulesClient.updateTaxRate` refuses an edit without a boolean one.
