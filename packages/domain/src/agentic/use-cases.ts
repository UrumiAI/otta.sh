import type { Currency } from "../money/cents.js";
import type { OrderId } from "../money/ids.js";
import type { OrderAddress } from "../orders/model.js";
import type { Clock } from "../ports/clock.js";
import type {
	AgentCreateIdempotencyRecord,
	AgentSessionStore,
} from "../ports/agent-session-store.js";
import type {
	AgentHandoffFailure,
	AgentHandoffFinalizeFailure,
	AgentOrderSecretFailure,
	AgentSessionFailure,
	AgentSessionFailureReason,
} from "./errors.js";
import {
	AGENT_HANDOFF_CLAIM_LEASE_MS,
	AGENT_HANDOFF_REENTRY_WINDOW_MS,
	AGENT_SESSION_DOCUMENT_RESERVE_BYTES,
	AGENT_SESSION_MAX_CONTENT_BYTES,
	AGENT_SESSION_MAX_DOCUMENT_BYTES,
	AGENT_SESSION_MAX_LINE_ID_LENGTH,
	AGENT_SESSION_MAX_ORDER_ID_LENGTH,
	agentSessionDocumentBytes,
	isAgentHandoffClaimLive,
	utf8ByteLength,
	AGENT_SESSION_ID_PREFIX,
	AGENT_SESSION_MAX_ADDRESS_FIELD_LENGTH,
	AGENT_SESSION_MAX_BUYER_FIELD_LENGTH,
	AGENT_SESSION_MAX_CART_ID_LENGTH,
	AGENT_SESSION_MAX_COUPON_CODE_LENGTH,
	AGENT_SESSION_MAX_FINGERPRINT_LENGTH,
	AGENT_SESSION_MAX_IDEMPOTENCY_KEY_LENGTH,
	AGENT_SESSION_MAX_LINES,
	AGENT_SESSION_MAX_NETWORK_KEY_LENGTH,
	AGENT_SESSION_MAX_SHIPPING_METHOD_ID_LENGTH,
	AGENT_SESSION_MAX_WRITE_RECORDS,
	AGENT_SESSION_MAX_WRITES,
	AGENT_SESSION_RETENTION_MS,
	AGENT_SESSION_TTL_MS,
	AGENT_SESSION_UNREDEEMED_RETENTION_MS,
	agentSessionId,
	agentSessionStatusForLines,
	isAgentSessionHandedOff,
	isAgentSessionOpen,
	type AgentCheckoutSession,
	type AgentSessionBuyer,
	type AgentSessionId,
	type AgentSessionLine,
	type AgentSessionOperation,
	type AgentSessionQuote,
	type AgentSessionView,
	type AgentSessionWriteKey,
	type AgentSessionWriteRecord,
} from "./model.js";
import type { AgentSessionSecrets } from "./secrets.js";

/**
 * Agent checkout session use-cases (ADR-0047). Pure: the clock, id minting,
 * secret derivation and hashing arrive as deps. Nothing here prices, discounts,
 * taxes or ships: the caller builds the cart and quotes it with the store's own
 * code, and hands the results in as `cartId` and `quote`.
 *
 * Idempotency: every write carries an `Idempotency-Key`. A create's key is
 * scoped to the caller's `networkKey` (no session exists yet to scope it to); a
 * write to an existing session is scoped to that session alone, because the
 * unguessable session id is already the bearer credential and a retry from
 * another egress network must replay, not apply twice. The same key and
 * fingerprint replay the STORED answer of that write (the session as that write
 * left it), with `order_secret` and the current live hand-off link re-derived
 * and checked against their stored hashes; a different fingerprint is
 * `IDEMPOTENCY_KEY_REUSED`.
 *
 * Every result carries an {@link AgentSessionView}, never the stored document.
 *
 * Hand-off links: a link is stable. Create (with lines) issues generation 1;
 * replace and complete keep an unused link, because redemption always reads the
 * current session. A new generation is minted by an explicit
 * {@link issueAgentHandoff}, or by a fresh replace or complete whose unused
 * link no longer re-derives under the current server key (a key rotation).
 *
 * Redeeming a link is two steps, so a failure in between never kills it:
 * {@link claimAgentHandoff} leases the link (agent writes and other redeems wait
 * `HANDOFF_IN_PROGRESS`), the caller builds the shopper's cart, then
 * {@link finalizeAgentHandoff} records use and cart in one compare-and-set (or
 * {@link releaseAgentHandoffClaim} gives the claim up). A lapsed lease lets the
 * same token claim again; a finalized link re-enters its cart for a short window.
 *
 * Hand-off is terminal for the agent: once a shopper's claim finalizes, replace,
 * complete and issue_handoff are refused `SESSION_HANDED_OFF` (the shopper owns
 * the cart; a second link could be paid twice). Cancel stays, and the checkout
 * that places the order calls {@link recordAgentSessionOrder}.
 *
 * Retention: a session (or create record) at or past its `purgeAt` answers
 * nothing — not found to reads and writes, `IDEMPOTENCY_KEY_EXPIRED` to a create
 * replay — even before the sweep deletes it. After the sweep a create key is
 * fresh again.
 */

export interface AgentSessionLimits {
	/**
	 * Store-wide live slots: a session holds one from its insert until its
	 * `expiresAt` (canceled or handed off included), unless a recorded order
	 * frees it earlier. HARD: the store takes the slot by compare-and-set before
	 * it writes the session ({@link AgentSessionStore.insert}); adapters must keep
	 * it race-safe, as the contract's interleaving and crash tests prove. Each
	 * insert may probe every slot when the pool is nearly full, so the slot count
	 * is also a per-create read cost (see the spec).
	 */
	maxLiveSessions: number;
	/** Live slots one network key may hold at once: HARD, like `maxLiveSessions`,
	 *  so one network can never take the whole store-wide pool. */
	maxLivePerNetwork: number;
	/** Creates one network may make within `createWindowMs`. SOFT: counted
	 *  before the insert, so racing creates from one network can overshoot it. */
	maxCreatesPerNetwork: number;
	createWindowMs: number;
	/** Per-line quantity cap (the plugin passes its `CART_LINE_MAX_QTY`). */
	maxLineQuantity: number;
}

export const DEFAULT_AGENT_SESSION_LIMITS: AgentSessionLimits = {
	maxLiveSessions: 500,
	maxLivePerNetwork: 50,
	maxCreatesPerNetwork: 60,
	createWindowMs: 60 * 60 * 1000,
	maxLineQuantity: 10_000,
};

export interface AgentSessionDeps {
	store: AgentSessionStore;
	clock: Clock;
	/** Mints session ids and derives, hashes and compares the session's secrets. */
	secrets: AgentSessionSecrets;
	limits?: Partial<AgentSessionLimits>;
}

