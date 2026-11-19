/**
 * How a tool says "no" with a stable code an agent can branch on.
 *
 * THE ENVELOPE IS EMDASH'S, NOT OURS. A plugin route fails, in EmDash's own
 * route contract, by THROWING a `PluginRouteError`: `PluginRouteHandler.invoke`
 * (emdash `plugins/routes.ts`) catches it and answers
 * `{ success: false, error: { code, message, details }, status }`. The MCP server
 * passes that result through `unwrap` (emdash `mcp/server.ts`), which returns a
 * tool error carrying the code in `_meta.code` and as a `[CODE]` message prefix.
 * A RETURNED `{ success: false, … }` would not work: the host would wrap it as a
 * successful route's data and the agent would see a success.
 *
 * EmDash recognises the error ON SHAPE (`isPluginRouteError`: an `Error` whose
 * `name` is "PluginRouteError" with a string `code` and a numeric `status`), so
 * this class carries that shape without importing `emdash` at runtime. Anything
 * thrown that lacks it becomes `INTERNAL_ERROR` with a generic message.
 */

/** HTTP status per code, for a direct (non-MCP) caller of the route. MCP ignores it. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
	NOT_FOUND: 404,
	CONFLICT: 409,
	/** The audit log could not record the call, so the tool did not run (a host
	 *  storage failure, not the caller's input): retry later. */
	AUDIT_UNAVAILABLE: 503,
};

export class ToolError extends Error {
	/** The name EmDash's `isPluginRouteError` matches on. */
	override readonly name = "PluginRouteError";
	readonly status: number;

	constructor(
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.status = STATUS_BY_CODE[code] ?? 400;
	}
}

/** Throw a {@link ToolError}. For a tool's `run`: `return toolFailure(…)` reads as an answer. */
export function toolFailure(code: string, message: string, details?: unknown): never {
	throw new ToolError(code, message, details);
}
