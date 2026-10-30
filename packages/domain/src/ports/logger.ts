/**
 * Where the domain states a diagnostic; the caller owns the sink. Mirrors how
 * {@link import("./clock.js").Clock} displaces ambient `Date.now()`: the domain
 * stays IO-free and tests assert against an injected recorder, not a global spy.
 */
export interface Logger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

/** Discards everything: for tests and consumers that deliberately want no diagnostics (no deps type defaults to it). */
export const NOOP_LOGGER: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};