/** Everything a create or a full replacement (UCP `PUT`) sets. An absent field is cleared. */
export interface AgentSessionContent {
	currency: Currency;
	lines: AgentSessionLine[];
	buyer?: AgentSessionBuyer;
	destination?: OrderAddress;
	shippingMethodId?: string;
	couponCode?: string;
	/** The cart the caller built and quoted on. */
	cartId?: string;
	/** The caller's preview of the cart's totals; absent when not quoted. */
	quote?: AgentSessionQuote;
}

/**
 * Identifies a keyed write to an existing session: its `Idempotency-Key` (1 to
 * 255 characters) and the caller's fingerprint of the body (at most 128).
 */
export interface AgentSessionKeyedRequest {
	idempotencyKey: string;
	fingerprint: string;
}

/** A keyed create: the key is scoped to the caller's network, since no session exists yet. */
export interface AgentSessionCreateRequest extends AgentSessionKeyedRequest {
	/** The caller's rate-limit key (opaque, e.g. a hash of the client IP; at most 128). */
	networkKey: string;
}

/**
 * A write's answer. `session` is the session as this write (or, on a replay, the
 * replayed write) left it, so after later writes it can lag.
 * `handoffToken` is NOT from that time: it is always the session's CURRENT live
 * link, re-derived now. The site MUST build `continue_url` only from the
 * returned `handoffToken`, never from any field of `session`.
 */
export type AgentSessionWriteResult =
	| {
			ok: true;
			/** True when this answers an earlier write with the same key (see
			 *  {@link createAgentSession} for a racing create's loser). */
			replayed: boolean;
			/** The session as this write (or the replayed one) left it. */
			session: AgentSessionView;
			/** The raw token of the session's CURRENT live link; absent when it has none. */
			handoffToken?: string;
	  }
	| AgentSessionFailure;

/** A create's answer; `session` and `handoffToken` as in {@link AgentSessionWriteResult}. */
export type CreateAgentSessionResult =
	| {
			ok: true;
			replayed: boolean;
			session: AgentSessionView;
			/** The raw `order_secret`; the same on every replay. */
			orderSecret: string;
			/** The raw token of the session's CURRENT live link; absent when it has none. */
			handoffToken?: string;
	  }
	| AgentSessionFailure;

const MAX_CAS_ATTEMPTS = 5;

function limitsOf(deps: Pick<AgentSessionDeps, "limits">): AgentSessionLimits {
	return { ...DEFAULT_AGENT_SESSION_LIMITS, ...deps.limits };
}

function fail(reason: AgentSessionFailureReason): AgentSessionFailure {
	return { ok: false, reason };
}

function validateContent(
	content: AgentSessionContent,
	limits: AgentSessionLimits,
): AgentSessionFailure | null {
	if (content.lines.length > AGENT_SESSION_MAX_LINES) return fail("TOO_MANY_LINES");
	const skus = new Set<string>();
	for (const line of content.lines) {
		if (
			line.productId.length === 0 ||
			line.sku.length === 0 ||
			longerThan(line.productId, AGENT_SESSION_MAX_LINE_ID_LENGTH) ||
			longerThan(line.sku, AGENT_SESSION_MAX_LINE_ID_LENGTH)
		) {
			return fail("INVALID_REQUEST");
		}
		if (
			!Number.isSafeInteger(line.quantity) ||
			line.quantity < 1 ||
			line.quantity > limits.maxLineQuantity
		) {
			return fail("INVALID_QUANTITY");
		}
		if (skus.has(line.sku)) return fail("DUPLICATE_SKU");
		skus.add(line.sku);
	}
	if (contentTooLong(content)) return fail("INVALID_REQUEST");
	if (utf8ByteLength(JSON.stringify(content)) > AGENT_SESSION_MAX_CONTENT_BYTES) {
		return fail("CONTENT_TOO_LARGE");
	}
	const quote = content.quote;
	if (quote !== undefined) {
		if (quote.currency !== content.currency) return fail("QUOTE_CURRENCY_MISMATCH");
		if ((quote.fulfillment === null || quote.tax === null) && quote.total !== null) {
			return fail("QUOTE_PARTIAL_TOTAL");
		}
	}
	return null;
}

function longerThan(value: string | null | undefined, max: number): boolean {
	return typeof value === "string" && value.length > max;
}

/** Whether any content string is over its cap. */
function contentTooLong(content: AgentSessionContent): boolean {
	const buyer = content.buyer;
	if (
		buyer !== undefined &&
		[buyer.email, buyer.firstName, buyer.lastName, buyer.phone].some((v) =>
			longerThan(v, AGENT_SESSION_MAX_BUYER_FIELD_LENGTH),
		)
	) {
		return true;
	}
	const d = content.destination;
	if (
		d !== undefined &&
		[d.name, d.line1, d.line2, d.city, d.region, d.postalCode, d.country, d.email, d.phone].some(
			(v) => longerThan(v, AGENT_SESSION_MAX_ADDRESS_FIELD_LENGTH),
		)
	) {
		return true;
	}
	return (
		longerThan(content.couponCode, AGENT_SESSION_MAX_COUPON_CODE_LENGTH) ||
		longerThan(content.shippingMethodId, AGENT_SESSION_MAX_SHIPPING_METHOD_ID_LENGTH) ||
		longerThan(content.cartId, AGENT_SESSION_MAX_CART_ID_LENGTH)
	);
}

/** Refuse a missing or over-long key, an empty or over-long network key or fingerprint. */
function refuseRequest(
	request: AgentSessionKeyedRequest,
	networkKey?: string,
): AgentSessionFailure | null {
	if (request.idempotencyKey.length === 0) return fail("IDEMPOTENCY_KEY_MISSING");
	if (
		request.idempotencyKey.length > AGENT_SESSION_MAX_IDEMPOTENCY_KEY_LENGTH ||
		request.fingerprint.length === 0 ||
		request.fingerprint.length > AGENT_SESSION_MAX_FINGERPRINT_LENGTH ||
		(networkKey !== undefined &&
			(networkKey.length === 0 || networkKey.length > AGENT_SESSION_MAX_NETWORK_KEY_LENGTH))
	) {
		return fail("INVALID_REQUEST");
	}
	return null;
}

/** Session-scoped: a key matches on the key alone, whatever network sent it. */
function sameKey(a: AgentSessionWriteKey, request: AgentSessionKeyedRequest): boolean {
	return a.key === request.idempotencyKey;
}

/**
 * The public projection, built by explicit pick (an allowlist): a field added to
 * the stored document never reaches a result unless it is added here. Accepts a
 * stored answer too (already a view), so a replay re-projects it.
 */
function viewOf(session: AgentCheckoutSession | AgentSessionView): AgentSessionView {
	const handedOff = "handedOff" in session ? session.handedOff : isAgentSessionHandedOff(session);
	const view: AgentSessionView = {
		id: session.id,
		status: session.status,
		currency: session.currency,
		lines: session.lines,
		expiresAt: session.expiresAt,
		handedOff,
	};
	if (session.buyer !== undefined) view.buyer = session.buyer;
	if (session.destination !== undefined) view.destination = session.destination;
	if (session.shippingMethodId !== undefined) view.shippingMethodId = session.shippingMethodId;
	if (session.couponCode !== undefined) view.couponCode = session.couponCode;
	if (session.quote !== undefined) view.quote = session.quote;
	if (session.orderId !== undefined) view.orderId = session.orderId;
	return structuredClone(view);
}

