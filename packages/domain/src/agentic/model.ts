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
/** A checkout session id: `cs_` followed by an opaque, random suffix. */
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
 * the hand-off re-prices from scratch. Computed outside this module by the
 * store's quote code; stored here verbatim. A part that could not be computed
 * yet (no destination, so no shipping or tax) is `null`, never zero.
 */
export interface AgentSessionQuote {
	currency: Currency;
	subtotal: Cents;
	discount: Cents;
	fulfillment: Cents | null;
	tax: Cents | null;
	/** Payment rounding (ADR-0035 amendment); absent for a currency without an increment. */
	rounding?: SignedCents;
	total: Cents;
	/** When the quote was computed (ISO-8601 UTC). */
	quotedAt: string;
}

/** The request a write was keyed on: kept on the session so a replay answers it. */
export interface AgentSessionWriteRecord {
	/** The caller's `Idempotency-Key`. */
	key: string;
	operation: AgentSessionOperation;
	/** The caller's fingerprint of the request body. */
	fingerprint: string;
	/** The session revision the write produced. */
	revision: number;
}

export type AgentSessionOperation = "create" | "replace" | "cancel" | "complete";

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
	/** Hash of the `order_secret` returned once at create. */
	orderSecretHash: string;
	/** Hash of the live hand-off token; absent until one is issued. */
	handoffTokenHash?: string;
	/** When the live hand-off token was redeemed (single use). */
	handoffUsedAt?: string;
	orderId?: OrderId;
	channel: AgentSessionChannel;
	/**
	 * The rate-limit key of the network that created the session (an opaque,
	 * caller-derived value, e.g. a hash of the client IP). Never a raw address.
	 */
	networkKey: string;
	createdAt: string;
	updatedAt: string;
	/** createdAt + 24 h: the session, and every hand-off link it issues, dies here. */
	expiresAt: string;
	/** createdAt + 30 d: the sweep deletes the session from here on. */
	purgeAt: string;
	/** Writes this session answered, newest last, bounded to {@link MAX_WRITE_RECORDS}. */
	writes: AgentSessionWriteRecord[];
}

export const AGENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** UCP / spec cap on lines per session. */
export const AGENT_SESSION_MAX_LINES = 50;
/** How many keyed writes a session remembers for replay. A key evicted from this
 *  list is treated as new: a very late replay re-applies its request. */
export const MAX_WRITE_RECORDS = 64;

/** The status rule: no lines → `incomplete`; at least one → `requires_escalation`. */
export function statusForLines(lines: readonly AgentSessionLine[]): AgentSessionStatus {
	return lines.length === 0 ? "incomplete" : "requires_escalation";
}

/** A session that agents may still write to and whose link may still be redeemed. */
export function isOpenStatus(status: AgentSessionStatus): boolean {
	return status === "incomplete" || status === "requires_escalation";
}
