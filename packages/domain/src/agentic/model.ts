import type { Cents, Currency, SignedCents } from "../money/cents.js";
import type { OrderId, ProductId, Sku } from "../money/ids.js";
import type { OrderAddress } from "../orders/model.js";

/**
 * The agent checkout session (ADR-0047, spec "Checkout session"). An AI agent
 * builds one over UCP; the shopper finishes it on the store's own `/checkout`
 * through a single-use hand-off link. The session never takes payment and never
 * prices anything: its `quote` is a preview computed by the store's own quote
 * code and handed in by the caller.
 *
 * One storage document per session (ADR-0019), written by compare-and-set on
 * `revision`.
 */

declare const AgentSessionIdBrand: unique symbol;
/** A checkout session id: `cs_` followed by an unguessable suffix from the secrets port. */
export type AgentSessionId = string & { readonly [AgentSessionIdBrand]: true };

export const AGENT_SESSION_ID_PREFIX = "cs_";

/** Mint an {@link AgentSessionId}; throws on a value without the `cs_` prefix. */
export function agentSessionId(value: string): AgentSessionId {
	if (
		!value.startsWith(AGENT_SESSION_ID_PREFIX) ||
		value.length <= AGENT_SESSION_ID_PREFIX.length
	) {
		throw new RangeError("agentSessionId must be cs_ followed by a non-empty suffix");
	}
	return value as AgentSessionId;
}

/** UCP checkout status. `completed` is never reached in this layer: the agent
 *  cannot take payment, so `complete` answers `requires_escalation`. */
export type AgentSessionStatus = "incomplete" | "requires_escalation" | "completed" | "canceled";

/** The attribution channel the session records (UCP open tier: unverified agent). */
export type AgentSessionChannel = "other";

export interface AgentSessionLine {
	productId: ProductId;
	sku: Sku;
	/** A positive integer, at most the caller's line cap. */
	quantity: number;
}

/** Shopper contact details, as the agent supplied them. Never logged. */
export interface AgentSessionBuyer {
	email?: string;
	firstName?: string;
	lastName?: string;
	phone?: string;
}

/**
 * The last quote computed for the session, a PREVIEW only (ADR-0047 Decision 4):
 * the hand-off re-prices from scratch. It is the plugin's verbatim preview from
 * the domain's own pricing code (the quote use-case), stored here UNCHECKED: this
 * module never re-adds it, so it does not check `total` against subtotal -
 * discount + fulfillment + tax + rounding, and accepts a `null` total even when
 * every part is known. It refuses only what is malformed on its face: another
 * currency, or a total beside an unknown part. A part that could not be computed
 * yet (no destination, so no shipping or tax) is `null`, never zero, and then
 * `total` is `null` too: a partial quote has no total.
 */
export interface AgentSessionQuote {
	currency: Currency;
	subtotal: Cents;
	discount: Cents;
	fulfillment: Cents | null;
	tax: Cents | null;
	/** Payment rounding (ADR-0035 amendment); absent for a currency without an increment. */
	rounding?: SignedCents;
	/** `null` whenever `fulfillment` or `tax` is `null`. */
	total: Cents | null;
	/** When the quote was computed (ISO-8601 UTC). */
	quotedAt: string;
}

export type AgentSessionOperation = "create" | "replace" | "cancel" | "complete" | "issue_handoff";

/**
 * The public projection of a session: what every use-case result the site layer
 * can see carries (get, create, replace, complete, cancel, issue_handoff and
 * their replays, redeem, verifyOrderSecret). It leaves out the idempotency
 * bookkeeping (`writes`, `retiredWriteKeys`), the creating `networkKey`, both
 * secret hashes and the redeemed-link history, so serialising it leaks none of
 * them. `linkGeneration` is informational only: build `continue_url` from the
 * returned token, never from this.
 */
export type AgentSessionView = Omit<
	AgentCheckoutSession,
	| "writes"
	| "retiredWriteKeys"
	| "networkKey"
	| "orderSecretHash"
	| "handoffTokenHash"
	| "redeemedHandoffs"
>;

/** @deprecated The name before the public projection; use {@link AgentSessionView}. */
export type AgentSessionSnapshot = AgentSessionView;

/**
 * An `Idempotency-Key` recorded on a session. Session-scoped writes are keyed by
 * the session alone: the unguessable session id is already the bearer
 * credential, so a retry from another egress network replays rather than
 * applying twice. (Creates, which have no session yet, are keyed by network and
 * key in the store's create index.)
 */
export interface AgentSessionWriteKey {
	key: string;
}

