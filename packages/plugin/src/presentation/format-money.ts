/**
 * Money display formatting — the plugin's ONE sanctioned money→display
 * boundary, RE-EXPORTED from `@otta-sh/admin-presentation` since INC-20.
 *
 * This file used to hold the implementation and a note saying to "extract to a
 * shared presentation package only when a second real consumer package exists
 * (ADR-0002 rule 5)". INC-20 is the increment where one does: the React admin
 * console (`@otta-sh/admin-react`) renders the same orders and may not import
 * `@otta-sh/plugin`, so G1's "always `formatMoney(Cents, Currency, locale)`"
 * could be honoured only by sharing this function. It moved; it did not change.
 *
 * Everything the old header promised still holds, and is now pinned in two
 * places instead of one: branded inputs only (a raw `number` amount or raw
 * `string` currency is a compile error — `test/format-money.type-test.ts`
 * mirrors Phase 0's `Cents` test), no float ever touches the amount (the
 * minor→major conversion is integer string arithmetic and the exact decimal
 * string goes to `Intl.NumberFormat.format`), and localization plus RTL-safety
 * come from Intl rather than hand-assembled symbol+number strings.
 *
 * ONE IDIOM, STATED ONCE (INC-20 review). A module in `src/` that needs a
 * shared primitive imports `@otta-sh/admin-presentation` DIRECTLY. This file
 * and its four siblings are compatibility re-exports for the ~30 modules that
 * already imported these paths and that this increment had no reason to touch
 * — they are not a second sanctioned way in. A module being edited for any
 * other reason should take the package import and drop the shim path; when the
 * last caller has, these files go.
 */
export { formatMoney, majorUnits } from "@otta-sh/admin-presentation";
