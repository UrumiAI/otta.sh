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

/**
 * `true` only while every key of `Input` is a key of `Wire` (or one of `Except`,
 * the keys the tool consumes itself). Assigned to a const, it fails the typecheck
 * when a schema field is renamed or misspelled against the operation's input type,
 * which a spread into that type would not catch.
 */
export type KeysWithin<Input, Wire, Except extends PropertyKey = never> = [
	Exclude<keyof Input, keyof Wire | Except>,
] extends [never]
	? true
	: never;
