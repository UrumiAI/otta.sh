import type { Logger } from "@urumi.ai/otta-domain";

/**
 * The production sink for `@urumi.ai/otta-domain`'s diagnostics: the composition
 * roots hand this to every domain deps type that takes a `logger`, so the domain
 * stays IO-free while the output still reaches the worker log as before.
 */
export const CONSOLE_LOGGER: Logger = {
	info: (message, fields) => console.info(message, ...(fields === undefined ? [] : [fields])),
	warn: (message, fields) => console.warn(message, ...(fields === undefined ? [] : [fields])),
	error: (message, fields) => console.error(message, ...(fields === undefined ? [] : [fields])),
};