/** The content fields of a session, rebuilt from `content` so an absent field is cleared. */
function applyContent(
	base: AgentCheckoutSession,
	content: AgentSessionContent,
	updatedAt: string,
): AgentCheckoutSession {
	const {
		buyer: _buyer,
		destination: _destination,
		shippingMethodId: _shippingMethodId,
		couponCode: _couponCode,
		cartId: _cartId,
		quote: _quote,
		...rest
	} = base;
	const next: AgentCheckoutSession = {
		...rest,
		currency: content.currency,
		lines: content.lines.map((l) => ({ ...l })),
		status: agentSessionStatusForLines(content.lines),
		updatedAt,
	};
	if (content.buyer !== undefined) next.buyer = { ...content.buyer };
	if (content.destination !== undefined) next.destination = { ...content.destination };
	if (content.shippingMethodId !== undefined) next.shippingMethodId = content.shippingMethodId;
	if (content.couponCode !== undefined) next.couponCode = content.couponCode;
	if (content.cartId !== undefined) next.cartId = content.cartId;
	if (content.quote !== undefined) next.quote = { ...content.quote };
	return next;
}

/**
 * Point the session at the next link generation. A redeemed current link moves
 * to `redeemedHandoffs` (so it still answers "used"); an unused one just dies.
 */
async function mintLinkGeneration(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession,
): Promise<AgentCheckoutSession> {
	const { handoffTokenHash, handoffUsedAt, ...rest } = session;
	const redeemedHandoffs =
		handoffTokenHash !== undefined && handoffUsedAt !== undefined
			? [...session.redeemedHandoffs, { tokenHash: handoffTokenHash, usedAt: handoffUsedAt }]
			: session.redeemedHandoffs;
	const linkGeneration = session.linkGeneration + 1;
	const token = await deps.secrets.derive("handoff", session.id, linkGeneration);
	return {
		...rest,
		linkGeneration,
		handoffTokenHash: await deps.secrets.hash(token),
		redeemedHandoffs,
	};
}

/** Keep an existing link; mint the first one for a session that has lines and none yet. */
async function ensureLink(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession,
): Promise<AgentCheckoutSession> {
	if (session.lines.length === 0 || session.linkGeneration > 0) return session;
	return mintLinkGeneration(deps, session);
}

function isExpired(session: { expiresAt: string }, now: string): boolean {
	return now >= session.expiresAt;
}

/** Whether retention is over: the sweep may delete it any moment, so nothing answers from it. */
function isPurgeDue(item: { purgeAt: string }, now: string): boolean {
	return now >= item.purgeAt;
}

/** The session, or null when there is none or its retention is over (purge-due). */
async function readSession(
	store: AgentSessionStore,
	id: AgentSessionId,
	now: string,
): Promise<AgentCheckoutSession | null> {
	const session = await store.get(id);
	return session === null || isPurgeDue(session, now) ? null : session;
}

/** Whether a re-derived `secret` hashes to `storedHash` (it would verify). */
async function matchesStored(
	deps: Pick<AgentSessionDeps, "secrets">,
	secret: string,
	storedHash: string | undefined,
): Promise<boolean> {
	if (storedHash === undefined) return false;
	return deps.secrets.constantTimeEqual(await deps.secrets.hash(secret), storedHash);
}

/**
 * The raw token of the session's current link, if a shopper could redeem it now
 * (`token` absent if not). Re-derived and checked against the stored hash; a
 * mismatch (the server key changed) is `SECRET_KEY_MISMATCH`, never a token that
 * would not redeem.
 */
async function liveHandoffToken(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession,
	now: string,
): Promise<{ ok: true; token?: string } | AgentSessionFailure> {
	if (
		!isAgentSessionOpen(session.status) ||
		session.lines.length === 0 ||
		session.linkGeneration === 0 ||
		session.handoffUsedAt !== undefined ||
		isExpired(session, now)
	) {
		return { ok: true };
	}
	const token = await deps.secrets.derive("handoff", session.id, session.linkGeneration);
	if (!(await matchesStored(deps, token, session.handoffTokenHash))) {
		return fail("SECRET_KEY_MISMATCH");
	}
	return { ok: true, token };
}

/** The session's `order_secret`, re-derived and checked against the stored hash. */
async function rederivedOrderSecret(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession,
): Promise<{ ok: true; secret: string } | AgentSessionFailure> {
	const secret = await deps.secrets.derive("order", session.id);
	if (!(await matchesStored(deps, secret, session.orderSecretHash))) {
		return fail("SECRET_KEY_MISMATCH");
	}
	return { ok: true, secret };
}

/** The per-network create cap (SOFT) and an early count of the live cap (the
 *  store enforces the live and stored caps again, atomically, at insert). */
async function admitCreate(
	deps: AgentSessionDeps,
	networkKey: string,
	now: Date,
): Promise<AgentSessionFailure | null> {
	const limits = limitsOf(deps);
	const since = new Date(now.getTime() - limits.createWindowMs).toISOString();
	if ((await deps.store.countCreatedSince(networkKey, since)) >= limits.maxCreatesPerNetwork) {
		return fail("RATE_LIMITED");
	}
	// An early refusal from the slots actually held (canceled sessions' and
	// over-cap ones' included), so a full pool costs no slot probe. The insert
	// re-checks atomically.
	const held = await deps.store.occupiedSlots(networkKey, now.toISOString());
	if (held.store >= limits.maxLiveSessions || held.network >= limits.maxLivePerNetwork) {
		return fail("TOO_MANY_SESSIONS");
	}
	return null;
}

type CreateInput = AgentSessionCreateRequest & { content: AgentSessionContent };

/**
 * Create a session (UCP `POST /checkout-sessions`). The id's suffix comes from
 * the secrets port. A replay (same network, key and fingerprint) answers the
 * session as created, with the same `order_secret` and the current live link.
 * A create whose key was recorded but whose session was never written (a crash
 * in between) is finished by its replay, under the recorded id, after the same
 * validation and caps as a fresh create, after it adopts the record.
 *
 * Accepted hazard (ADR-0047): the create key is scoped to the caller's network,
 * so a create retried from a different egress network is a fresh create and may
 * leave a duplicate session.
 *
 * Racing creates on one key make one session, but `replayed` can be wrong for
 * the original requester: a racer that read the record before the session was
 * written takes the orphan path and may insert first, so the original requester
 * loses the insert and is answered `replayed: true`. The session, secret and
 * link it gets are the right ones.
 */
