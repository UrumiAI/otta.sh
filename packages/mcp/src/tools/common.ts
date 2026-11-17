import { z } from "zod";
import { toolFailure } from "../errors.js";

/** A page size for list tools: 1..100, default 25. */
export const limitInput = z
	.number()
	.int()
	.min(1)
	.max(100)
	.default(25)
	.describe("How many items to return, 1-100 (default 25).");

export const cursorInput = z
	.string()
	.min(1)
	.optional()
	.describe("The `nextCursor` from the previous page. Omit for the first page.");

/** ISO-8601 UTC instant, e.g. 2026-01-31T00:00:00.000Z. Ranges are half-open [from, to). */
export const instantInput = (what: string) =>
	z.string().min(1).describe(`${what} as an ISO-8601 UTC instant, e.g. 2026-01-01T00:00:00.000Z.`);

export const MONEY_NOTE =
	"Money is integer minor units (1999 = 19.99) alongside an ISO-4217 currency code, never a decimal.";

/** A page that was re-issued from page one because the cursor was refused. */
export function refuseRejectedCursor(page: { cursorRejected?: true }): void {
	if (page.cursorRejected === true) {
		toolFailure(
			"INVALID_CURSOR",
			"That cursor does not belong to this query (or is not a cursor). Start again without `cursor`.",
		);
	}
}

/**
 * Run a surface read; the input errors the surfaces throw (`CommerceInputError`,
 * matched by shape as the plugin does) become `INVALID_INPUT` so the agent keeps
 * the code. Everything else is left to surface as an internal error.
 */
export async function readOrRefuse<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		// A range wider than the domain's cap (400 days) is the caller's input, too.
		if (
			error instanceof Error &&
			((error as { code?: unknown }).code === "INVALID_INPUT" ||
				error.name === "ReportRangeTooWideError")
		) {
			toolFailure("INVALID_INPUT", error.message);
		}
		throw error;
	}
}

/**
 * Run an admin operation. Its input assertions throw `RangeError` (a value the
 * schema let through, such as a whitespace-only string); that is the caller's
 * input, so it becomes `INVALID_INPUT` rather than an internal error.
 */
export async function operate<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof RangeError) toolFailure("INVALID_INPUT", error.message);
		throw error;
	}
}
