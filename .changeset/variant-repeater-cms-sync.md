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
declares a variant, so the demo catalogue is unchanged. The repeater is bounded
at 50 rows as a deliberate fan-out limit: every declared row is one request on
every save of the document, on a fire-and-forget hook with no retry. The bound is
an editor-side affordance only — writes that bypass editor validation (API, CLI,
import, seed) are unbounded by it, and the sync declares every row it is given.

**The variant key is enforced by recovery, not by refusal** (ADR-0016, amended).
The CMS cannot express a save-time refusal of a mutated or reused key: the save
hook returns a replacement content bag rather than a verdict, a sandboxed hook's
error is logged while the save proceeds, the event carries no pre-save document
to compare against, and a repeater sub-field has no uniqueness or immutability
rule. The guarantee sits on the other side of the mistake instead, and nothing is
destroyed by one:

- A changed key reads as one variant dropped and another declared. The dropped
  one is deactivated, never deleted — it keeps its sku, its price and its
  inventory, and its stock stays where it is under the sku it was already keyed
  by.
- Restoring the original key in the CMS resurrects that same row under the
  existing resurrect rules, so a kept sku keeps its units. The repair verb is
  **publish**: presence moves only on a strictly newer content watermark, and a
  draft-only save can leave that watermark frozen, so re-adding a deleted key
  inside the draft window takes effect when the document is published. A bare
  re-save repairs it only where the CMS bumps the watermark. Either way it is a
  CMS action, never a manual reconciliation of the commerce database.
- A reused key resolves to the first row, deterministically, and is logged, so
  the stored name never depends on request ordering.
- An absent name sub-field omits the field so the store preserves the stored
  name; only an explicit null or an emptied name clears it. The name is a cache
  with a single writer, so reading "absent" as "cleared" would blank every stored
  variant name on every save of a document that stopped carrying the sub-field,
  and every order line placed afterwards would freeze the blank permanently.
- The drop phase is withheld whenever the repeater cannot be read as a list of
  rows, or carries rows of which none yields a usable key. A content problem is
  never read as "the merchant deleted every size" — only a present, empty
  repeater retires a product's whole range.

Because there is no save-time refusal, the admin's variant list is obliged to
render an orphaned row distinctly — that row is the only place a mistaken re-key
becomes visible to the person who made it.
