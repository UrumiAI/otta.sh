import { toolFailure } from "../errors.js";

/**
 * The `default` of every outcome switch: `outcome` is `never` while the switch
 * covers its union, so a new outcome kind fails the typecheck. At runtime (a
 * plugin newer than this build) it is refused, never returned as success.
 */
export function unhandled(outcome: never): never {
	const value = outcome as { kind?: unknown; reason?: unknown };
	return toolFailure(
		"INTERNAL_ERROR",
		`Unhandled operation outcome: ${String(value.kind ?? value.reason)}.`,
	);
}

/**
 * The reverse check for a closed set an input schema restates: `satisfies`
 * refuses a value the type lacks; this refuses a type member the list lacks. It
 * is `true` only while the list is complete, so assign `true` to a const of it
 * (a bare alias that resolved to `never` would not fail the compile) and a new
 * member upstream fails the typecheck.
 */
export type Complete<Type, List extends readonly unknown[]> = [
	Exclude<Type, List[number]>,
] extends [never]
	? true
	: never;
