---
"@otta-sh/admin-presentation": patch
"@otta-sh/admin-react": patch
---

A price save gets a before and an after, and Add stock gets the gate Remove
stock already had.

`Save price` wrote on the first click with nothing stating the pending change or
its size, and reported back a generic `Saved` at the top of the page that would
have read identically for a weight edit. It is still one click — routing every
save through a confirm dialog taxes the correct edits to guard the rare one —
but it now has four states:

- **clean** — `Save` is disabled under `No changes to save.`, because a clean
  save is a no-op that still bumps `updatedAt`. Dirtiness is compared against
  the last-committed values rather than latched, so typing a character and
  deleting it leaves nothing to save;
- **dirty** — the group's own label gains ` · unsaved` so a shut group cannot
  hide work, each changed input takes a warn border, a pending block above the
  buttons names both amounts over the sentence saying the save publishes to the
  storefront immediately, and `Discard` appears beside `Save`;
- **in flight** — only the button that was clicked reads `Saving…`;
- **saved** — a receipt renders inside the section, under the button, naming the
  two amounts and saying that orders already placed keep the price they were
  charged. It persists; nothing dismisses it.

Both ends of every `$9.00 → $99.99` come from the existing money formatter, over
integer minor units parsed by the same exact-integer parse the write itself
goes through. An absent end is stated as nothing rather than as `$0.00`.

On the stock panel, the two movements sat one above the other, took the same
input and had opposite gates for no stated reason. They are reconciled upward:
`Add stock` now confirms as `Remove stock` does. The direction is deliberate —
an over-add lets the store sell units it does not have, where an over-remove
only costs sales — and the dialog's job is restating the *parsed* quantity and
the on-hand it projects, which is the `10`-versus-`100` typo the field cannot
catch. `Remove stock` keeps its alert banner, danger styling and consequence
label, so a shared gate does not make two different acts look alike. Both
movements' receipts now render in the group that caused them.

No new endpoint, wire field, capability or dependency: every write posts the
same action id and the same payload as before.
