# "Tempered" — the Urumi reference storefront theme

Design direction for `sites/staging`, approved 2026-07-28. This file is the **spec**;
[`tempered-mockup.html`](./tempered-mockup.html) is the rendered reference — open it in a
browser and compare against it as you build. Where the two disagree, the mockup wins for
*appearance* and this file wins for *rules*.

ADR-0003 is unchanged: the plugin serves JSON view models, the theme owns every byte of
markup. Nothing in here belongs in `@urumi/plugin`.

---

## 1. Why it looks like this

An urumi is a ribbon of spring steel, worn coiled. Heat spring steel and it runs through
straw → bronze → violet → deep blue: an **ordered** scale. The store has ordered states too
(available → held → expiring → released; pending → paid / failed / expired). The palette is
that scale, so colour carries state instead of decorating.

Three rules fall out, and everything else follows from them:

1. **Tempering colours are state, never decoration.** A hue means one thing, everywhere.
2. **Money is set in mono, and nothing else is.** Prices, quantities, SKUs, stock counts,
   countdowns, order references. Tabular figures so columns align for free.
3. **One hairline, never a box.** A single 1px rule is the only divider. No card borders,
   no shadows, 2px radius maximum.

---

## 2. Tokens

Define once in `src/styles/tokens.css`, imported by `Base.astro`. Every page reads these —
no page declares a raw colour or a font stack of its own.

### Light (default)

| Token | Value | Job |
|---|---|---|
| `--u-ink` | `#131A20` | Text, and every primary button fill |
| `--u-ground` | `#F1F4F4` | Page behind the store surface |
| `--u-surface` | `#FFFFFF` | Where products sit |
| `--u-edge` | `#D2DAD9` | The hairline. Nothing else |
| `--u-mute` | `#5A6A70` | Secondary text, sold-out, released holds |
| `--u-straw` | `#8A6412` | Brass fitting: focus rings, hover underlines, wordmark rule, `required` |
| `--u-violet` | `#6B4C9E` | Held / in progress |
| `--u-bronze` | `#96541F` | Expiring / failed / degraded |
| `--u-panel` | `rgba(19, 26, 32, 0.05)` | Media-panel ground (always neutral) |
| `--u-coil-a` | `0.5` | Coil fill opacity |

### Dark

Same token names, redefined under **both** `@media (prefers-color-scheme: dark)` and
`:root[data-theme="dark"]` (and restored under `:root[data-theme="light"]`), so an explicit
toggle beats the OS preference in both directions.

| Token | Value |
|---|---|
| `--u-ink` | `#E7EDEC` |
| `--u-ground` | `#0F1418` |
| `--u-surface` | `#171E22` |
| `--u-edge` | `#2B363B` |
| `--u-mute` | `#8FA0A6` |
| `--u-straw` | `#E0AC3A` |
| `--u-violet` | `#AE93DE` |
| `--u-bronze` | `#D68F4E` |
| `--u-panel` | `rgba(231, 237, 236, 0.055)` |

### Structure

```css
--u-r: 2px;                        /* a blade edge, not a pill — one value, everywhere */
--u-hair: 1px solid var(--u-edge); /* the only divider in the theme */
```

**Straw is a fitting, not a fill.** It never becomes a button background — that keeps every
interactive element at full text contrast. Primary buttons are `--u-ink` filled; hover slides
a 3px straw rule along the inner bottom edge.

---

## 3. Type

Three faces, three roles, no overlap. Self-host through Astro's font API (`astro:fonts`,
Google provider, latin subset) — **no CDN link at runtime**, and no silent fallback.

| Role | Face | Settings | Used for |
|---|---|---|---|
| Display | **Bricolage Grotesque** | `wdth 78`, `opsz 48`, weight 700–800, tracking `-0.025em`, line-height 0.95–1 | Wordmark, page titles, product names, state stamps. **Never below 17px** |
| Body | **Schibsted Grotesk** | 400–600 | Running text, nav, buttons, field labels, notices |
| Data | **Martian Mono** | `wdth 90`, tracking `-0.045em`, `font-variant-numeric: tabular-nums` | Money, qty, SKU, stock, countdowns, order refs, uppercase eyebrow labels |

