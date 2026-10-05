/**
 * The order's email as a page may show it to whoever holds the order link (QA
 * U-2) — `jane.doe@gmail.com` → `j•••@g•••.com`. RE-EXPORTED from
 * `@otta-sh/admin-presentation` since issue #377, when the React Orders
 * console began masking buyer emails with the same rule and could not import
 * this package to get it. It moved; it did not change. `test/buyer-ref-hint.test.ts`
 * still pins the behaviour through this path, and pins that it IS the shared
 * function rather than a copy.
 *
 * The same compatibility-shim idiom as `presentation/format-money.ts`: a module
 * being edited for another reason should import the package directly.
 */
export { buyerRefHint } from "@otta-sh/admin-presentation";
