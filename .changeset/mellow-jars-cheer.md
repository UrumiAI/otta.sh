---
"@otta-sh/admin-react": patch
---

Shared console chrome: an opt-in card frame for list tables, a border-only status
pill, a hover- and focus-revealed Copy control, and a legible, centred confirm
dialog. `cursor` moves out of the inline button and disclosure styles into the
stylesheet, which retires the `!important` on the row-activation reset, lets that
reset reach a disclosure, and restores `not-allowed` on disabled controls inside
an activatable row. The confirm dialog's destructive
weight becomes a per-call tone, so an additive confirm stops reading as a
destructive one, and a button whose own click disables it now hands focus to a
named target instead of dropping it to the document.
