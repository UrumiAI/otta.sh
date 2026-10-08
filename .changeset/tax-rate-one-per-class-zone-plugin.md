---
"@otta-sh/plugin": minor
---

Tax admin: creating a second rate for a class in a zone it already covers is refused with
a message naming the existing rate ("Class "standard" already has a rate for "United
States": "std-us" (7.25%) …"). Duplicates stored before this are flagged on the class's
rates page — a warning naming each pair, and `duplicate: only <id> applies` on the
ignored row — and stay editable and deletable. `RulesCreateResult`'s failure arm gains an
optional `duplicateTaxRate`.

**Check after upgrading if your store has duplicate tax rates.** Only the rate that applies
counts, for goods and for shipping. If an ignored duplicate was the one marked "applies to
shipping", shipping tax may change: it disappears, or moves to another class's rate. The
class's rates page flags every duplicate (the ignored row shows no shipping toggle), and
deleting the one you don't want resolves it. Orders already placed are unaffected.