export async function createAgentSession(
	deps: AgentSessionDeps,
	input: CreateInput,
): Promise<CreateAgentSessionResult> {
	const malformed = refuseRequest(input, input.networkKey);
	if (malformed !== null) return malformed;
	const recorded = await deps.store.getIdempotency(input.networkKey, input.idempotencyKey);
	if (recorded !== null) return createFromRecord(deps, input, recorded);
	// (A replay must not be refused by today's content rules, so validation
	// comes after the record lookup.)

	const refused = validateContent(input.content, limitsOf(deps));
	if (refused !== null) return refused;
	const now = deps.clock.now();
	const capped = await admitCreate(deps, input.networkKey, now);
	if (capped !== null) return capped;

	const id = agentSessionId(`${AGENT_SESSION_ID_PREFIX}${deps.secrets.mintId()}`);
	const attemptId = deps.secrets.mintId();
	const put = await deps.store.putIdempotency({
		networkKey: input.networkKey,
		key: input.idempotencyKey,
		fingerprint: input.fingerprint,
		sessionId: id,
		createdAt: now.toISOString(),
		attemptId,
		purgeAt: unredeemedPurgeAt(now),
	});
	if (!put.stored) return createFromRecord(deps, input, put.existing);
	return insertCreated(deps, input, id, now, attemptId);
}

/** Answer a create whose key is already recorded: replay, refuse, or finish an orphan. */
async function createFromRecord(
	deps: AgentSessionDeps,
	input: CreateInput,
	record: AgentCreateIdempotencyRecord,
): Promise<CreateAgentSessionResult> {
	if (record.fingerprint !== input.fingerprint) return fail("IDEMPOTENCY_KEY_REUSED");
	const now = deps.clock.now();
	// Retention is over for the record (and so for any session it made): it
	// answers no replay and finishes no orphan until the sweep deletes it.
	if (isPurgeDue(record, now.toISOString())) return fail("IDEMPOTENCY_KEY_EXPIRED");
	const existing = await deps.store.get(record.sessionId);
	if (existing !== null) {
		return isPurgeDue(existing, now.toISOString())
			? fail("IDEMPOTENCY_KEY_EXPIRED")
			: replayCreate(deps, existing, input);
	}
	const refused = validateContent(input.content, limitsOf(deps));
	if (refused !== null) return refused;
	const capped = await admitCreate(deps, record.networkKey, now);
	if (capped !== null) return capped;
	// Adopt the record first: from here only this attempt may release it (so a
	// racer whose insert was refused cannot delete it under our session), and its
	// purge moves out to the session's own. Lost to a release or another adopter:
	// retryable, and the retry starts from what is stored then.
	const attemptId = deps.secrets.mintId();
	const adopted = await deps.store.adoptIdempotency(record.networkKey, record.key, {
		sessionId: record.sessionId,
		attemptId,
		purgeAt: unredeemedPurgeAt(now),
		now: now.toISOString(),
	});
	// Lost, or busy (another attempt's insert of this session is in flight).
	if (adopted !== "adopted") return fail("WRITE_CONFLICT");
	return insertCreated(
		deps,
		{ ...input, networkKey: record.networkKey },
		record.sessionId,
		now,
		attemptId,
	);
}

async function replayCreate(
	deps: AgentSessionDeps,
	session: AgentCheckoutSession,
	input: CreateInput,
): Promise<CreateAgentSessionResult> {
	const record = session.writes.find((w) => w.operation === "create" && sameKey(w, input));
	if (record === undefined) return fail("IDEMPOTENCY_KEY_EXPIRED");
	const orderSecret = await rederivedOrderSecret(deps, session);
	if (!orderSecret.ok) return orderSecret;
	const link = await liveHandoffToken(deps, session, deps.clock.now().toISOString());
	if (!link.ok) return link;
	const result: CreateAgentSessionResult = {
		ok: true,
		replayed: true,
		session: viewOf(record.answer),
		orderSecret: orderSecret.secret,
	};
	if (link.token !== undefined) result.handoffToken = link.token;
	return result;
}

/** A never-handed-off session's purge time: its expiry plus the short retention. */
function unredeemedPurgeAt(createdAt: Date): string {
	return new Date(
		createdAt.getTime() + AGENT_SESSION_TTL_MS + AGENT_SESSION_UNREDEEMED_RETENTION_MS,
	).toISOString();
}

/**
 * Insert the created session under `id`, or replay it if a racer inserted first.
 * The store admits it under the live caps; a refused insert releases the create
 * record by `attemptId` (the attempt that put or adopted it), so the key is free
 * again and no orphan record is left behind. A record another attempt adopted
 * in between is not this attempt's to release, and stays.
 */
async function insertCreated(
	deps: AgentSessionDeps,
	input: CreateInput,
	id: AgentSessionId,
	now: Date,
	attemptId: string,
): Promise<CreateAgentSessionResult> {
	const nowIso = now.toISOString();
	const orderSecret = await deps.secrets.derive("order", id);
	const base: AgentCheckoutSession = {
		id,
		revision: 1,
		status: "incomplete",
		currency: input.content.currency,
		lines: [],
		orderSecretHash: await deps.secrets.hash(orderSecret),
		linkGeneration: 0,
		redeemedHandoffs: [],
		channel: "other",
		networkKey: input.networkKey,
		createdAt: nowIso,
		updatedAt: nowIso,
		expiresAt: new Date(now.getTime() + AGENT_SESSION_TTL_MS).toISOString(),
		purgeAt: unredeemedPurgeAt(now),
		writes: [],
		retiredWriteKeys: [],
	};
	const session = await ensureLink(deps, applyContent(base, input.content, nowIso));
	session.writes = [
		{
			key: input.idempotencyKey,
			operation: "create",
			fingerprint: input.fingerprint,
			revision: 1,
			answer: viewOf(session),
		},
	];
	const limits = limitsOf(deps);
	const written = await deps.store.insert(session, {
		now: nowIso,
		maxLive: limits.maxLiveSessions,
		maxLivePerNetwork: limits.maxLivePerNetwork,
	});
	if (!written.ok) {
		if (written.reason === "exists") return replayCreate(deps, written.current, input);
		const released = await deps.store.releaseIdempotency(
			input.networkKey,
			input.idempotencyKey,
			attemptId,
			nowIso,
		);
		// Busy: another attempt's insert of this session is in flight, so the key
		// may yet answer a session; retry rather than report the refusal.
		if (released === "busy") return fail("WRITE_CONFLICT");
		return fail(written.reason === "capacity" ? "TOO_MANY_SESSIONS" : "CONTENT_TOO_LARGE");
	}
	// The record may have been released before this insert took its slot (so the
	// release saw nothing in flight): put it back, insert-if-absent, so a replay of
	// the key answers this session. If another create took the key since, it keeps it.
	await deps.store.putIdempotency({
		networkKey: input.networkKey,
		key: input.idempotencyKey,
		fingerprint: input.fingerprint,
		sessionId: id,
		attemptId,
		createdAt: nowIso,
		purgeAt: written.session.purgeAt,
	});
	const link = await liveHandoffToken(deps, written.session, nowIso);
	if (!link.ok) return link;
	const result: CreateAgentSessionResult = {
		ok: true,
		replayed: false,
		session: viewOf(written.session),
		orderSecret,
	};
	if (link.token !== undefined) result.handoffToken = link.token;
	return result;
}