The display face is set **narrow** because the object the project is named after is a long
thin ribbon; the data face is set **wide** so figures read as objects rather than as text.
The contrast between them is the theme's loudest move — don't flatten it.

Uppercase mono labels: `0.5625rem`, weight 500, `letter-spacing: 0.11em`, colour `--u-mute`.

---

## 4. Components

Build these in `src/components/`. Each renders one view-model field group and nothing more.

| Component | Notes |
|---|---|
| `MediaPanel` | Neutral `--u-panel` ground + one generated coil. See §5 |
| `ProductCard` | Media, title, description, foot. Foot uses `margin-top: auto` so feet align across a row regardless of description length |
| `PriceTag` | Mono, tabular. Struck + muted when sold out |
| `StockRule` | A short 2px rule + mono caps. Solid when in stock, dashed when sold out. **Not** a coloured badge |
| `HoldRibbon` | §6 — the signature |
| `StepTrack` | Cart → Details → Payment → Order. Done = ink dot, current = straw dot with a soft ring |
| `Ledger` / `Sum` | SKU / qty / money rows; the totals block with the "not calculated" rule (§7) |
| `StateStamp` | Order state: a 4.5rem × 3px rule in the state colour, then the headline |
| `Notice` | Degraded/error. Dashed bronze rules top and bottom, a dashed mark, **no filled background** |
| `QtyField` | Mono numeric input |

Focus: `outline: 2px solid var(--u-straw); outline-offset: 2px` on every interactive element.
Keyboard focus must be visible on all of them.

---

## 5. Product art (the seed ships no photography)

A fresh install must look intentional with zero images. Each product gets a **coil**: an
Archimedean spiral swept as a ribbon that tapers to a point at its inner end, drawn on the
neutral panel, in one of `--u-tint-violet` / `--u-tint-straw` / `--u-tint-blue`.

Generate it — do not hand-author path data. Centre, turn count, rotation and outer radius all
key off the product slug so each one crops differently instead of repeating like a logo.
Reference implementation is in the mockup's `coilPath()`. It must:

- be `aria-hidden` (it carries no information);
- fall back cleanly — when a product *does* have an image, the image replaces the coil entirely;
- stay flat SVG with no animation.

---

## 6. The hold ribbon — the signature element

Every cart line carries one. A 2px track in `--u-edge`; a fill that drains left→right against
the line's `expiresAt` (already on the cart wire); the remaining time in mono beside it.

| State | Colour | Label | Notes |
|---|---|---|---|
| Held | `--u-violet` | `Held for you` | Default |
| Expiring (≤60s) | `--u-bronze` | `Expiring` | |
| Released (0) | `--u-mute`, track goes dashed, fill hidden | `Hold released` | Plus a line telling the shopper what to do next |

The countdown is **information, so it ticks even under `prefers-reduced-motion`** — that
media query suppresses decorative motion, not a timer the shopper is relying on. Roughly 15
lines of client script. Ship a no-JS fallback that renders the absolute expiry time.

The same ribbon reappears on `/orders/<id>` while an order is `pending`, running
**indeterminate** (a sweeping segment) with the poll count in mono — `Checking 3 of 8`. Under
reduced motion the sweep becomes a static filled track at 40% opacity.

---

## 7. Money rules

- Never invent a money string. Render `price.formatted` / `.label` from the view model.
- **"Not calculated" is not zero.** `totals.shipping.label` and `totals.tax.label` can mean
  *this store has not configured it*. That renders as muted mono prose — `Not calculated` —
  and **never** as `$0.00`, `—` alone, or "Free shipping". When `totalExcludesUncalculated`
  is set, the footnote below the total says which parts are missing.