/** A keyed write the session answered, kept so a replay returns the same answer. */
export interface AgentSessionWriteRecord extends AgentSessionWriteKey {
	operation: AgentSessionOperation;
	/** The caller's fingerprint of the request body. */
	fingerprint: string;
	/** The session revision the write produced. */
	revision: number;
	/**
	 * The session as of this write; a replay answers it (secrets are re-derived).
	 * It is a historical copy: buyer and destination data a later write cleared
	 * survive here until the whole session is purged (30 d). Any erasure must
	 * therefore delete the whole session document, never just its current fields.
	 */
	answer: AgentSessionView;
}

/** An earlier hand-off link of the session that a shopper redeemed. */
export interface AgentSessionRedeemedHandoff {
	tokenHash: string;
	usedAt: string;
}

export interface AgentCheckoutSession {
	id: AgentSessionId;
	/** Compare-and-set revision; 1 on create. */
	revision: number;
	status: AgentSessionStatus;
	currency: Currency;
	lines: AgentSessionLine[];
	buyer?: AgentSessionBuyer;
	/** The ship-to, in the order's own address shape (ADR-0009). */
	destination?: OrderAddress;
	shippingMethodId?: string;
	couponCode?: string;
	/** The cart last used to quote; may since have expired or been checked out. */
	cartId?: string;
	quote?: AgentSessionQuote;
	/** Hash of the derived `order_secret`. */
	orderSecretHash: string;
	/**
	 * The current hand-off link's generation; 0 until the first one is issued.
	 * Its token is derived from (id, generation), so it is never stored.
	 */
	linkGeneration: number;
	/** Hash of the current generation's token; absent while `linkGeneration` is 0. */
	handoffTokenHash?: string;
	/** When the current link was redeemed (single use). */
	handoffUsedAt?: string;
	/** Earlier links that were redeemed, oldest first. Never cleared, so a used
	 *  link still answers "already used" and attribution survives a re-issue. */
	redeemedHandoffs: AgentSessionRedeemedHandoff[];
	orderId?: OrderId;
	channel: AgentSessionChannel;
	/**
	 * The rate-limit key of the network that created the session (an opaque,
	 * caller-derived value, e.g. a hash of the client IP, at most
	 * {@link AGENT_SESSION_MAX_NETWORK_KEY_LENGTH} characters). Never a raw address.
	 */
	networkKey: string;
	createdAt: string;
	updatedAt: string;
	/** createdAt + 24 h: the session, and every hand-off link it issues, dies here. */
	expiresAt: string;
	/** createdAt + 30 d: the sweep deletes the session from here on. */
	purgeAt: string;
	/** Recent keyed writes with their answers, newest last, at most
	 *  {@link AGENT_SESSION_MAX_WRITE_RECORDS}. Each answer holds a copy of the
	 *  session's PII as of that write (see {@link AgentSessionWriteRecord}). */
	writes: AgentSessionWriteRecord[];
	/** Keys whose records were evicted from `writes`: a late replay of one is
	 *  refused (`IDEMPOTENCY_KEY_EXPIRED`), never re-applied. */
	retiredWriteKeys: AgentSessionWriteKey[];
}

export const AGENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** UCP / spec cap on lines per session. */
export const AGENT_SESSION_MAX_LINES = 50;
/** How many keyed writes a session keeps full answers for. */
export const AGENT_SESSION_MAX_WRITE_RECORDS = 32;
/** The most keyed writes one session accepts in its life (records plus retired
 *  keys); beyond it writes are refused `WRITE_LIMIT_REACHED`, so no key is ever
 *  forgotten while the session lives. Cancel is exempt, so a session at the cap
 *  can still be canceled and its link killed. */
export const AGENT_SESSION_MAX_WRITES = 512;
/** Length caps (characters) on caller-supplied keys; longer is `INVALID_REQUEST`. */
export const AGENT_SESSION_MAX_IDEMPOTENCY_KEY_LENGTH = 255;
export const AGENT_SESSION_MAX_NETWORK_KEY_LENGTH = 128;
export const AGENT_SESSION_MAX_FINGERPRINT_LENGTH = 128;

/** The status rule: no lines → `incomplete`; at least one → `requires_escalation`. */
export function agentSessionStatusForLines(lines: readonly AgentSessionLine[]): AgentSessionStatus {
	return lines.length === 0 ? "incomplete" : "requires_escalation";
}

/** A session that agents may still write to and whose link may still be redeemed. */
export function isAgentSessionOpen(status: AgentSessionStatus): boolean {
	return status === "incomplete" || status === "requires_escalation";
}
