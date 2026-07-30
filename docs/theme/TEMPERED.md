# "Tempered" — the Urumi reference storefront theme

Design direction for `sites/staging`, approved 2026-07-28. This file is the **spec**;
[`tempered-mockup.html`](./tempered-mockup.html) is the rendered reference — open it in a
browser and compare against it as you build. Where the two disagree, the mockup wins for
*appearance* and this file wins for *rules*.

ADR-0003 is unchanged: the plugin serves JSON view models, the theme owns every byte of
markup. Nothing in here belongs in `@otta-sh/plugin`.

---

## 1. Why it looks like this

An urumi is a ribbon of spring steel, worn coiled. Heat spring steel and it runs through
straw → bronze → violet → deep blue: an **ordered** scale. The store has ordered states too
(available → held → expiring → released; pending → paid / failed / expired). The palette is
that scale, so colour carries state instead of decorating.

Three rules fall out, and everything else follows from them:

1. **Tempering colours are state, never decoration.** A hue means one thing, everywhere.
2. **Money is set in mono, and nothing else is.** Prices, quantities, SKUs, stock,
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
| `--u-tint-violet` | `#6B4C9E` | Coil hue (§5) — the one place a tempering colour is a fill |
| `--u-tint-straw` | `#8A6412` | Coil hue |
| `--u-tint-blue` | `#1F3D6B` | Coil hue: the deep-blue far end of the scale, which has no state of its own |
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
| `--u-tint-violet` | `#AE93DE` |
| `--u-tint-straw` | `#E0AC3A` |
| `--u-tint-blue` | `#6E9BD8` |

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
| Display | **Bricolage Grotesque** | `wdth 78`, `opsz 48`, weight 700–800 (400 is the muted counter-voice), tracking `-0.025em`, line-height 0.95–1 | Wordmark, page titles, product names, state stamps. **Never below 17px** |
| Body | **Schibsted Grotesk** | 400–700 | Running text, nav, buttons, field labels, notices |
| Data | **Martian Mono** | `wdth 90`, tracking `-0.045em`, `font-variant-numeric: tabular-nums` | Money, qty, SKU, stock, countdowns, order refs, uppercase eyebrow labels |

The display face is set **narrow** because the object the project is named after is a long
thin ribbon; the data face is set **wide** so figures read as objects rather than as text.
The contrast between them is the theme's loudest move — don't flatten it.

Self-hosting means the **ranges** are a build-time decision, not just the weights: Astro's
font API asks Google's css2 endpoint for a variable file, and an axis nobody named is not in
it. What the three entries in `astro.config.ts` actually ship:

| Face | Weight range | Variable axes |
|---|---|---|
| Bricolage Grotesque | `400 800` | `opsz` 12–96, `wdth` 75–100 |
| Schibsted Grotesk | `400 700` | — (weight is its only axis) |
| Martian Mono | `300 700` | `wdth` 75–112.5 |

The axes go through `options.experimental.variableAxis` — **unifont's** namespace, not
Astro's, so a transitive patch bump can rename it with no major release to warn anyone. Drop
them and every `font-variation-settings: "wdth" …` in the theme becomes a silent no-op that
renders at the default width, with no error anywhere. `test/fonts-config.test.ts` pins that
they are *requested* for that reason — the axis names, and that every weight is asked for as
a range rather than as N static cuts. The numbers in the table above are the config's to
choose; the test does not hold them.

### The two data recipes

`wdth 90` + tracking + tabular figures is one tuple that every price, quantity, SKU,
countdown and eyebrow needs, so it is written down **once**, in `tokens.css`, as unscoped
globals beside `.u-sr-only`:

- **`.u-mono`** — the data face, `wdth 90`, `letter-spacing: -0.045em`, `tabular-nums`. Type
  only: no size, no colour, no layout.
- **`.u-label`** — the uppercase eyebrow: the same family and width axis, plus `0.5625rem`,
  weight 500, `letter-spacing: 0.11em` (which *replaces* the mono tracking rather than adding
  to it), uppercase, colour `--u-mute`. No tabular figures — it labels columns, it does not
  set them.

Components take the class rather than restate the tuple. The first cut of the component set
shipped six copies of it and two had already drifted onto a different `letter-spacing`. Size,
weight and state colour stay the component's business — a scoped rule carries the extra
`[data-astro-cid-…]` attribute and beats these on specificity for free.

---

## 4. Components

Build these in `src/components/`. Each renders one view-model field group and nothing more.

