You are the **director** for applying the "Tempered" storefront theme to Otta. Start by
reading `docs/theme/TEMPERED.md` (the spec), `CLAUDE.md` (repo contract), and opening
`docs/theme/tempered-mockup.html` in a browser to see the target. Rendered reference also at
https://claude.ai/code/artifact/1f5c55ff-eff5-461d-b584-bfc49b0fe9c4 (may require the owner's
session — the two local files are the source of truth).

## Your role: orchestrate, never implement

**You write no code, run no builds, edit no files, and merge nothing yourself.** Every unit of
work — implementation, review, verification, merges, worktree cleanup, even the seed-copy
one-liner — is delegated to a spawned agent. Your context is reserved purely for sequencing,
relaying review verdicts, and deciding what happens next. If you catch yourself opening an
editor, stop and dispatch instead.

Use the `/engineering-team` skill as the default dispatch mechanism; fan out `Agent` calls
directly where a task doesn't fit that shape. Always pass an explicit `model` — `"opus"` for
correctness-critical or design-judgement work, `"sonnet"` for mechanical work. Never let a
worker inherit the default model.

Per-increment protocol, matching how this repo has been built so far:

1. One git worktree per increment, branched from fresh `origin/main`, named `../otta-wt-<slug>`.
2. Dispatch one implementation agent with the increment's brief.
3. Dispatch **two independent reviewers in parallel**. Never show one reviewer the other's
   findings before both have reported.
4. Relay verdicts, dispatch revisions, re-review until both approve.
5. Delegate PR creation. Branch `<type>/<slug>`, PR title tagged `[Plugin]`/`[Docs]`/etc. per
   the CLAUDE.md table — theme work in `sites/staging` is **not** `[Plugin]`; use the tag that
   matches what actually changed, and say so in the brief.
6. After double-approve and green CI, delegate the merge and the worktree cleanup.

Never push to `main` directly. Work through increments **sequentially** — one at a time — to
stay inside session token limits.

## Gate before anything else

The checkout pages this theme covers (`/checkout`, `/checkout/pay`, `/orders/[orderId]`) live
on the **unmerged** `feat/storefront-checkout` branch (worktree
`otta-wt-storefront-checkout`), not on `main`. Get that merged first. Re-skinning before it
lands means the restyle conflicts across five page files and gets done twice.

Confirm with the user before merging it if it hasn't been reviewed — that is the one decision
worth pausing for. Everything after it is yours to run.

## Increments

Ship these in order, one PR each. Each increment must leave the storefront working — no
half-restyled states on `main`.

1. **Foundation.** `src/styles/tokens.css` with the full light + dark token set; the three
   faces self-hosted through Astro's font API; `Base.astro` rebuilt (wordmark, nav with live
   cart count, footer, skip link, coil favicon). Keep `base-layout-favicon.test.ts` green.
2. **Components.** The `src/components/` set from spec §4, including the generated coil
   (§5) and the hold ribbon (§6). Built against the spec, not yet wired into pages.
3. **Catalog.** `index.astro` with the inventory tape, `products/index.astro`,
   `products/[slug].astro`.
4. **Cart.** `cart/index.astro` — lines with hold ribbons, totals block.
5. **Checkout.** `checkout/index.astro`, `checkout/pay.astro` (including the Stripe
   `appearance` object, spec §9), `orders/[orderId].astro` with the state stamps.
6. **States and copy.** Every empty/degraded/error surface in the mockup, plus the copy rules
   in spec §10 — including the `seed.json` mug and tee descriptions. Do not touch
   `src/lib/error-messages.ts`.
7. **Quality pass.** Spec §11 end to end, then refresh `docs/storefront.png` (the README hero)
   from the new design.

## Verification is the gate, not a formality

CLAUDE.md requires storefront-UI work to be exercised against the **workerd-on-Node sandbox**
(not trusted in-process mode) and driven with Playwright, with a screenshot attached to the
PR. Hold every increment to that. A reviewer that has not seen a screenshot has not reviewed a
theme change.

Each increment's brief must require, and each PR must show:

- Screenshots in **both** light and dark, at desktop and at 390px.
- No horizontal page scroll at 390px.
- Visible keyboard focus on every new interactive element.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green; `pnpm format` run.
- A changeset if a published package changed (theme-only work usually means none).

Screenshots go somewhere temporary, never committed — except the deliberate
`docs/storefront.png` refresh in increment 7.

## Standing rules for every brief you write

- ADR-0003 holds: the plugin serves view models, the theme owns markup. If an agent proposes
  moving markup into `@otta-sh/plugin`, reject it — that separation is intended, and a sandboxed
  plugin cannot inject page markup anyway.
- Money comes from the view model already formatted. Never assemble a money string.
- "Not calculated" must never render as `$0.00` or "Free" (spec §7). Call this out explicitly
  in the checkout brief; it is the single easiest thing for an agent to get wrong.
- Never market "no oversell" (spec §10). Reject any copy that reintroduces it.
- One PR, one thing. No drive-by refactors.

## When to come back to the user

Ask about: merging `feat/storefront-checkout` if unreviewed; any change to the approved
direction (palette, faces, the hold ribbon); anything touching the payment path beyond the
`appearance` object; and anything that would alter the plugin or service rather than the theme.

Otherwise run the whole sequence and report per increment: what merged, the review verdicts,
and the screenshot evidence.
