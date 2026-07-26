# 0012. The plugin takes `content:write` to validate product input before the CMS save

- Status: accepted
- Date: 2026-07-26
- Refines: ADR-0006 (first-party deployments may register the plugin trusted, in-process) and
  ADR-0001 (the commerce service is the authoritative owner of money). Relates to
  `packages/plugin/src/sync/before-save.ts`, `src/product-commerce/commerce-save-blockers.ts`,
  `src/product-commerce/commerce-rejection-message.ts`, and `src/manifest.ts`.

## Context

Editing a product's price in the admin **silently diverged**. Typing `24.99` into the "Product
data" widget's Price field (labelled *integer minor units*) produced a green "Saved" toast, the CMS
kept `price: 24.99` across reloads, and `GET /products/{id}/commerce` still returned the old
amount. No error appeared anywhere. The same held for `-5`.

Nothing was actually broken *downstream*. The service has always been strict
(`price.amount: z.number().int().nonnegative()`, branded `Cents` in the domain) and the plugin's
own derive guard, `parseCommerceFields`, correctly refused the value. The failure was that the
refusal was **terminal and invisible**: validation lived strictly *downstream of the CMS write*, in
a `content:afterSave` hook that is fire-and-forget by design and has no channel back to the editor.
The CMS accepted and displayed a number the rest of the system would never honour.

Fixing that means adding a rejection point **upstream of the write**, which on em-dash means a
`content:beforeSave` hook. Three host facts decide the shape of this ADR:

1. **Registration is capability-gated.** em-dash's `HookPipeline.registerPluginHook` maps
   `content:beforeSave → content:write` and **silently skips** a hook whose required capability is
   absent. Without declaring `content:write`, the handler is dead code in production — it does not
   warn, it simply never runs.
2. **`content:write` is far broader than what we need.** In trusted mode it makes the host build
   `createContentAccessWithWrite(db)` — **hook-free, transactional read *and* write access to every
   collection's content** — and it subsumes `content:read`. We want exactly one narrow behaviour:
   rewriting our *own* field on the save payload the host has already handed us.
3. **A throw is not a rejection.** em-dash's trusted dispatcher propagates a thrown hook error under
   the default `"abort"` error policy, but the **sandboxed** dispatcher swallows every throw and
   then proceeds **with the original, bad payload**. Both dispatchers honour the handler's **return
   value**. ADR-0006 deliberately keeps sandboxed deployment a live option, so the rejection
   mechanism has to be mode-independent.

There is also no plugin-side way to prevent the input client-side: em-dash's `BlockKitFieldWidget`
drops any `min`/`step` a Block Kit `number_input` declares, so a float or a negative is a legal
widget value. That is an upstream fix, not this one.

## Decision

**Declare `content:write` and register a `content:beforeSave` handler scoped to `products`.**

- **Rejection is return-based, never a throw** — the only form both dispatchers honour.
- **The load-bearing invariant is the STRIP:** when the submitted `commerce` bag is invalid, the
  returned payload contains **no `commerce` key**. A key absent from the payload leaves the stored
  value untouched on *both* em-dash write paths — "only present keys are written" on the column
  path, and the `{...baseData, ...processedData}` merge on the draft-revision path that `products`
  actually uses. So the CMS can never store a money value the service would reject, and the
  last-good bag survives.
