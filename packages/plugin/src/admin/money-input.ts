/**
 * The money INPUT boundary — an operator's typed amount → integer minor units —
 * RE-EXPORTED from `@otta-sh/admin-presentation` since INC-20.
 *
 * It moved for the same reason `formatAmount` did, running the other way. The
 * React Orders console has a partial-refund field, and the moment an operator
 * types `19.99` into it two things must happen in the BROWSER: the string
 * becomes 1999 minor units to put in the action payload, and it becomes
 * `$19.99` to put in the confirm dialog the operator reads before the money
 * moves. A second parser for that — with its own opinion about `19,99`, about
 * `19.999`, about a leading `+`, about whether zero is allowed — is the last
 * place in this console where drift is acceptable.
 *
 * `packages/plugin/src/admin/money-input.js` stays as this re-export because it
 * is the path `orders-page.ts` and `products-page.ts` already import, and
 * `@otta-sh/plugin`'s public `index.ts` re-exports both functions from it.
 */
export { formatMinorUnitsInput, parseMinorUnitsInput } from "@otta-sh/admin-presentation";
