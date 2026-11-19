/**
 * Typed agent-session failures. The UCP layer maps them to HTTP statuses and
 * `messages[]` codes; the domain speaks only in these unions. No failure carries
 * shopper data.
 */

/** A request that the session's own rules refuse. */
export type AgentSessionInvalidReason =
	| "too_many_lines"
	| "invalid_quantity"
	| "duplicate_sku"
	| "quote_currency_mismatch"
	| "idempotency_key_missing";

export type AgentSessionFailure =
	/** Unknown session id. */
	| { ok: false; code: "session_not_found" }
	/** The session's 24 h life is over; it accepts no more writes. */
	| { ok: false; code: "session_expired" }
	/** Canceled (or completed) sessions accept no more writes. */
	| { ok: false; code: "session_closed" }
	/** The session has no lines, so there is nothing to hand off. */
	| { ok: false; code: "session_incomplete" }
	/** The same `Idempotency-Key` was sent with a different request (UCP 409). */
	| { ok: false; code: "idempotency_key_reused" }
	/** A concurrent writer kept winning the compare-and-set; the caller may retry. */
	| { ok: false; code: "write_conflict" }
	| { ok: false; code: "invalid_request"; reason: AgentSessionInvalidReason }
	/** The store-wide cap on live sessions is reached. */
	| { ok: false; code: "too_many_sessions" }
	/** This network created too many sessions within the window. */
	| { ok: false; code: "rate_limited" };

export type AgentSessionFailureCode = AgentSessionFailure["code"];

/**
 * Hand-off redemption failures. Each leaves the session untouched. `invalid`
 * covers an unknown token, so a guess learns nothing about which sessions exist.
 */
export type HandoffFailure =
	| { ok: false; code: "handoff_invalid" }
	| { ok: false; code: "handoff_expired" }
	| { ok: false; code: "handoff_canceled" }
	| { ok: false; code: "handoff_used" };

export type HandoffFailureCode = HandoffFailure["code"];

/** One answer for an unknown session and a wrong secret: no existence oracle. */
export type OrderSecretFailure = { ok: false; code: "order_secret_invalid" };
