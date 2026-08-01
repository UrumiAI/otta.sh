/**
 * The plugin's branded money types, now RE-EXPORTED from
 * `@otta-sh/admin-presentation` rather than defined here (INC-20).
 *
 * WHAT MOVED, AND WHAT DID NOT. The definitions moved; nothing about them
 * changed. `Cents` is still a `unique symbol` brand, `cents()` is still the only
 * mint, float literals are still a compile error, and the two `Cents` types
 * (this one and `@otta-sh/domain`'s) are still intentionally NOT
 * cross-assignable — a value crosses the wire as an integer and is re-validated
 * and re-branded at the plugin edge (`catalog/commerce-view.ts`), so each side's
 * brand proves ITS OWN validation ran. `test/money-parity.test.ts` still pins
 * behaviour parity with the domain module and now does it through this file, so
 * the extraction is covered by the suite that already existed.
 *
 * WHY IT MOVED. `@otta-sh/admin-react` renders money and may not import
 * `@otta-sh/plugin` (ADR-0014 Decision 3 / `console-imports-no-workspace-package`).
 * G1 says the second surface gets the SAME renderer, never a second one, so the
 * renderer and the brands it takes had to live somewhere both packages can
 * reach. That is the "second real consumer package" `format-money.ts` named as
 * the condition for extraction.
 *
 * THIS FILE STAYS a re-export instead of every call site being rewritten,
 * deliberately: `presentation/money.js` is the import path ~30 modules in `src/`
 * already use, the plugin's public `index.ts` re-exports `cents`/`currency` from
 * it, and a rename touching all of them would make the extraction's diff
 * unreadable for no behavioural gain.
 *
 * THE ONE THING THIS COSTS, stated plainly: `src/` now has a runtime workspace
 * import, which it had none of before. The sandbox harness bundles a bare copy
 * of `src/` in a scratch directory with no workspace `node_modules`, so it
 * materialises this package beside the copy (`test/sandbox/harness.ts`) and
 * tsdown inlines it — the property the harness pins, that the shipped bundle is
 * self-contained, is unchanged. ADR-0001/0002's actual rule is that the plugin
 * never links DOMAIN code and reaches commerce truth only over `ctx.http`; a
 * dependency-free package of `Intl` and string functions is not that, and the
 * `plugin-is-sandbox-clean` rule still forbids `@otta-sh/domain` by name.
 *
 * ONE IDIOM, STATED ONCE (INC-20 review). A module in `src/` that needs a
 * shared primitive imports `@otta-sh/admin-presentation` DIRECTLY. This file
 * and its four siblings are compatibility re-exports for the ~30 modules that
 * already imported these paths and that this increment had no reason to touch
 * — they are not a second sanctioned way in. A module being edited for any
 * other reason should take the package import and drop the shim path; when the
 * last caller has, these files go.
 */
export { cents, currency, type Cents, type Currency } from "@otta-sh/admin-presentation";
