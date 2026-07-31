---
"@otta-sh/plugin": patch
---

Fix the admin Settings screen's Admin token and Service token fields: drop the
masked `secret_input` variant.

The reveal/copy controls the masked variant renders computed to `opacity: 0`; on
hover a blue Copy chip appeared and overlapped the `Admin token
(X-Internal-Token)` label above it, and a *revealed* set token became visually
identical to the unset field below it. The screen's own helper text already says
both tokens are stored write-only and neither is ever displayed, so the reveal
affordance was offering to reveal something that cannot be revealed — a false
affordance, not merely a rendering collision.

Both the Admin token and Service token fields now render as a plain, always-empty
`text_input` with a single static placeholder (`Enter new admin token (blank
keeps current)` / `Enter new service token (blank keeps current)`), whether or
not a token is already stored. Save behaviour is unchanged: a blank submit still
keeps the currently stored token; a non-empty submit still overwrites it,
write-only, with no read-back path into any block, toast, or error text.

A successful save on either field now also remounts that form blank: since
neither field carries `initial_value`/`has_value` any more, a save generation
counter rides in the form's carrier context instead, so the just-typed value
does not linger in the unmasked input after a "saved" re-render.
