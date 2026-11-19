import type { Currency } from "../money/cents.js";
import type { OrderAddress } from "../orders/model.js";
import type { Clock } from "../ports/clock.js";
import type {
	AgentCreateIdempotencyRecord,
	AgentSessionStore,
} from "../ports/agent-session-store.js";
import type {
	AgentHandoffFailure,
	AgentOrderSecretFailure,
	AgentSessionFailure,
	AgentSessionFailureReason,
} from "./errors.js";
import {
	AGENT_SESSION_ID_PREFIX,
	AGENT_SESSION_MAX_LINES,
	AGENT_SESSION_MAX_WRITE_RECORDS,
	AGENT_SESSION_MAX_WRITES,
	AGENT_SESSION_RETENTION_MS,
	AGENT_SESSION_TTL_MS,
	agentSessionId,
	agentSessionStatusForLines,
	isAgentSessionOpen,
	type AgentCheckoutSession,
	type AgentSessionBuyer,
	type AgentSessionId,
	type AgentSessionLine,
	type AgentSessionOperation,
	type AgentSessionQuote,
	type AgentSessionSnapshot,
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
 * Idempotency: every write carries an `Idempotency-Key`, scoped to the caller's
 * `networkKey` (the same key from another network is a different request). The
 * same key and fingerprint replay the STORED answer of that write (the session
 * as that write left it), with `order_secret` and the current live hand-off link
 * re-derived; a different fingerprint is `IDEMPOTENCY_KEY_REUSED`.
 *
 * Hand-off links: a link is stable. Create (with lines) issues generation 1;
 * replace and complete keep an unused link, because redemption always reads the
 * current session. A new generation is minted only when the current link was
 * already redeemed and a later write needs one, or by an explicit
 * {@link issueAgentHandoff}.
 */

export interface AgentSessionLimits {
	/**
	 * Store-wide cap on open, unexpired sessions: a tuning knob against storage
	 * exhaustion, sized well above what the per-network cap lets a few networks
	 * reach. SOFT: checked before the insert, so racing creates can overshoot it.
	 */
	maxLiveSessions: number;
	/** Creates one network may make within `createWindowMs`. SOFT, as above. */
	maxCreatesPerNetwork: number;
	createWindowMs: number;
	/** Per-line quantity cap (the plugin passes its `CART_LINE_MAX_QTY`). */
	maxLineQuantity: number;
}

export const DEFAULT_AGENT_SESSION_LIMITS: AgentSessionLimits = {
	maxLiveSessions: 5000,
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

/** Identifies a keyed write: the caller's network, `Idempotency-Key` and body fingerprint. */
export interface AgentSessionKeyedRequest {
	/** The caller's rate-limit key (opaque, e.g. a hash of the client IP). */
	networkKey: string;
	idempotencyKey: string;
	fingerprint: string;
}

export type AgentSessionWriteResult =
	| {
			ok: true;
			/** True when this answers an earlier write with the same key. */
			replayed: boolean;
			/** The session as this write (or the replayed one) left it. */
			session: AgentSessionSnapshot;
			/** The raw token of the session's current live link; absent when it has none. */
			handoffToken?: string;
	  }
	| AgentSessionFailure;

export type CreateAgentSessionResult =
	| {
			ok: true;
			replayed: boolean;
			session: AgentSessionSnapshot;
			/** The raw `order_secret`; the same on every replay. */
			orderSecret: string;
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
			!Number.isSafeInteger(line.quantity) ||
			line.quantity < 1 ||
			line.quantity > limits.maxLineQuantity
		) {
			return fail("INVALID_QUANTITY");
		}
		if (skus.has(line.sku)) return fail("DUPLICATE_SKU");
		skus.add(line.sku);
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

function sameKey(a: AgentSessionWriteKey, request: AgentSessionKeyedRequest): boolean {
	return a.key === request.idempotencyKey && a.networkKey === request.networkKey;
}

/** The session without its idempotency bookkeeping. */
function snapshotOf(session: AgentCheckoutSession): AgentSessionSnapshot {
	const { writes: _writes, retiredWriteKeys: _retired, ...snapshot } = session;
	return structuredClone(snapshot);
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

/** Keep a usable link; mint one only for a session with lines that has none or used its last. */
async function ensureLink(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession,
): Promise<AgentCheckoutSession> {
	if (session.lines.length === 0) return session;
	if (session.linkGeneration > 0 && session.handoffUsedAt === undefined) return session;
	return mintLinkGeneration(deps, session);
}

function isExpired(session: { expiresAt: string }, now: string): boolean {
	return now >= session.expiresAt;
}

/** The raw token of the session's current link, if a shopper could redeem it now. */
async function liveHandoffToken(
	deps: Pick<AgentSessionDeps, "secrets">,
	session: AgentCheckoutSession,
	now: string,
): Promise<string | undefined> {
	if (
		!isAgentSessionOpen(session.status) ||
		session.lines.length === 0 ||
		session.linkGeneration === 0 ||
		session.handoffUsedAt !== undefined ||
		isExpired(session, now)
	) {
		return undefined;
	}
	return deps.secrets.derive("handoff", session.id, session.linkGeneration);
}

/** The per-network and store-wide create caps. Both SOFT (check-then-insert). */
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
	if ((await deps.store.countLive(now.toISOString())) >= limits.maxLiveSessions) {
		return fail("TOO_MANY_SESSIONS");
	}
	return null;
}

type CreateInput = AgentSessionKeyedRequest & { content: AgentSessionContent };

/**
 * Create a session (UCP `POST /checkout-sessions`). The id's suffix comes from
 * the secrets port. A replay (same network, key and fingerprint) answers the
 * session as created, with the same `order_secret` and the current live link.
 * A create whose key was recorded but whose session was never written (a crash
 * in between) is finished by its replay, under the recorded id, after the same
 * validation and caps as a fresh create.
 */
export async function createAgentSession(
	deps: AgentSessionDeps,
	input: CreateInput,
): Promise<CreateAgentSessionResult> {
	if (input.idempotencyKey.length === 0) return fail("IDEMPOTENCY_KEY_MISSING");
	const recorded = await deps.store.getIdempotency(input.networkKey, input.idempotencyKey);
	if (recorded !== null) return createFromRecord(deps, input, recorded);

	const refused = validateContent(input.content, limitsOf(deps));
	if (refused !== null) return refused;
	const now = deps.clock.now();
	const capped = await admitCreate(deps, input.networkKey, now);
	if (capped !== null) return capped;

	const id = agentSessionId(`${AGENT_SESSION_ID_PREFIX}${deps.secrets.mintId()}`);
	const put = await deps.store.putIdempotency({
		networkKey: input.networkKey,
		key: input.idempotencyKey,
		fingerprint: input.fingerprint,
		sessionId: id,
		createdAt: now.toISOString(),
		purgeAt: new Date(now.getTime() + AGENT_SESSION_RETENTION_MS).toISOString(),
	});
	if (!put.stored) return createFromRecord(deps, input, put.existing);
	return insertCreated(deps, input, id);
}

/** Answer a create whose key is already recorded: replay, refuse, or finish an orphan. */
async function createFromRecord(
	deps: AgentSessionDeps,
	input: CreateInput,
	record: AgentCreateIdempotencyRecord,
): Promise<CreateAgentSessionResult> {
	if (record.fingerprint !== input.fingerprint) return fail("IDEMPOTENCY_KEY_REUSED");
	const existing = await deps.store.get(record.sessionId);
	if (existing !== null) return replayCreate(deps, existing, input);
	const refused = validateContent(input.content, limitsOf(deps));
	if (refused !== null) return refused;
	const capped = await admitCreate(deps, record.networkKey, deps.clock.now());
	if (capped !== null) return capped;
	return insertCreated(deps, { ...input, networkKey: record.networkKey }, record.sessionId);
}

async function replayCreate(
	deps: AgentSessionDeps,
	session: AgentCheckoutSession,
	input: CreateInput,
): Promise<CreateAgentSessionResult> {
	const record = session.writes.find((w) => w.operation === "create" && sameKey(w, input));
	if (record === undefined) return fail("IDEMPOTENCY_KEY_EXPIRED");
	const result: CreateAgentSessionResult = {
		ok: true,
		replayed: true,
		session: structuredClone(record.answer),
		orderSecret: await deps.secrets.derive("order", session.id),
	};
	const token = await liveHandoffToken(deps, session, deps.clock.now().toISOString());
	if (token !== undefined) result.handoffToken = token;
	return result;
}

/** Insert the created session under `id`, or replay it if a racer inserted first. */
async function insertCreated(
	deps: AgentSessionDeps,
	input: CreateInput,
	id: AgentSessionId,
): Promise<CreateAgentSessionResult> {
	const now = deps.clock.now();
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
		purgeAt: new Date(now.getTime() + AGENT_SESSION_RETENTION_MS).toISOString(),
		writes: [],
		retiredWriteKeys: [],
	};
	const session = await ensureLink(deps, applyContent(base, input.content, nowIso));
	session.writes = [
		{
			key: input.idempotencyKey,
			networkKey: input.networkKey,
			operation: "create",
			fingerprint: input.fingerprint,
			revision: 1,
			answer: snapshotOf(session),
		},
	];
	const written = await deps.store.write(session, null);
	if (!written.ok) {
		return written.current === null
			? fail("WRITE_CONFLICT")
			: replayCreate(deps, written.current, input);
	}
	const result: CreateAgentSessionResult = {
		ok: true,
		replayed: false,
		session: snapshotOf(written.session),
		orderSecret,
	};
	const token = await liveHandoffToken(deps, written.session, nowIso);
	if (token !== undefined) result.handoffToken = token;
	return result;
}

/** A mutation's outcome: the next session, "nothing to change", or a refusal. */
type Mutation =
	| { ok: true; session: AgentCheckoutSession }
	| { ok: true; unchanged: true }
	| AgentSessionFailure;

/**
 * A keyed write to an existing session: replay-or-refuse on the caller's key
 * recorded on the session; refuse a key whose record was evicted; else apply
 * `mutate` and compare-and-set, retrying on a lost race. `mutate` runs only for
 * a fresh request, so validation never blocks a true replay.
 */
async function keyedWrite(
	deps: AgentSessionDeps,
	sessionId: AgentSessionId,
	request: AgentSessionKeyedRequest,
	operation: AgentSessionOperation,
	mutate: (session: AgentCheckoutSession, now: string) => Promise<Mutation>,
): Promise<AgentSessionWriteResult> {
	if (request.idempotencyKey.length === 0) return fail("IDEMPOTENCY_KEY_MISSING");
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		const current = await deps.store.get(sessionId);
		if (current === null) return fail("SESSION_NOT_FOUND");
		const now = deps.clock.now().toISOString();
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
		if (current.writes.length + current.retiredWriteKeys.length >= AGENT_SESSION_MAX_WRITES) {
			return fail("WRITE_LIMIT_REACHED");
		}
		const mutated = await mutate(current, now);
		if (!mutated.ok) return mutated;
		if ("unchanged" in mutated) return answer(deps, current, snapshotOf(current), false, now);

		const revision = current.revision + 1;
		const next: AgentCheckoutSession = { ...mutated.session, revision };
		const record: AgentSessionWriteRecord = {
			key: request.idempotencyKey,
			networkKey: request.networkKey,
			operation,
			fingerprint: request.fingerprint,
			revision,
			answer: snapshotOf(next),
		};
		const writes = [...current.writes, record];
		const evicted = writes.splice(0, Math.max(0, writes.length - AGENT_SESSION_MAX_WRITE_RECORDS));
		next.writes = writes;
		next.retiredWriteKeys = [
			...current.retiredWriteKeys,
			...evicted.map((w) => ({ key: w.key, networkKey: w.networkKey })),
		];
		const written = await deps.store.write(next, current.revision);
		if (written.ok) return answer(deps, written.session, snapshotOf(written.session), false, now);
	}
	return fail("WRITE_CONFLICT");
}