- **Surfacing is best-effort, not the fix.** The handler adds one extra top-level key whose *name is
  the merchant-facing message*; em-dash's `validateContentData` rejects unknown top-level data keys
  and the editor toasts the resulting `VALIDATION_ERROR.message` verbatim, discarding the whole save
  before any write. The key is sanitized (control characters stripped, whitespace collapsed, values
  clipped to 40 chars, whole key ≤ 110 — under em-dash's `MAX_IDENTIFIER_LENGTH` of 128) and carries
  a stable `Urumi — ` prefix.
- **The blocking predicate is new and deliberately narrow.** `commerceSaveBlockers` blocks only
  **present-and-wrong** values. Absent, cleared (`undefined`) and `""` are always clean, so unpriced
  products stay saveable and clearing the price is always an escape hatch back to a saveable state.
  `parseCommerceFields` — a *derive* guard that legitimately errors on absence — is **not** reused
  and **not** modified; reusing it would make ordinary widget gestures permanently unsaveable.
- **`event.collection !== "products"` is a security control**, not tidiness: it is what keeps a
  content-write-capable hook from touching any other collection's payload.
- **The `content:write` grant is bounded compile-time, not by convention.** The plugin's own
  `PluginContext` declares exactly `{http, kv}`, so **any `ctx.content…` reference is a
  `pnpm typecheck` error** — immune to aliasing, and stronger than a grep. Backed as
  defense-in-depth by the `plugin-is-sandbox-clean` dependency-cruiser rule and by a sandbox test
  pinning our harness's ctx keys (which proves the harness, not the deployment).

## Consequences

**Easier.** A bad price now fails loudly at the point of entry instead of diverging silently. Money
integrity gains a second, independent layer above the service's zod + branded `Cents`; this is
defense-in-depth and UX, never the sole money guard.

**Harder / accepted.**

- **The capability trap is CI-uncoverable, and this is the largest maintenance risk here.** Urumi's
  sandbox harness dispatches hooks directly and has no `HOOK_REQUIRED_CAPABILITY` gate. If a future
  edit drops `content:write` from `manifest.ts`, or drops the hook entry from `plugin.ts`, **every
  test in this repo stays green while production silently stops validating** and the P1 returns. No
  test can catch it. Mitigations: a comment at *both* wiring sites naming the other, this record,
  and a mandatory staging Playwright run as the definition of done for any change here.
- **We hold a broader capability than we use.** `content:write` is hook-free transactional write
  access to all content. The bounds are the compile-time `PluginContext`, the depcruise rule, and
  the `collection !== "products"` early return — not a promise.
- **Degradation is silence, not divergence.** If em-dash ever replaces its unknown-key rule with a
  zod `.strip()`, the sentinel key is silently dropped and the merchant sees no message — the
  *silence* half of the original bug returns, while the *divergence* half stays fixed by the strip.
  That is why the strip, not the sentinel, is the invariant. (Deliberately *not* mitigated by using
  a leading-underscore key: em-dash's validator skips those, which would forfeit the entire
  surfacing mechanism.)
- **Publish-brick vector (host-regression world only).** If a sentinel key ever *did* reach a draft
  revision's JSON, publishing that entry would hard-500: the publish path pushes draft data into
  columns via `syncDataColumns → validateIdentifier`, which rejects the key, and **no `beforeSave`
  runs on that path**, so the scrub cannot reach it. This is unreachable while em-dash's unknown-key
  check holds (validation fires first on every save), and the handler additionally runs an always-on
  `scrubStaleSentinels` over every incoming payload — which guarantees a stale sentinel can never
  *block* a save. The scrub does **not** clean storage: the draft merge is
  `{...baseData, ...processedData}`, so a sentinel that reached the draft JSON would be re-merged
  indefinitely. The staging DoD therefore asserts *"no `Urumi — ` key in the draft JSON"* as the
  early catch, and that assertion is mandatory.
- **A small set of already-corrupted products becomes unsaveable until fixed.** A product whose
  *stored* bag holds `24.99` blocks on save, because the editor resubmits the stored bag. Recovery
  is one gesture: correct the price or clear it. Bounded and intended.
- **Autosave will toast repeatedly** (~every 2 s) while a genuinely invalid value sits in the field.
  Accepted: it is correct feedback aimed at exactly the merchants making the error. The widget's
  new *"whole number, no decimals"* label hint reduces the entry rate.

**Follow-ups (filed, not built here).**

1. em-dash fork: return a clean `VALIDATION_ERROR` when a `content:beforeSave` hook rejects — a
   structured rejection, or a typed thrown error honoured in both modes. Then delete the sentinel.
2. em-dash fork / upstream: forward `min`/`step`/format affordances from a Block Kit `number_input`
   to the rendered `<Input>`, and render per-element field errors in `BlockKitFieldWidget`. That is
   the real cure for the residual.
