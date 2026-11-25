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
	/** A caller-supplied value is malformed: an empty network key or fingerprint,
	 *  an `Idempotency-Key` over 255, a network key or fingerprint over 128
	 *  characters, or a content string over its cap (see the
	 *  `AGENT_SESSION_MAX_*_LENGTH` constants). */
	| "INVALID_REQUEST"
	/** A REPLAY would re-derive a secret that no longer matches its stored hash
	 *  (the server key changed since it was issued). Refused rather than handing
	 *  out a secret that would not verify; see `AgentSessionSecrets` on key
	 *  rotation. A fresh write instead mints a new link under the new key. */
	| "SECRET_KEY_MISMATCH"
	/** A shopper has redeemed the session's hand-off link and now owns the cart:
	 *  the agent may only cancel it (or read it). For changes, create a new session. */
	| "SESSION_HANDED_OFF"
	/** A shopper's claim on the hand-off link is live (the redeem is building the
	 *  cart): agent writes are refused until it finalizes or its short lease
	 *  lapses. Retryable. */
	| "HANDOFF_IN_PROGRESS"
	/** The content's serialized weight is over `AGENT_SESSION_MAX_CONTENT_BYTES`. */
	| "CONTENT_TOO_LARGE"
	/** `recordAgentSessionOrder` on a session whose hand-off link was never redeemed. */
	| "HANDOFF_NOT_REDEEMED"
	/** `recordAgentSessionOrder` with an order other than the one already recorded. */
	| "ORDER_ALREADY_RECORDED"
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
	/** The redeem carried no redeemer nonce (the site's cookie): retryable, the
	 *  site reloads its landing page (which sets it) and redeems again. */
	| "HANDOFF_REDEEMER_MISSING"
	| "HANDOFF_EXPIRED"
	| "HANDOFF_CANCELED"
	| "HANDOFF_USED"
	/** The session has no lines right now (checked again inside the atomic claim);
	 *  the link itself stays valid. */
	| "HANDOFF_INCOMPLETE"
	/** Another redeem of this link holds a live claim. Retryable: once that claim
	 *  finalizes the link re-enters its cart, and if it lapses the link claims again. */
	| "HANDOFF_IN_PROGRESS"
	/** The store refused the claim's document (over its byte cap). Not expected:
	 *  keyed writes leave a reserve for it. */
	| "HANDOFF_UNAVAILABLE";

export type AgentHandoffFailure = { ok: false; reason: AgentHandoffFailureReason };

/** One answer for an unknown session and a wrong secret: no existence oracle. */
export type AgentOrderSecretFailure = { ok: false; reason: "ORDER_SECRET_INVALID" };

/**
 * Why {@link finalizeAgentHandoff} refused. `HANDOFF_CLAIM_LOST`: the claim is no
 * longer the session's (it lapsed and was re-claimed, an agent write after the
 * lapse cleared it, or its finalize grace ran out); `HANDOFF_EXPIRED`: the
 * session's 24 h ended first. Either way the caller must not hand the shopper
 * the cart it built. Nothing is written on any failure.
 */
export type AgentHandoffFinalizeFailure = {
	ok: false;
	reason:
		| "SESSION_NOT_FOUND"
		| "HANDOFF_CLAIM_LOST"
		| "HANDOFF_CANCELED"
		| "HANDOFF_USED"
		| "HANDOFF_EXPIRED"
		| "HANDOFF_UNAVAILABLE"
		| "INVALID_REQUEST";
};