async function answer(
	deps: AgentSessionDeps,
	current: AgentCheckoutSession,
	snapshot: AgentSessionSnapshot,
	replayed: boolean,
	now: string,
): Promise<AgentSessionWriteResult> {
	const result: AgentSessionWriteResult = {
		ok: true,
		replayed,
		session: structuredClone(snapshot),
	};
	const token = await liveHandoffToken(deps, current, now);
	if (token !== undefined) result.handoffToken = token;
	return result;
}

function refuseUnwritable(session: AgentCheckoutSession, now: string): AgentSessionFailure | null {
	if (!isAgentSessionOpen(session.status)) return fail("SESSION_CLOSED");
	if (isExpired(session, now)) return fail("SESSION_EXPIRED");
	return null;
}

/**
 * Replace the session's content (UCP `PUT`: full replacement). An unused link
 * stays valid; a session whose link was redeemed gets a new one. A session left
 * with no lines keeps its link, which redeems again once it has lines.
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

/** Read a session. */
export async function getAgentSession(
	deps: Pick<AgentSessionDeps, "store">,
	input: { sessionId: AgentSessionId },
): Promise<{ ok: true; session: AgentCheckoutSession } | AgentSessionFailure> {
	const session = await deps.store.get(input.sessionId);
	return session === null ? fail("SESSION_NOT_FOUND") : { ok: true, session };
}

