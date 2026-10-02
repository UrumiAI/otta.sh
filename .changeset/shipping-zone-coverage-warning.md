---
"@otta-sh/plugin": minor
---

The Shipping console says what the first zone does to checkout. ADR-0021 refuses a
physical checkout to an address no zone lists once any zone exists, and nothing on the
screen said so — QA created a Japan-only zone and every other country started seeing
"We don't ship to this address". The zones landing now carries a standing "Checkout only
ships to addresses your zones list" warning with the covered codes, and the first zone's
create screen warns and requires an acknowledgement toggle (re-checked against a fresh
zones read) before it saves. The matching rule itself is unchanged.
