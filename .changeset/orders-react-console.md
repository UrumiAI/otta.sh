---
"@otta-sh/admin-presentation": minor
"@otta-sh/admin-react": minor
"@otta-sh/plugin": minor
---

Migrate the Orders admin screen to the React console, and extract the shared presentation package both surfaces now render through.

**New package `@otta-sh/admin-presentation`.** Money (`formatMoney`, `formatAmount`, the `Cents`/`Currency` brands, `parseMinorUnitsInput`), the console's single date dialect, the git-style short-id rule, the order-status vocabulary (`cancelled · closed`) and the refund confirm/capability copy moved out of `@otta-sh/plugin` into a package with no dependencies, no IO, no React and no EmDash. `@otta-sh/plugin` re-exports every one of them from its original paths, so its existing suites cover the extracted code and neither surface can drift from the other. This is the bill `console-imports-no-workspace-package` recorded as owed: the React tier gets `formatMoney` by SHARING the function, never by writing a second one.

**`@otta-sh/admin-react` gains the Orders screen** at `/orders` under the `otta-console` descriptor: row click to the order detail (the primary cell is a link with a full-row hover tint, not a row-wide click target), a copy button that copies the full order id beside the short prefix the row shows, the four-tab detail, and the refund, cancel, transition, fulfilment, note and reconciliation actions. The `Open order` picker is gone. Failure paths render an honest `aria-live` state carrying the server's own message plus what to do about it.

**`@otta-sh/plugin` gains a console branch** on its existing single admin route — two new interaction types that return raw JSON rather than Block Kit blocks, and one that forwards a console click to the Block Kit action handler unchanged, so every money-moving write keeps its watermark, its idempotency key and its refusal copy. No new route, no new capability, no `allowedHosts` change. The Block Kit Orders screen and its sandbox suite are untouched and both screens render.
