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

/** UCP checkout status. An agent never reaches `completed` (it cannot take
 *  payment, so `complete` answers `requires_escalation`); only
 *  `recordAgentSessionOrder`, called when a redeemed hand-off places an order,
 *  sets it. */
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
 * their replays, redeem, verifyOrderSecret, recordOrder). An ALLOWLIST: it is
 * built field by field ({@link AGENT_SESSION_VIEW_KEYS}), so a field added to
 * the stored document never leaks by default. It carries no idempotency
 * bookkeeping, network key, secret hash, link generation or history, revision
 * or purge time; build `continue_url` only from a returned `handoffToken`.
 */
export interface AgentSessionView {
	id: AgentSessionId;
	status: AgentSessionStatus;
	currency: Currency;
	lines: AgentSessionLine[];
	buyer?: AgentSessionBuyer;
	destination?: OrderAddress;
	shippingMethodId?: string;
	couponCode?: string;
	cartId?: string;
	quote?: AgentSessionQuote;
	/** createdAt + 24 h: agent writes and hand-off links end here. */
	expiresAt: string;
	/** The order a redeemed hand-off placed, once recorded. */
	orderId?: OrderId;
	/** A shopper redeemed a hand-off link: the agent may now only cancel. */
	handedOff: boolean;
}

/** Every key an {@link AgentSessionView} may carry (optional ones only when set). */
export const AGENT_SESSION_VIEW_KEYS = [
	"id",
	"status",
	"currency",
	"lines",
	"buyer",
	"destination",
	"shippingMethodId",
	"couponCode",
	"cartId",
	"quote",
	"expiresAt",
	"orderId",
	"handedOff",
] as const satisfies readonly (keyof AgentSessionView)[];

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

/** A shopper's lease on the current hand-off link (see {@link AgentCheckoutSession.handoffClaim}). */
export interface AgentHandoffClaim {
	/** The link the claim is on: the session's `handoffTokenHash` when claimed. */
	tokenHash: string;
	/** Unguessable, minted per claim; finalize and release must present it. */
	claimId: string;
	claimedAt: string;
	/** claimedAt + {@link AGENT_HANDOFF_CLAIM_LEASE_MS}. */
	leaseUntil: string;
}

/** Whether `session` carries an unfinalized claim whose lease is still running at `now`. */
export function isAgentHandoffClaimLive(
	session: Pick<AgentCheckoutSession, "handoffClaim" | "handoffUsedAt">,
	now: string,
): boolean {
	return (
		session.handoffUsedAt === undefined &&
		session.handoffClaim !== undefined &&
		session.handoffClaim.leaseUntil > now
	);
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
	/** When the current link was redeemed (single use): the hand-off was
	 *  FINALIZED (the store's `finalizeHandoff`). From then on agent
	 *  writes other than cancel are refused `SESSION_HANDED_OFF`. */
	handoffUsedAt?: string;
	/**
	 * The shopper's claim on the current link while the redeem does its cart
	 * work: a lease, not a use. While `leaseUntil` is after now, agent writes are
	 * refused `HANDOFF_IN_PROGRESS` and a second claim is refused `claimed`; once
	 * it lapses the same token may claim again. A finalized hand-off keeps the
	 * claim that finalized it (so a repeated finalize replays). Absent until the
	 * first claim.
	 */
	handoffClaim?: AgentHandoffClaim;
	/** Earlier links that were redeemed, oldest first. Never cleared, so a used
	 *  link still answers "already used". Since a redeemed session takes no new
	 *  link, the use-cases leave it empty; kept so stores can index it. */
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
/** How long a shopper's claim on a link holds off other claims and agent writes. */
export const AGENT_HANDOFF_CLAIM_LEASE_MS = 60 * 1000;
/** After a finalized hand-off, the same link re-enters its cart (double click,
 *  second tab) for this long while no order is recorded; then it is used. */
export const AGENT_HANDOFF_REENTRY_WINDOW_MS = 15 * 60 * 1000;
/**
 * The most a stored session document may weigh: UTF-8 bytes of its JSON
 * ({@link agentSessionDocumentBytes}). The store refuses a larger insert or
 * write (`too_large`); the use-cases keep every keyed write at least
 * {@link AGENT_SESSION_DOCUMENT_RESERVE_BYTES} under it by evicting the oldest
 * write records (their keys retire), so a cancel and the store's own hand-off
 * marks always fit.
 */
export const AGENT_SESSION_MAX_DOCUMENT_BYTES = 128 * 1024;
/** Headroom keyed writes leave under the document cap (see above). */
export const AGENT_SESSION_DOCUMENT_RESERVE_BYTES = 4 * 1024;
/** The most a session's content (its public view) may weigh, UTF-8 bytes of
 *  its JSON; heavier is `CONTENT_TOO_LARGE`. */
export const AGENT_SESSION_MAX_CONTENT_BYTES = 32 * 1024;
/** Length cap (characters) on a line's product id and sku. */
export const AGENT_SESSION_MAX_LINE_ID_LENGTH = 128;
/** Length cap (characters) on a recorded order id. */
export const AGENT_SESSION_MAX_ORDER_ID_LENGTH = 128;

/** UTF-8 byte length of `text` (lone surrogates count 3, as an encoder replaces them). */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

/** The weight a store measures a session document by: UTF-8 bytes of its JSON. */
export function agentSessionDocumentBytes(session: AgentCheckoutSession): number {
	return utf8ByteLength(JSON.stringify(session));
}

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
/** Length caps (characters) on content strings; longer is `INVALID_REQUEST`. */
export const AGENT_SESSION_MAX_BUYER_FIELD_LENGTH = 256;
export const AGENT_SESSION_MAX_ADDRESS_FIELD_LENGTH = 256;
export const AGENT_SESSION_MAX_COUPON_CODE_LENGTH = 64;
export const AGENT_SESSION_MAX_SHIPPING_METHOD_ID_LENGTH = 128;
export const AGENT_SESSION_MAX_CART_ID_LENGTH = 128;

/** The status rule: no lines → `incomplete`; at least one → `requires_escalation`. */
export function agentSessionStatusForLines(lines: readonly AgentSessionLine[]): AgentSessionStatus {
	return lines.length === 0 ? "incomplete" : "requires_escalation";
}

/** Whether a shopper has redeemed any hand-off link of the session. From then
 *  on the shopper owns the cart: agents may only cancel. */
export function isAgentSessionHandedOff(
	session: Pick<AgentCheckoutSession, "handoffUsedAt" | "redeemedHandoffs">,
): boolean {
	return session.handoffUsedAt !== undefined || session.redeemedHandoffs.length > 0;
}

/** A session that agents may still write to and whose link may still be redeemed. */
export function isAgentSessionOpen(status: AgentSessionStatus): boolean {
	return status === "incomplete" || status === "requires_escalation";
}
