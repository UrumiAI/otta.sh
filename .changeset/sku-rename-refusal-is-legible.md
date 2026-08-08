---
"@otta-sh/service": minor
"@otta-sh/plugin": minor
"@otta-sh/admin-react": minor
---

A refused SKU rename now reaches the operator as a sentence, beside the SKU field.

Renaming a SKU carries its stock across, and there are two states the domain refuses because it
cannot carry them honestly: the new SKU already has a stock record of its own, or the old SKU
still has live reservations against it. Both refusals were correct and atomic — nothing was
written on either side — and both arrived at the console as a generic failure with a 500 behind
it. On the one screen where the answer is "type a different SKU" or "wait a few minutes", the
operator was told only that something had gone wrong, and the reason survived nowhere but the
service log.

- **Both writers answer with a structured conflict**, in the shape each already used for a SKU
  collision: a machine code — `SKU_STOCK_CONFLICT` or `SKU_HELD_STOCK` — plus the facts the answer
  needs, which are both SKUs, or the SKU and how many reservations still reference it. The admin
  edit and the integrator `PUT /products/:id/commerce` behave identically, because the rule
  belongs to the field rather than to one caller. Nothing else crosses the wire: no internal
  message, no error name, no stack, no hint of the tables the check ran against.
- **One sentence per refusal, written once.** "That SKU already has stock of its own" names both
  SKUs and says what to do instead — rename to a SKU that has never held stock, or move the other
  SKU's units first. "This SKU has reservations in flight" names the SKU and the count, and says
  the holds end on their own, because they do: a cart hold expires and an order's hold settles
  with the order. Both open by saying nothing was changed, which is the fact the next decision
  rests on.
- **It renders beside the SKU field, not at the top of the page.** A refusal an operator can only
  answer by changing one input belongs next to that input, and the field points at it so it is
  announced together with the field — focus moves into the message when it arrives, because the
  click that raised it landed on Save and the message is no longer repeated at the top of the page.
  Identity is the group that is shut on arrival, so a served refusal holds that group open — once
  opened it stays opened, and closing it remains the operator's to do. Every other outcome — a
  save, a stale watermark, a SKU another live product already holds — reports at the top of the
  screen exactly as before.
- **A refused save keeps what the operator typed.** Every save on this screen is followed by a
  re-read, and the section that saved is re-seeded from the record that came back. A refusal wrote
  nothing, so there is nothing to re-seed from — and re-seeding anyway replaced the rejected SKU
  with the stored one, underneath a sentence advising a different SKU. The form now keeps the
  draft and reports itself unsaved, which it is. This applies to all three of the split forms: a
  refused price or shipping save keeps its typed values too.

A count the service did not send is never rendered as `0`: zero reservations beside a refusal
caused by reservations would be the one thing the sentence must not say, so the copy drops the
figure and keeps the fact.
