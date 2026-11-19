/**
 * Typed agent-session failures, in the domain's `{ ok: false; reason }` shape
 * (as cart, customers and orders). The site layer maps each reason to a UCP
 * HTTP status and `messages[]` code; the domain speaks only in these unions.
 * No failure carries shopper data.
 */

export type AgentSessionFailureReason =
	/** Unknown session id. */
	| "SESSION_NOT_FOUND"
	/** The session's 24 h life is over; it accepts no more writes. */
	| "SESSION_EXPIRED"
	/** Canceled (or completed) sessions accept no more writes. */
	| "SESSION_CLOSED"
	/** The session has no lines, so there is nothing to hand off. */
	| "SESSION_INCOMPLETE"
	/** The same `Idempotency-Key` was sent with a different request (UCP 409). */
	| "IDEMPOTENCY_KEY_REUSED"
	/** The key was used on this session long enough ago that its answer is no
	 *  longer kept. Refused rather than re-applied. */
	| "IDEMPOTENCY_KEY_EXPIRED"
	/** The request carried no `Idempotency-Key`. */
	| "IDEMPOTENCY_KEY_MISSING"
	/** A caller-supplied key is too long: `Idempotency-Key` over 255, network key
	 *  or fingerprint over 128 characters. */
	| "INVALID_REQUEST"
	/** A re-derived secret does not match its stored hash (the server key changed
	 *  since it was issued). Refused rather than handing out a secret that would
	 *  not verify; see `AgentSessionSecrets` on key rotation. */
	| "SECRET_KEY_MISMATCH"
	/** The session has taken its lifetime maximum of keyed writes. */
	| "WRITE_LIMIT_REACHED"
	/** A concurrent writer kept winning the compare-and-set; the caller may retry. */
	| "WRITE_CONFLICT"
	| "TOO_MANY_LINES"
	| "INVALID_QUANTITY"
	| "DUPLICATE_SKU"
	| "QUOTE_CURRENCY_MISMATCH"
	/** The quote has a total although its shipping or tax is unknown: a partial
	 *  quote has no total (unknown is not zero). */
	| "QUOTE_PARTIAL_TOTAL"
	/** The store-wide cap on live sessions is reached. */
	| "TOO_MANY_SESSIONS"
	/** This network created too many sessions within the window. */
	| "RATE_LIMITED";

export type AgentSessionFailure = { ok: false; reason: AgentSessionFailureReason };

/**
 * Hand-off redemption failures. Each leaves the session untouched. `INVALID`
 * covers an unknown token, so a guess learns nothing about which sessions exist.
 */
export type AgentHandoffFailureReason =
	| "HANDOFF_INVALID"
	| "HANDOFF_EXPIRED"
	| "HANDOFF_CANCELED"
	| "HANDOFF_USED"
	/** The session has no lines right now (checked again inside the atomic mark);
	 *  the link itself stays valid. */
	| "HANDOFF_INCOMPLETE";

export type AgentHandoffFailure = { ok: false; reason: AgentHandoffFailureReason };

/** One answer for an unknown session and a wrong secret: no existence oracle. */
export type AgentOrderSecretFailure = { ok: false; reason: "ORDER_SECRET_INVALID" };