/** A mutation's outcome: the next session, "nothing to change" (only the key is
 *  recorded), or a refusal. */
type Mutation =
	| { ok: true; session: AgentCheckoutSession }
	| { ok: true; unchanged: true }
	| AgentSessionFailure;

/**
 * A keyed write to an existing session: replay-or-refuse on the key recorded on
 * the session (session-scoped: whatever network sends it); refuse a key whose
 * record was evicted; else apply `mutate` and compare-and-set, retrying on a lost
 * race. `mutate` runs only for a fresh request, so validation never blocks a true
 * replay.
 *
 * Key rotation: a REPLAY whose live link no longer re-derives fails closed
 * (`SECRET_KEY_MISMATCH`). A FRESH write whose next session keeps an unused link
 * that no longer re-derives mints a new link generation (under the current key)
 * in the same write and returns it; the old link dies, as any replaced link does.
 *
 * `cancel` is exempt from the lifetime write cap, so a session can always be
 * canceled. A cancel of an already-canceled session (`unchanged`) still records
 * its key (so reusing it with another body is `IDEMPOTENCY_KEY_REUSED`) and
 * changes nothing else; at the cap it answers without recording, so the exemption
 * cannot grow the session without bound.
 */
async function keyedWrite(
	deps: AgentSessionDeps,
	sessionId: AgentSessionId,
	request: AgentSessionKeyedRequest,
	operation: AgentSessionOperation,
	mutate: (session: AgentCheckoutSession, now: string) => Promise<Mutation>,
): Promise<AgentSessionWriteResult> {
	const malformed = refuseRequest(request);
	if (malformed !== null) return malformed;
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		const now = deps.clock.now().toISOString();
		const current = await readSession(deps.store, sessionId, now);
		if (current === null) return fail("SESSION_NOT_FOUND");
		const prior = current.writes.find((w) => sameKey(w, request));
		if (prior !== undefined) {
			if (prior.operation !== operation || prior.fingerprint !== request.fingerprint) {
				return fail("IDEMPOTENCY_KEY_REUSED");
			}
			return answer(deps, current, prior.answer, true, now);
		}
		if (current.retiredWriteKeys.some((k) => sameKey(k, request))) {
			return fail("IDEMPOTENCY_KEY_EXPIRED");
		}
		// A shopper is redeeming the link right now: every agent write waits.
		// A shopper is redeeming the link right now: agent writes wait, except a
		// cancel (always allowed: the claim's finalize then fails `canceled`).
		if (operation !== "cancel" && isAgentHandoffClaimLive(current, now)) {
			return fail("HANDOFF_IN_PROGRESS");
		}
		const atCap =
			current.writes.length + current.retiredWriteKeys.length >= AGENT_SESSION_MAX_WRITES;
		if (atCap && operation !== "cancel") return fail("WRITE_LIMIT_REACHED");
		const mutated = await mutate(current, now);
		if (!mutated.ok) return mutated;
		if ("unchanged" in mutated && atCap) return answer(deps, current, current, false, now);

		const revision = current.revision + 1;
		let next: AgentCheckoutSession = {
			...("unchanged" in mutated ? current : mutated.session),
			revision,
		};
		// A lapsed, unfinalized claim dies with any agent write except a cancel (a
		// cancel already makes its finalize fail): its redeem can no longer
		// finalize a cart built from the session as it was.
		if (next.handoffUsedAt === undefined && operation !== "cancel") delete next.handoffClaim;
		let link = await liveHandoffToken(deps, next, now);
		if (!link.ok) {
			// The unused link no longer re-derives (the key rotated): replace it.
			next = { ...(await mintLinkGeneration(deps, next)), revision };
			link = await liveHandoffToken(deps, next, now);
			if (!link.ok) return link;
		}
		const record: AgentSessionWriteRecord = {
			key: request.idempotencyKey,
			operation,
			fingerprint: request.fingerprint,
			revision,
			answer: viewOf(next),
		};
		const fitted = withRecord(next, current, record, operation === "cancel");
		if (fitted === null) return fail("WRITE_LIMIT_REACHED");
		next = fitted;
		const written = await deps.store.write(next, current.revision);
		if (!written.ok && written.reason === "too_large") return fail("WRITE_LIMIT_REACHED");
		if (written.ok) {
			const result: AgentSessionWriteResult = {
				ok: true,
				replayed: false,
				session: viewOf(written.session),
			};
			if (link.token !== undefined) result.handoffToken = link.token;
			return result;
		}
	}
	return fail("WRITE_CONFLICT");
}

/**
 * `next` with `record` appended to the kept write records, evicting the oldest
 * (their keys retire, so a late replay is `IDEMPOTENCY_KEY_EXPIRED`) past
 * {@link AGENT_SESSION_MAX_WRITE_RECORDS}, and then while the document is over
 * its byte budget: {@link AGENT_SESSION_MAX_DOCUMENT_BYTES} less the reserve, or
 * the full cap for a cancel (the reserve exists so a cancel always fits). The
 * newest record is never evicted; null when even it alone does not fit.
 */
function withRecord(
	next: AgentCheckoutSession,
	current: AgentCheckoutSession,
	record: AgentSessionWriteRecord,
	isCancel: boolean,
): AgentCheckoutSession | null {
	const budget = isCancel
		? AGENT_SESSION_MAX_DOCUMENT_BYTES
		: AGENT_SESSION_MAX_DOCUMENT_BYTES - AGENT_SESSION_DOCUMENT_RESERVE_BYTES;
	const writes = [...current.writes, record];
	const retired = [...current.retiredWriteKeys];
	const evict = (): void => {
		const oldest = writes.shift();
		if (oldest !== undefined) retired.push({ key: oldest.key });
	};
	while (writes.length > AGENT_SESSION_MAX_WRITE_RECORDS) evict();
	const build = (): AgentCheckoutSession => ({
		...next,
		writes: [...writes],
		retiredWriteKeys: [...retired],
	});
	let fitted = build();
	while (agentSessionDocumentBytes(fitted) > budget && writes.length > 1) {
		evict();
		fitted = build();
	}
	return agentSessionDocumentBytes(fitted) > budget ? null : fitted;
}

/** Answer `shown` (the session as some write left it) with `current`'s live link. */
async function answer(
	deps: AgentSessionDeps,
	current: AgentCheckoutSession,
	shown: AgentCheckoutSession | AgentSessionView,
	replayed: boolean,
	now: string,
): Promise<AgentSessionWriteResult> {
	const link = await liveHandoffToken(deps, current, now);
	if (!link.ok) return link;
	const result: AgentSessionWriteResult = { ok: true, replayed, session: viewOf(shown) };
	if (link.token !== undefined) result.handoffToken = link.token;
	return result;
}