/**
 * Cancel the session. Its hand-off link is dead from here on. Releasing the
 * cart's holds is the caller's job (it owns the cart). Canceling an already
 * canceled session answers it as it is and writes nothing; an expired session
 * may still be canceled.
 */
export async function cancelAgentSession(
	deps: AgentSessionDeps,
	input: AgentSessionKeyedRequest & { sessionId: AgentSessionId },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "cancel", async (session, now) => {
		if (session.status === "completed") return fail("SESSION_CLOSED");
		if (session.status === "canceled") return { ok: true, unchanged: true };
		return { ok: true, session: { ...session, status: "canceled", updatedAt: now } };
	});
}

/**
 * UCP `complete`. The agent cannot pay, so this never completes: it answers the
 * session in `requires_escalation` with its current live link (a new one only if
 * the last was redeemed). A session with no lines is `SESSION_INCOMPLETE`.
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
 * lines; the previous link dies (or, if redeemed, keeps answering "used"). A
 * keyed write like every other: a replay answers the same live link.
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

/** Why a link for `tokenHash` cannot be redeemed on `session` now, or null if it can. */
function refuseRedeem(
	session: AgentCheckoutSession | null,
	tokenHash: string,
	now: string,
): AgentHandoffFailure | null {
	if (session === null) return { ok: false, reason: "HANDOFF_INVALID" };
	if (session.handoffTokenHash !== tokenHash) {
		return session.redeemedHandoffs.some((r) => r.tokenHash === tokenHash)
			? { ok: false, reason: "HANDOFF_USED" }
			: { ok: false, reason: "HANDOFF_INVALID" };
	}
	if (session.status === "canceled") return { ok: false, reason: "HANDOFF_CANCELED" };
	if (session.status === "completed" || session.handoffUsedAt !== undefined) {
		return { ok: false, reason: "HANDOFF_USED" };
	}
	if (isExpired(session, now)) return { ok: false, reason: "HANDOFF_EXPIRED" };
	if (session.lines.length === 0) return { ok: false, reason: "HANDOFF_INCOMPLETE" };
	return null;
}

