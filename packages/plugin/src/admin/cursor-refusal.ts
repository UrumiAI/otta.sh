/**
 * The one condition a paged admin list request can recover from by itself.
 *
 * WHAT THE SERVICE SAYS. Both admin list routes fail closed when the cursor and
 * the request's own filter params describe different predicates, or when the
 * token is malformed, tampered or otherwise undecodable. Those arrive as a 400
 * whose body names the cause: `cursor filter mismatch` for the disagreement,
 * `invalid cursor` for the token itself. Every other refusal on that surface —
 * an unparseable filter, a missing admin token, an outage — means something the
 * caller cannot fix by asking differently.
 *
 * WHY THE DISTINCTION IS WORTH A MODULE. The remedy for these two is mechanical
 * and identical: drop the cursor and re-issue page one with the same parameters.
 * The remedy for everything else is to tell the operator. Getting that wrong in
 * either direction is a real defect rather than a cosmetic one — treat a refused
 * token as an outage and the console shows an error pane for a request that was
 * perfectly answerable; treat an outage as a refused token and the console
 * quietly rewrites the address, throwing away the only record of the page the
 * operator was on just when a reload would have restored it.
 *
 * WHY IT IS SHARED RATHER THAN COPIED. Two clients speak this contract and the
 * strings are the service's, not theirs. A second copy would be free to drift on
 * exactly the values that make the classification work, and drift here is
 * silent: the wrong branch still returns rows.
 *
 * IT MATCHES THE VALUE, NEVER THE PROSE. `error` is a stable wire code the
 * routes emit deliberately (the changeset that added the gate says as much);
 * anything human-readable in a body is not a contract.
 */

/** The service's own words for the two refusals a client can answer itself. */
const CURSOR_REFUSAL_ERRORS: ReadonlySet<string> = new Set([
	"cursor filter mismatch",
	"invalid cursor",
]);

/** The sentinel a list read resolves to when the cursor — not the service, not
 *  the caller's credentials — is what was refused. A unique object rather than
 *  `null` or a boolean, so a caller that forgets to branch on it gets a type
 *  error rather than an empty page. */
export const CURSOR_REFUSED: unique symbol = Symbol("cursor-refused");

/**
 * Is this non-OK response the service refusing the CURSOR?
 *
 * Reads the body defensively: a 400 with no body, a truncated one, or one that
 * is not JSON at all is NOT a cursor refusal — it is an unexplained failure, and
 * the safe reading of an unexplained failure is the one that keeps the
 * operator's page in the address rather than the one that silently discards it.
 */
export async function isCursorRefusal(res: Response): Promise<boolean> {
	if (res.status !== 400) return false;
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return false;
	}
	if (typeof body !== "object" || body === null) return false;
	const error = (body as { error?: unknown }).error;
	return typeof error === "string" && CURSOR_REFUSAL_ERRORS.has(error);
}