| Component | Notes |
|---|---|
| `MediaPanel` | Neutral `--u-panel` ground + one generated coil. See §5 |
| `ProductCard` | Media, title, description, foot. Foot uses `margin-top: auto` so feet align across a row regardless of description length |
| `PriceTag` | Mono, tabular. Struck + muted when sold out |
| `StockRule` | A short 2px rule + mono caps. Solid when in stock, dashed when sold out. **Not** a coloured badge. **Words, not a figure** — see below |
| `HoldRibbon` | §6 — the signature |
| `PollRibbon` | §6's indeterminate variant, for `/orders/<id>` while an order is `pending`. Its own file rather than a prop on `HoldRibbon`: that component carries a bundled `<script>`, and Astro emits a component's script wherever the component renders, so sharing one would put the countdown on a page ADR-0012 keeps free of client JavaScript. Nothing here runs in the browser — the sweep is CSS, the count is server-rendered on each hop |
| `StepTrack` | Cart → Details → Payment → Order. Done = ink dot, current = straw dot with a soft ring |
| `Ledger` / `Sum` | SKU / qty / money rows; the totals block with the "not calculated" rule (§7). A `Ledger` row takes an optional `title`: given, it leads in the body face and the SKU drops beneath it as the reference you quote in an email; omitted, the SKU stands alone. `/checkout` omits it — the row is still a cart line, the wire carries no title, and the shopper picked the thing a moment ago. `/orders/<id>` passes it, because there the same block is a **receipt** and the title is the purchase-time snapshot the order froze |
| `StateStamp` | Order state: a 4.5rem × 3px rule in the state colour, then the headline |
| `Notice` | Degraded/error. Dashed bronze rules top and bottom, a dashed mark, **no filled background** |
| `QtyField` | Mono numeric input |

**Stock is stated in words, never as a count the store did not quote.** The product view
model carries an availability *token*, not a number, so every surface that shows stock — the
hero tape, the card foot, the PDP spec ledger — renders `In stock` or `Sold out` and stops
there. The mockup's `12 in stock`, `3 left` and the tape's bare `12` are superseded: they
draw a figure nothing on the wire can supply. `StockRule` keeps a `label` override for the
day a store really does carry an exact count. The rule for a third token — a future
`preorder`, `backorder` — is that the positive `in_stock` earns the words, not the absence of
`out_of_stock`, and the surfaces do not yet agree on it: the hero tape keys positively and
leaves the cell blank, while `StockRule` (the card foot and the spec ledger) still tests
`!== "in_stock"` and would fold anything else into `Sold out` — only a `null` availability
renders nothing there. Unreachable today, since `AvailabilityToken` is a two-value union.
Bringing `StockRule` onto positive keying is a code follow-up, not something this file can
declare done.

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

The window is the store's hold TTL — **900 seconds, fifteen minutes**: the domain's
`DEFAULT_HOLD_TTL_MS`, which a deployment overrides with `CART_HOLD_TTL_MS` and otherwise
gets by default. It is *only* the fill's denominator. The wire carries the expiry instant,
not the length of the hold, so the state, the label and the countdown all come off
`expiresAt` and are unaffected by this number: getting it wrong draws the bar at the wrong
width, never the wrong time. (It shipped at 600, which pinned the bar at full for the first
third of every hold and then drained it half again too fast.) A store on a longer TTL is
clamped, never overflowed.

| State | Colour | Label | Notes |
|---|---|---|---|
| Held | `--u-violet` | `Held for you` | Default |
| Expiring (≤60s) | `--u-bronze` | `Expiring` | |
| Released (0) | `--u-mute`, track goes dashed, fill hidden | `Hold released` | Plus a line telling the shopper what to do next |

The countdown is **information, so it ticks even under `prefers-reduced-motion`** — that
media query suppresses decorative motion, not a timer the shopper is relying on. Roughly 15
lines of client script. Ship a no-JS fallback that renders the absolute expiry time.