/**
 * Redeem a hand-off link, once. On success the caller rebuilds the cart from the
 * returned session (re-reading prices and stock). Every failure leaves the
 * session as it was. The store's atomic mark re-checks status, use and expiry;
 * if it refuses, the reason comes from re-reading the session, so the pre-check
 * and the mark always classify a session the same way.
 */
export async function redeemAgentHandoff(
	deps: Pick<AgentSessionDeps, "store" | "clock" | "secrets">,
	input: { token: string },
): Promise<{ ok: true; session: AgentCheckoutSession } | AgentHandoffFailure> {
	if (input.token.length === 0) return { ok: false, reason: "HANDOFF_INVALID" };
	const tokenHash = await deps.secrets.hash(input.token);
	const session = await deps.store.findByHandoffTokenHash(tokenHash);
	const now = deps.clock.now().toISOString();
	const refused = refuseRedeem(session, tokenHash, now);
	if (refused !== null || session === null)
		return refused ?? { ok: false, reason: "HANDOFF_INVALID" };
	const marked = await deps.store.markHandoffUsed(session.id, tokenHash, now);
	if (marked.ok) return { ok: true, session: marked.session };
	return (
		refuseRedeem(await deps.store.get(session.id), tokenHash, now) ?? {
			ok: false,
			reason: "HANDOFF_INVALID",
		}
	);
}

/**
 * Check an `order_secret` against the session's stored hash, in constant time.
 * An unknown session and a wrong secret get the same answer.
 */
export async function verifyAgentOrderSecret(
	deps: Pick<AgentSessionDeps, "store" | "secrets">,
	input: { sessionId: AgentSessionId; secret: string },
): Promise<{ ok: true; session: AgentCheckoutSession } | AgentOrderSecretFailure> {
	const hash = await deps.secrets.hash(input.secret);
	const session = await deps.store.get(input.sessionId);
	if (session === null || input.secret.length === 0) {
		return { ok: false, reason: "ORDER_SECRET_INVALID" };
	}
	return deps.secrets.constantTimeEqual(hash, session.orderSecretHash)
		? { ok: true, session }
		: { ok: false, reason: "ORDER_SECRET_INVALID" };
}
