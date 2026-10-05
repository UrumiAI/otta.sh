/**
 * The admin screens' check on an operator-typed record ID (zone, method, tax
 * class, tax rate, coupon), BEFORE it reaches the commerce boundary.
 *
 * WHY THE SCREENS CHECK WHAT THE BOUNDARY ALREADY CHECKS. The boundary's rule
 * (`requireIdToken` in `commerce-input.ts`: non-empty, ≤200 characters, printable
 * ASCII with no whitespace) refuses by THROWING, and a throw inside a custom
 * action lands in the scaffold's net — which can only re-render the root list,
 * dropping the create screen and everything the operator typed. Checking here
 * lets the screen answer on its own create screen with the draft put back
 * (DA-3a-i), in words an operator can act on. The predicate is the boundary's
 * own `isIdToken`, so the two cannot drift: this decides only the WORDS.
 */
import { isIdToken } from "../commerce/commerce-input.js";

/** The refusal sentence for a typed ID, or `undefined` when it is acceptable.
 *  `id` is the already-trimmed value the screen is about to send. */
export function idInputProblem(id: string): string | undefined {
	if (isIdToken(id)) return undefined;
	if (/\s/.test(id)) {
		return `The ID can't contain spaces — try "${id.replace(/\s+/g, "-")}".`;
	}
	if (id.length > 200) return "The ID must be at most 200 characters.";
	return "The ID can only use plain letters, digits and punctuation — no accents or other symbols.";
}