/** Why an agent may not change the session's content or link now, or null. */
function refuseUnwritable(session: AgentCheckoutSession, now: string): AgentSessionFailure | null {
	if (!isAgentSessionOpen(session.status)) return fail("SESSION_CLOSED");
	if (isExpired(session, now)) return fail("SESSION_EXPIRED");
	if (isAgentSessionHandedOff(session)) return fail("SESSION_HANDED_OFF");
	return null;
}

/**
 * Replace the session's content (UCP `PUT`: full replacement). An unused link
 * stays valid. A session left with no lines keeps its link, which redeems again
 * once it has lines. A session whose link was redeemed is `SESSION_HANDED_OFF`.
 */
export async function replaceAgentSession(
	deps: AgentSessionDeps,
	input: AgentSessionKeyedRequest & { sessionId: AgentSessionId; content: AgentSessionContent },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "replace", async (session, now) => {
		const refused =
			refuseUnwritable(session, now) ?? validateContent(input.content, limitsOf(deps));
		if (refused !== null) return refused;
		return { ok: true, session: await ensureLink(deps, applyContent(session, input.content, now)) };
	});
}

/**
 * Read a session, as its public {@link AgentSessionView}, with its current live
 * link's token (for `continue_url`) when that link is unused, unexpired and
 * re-derives under the current server key; otherwise no token (a read never
 * fails on a rotated key).
 */
export async function getAgentSession(
	deps: Pick<AgentSessionDeps, "store" | "clock" | "secrets">,
	input: { sessionId: AgentSessionId },
): Promise<{ ok: true; session: AgentSessionView; handoffToken?: string } | AgentSessionFailure> {
	const now = deps.clock.now().toISOString();
	const session = await readSession(deps.store, input.sessionId, now);
	if (session === null) return fail("SESSION_NOT_FOUND");
	const link = await liveHandoffToken(deps, session, now);
	const result: { ok: true; session: AgentSessionView; handoffToken?: string } = {
		ok: true,
		session: viewOf(session),
	};
	if (link.ok && link.token !== undefined) result.handoffToken = link.token;
	return result;
}

/**
 * Cancel the session. Its hand-off link is dead from here on. Releasing the
 * cart's holds is the caller's job (it owns the cart). Allowed after a hand-off
 * (the agent ends its session; the shopper's rebuilt cart is not touched).
 * Canceling an already canceled session answers it as it is and records only the
 * key; an expired session may still be canceled, and so may one at its lifetime
 * write cap.
 */
export async function cancelAgentSession(
	deps: AgentSessionDeps,
	input: AgentSessionKeyedRequest & { sessionId: AgentSessionId },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "cancel", async (session, now) => {
		if (session.status === "completed") return fail("SESSION_CLOSED");
		if (session.status === "canceled") return { ok: true, unchanged: true };
		// A canceled session keeps only the short retention, unless it was handed
		// off: then its purge (expiresAt + 1 h; there is no order, else it could
		// not be canceled) is kept as it is.
		const from = now > session.expiresAt ? now : session.expiresAt;
		const purgeAt =
			session.handoffUsedAt !== undefined
				? session.purgeAt
				: new Date(Date.parse(from) + AGENT_SESSION_UNREDEEMED_RETENTION_MS).toISOString();
		return { ok: true, session: { ...session, status: "canceled", updatedAt: now, purgeAt } };
	});
}

/**
 * UCP `complete`. The agent cannot pay, so this never completes: it answers the
 * session in `requires_escalation` with its current live link. A session with no
 * lines is `SESSION_INCOMPLETE`; one whose link was redeemed is
 * `SESSION_HANDED_OFF`.
 */
export async function completeAgentSession(
	deps: AgentSessionDeps,
	input: AgentSessionKeyedRequest & { sessionId: AgentSessionId },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "complete", async (session, now) => {
		const refused = refuseUnwritable(session, now);
		if (refused !== null) return refused;
		if (session.lines.length === 0) return fail("SESSION_INCOMPLETE");
		return {
			ok: true,
			session: await ensureLink(deps, {
				...session,
				status: "requires_escalation",
				updatedAt: now,
			}),
		};
	});
}

/**
 * Explicitly issue a new hand-off link generation for an open session with
 * lines that no shopper has redeemed; the previous link dies. A keyed write like
 * every other: a replay answers the same live link.
 */
export async function issueAgentHandoff(
	deps: AgentSessionDeps,
	input: AgentSessionKeyedRequest & { sessionId: AgentSessionId },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "issue_handoff", async (session, now) => {
		const refused = refuseUnwritable(session, now);
		if (refused !== null) return refused;
		if (session.lines.length === 0) return fail("SESSION_INCOMPLETE");
		return { ok: true, session: await mintLinkGeneration(deps, { ...session, updatedAt: now }) };
	});
}

/** The longest redeemer nonce a claim accepts (characters). */
const MAX_REDEEMER_LENGTH = 256;

/** A claim's pre-check: a refusal, a re-entry for the same browser, or null to claim. */
type RedeemPrecheck = AgentHandoffFailure | { ok: true; reentered: AgentCheckoutSession } | null;

/**
 * How a redeem of `tokenHash` by `redeemerHash` stands on `session` at `now`:
 *  - a finalized link re-enters ONLY for the browser that redeemed it (same
 *    redeemer), within {@link AGENT_HANDOFF_REENTRY_WINDOW_MS}, while open and
 *    with no order; anyone else (the agent holds the token) gets `HANDOFF_USED`;
 *  - a live claim answers `HANDOFF_IN_PROGRESS` to everyone, the claiming
 *    browser included (a second tab or a double click: retry shortly);
 *  - a lapsed, unfinalized claim binds nobody: any browser may claim again (a
 *    lost response, or a move from an in-app webview to Safari, never kills it).
 */
