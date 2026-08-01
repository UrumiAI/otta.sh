---
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
"@otta-sh/plugin": minor
---

Migrate the Pricing & inventory admin screen to the React console — the second and last screen ADR-0014 puts in scope.

**`@otta-sh/admin-react` gains the screen** at `/products` under the `otta-console` descriptor: row click to the product detail (the title cell is a link with a full-row hover tint, not a row-wide click target), the two-tab detail, the three split saves, and the two adjacent stock forms. The `Open product` picker is gone, and with it the `ComboboxList` duplicate-key React error it was the only source of. The drill-in has a URL, so a product can be reloaded, bookmarked and sent to a colleague as a link.

**Identity on this screen is the SKU, and it renders in full.** The UUID display rule governs opaque ids, and this screen shows none — the product uuid lives in the link's target and is never rendered. A SKU is a natural key, the thing low stock is reported by and the thing a purchase order is written against, so it renders whole with a copy button beside it rather than truncated to a prefix.

**`Low stock only` stays page-scoped, and the row count stays honest.** The filter narrows the page a request fetched rather than the query (the products list has no stock predicate), so the service's exact count describes a different set of rows than the ones on screen and is withheld while it is on — both surfaces make that call in one place. There is no Title field and no Status field on either surface: `product_commerce.title` and `active` are CMS-owned, and a Playwright spec now asserts their absence on the React side, where the type system cannot.

**`@otta-sh/admin-presentation` gains the products vocabulary** both surfaces render through: `statusLabel`, `onHandCell` (with the null-vs-zero-vs-missing distinction intact), `parseStockQty`, the screen's authored copy, the stock-degradation banner's composition, the remove-stock confirm's sentence, the D-6 group labels and `formatOptionalAmount`. The last of those deleted the console's remaining second money renderer, whose Intl-failure branch printed raw minor units into a money field. The Orders detail's roughly-a-dozen hand-copied strings moved here too, closing the rider INC-20 recorded — and finding four places the two Orders surfaces had already drifted: typographic quotes in the cancel copy, a reconciliation note that had lost its next step, an over-refund refusal that stated the fact without the instruction, and an additive-refunds warning whose step reference is true on only one surface.

**`@otta-sh/plugin` gains a second console branch** on its existing single admin route. Reads answer with raw amounts and raw on-hand counts; writes are forwarded to the Block Kit handlers unchanged, with the `block_id` carrier those form submits read minted server-side from the click's own payload — so every watermark, every content-derived idempotency key and every refusal sentence stays where it was. No new route, no new capability, no `allowedHosts` change. Both Block Kit screens and their sandbox suites are untouched, and all four admin screens render.
