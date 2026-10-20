/**
 * Where a site's registered tax calculator lives (ADR-0030).
 *
 * A site opts in from its own plugin entry module —
 * `export default createOttaPlugin({ taxCalculator })` — which em-dash imports at
 * build time, exactly as it imports `@urumi.ai/otta-plugin/plugin`. Registration runs
 * once, when that module is evaluated, and every commerce client the isolate
 * builds reads it from here (`makeCommerceClient`). Nothing registered ⇒ the
 * built-in `otta.rate-table`. Sandboxed mode loads the default export, so it is
 * always the built-in. An in-process site writing its own entry should also pass
 * `trustedHost: true` (issue #447): its entry replaces `@urumi.ai/otta-plugin/trusted`.
 *
 * A calculator is TRUSTED code the merchant chose to install, like a WordPress
 * plugin: it runs in-process and may use `fetch` itself (ADR-0030). What Otta
 * guards is its ANSWER — validated, and timed out — not its code.
 */
import { isValidCalculatorId, type TaxCalculator } from "@urumi.ai/otta-domain";

let registered: TaxCalculator | undefined;
/** The replacement warning is logged once per process: a dev server re-evaluates
 *  the entry on every hot reload, and each reload would repeat it (#463). */
let warnedReplaced = false;

/**
 * Register the site's calculator. Re-registering one with the SAME id replaces
 * it: a dev server that re-evaluates the site's entry module builds a new
 * object while this module (a dependency) keeps its state. Replacing with a
 * different object logs a `console.warn` so the override is visible — once per
 * process, so a hot-reloading dev server does not repeat it; re-registering the
 * very same object stays silent. A DIFFERENT id
 * throws, so two entries can never silently race for which one prices orders.
 */
export function setTaxCalculator(calculator: TaxCalculator): void {
	if (
		typeof calculator !== "object" ||
		calculator === null ||
		typeof calculator.calculate !== "function" ||
		!isValidCalculatorId(calculator.id)
	) {
		throw new TypeError(
			"taxCalculator must be { id, calculate(request) } with an id of 1–64 [A-Za-z0-9._-]",
		);
	}
	if (registered !== undefined && registered.id !== calculator.id) {
		throw new Error(
			`a tax calculator ("${registered.id}") is already registered; register exactly one`,
		);
	}
	if (registered !== undefined && registered !== calculator && !warnedReplaced) {
		// Not an error (a dev reload does this), but never silent: which calculator
		// prices orders should be visible in the log. Once, not on every reload.
		warnedReplaced = true;
		console.warn(`[otta] tax calculator "${calculator.id}" replaced an already-registered one`);
	}
	registered = calculator;
}

/** The registered calculator, or `undefined` for the built-in. */
export function getTaxCalculator(): TaxCalculator | undefined {
	return registered;
}