- Cart line totals are quantity-only; a cart line snapshots no price. Don't imply otherwise.
- The pay button carries the amount: `Pay $40.00`, not `Pay now`.

---

## 8. Page by page

Compare each against the matching frame in the mockup.

| Page | Shape |
|---|---|
| `index.astro` | Asymmetric hero (~1.15fr / 1fr): thesis copy + CTA left, the **inventory tape** right — ITEM / PRICE / IN STOCK as mono rows. This page currently makes no commerce call by construction; the tape needs one, so render thesis copy alone when the service is down |
| `products/index.astro` | 3-up grid, no card borders, generous air. Titles carry the weight |
| `products/[slug].astro` | Media left (~4/5), right column: title, description, **spec ledger** (Price / Stock / SKU), qty + add-to-cart, then the hold note |
| `cart/index.astro` | Lines, not a table: media, name + SKU + hold ribbon, then price and controls right. Totals block bottom-right |
| `checkout/index.astro` | Step track, then two panels: details form left (~1.15fr), order ledger + totals right |
| `checkout/pay.astro` | Narrow single column. Trust line, Stripe mount, `Pay $X`. See §9 |
| `orders/[orderId].astro` | State stamp first (it's the most important thing on the page), reference in mono, then items + totals |
| `404.astro` | Same empty-state language as the others |

**Empty and degraded states are designed surfaces, not afterthoughts** — empty cart, empty
catalog, prices unavailable, totals unavailable, payment not configured. All are in the
mockup. An empty screen is an invitation to act; a failure explains what still works.

---

## 9. Stripe's Payment Element

`/checkout/pay` mounts Stripe's own fields — left alone they arrive as a default blue-focus
widget in the middle of this theme. Pass an `appearance` object built from the tokens
(`--u-ink`, `--u-surface`, `--u-edge`, `--u-straw` for focus, and the body face) so the fields
match. This is the one surface the theme cannot style with its own CSS.

Do not otherwise touch the payment path. Card data goes browser → Stripe and never reaches
this origin; that is what keeps the deployment at PCI SAQ-A.

---

## 10. Copy rules

The copy is design material and is part of this spec.

- **Never market "no oversell" / "atomic inventory" / "no oversell under concurrency."** It is
  a basic requirement of any store, not a highlight feature, and it does not belong in
  shopper-facing copy or in the theme's positioning. The *hold* stays visible — "we'll hold it
  for ten minutes" is useful to a shopper — but the boast goes.
  - **`sites/staging/seed/seed.json` still carries the old mug description** ("Holds exactly
    one coffee, atomically. No oversell under concurrency."). Replace it, and drop the
    CMS/commerce-service plumbing talk from the tee description, in the same increment.
- Write from the shopper's side. Never name internals: no "the commerce service", no "CMS",
  no "view model" in anything a shopper reads.
- Active voice; a control says exactly what happens. "Continue to payment" leads to Payment.
- Errors state what went wrong and what still works, and never apologise.
  **`src/lib/error-messages.ts` needs no changes** — its copy is already written from the
  shopper's side. Quote it; don't rewrite it.
- Sentence case everywhere except the mono eyebrow labels.

---

## 11. Quality floor

Not optional, and not worth announcing in the UI:

- Responsive to 390px with **no horizontal page scroll**. Wide content scrolls inside its own
  `overflow-x: auto` container.
- Visible keyboard focus on every interactive element (straw, 2px, offset 2px).
- `prefers-reduced-motion` respected for all decorative motion; the hold countdown is exempt
  (see §6).
- Both themes carry equal care — dark is not a naive inversion, and the accent works on both
  grounds.
- Text contrast meets AA. Straw is never a text-on-fill colour.
- `base-layout-favicon.test.ts` pins an inline SVG data-URI favicon in `Base.astro`. Keep it
  inline; redraw the mark as the coil.
