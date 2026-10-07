import type { Clock } from "@otta-sh/domain";

/**
 * Real time, for the in-process adapters. `Date` only — no `node:` import, so
 * it is safe inside the workerd sandbox. Tests use the domain's `FixedClock`.
 */
export const systemClock: Clock = {
	now(): Date {
		return new Date();
	},
};
