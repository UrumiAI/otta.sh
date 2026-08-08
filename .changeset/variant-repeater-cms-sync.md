---
"@otta-sh/plugin": minor
---

The CMS repeater is the variant name, and deleting a row deactivates the variant.

A product that sells in several sizes now declares them in one content field: a
repeater whose rows carry exactly two sub-fields — a stable key and a display
name — and nothing commercial. The sync projects that field onto the commerce
layer through the same single channel the product title already uses, which is
ADR-0016 applied clause for clause (itself ADR-0013 one level down).

- **Declare.** Every row the repeater carries is upserted through the CMS-sync
  declare with the save's own content watermark. That is also what brings a
  variant into existence and what resurrects one the CMS had stopped declaring.
  The body is the name cache plus the watermark, as a strict key set: `sku` and
  `price` are absent from the declare's input type by construction, so the sync
  cannot become a second writer of a commercial field.
- **Deactivate, never delete.** A row the merchant removes orphans its commerce
  variant on the same save. The row is retained with its sku, its price and its
  inventory, because an orphaned size may still hold stock and still sit on live
  order lines. Surfacing that state in the console is a later change; this sets
  it. The dropped set is computed from the live-variants read rather than from
  the hook event, which carries no "before" document.
- **Inert for the existing catalogue.** A product whose document declares no
  repeater takes exactly the path it always did, down to the request count — no
  speculative read, no write. Pinned by a test that asserts the whole request
  list, not just the absence of a variant write.
- **Replay-safe.** Declares and orphans are separate idempotency key-spaces,
  keyed per variant row per save, so a redelivered hook is a no-op at the store
  and a genuinely newer save applies. The name is trimmed; an emptied name
  sub-field clears the cache with an explicit null; an unusable one omits itself
  and keeps what is stored, exactly as the product title does. Variant keys are
  trimmed too, so a stray keystroke cannot fork a size into two rows.
- Rides `content:afterSave` and `content:afterPublish` — no new hook, no new
  capability, no new allowed host — with the same fire-and-forget posture: a
  failure is logged and never thrown into the CMS save path, and there is still
  no reconcile job, so a failed variant sync is lost until the next save.

The staging seed declares the repeater on the products collection so the field
exists where a merchant edits the rest of the product's content. No sample entry
declares a variant, so the demo catalogue is unchanged.

**Known gap, deliberately not worked around.** ADR-0016 asks the sync to refuse a
mutated or reused variant key at save time, legibly inside the CMS editor. That
refusal is not implemented, because it is not reachable from a sandbox-clean
plugin on the pinned CMS: the save hook's contract offers no veto (only a
replacement content bag), a sandboxed plugin's thrown error is logged and the
save proceeds regardless, a message that does abort in-process never survives to
the editor's toast, and the event carries neither the prior document nor an id to
fetch one by. The field editor cannot express a uniqueness or immutability rule
either. Making the refusal legible needs an upstream change and its own decision.
Until then nothing is lost silently: a mutated key reads as one variant dropped
and another declared, the dropped one is retained rather than deleted, and a
reused key is resolved deterministically (the first row wins) and logged. The
reasoning is recorded in full beside the code.
