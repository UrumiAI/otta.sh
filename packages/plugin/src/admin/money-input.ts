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
 *
 * ONE IDIOM, STATED ONCE (INC-20 review). A module in `src/` that needs a
 * shared primitive imports `@otta-sh/admin-presentation` DIRECTLY. This file
 * and its four siblings are compatibility re-exports for the ~30 modules that
 * already imported these paths and that this increment had no reason to touch
 * — they are not a second sanctioned way in. A module being edited for any
 * other reason should take the package import and drop the shim path; when the
 * last caller has, these files go.
 */
export { formatMinorUnitsInput, parseMinorUnitsInput } from "@otta-sh/admin-presentation";