async function precheckRedeem(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession | null,
	tokenHash: string,
	redeemerHash: string,
	now: string,
): Promise<RedeemPrecheck> {
	if (session === null || isPurgeDue(session, now)) return { ok: false, reason: "HANDOFF_INVALID" };
	if (session.handoffTokenHash !== tokenHash) {
		return session.redeemedHandoffs.some((r) => r.tokenHash === tokenHash)
			? { ok: false, reason: "HANDOFF_USED" }
			: { ok: false, reason: "HANDOFF_INVALID" };
	}
	if (session.status === "canceled") return { ok: false, reason: "HANDOFF_CANCELED" };
	const claim = session.handoffClaim;
	const sameBrowser =
		claim !== undefined && deps.secrets.constantTimeEqual(claim.redeemerHash, redeemerHash);
	if (session.handoffUsedAt !== undefined) {
		const reentry =
			sameBrowser &&
			!isExpired(session, now) &&
			session.status !== "completed" &&
			session.orderId === undefined &&
			session.shopperCartId !== undefined &&
			Date.parse(now) < Date.parse(session.handoffUsedAt) + AGENT_HANDOFF_REENTRY_WINDOW_MS;
		if (reentry) return { ok: true, reentered: session };
		// The finalizing browser past expiry: the session is over (no order can be
		// attributed any more); anyone else: the link is used.
		return sameBrowser && isExpired(session, now)
			? { ok: false, reason: "HANDOFF_EXPIRED" }
			: { ok: false, reason: "HANDOFF_USED" };
	}
	if (session.status === "completed") return { ok: false, reason: "HANDOFF_USED" };
	if (isExpired(session, now)) return { ok: false, reason: "HANDOFF_EXPIRED" };
	if (session.lines.length === 0) return { ok: false, reason: "HANDOFF_INCOMPLETE" };
	if (isAgentHandoffClaimLive(session, now)) return { ok: false, reason: "HANDOFF_IN_PROGRESS" };
	return null;
}

/** A {@link claimAgentHandoff} answer. Never shown to the agent: it carries cart ids. */
export type ClaimAgentHandoffResult =
	| {
			ok: true;
			/** A fresh claim: build the shopper's cart, then {@link finalizeAgentHandoff}
			 *  with `claimId` (or {@link releaseAgentHandoffClaim} if that fails). */
			status: "claimed";
			claimId: string;
			/** The claim holds off other redeems and agent writes until here. */
			leaseUntil: string;
			session: AgentSessionView;
			/** The agent's cart, for the redeem to reuse when it still matches. */
			agentCartId?: string;
	  }
	| {
			ok: true;
			/** The SAME browser re-opened a link it finalized moments ago, with no
			 *  order recorded yet: hand it `shopperCartId` again. Writes nothing. The
			 *  caller MUST still check that this cart has not been converted to an
			 *  order (a checkout may have placed it before the order was recorded
			 *  here); if it has, treat the link as used. */
			status: "reentered";
			session: AgentSessionView;
			shopperCartId: string;
			/** When the hand-off finalized (the re-entry window runs from here). */
			handoffUsedAt: string;
	  }
	| AgentHandoffFailure;

/**
 * Step 1 of redeeming a hand-off link (ADR-0047): CLAIM it with a short lease
 * ({@link AGENT_HANDOFF_CLAIM_LEASE_MS}) instead of burning it, so a failure in
 * the cart work that follows never kills the link. `redeemer` is the browser's
 * random nonce (an httpOnly cookie the site sets on the landing page, before any
 * claim; without it the claim is `HANDOFF_REDEEMER_MISSING`); the domain
 * stores and compares only its hash. The link is single-use PER BROWSER: any
 * browser may claim it again after a lapsed, unfinalized claim, but only the
 * browser that finalized it may re-open it, before `expiresAt` and for
 * {@link AGENT_HANDOFF_REENTRY_WINDOW_MS}; nobody else may
 * (see `precheckRedeem` for every answer). Every refusal leaves the session as
 * it was. The store's atomic claim re-checks; if it refuses, the answer comes
 * from re-reading the session, so the pre-check and the claim always agree.
 */
export async function claimAgentHandoff(
	deps: Pick<AgentSessionDeps, "store" | "clock" | "secrets">,
	input: { token: string; redeemer: string },
): Promise<ClaimAgentHandoffResult> {
	// No nonce cookie: retryable; the site reloads its landing page, which sets it.
	if (input.redeemer.length === 0) return { ok: false, reason: "HANDOFF_REDEEMER_MISSING" };
	if (input.token.length === 0 || input.redeemer.length > MAX_REDEEMER_LENGTH) {
		return { ok: false, reason: "HANDOFF_INVALID" };
	}
	const tokenHash = await deps.secrets.hash(input.token);
	const redeemerHash = await deps.secrets.hash(input.redeemer);
	const session = await deps.store.findByHandoffTokenHash(tokenHash);
	const now = deps.clock.now();
	const nowIso = now.toISOString();
	const pre = await precheckRedeem(deps, session, tokenHash, redeemerHash, nowIso);
	if (pre !== null) return reentryOr(pre);
	if (session === null) return { ok: false, reason: "HANDOFF_INVALID" };
	const leaseUntil = new Date(now.getTime() + AGENT_HANDOFF_CLAIM_LEASE_MS).toISOString();
	const claimId = deps.secrets.mintId();
	const claimed = await deps.store.claimHandoff(session.id, {
		tokenHash,
		claimId,
		redeemerHash,
		now: nowIso,
		leaseUntil,
	});
	if (claimed.ok) {
		const result: ClaimAgentHandoffResult = {
			ok: true,
			status: "claimed",
			claimId,
			leaseUntil,
			session: viewOf(claimed.session),
		};
		if (claimed.session.cartId !== undefined) result.agentCartId = claimed.session.cartId;
		return result;
	}
	if (claimed.reason === "too_large") return { ok: false, reason: "HANDOFF_UNAVAILABLE" };
	const again = await precheckRedeem(
		deps,
		await deps.store.get(session.id),
		tokenHash,
		redeemerHash,
		nowIso,
	);
	return again !== null ? reentryOr(again) : { ok: false, reason: CLAIM_REFUSAL[claimed.reason] };
}

function reentryOr(pre: Exclude<RedeemPrecheck, null>): ClaimAgentHandoffResult {
	if (!pre.ok) return pre;
	const s = pre.reentered;
	return {
		ok: true,
		status: "reentered",
		session: viewOf(s),
		shopperCartId: s.shopperCartId ?? "",
		handoffUsedAt: s.handoffUsedAt ?? "",
	};
}

/** The claim's own reason, used when a re-read no longer shows why it refused
 *  (e.g. the session was emptied and refilled between the claim and the read). */
const CLAIM_REFUSAL = {
	not_found: "HANDOFF_INVALID",
	token_mismatch: "HANDOFF_INVALID",
	canceled: "HANDOFF_CANCELED",
	completed: "HANDOFF_USED",
	already_used: "HANDOFF_USED",
	expired: "HANDOFF_EXPIRED",
	incomplete: "HANDOFF_INCOMPLETE",
	claimed: "HANDOFF_IN_PROGRESS",
} as const satisfies Record<string, AgentHandoffFailure["reason"]>;

/**
 * Step 2: FINALIZE a claimed hand-off once the shopper's cart holds its lines.
 * One compare-and-set stamps the link used, records the shopper's cart
 * (`shopperCartId`, never shown to the agent); from here the shopper owns the
 * session. Its retention stays short (expiresAt + 1 h) and its live slots stay
 * held: only an order recorded before `expiresAt` extends it to 30 days. Idempotent: the
 * same claim and cart again answers `replayed: true`. Refused (nothing written):
 * `HANDOFF_CLAIM_LOST` when the claim is no longer the session's or its lease
 * lapsed more than `AGENT_HANDOFF_FINALIZE_GRACE_MS` ago, `HANDOFF_EXPIRED`
 * past `expiresAt`, `HANDOFF_CANCELED` after an agent cancel. Do not hand that
 * cart over then. A failed or empty cart attempt must NOT call this (release).
 */