The same ribbon reappears on `/orders/<id>` while an order is `pending`, running
**indeterminate** (a sweeping segment) with the poll count in mono — `Checking 3 of 8`. The
same *grammar*, not the same component: that is `PollRibbon` (§4), a separate file so this
one's bundled countdown script never reaches that page. Under reduced motion the sweep
becomes a static filled track at 40% opacity.

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
| `index.astro` | Asymmetric hero (~1.15fr / 1fr): thesis copy + CTA left, the **inventory tape** right — ITEM / PRICE / STOCK as mono rows. The head is `Stock`, not the mockup's `In stock`: the cells below hold the words `In stock` and `Sold out`, and a column headed with one of its own values reads as a claim about the column. The tape fetches a bounded window of the catalog, so this page does make a commerce call — render thesis copy alone when the service is down |
| `products/index.astro` | 3-up grid, no card borders, generous air. Titles carry the weight |
| `products/[slug].astro` | Media left (~4/5), right column: title, description, **spec ledger** (Price / Stock / SKU), qty + add-to-cart, then the hold note |
| `cart/index.astro` | Lines, not a table: media, name + SKU + hold ribbon, then price and controls right. Totals block bottom-right. The header carries the **unit count alone** — see below |
| `checkout/index.astro` | Step track, then two panels: details form left (~1.15fr), order ledger + totals right |
| `checkout/pay.astro` | Narrow single column. Trust line, Stripe mount, `Pay $X`. See §9 |
| `orders/[orderId].astro` | State stamp first (it's the most important thing on the page), reference in mono, then items + totals |
| `404.astro` | Same empty-state language as the others |

**No `· N held` clause on the cart header.** The mockup draws `3 items · 2 held` and the page
shipped it; both halves were wrong at once. The item count sums units while the held count
counted *lines*, so four units across three lines read `4 items · 3 held` with every unit
held — and the clause was a render-time snapshot printed above ribbons that keep ticking, so
it still said `2 held` over two ribbons that had both gone to `Hold released`. It is gone
rather than fixed: every line already carries a live ribbon stating what its own hold is
doing, and a staler second copy of that fact one line above is not worth keeping honest. The
mockup's frame is self-consistent only at quantity 1, where units, lines and holds are the
same number. Restoring the clause means re-deciding this, not re-adding a span.

**A page prints a count only when it can prove it.** A page fetches a bounded window of the
catalog, so the length of what came back counts the *window*, not the store — `48 items`
under a shop that has 900 is a lie the shopper cannot catch. The count survives when the
window did not fill, or when a full window comes with an explicit `hasMore: false`; otherwise
the shop page drops its eyebrow and the home CTA falls back from `Shop all 3 items` to `Shop
everything`. Same rule as §7's money: no figure the store did not hand us.

**Empty and degraded states are designed surfaces, not afterthoughts** — empty cart, empty
catalog, prices unavailable, totals unavailable, payment not configured. All are in the
mockup. An empty screen is an invitation to act; a failure explains what still works.

---

## 9. Stripe's Payment Element

`/checkout/pay` mounts Stripe's own fields — left alone they arrive as a default blue-focus
widget in the middle of this theme. Pass an `appearance` object built from the tokens
(`--u-ink`, `--u-surface`, `--u-edge`, `--u-straw` for focus, `--u-mute` for secondary text
and placeholders, `--u-bronze` for the invalid state, and the body face) so the fields match.
All six are required before the object is built — see below. This is the one surface the
theme cannot style with its own CSS.

Build it from **computed** values read off `documentElement`, not from a second copy of the
palette written down here: `var(--u-ink)` means nothing inside Stripe's iframe, and reading
the live value is what makes dark — and any future `data-theme` toggle — work with nothing to
drift. Return `undefined` rather than a half-built object if the tokens read empty; a missing
stylesheet is not an unpayable order.

**The self-hosted faces do not cross.** Stripe can load a custom font, but it fetches
`fonts[].src` from *its own* origin, which makes it a cross-origin fetch needing
`Access-Control-Allow-Origin` on `/_astro/fonts/*` and an HTTPS origin to boot. So the
appearance carries **names only** — the page's own resolved stack, and for the mono eyebrow
its first family plus a `ui-monospace, monospace` tail, because Astro's stack ends in a
`sans-serif` generic that would otherwise win. Right today, and right on the day these are
served with CORS over HTTPS. If you re-add the file handoff, prove it with a network trace
from the Stripe frame — the rendering looks the same either way.

Do not otherwise touch the payment path. Card data goes browser → Stripe and never reaches
this origin; that is what keeps the deployment at PCI SAQ-A.

---

## 10. Copy rules

The copy is design material and is part of this spec.

- **Never market "no oversell" / "atomic inventory" / "no oversell under concurrency."** It is
  a basic requirement of any store, not a highlight feature, and it does not belong in
  shopper-facing copy or in the theme's positioning. The *hold* stays visible — "we'll hold it
  for fifteen minutes" is useful to a shopper — but the boast goes. Fifteen, not ten: it is
  the TTL the store actually runs (§6), and it is stated as a number because "a few minutes"
  gives a shopper nothing to plan around.
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
