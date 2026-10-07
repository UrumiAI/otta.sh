/**
 * Git-style short ids for the admin console (the UUID display rule, D4),
 * RE-EXPORTED from `@otta-sh/admin-presentation` since INC-20.
 *
 * WHY THIS ONE HAD TO MOVE, specifically. §1.3's guarantee is a relationship
 * BETWEEN surfaces: the prefix an operator reads in a list row must be a
 * `startsWith` prefix of the one the confirm dialog names, so `#7e4c` and
 * `#7e4ce728` are visibly the same order. INC-20 adds a React Orders screen
 * beside the Block Kit one, and the two render the same page of orders — a
 * second implementation of "shortest unique prefix, floored at 4" could give a
 * different answer for the same set and there would be no test able to catch
 * it, because the two packages cannot import each other. One implementation
 * cannot disagree with itself.
 *
 * The React tier also delivers the half of the rule Block Kit could not: a copy
 * button on the row that copies the FULL id. That is an affordance, not a
 * different prefix — it reads the same `shortIdsFor` map.
 *
 * This file stays as a re-export so `scaffold/short-id.js` keeps working for
 * `orders-page.ts` and `scaffold/index.ts`.
 *
 * ONE IDIOM, STATED ONCE (INC-20 review). A module in `src/` that needs a
 * shared primitive imports `@otta-sh/admin-presentation` DIRECTLY. This file
 * and its four siblings are compatibility re-exports for the ~30 modules that
 * already imported these paths and that this increment had no reason to touch
 * — they are not a second sanctioned way in. A module being edited for any
 * other reason should take the package import and drop the shim path; when the
 * last caller has, these files go.
 */
export {
	SHORT_ID_CONFIRM_LEN,
	SHORT_ID_MIN,
	shortIdFixed,
	shortIdsFor,
} from "@otta-sh/admin-presentation";