export async function finalizeAgentHandoff(
	deps: Pick<AgentSessionDeps, "store" | "clock">,
	input: { sessionId: AgentSessionId; claimId: string; cartId: string },
): Promise<
	| { ok: true; replayed: boolean; session: AgentSessionView; shopperCartId: string }
	| AgentHandoffFinalizeFailure
> {
	if (
		input.claimId.length === 0 ||
		input.cartId.length === 0 ||
		input.cartId.length > AGENT_SESSION_MAX_CART_ID_LENGTH
	) {
		return { ok: false, reason: "INVALID_REQUEST" };
	}
	const now = deps.clock.now().toISOString();
	const session = await readSession(deps.store, input.sessionId, now);
	if (session === null) return { ok: false, reason: "SESSION_NOT_FOUND" };
	const done = await deps.store.finalizeHandoff(input.sessionId, {
		claimId: input.claimId,
		cartId: input.cartId,
		now,
		// A hand-off alone keeps the short retention; only a recorded order extends it.
		retainUntil: session.purgeAt,
	});
	if (done.ok) {
		return {
			ok: true,
			replayed: done.replayed,
			session: viewOf(done.session),
			shopperCartId: done.session.shopperCartId ?? input.cartId,
		};
	}
	return { ok: false, reason: FINALIZE_REFUSAL[done.reason] };
}

const FINALIZE_REFUSAL = {
	not_found: "SESSION_NOT_FOUND",
	claim_lost: "HANDOFF_CLAIM_LOST",
	lease_lapsed: "HANDOFF_CLAIM_LOST",
	canceled: "HANDOFF_CANCELED",
	completed: "HANDOFF_USED",
	already_used: "HANDOFF_USED",
	expired: "HANDOFF_EXPIRED",
	too_large: "HANDOFF_UNAVAILABLE",
} as const satisfies Record<string, AgentHandoffFinalizeFailure["reason"]>;

/**
 * Give up a claim before its lease lapses (the cart work failed, or no line
 * could be added): the link may be claimed again at once and agent writes
 * resume. Only that claim, only before it finalized, and never on a session
 * past its retention; `released: false` otherwise (nothing written).
 */
export async function releaseAgentHandoffClaim(
	deps: Pick<AgentSessionDeps, "store" | "clock">,
	input: { sessionId: AgentSessionId; claimId: string },
): Promise<{ ok: true; released: boolean }> {
	const session = await readSession(deps.store, input.sessionId, deps.clock.now().toISOString());
	if (session === null) return { ok: true, released: false };
	return {
		ok: true,
		released: await deps.store.releaseHandoffClaim(input.sessionId, input.claimId),
	};
}

/**
 * Check an `order_secret` against the session's stored hash, in constant time.
 * An unknown session and a wrong secret get the same answer.
 */
export async function verifyAgentOrderSecret(
	deps: Pick<AgentSessionDeps, "store" | "secrets" | "clock">,
	input: { sessionId: AgentSessionId; secret: string },
): Promise<{ ok: true; session: AgentSessionView } | AgentOrderSecretFailure> {
	const hash = await deps.secrets.hash(input.secret);
	const session = await readSession(deps.store, input.sessionId, deps.clock.now().toISOString());
	if (session === null || input.secret.length === 0) {
		return { ok: false, reason: "ORDER_SECRET_INVALID" };
	}
	return deps.secrets.constantTimeEqual(hash, session.orderSecretHash)
		? { ok: true, session: viewOf(session) }
		: { ok: false, reason: "ORDER_SECRET_INVALID" };
}

/** A {@link recordAgentSessionOrder} answer. `replayed` when this order was already recorded. */
export type RecordAgentSessionOrderResult =
	| { ok: true; replayed: boolean; session: AgentSessionView }
	| AgentSessionFailure;

/**
 * Record the order a redeemed hand-off placed, and complete the session
 * (ADR-0047, the plugin increment's precondition). One compare-and-set moves an
 * open session that has had a link redeemed to `completed` with `orderId` (and
 * `shopperCartId`, the cart the order was placed from, when given). Not a keyed write:
 * the checkout that placed the order calls it, and it is idempotent by
 * construction. The same order again answers `replayed: true` and writes
 * nothing; a different order is `ORDER_ALREADY_RECORDED`; a session nobody
 * redeemed is `HANDOFF_NOT_REDEEMED`; a canceled one is `SESSION_CLOSED`.
 * Attribution is for orders placed before `expiresAt`: from then on a new order
 * is `SESSION_EXPIRED` (a replay of the recorded one still answers). The order
 * moves the session (and its create records) to the 30-day retention and frees
 * its live slots.
 */
export async function recordAgentSessionOrder(
	deps: Pick<AgentSessionDeps, "store" | "clock">,
	input: { sessionId: AgentSessionId; orderId: OrderId; cartId?: string },
): Promise<RecordAgentSessionOrderResult> {
	if (
		input.orderId.length === 0 ||
		input.orderId.length > AGENT_SESSION_MAX_ORDER_ID_LENGTH ||
		(input.cartId !== undefined &&
			(input.cartId.length === 0 || input.cartId.length > AGENT_SESSION_MAX_CART_ID_LENGTH))
	) {
		return fail("INVALID_REQUEST");
	}
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		const current = await readSession(deps.store, input.sessionId, deps.clock.now().toISOString());
		if (current === null) return fail("SESSION_NOT_FOUND");
		if (current.orderId !== undefined) {
			return current.orderId === input.orderId
				? { ok: true, replayed: true, session: viewOf(current) }
				: fail("ORDER_ALREADY_RECORDED");
		}
		if (!isAgentSessionOpen(current.status)) return fail("SESSION_CLOSED");
		if (!isAgentSessionHandedOff(current)) return fail("HANDOFF_NOT_REDEEMED");
		// Attribution covers orders placed while the session is unexpired (24 h).
		const now = deps.clock.now().toISOString();
		if (isExpired(current, now)) return fail("SESSION_EXPIRED");
		const next: AgentCheckoutSession = {
			...current,
			status: "completed",
			orderId: input.orderId,
			updatedAt: now,
			// An order keeps the session (and, in the store, its create records) for
			// the 30-day retention, and frees its live slots.
			purgeAt: new Date(Date.parse(current.createdAt) + AGENT_SESSION_RETENTION_MS).toISOString(),
		};
		if (input.cartId !== undefined) next.shopperCartId = input.cartId;
		const written = await deps.store.write(next, current.revision);
		if (written.ok) return { ok: true, replayed: false, session: viewOf(written.session) };
		if (written.reason === "too_large") return fail("WRITE_LIMIT_REACHED");
	}
	return fail("WRITE_CONFLICT");
}
