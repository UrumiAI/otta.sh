---
"@otta-sh/plugin": minor
---

Tax admin: creating a second rate for a class in a zone it already covers is refused with
a message naming the existing rate ("Class "standard" already has a rate for "United
States": "std-us" (7.25%) …"). Duplicates stored before this are flagged on the class's
rates page — a warning naming each pair, and `duplicate: only <id> applies` on the
ignored row — and stay editable and deletable. `RulesCreateResult`'s failure arm gains an
optional `duplicateTaxRate`.
