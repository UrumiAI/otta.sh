import type { Currency } from "../money/cents.js";
import type { OrderAddress } from "../orders/model.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type { AgentSessionStore } from "../ports/agent-session-store.js";
import type {
	AgentSessionFailure,
	AgentSessionInvalidReason,
	HandoffFailure,
	OrderSecretFailure,
} from "./errors.js";
import {
	AGENT_SESSION_ID_PREFIX,
	AGENT_SESSION_MAX_LINES,
	AGENT_SESSION_RETENTION_MS,
	AGENT_SESSION_TTL_MS,
	MAX_WRITE_RECORDS,
	agentSessionId,
	isOpenStatus,
	statusForLines,
	type AgentCheckoutSession,
	type AgentSessionBuyer,
	type AgentSessionId,
	type AgentSessionLine,
	type AgentSessionOperation,
	type AgentSessionQuote,
} from "./model.js";
import type { AgentSessionSecrets } from "./secrets.js";

/**
 * Agent checkout session use-cases (ADR-0047). Pure: the clock, ids, tokens and
 * hashing arrive as deps. Nothing here prices, discounts, taxes or ships: the
 * caller builds the cart and quotes it with the store's own code, and hands the
 * results in as `cartId` and `quote`.
 */

export interface AgentSessionLimits {
	/** Store-wide cap on open, unexpired sessions. */
	maxLiveSessions: number;
	/** Creates one network may make within `createWindowMs`. */
	maxCreatesPerNetwork: number;
	createWindowMs: number;
	/** Per-line quantity cap (the plugin passes its `CART_LINE_MAX_QTY`). */
	maxLineQuantity: number;
}

export const DEFAULT_AGENT_SESSION_LIMITS: AgentSessionLimits = {
	maxLiveSessions: 500,
	maxCreatesPerNetwork: 60,
	createWindowMs: 60 * 60 * 1000,
	maxLineQuantity: 10_000,
};

export interface AgentSessionDeps {
	store: AgentSessionStore;
	clock: Clock;
	/** Supplies the random suffix of `cs_…` ids. */
	idGen: IdGen;
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

/** Identifies a keyed write: the caller's `Idempotency-Key` and its fingerprint of the body. */
export interface KeyedRequest {
	idempotencyKey: string;
	fingerprint: string;
}

export type AgentSessionWriteResult =
	| {
			ok: true;
			replayed: false;
			session: AgentCheckoutSession;
			/** The raw hand-off token, returned this once; absent when no link was issued. */
			handoffToken?: string;
	  }
	/** A replay: the session as it is now. Raw secrets are never stored, so none is returned. */
	| { ok: true; replayed: true; session: AgentCheckoutSession }
	| AgentSessionFailure;

export type CreateAgentSessionResult =
	| {
			ok: true;
			replayed: false;
			session: AgentCheckoutSession;
			/** The raw `order_secret`, returned this once. */
			orderSecret: string;
			handoffToken?: string;
	  }
	| { ok: true; replayed: true; session: AgentCheckoutSession }
	| AgentSessionFailure;

const MAX_CAS_ATTEMPTS = 5;

function limitsOf(deps: AgentSessionDeps): AgentSessionLimits {
	return { ...DEFAULT_AGENT_SESSION_LIMITS, ...deps.limits };
}

function invalid(reason: AgentSessionInvalidReason): AgentSessionFailure {
	return { ok: false, code: "invalid_request", reason };
}

function validateContent(
	content: AgentSessionContent,
	limits: AgentSessionLimits,
): AgentSessionFailure | null {
	if (content.lines.length > AGENT_SESSION_MAX_LINES) return invalid("too_many_lines");
	const skus = new Set<string>();
	for (const line of content.lines) {
		if (
			!Number.isSafeInteger(line.quantity) ||
			line.quantity < 1 ||
			line.quantity > limits.maxLineQuantity
		) {
			return invalid("invalid_quantity");
		}
		if (skus.has(line.sku)) return invalid("duplicate_sku");
		skus.add(line.sku);
	}
	if (content.quote !== undefined && content.quote.currency !== content.currency) {
		return invalid("quote_currency_mismatch");
	}
	return null;
}

function validateKey(request: KeyedRequest): AgentSessionFailure | null {
	return request.idempotencyKey.length === 0 ? invalid("idempotency_key_missing") : null;
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
		status: statusForLines(content.lines),
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
 * Point the session at a fresh hand-off token (replacing any earlier link) when it
 * has lines; drop the link when it has none. Returns the raw token, if one was minted.
 */
async function rotateHandoff(
	deps: AgentSessionDeps,
	session: AgentCheckoutSession,
): Promise<{ session: AgentCheckoutSession; token?: string }> {
	const { handoffTokenHash: _hash, handoffUsedAt: _used, ...rest } = session;
	if (session.lines.length === 0) return { session: rest };
	const token = deps.secrets.mintToken();
	return { session: { ...rest, handoffTokenHash: await deps.secrets.hash(token) }, token };
}

function isExpired(session: AgentCheckoutSession, now: string): boolean {
	return now >= session.expiresAt;
}

/**
 * Create a session (UCP `POST /checkout-sessions`). The same key with the same
 * fingerprint replays the session it created; with a different fingerprint it is
 * `idempotency_key_reused`. A create whose key was recorded but whose session was
 * never written (a crash in between) is completed by its replay, under the id the
 * record holds.
 */
export async function createSession(
	deps: AgentSessionDeps,
	input: KeyedRequest & { networkKey: string; content: AgentSessionContent },
): Promise<CreateAgentSessionResult> {
	const limits = limitsOf(deps);
	const refused = validateKey(input) ?? validateContent(input.content, limits);
	if (refused !== null) return refused;

	const recorded = await deps.store.getIdempotency(input.idempotencyKey);
	if (recorded !== null) {
		if (!deps.secrets.constantTimeEqual(recorded.fingerprint, input.fingerprint)) {
			return { ok: false, code: "idempotency_key_reused" };
		}
		return writeCreated(deps, input, recorded.sessionId);
	}

	const now = deps.clock.now();
	const since = new Date(now.getTime() - limits.createWindowMs).toISOString();
	if (
		(await deps.store.countCreatedSince(input.networkKey, since)) >= limits.maxCreatesPerNetwork
	) {
		return { ok: false, code: "rate_limited" };
	}
	if ((await deps.store.countLive(now.toISOString())) >= limits.maxLiveSessions) {
		return { ok: false, code: "too_many_sessions" };
	}

	const id = agentSessionId(`${AGENT_SESSION_ID_PREFIX}${deps.idGen.newId()}`);
	const put = await deps.store.putIdempotency({
		key: input.idempotencyKey,
		fingerprint: input.fingerprint,
		sessionId: id,
		createdAt: now.toISOString(),
	});
	if (!put.stored) {
		if (!deps.secrets.constantTimeEqual(put.existing.fingerprint, input.fingerprint)) {
			return { ok: false, code: "idempotency_key_reused" };
		}
		return writeCreated(deps, input, put.existing.sessionId);
	}
	return writeCreated(deps, input, id);
}

/** Write the created session under `id`, or replay it if it is already there. */
async function writeCreated(
	deps: AgentSessionDeps,
	input: KeyedRequest & { networkKey: string; content: AgentSessionContent },
	id: AgentSessionId,
): Promise<CreateAgentSessionResult> {
	const existing = await deps.store.get(id);
	if (existing !== null) return { ok: true, replayed: true, session: existing };

	const now = deps.clock.now();
	const nowIso = now.toISOString();
	const orderSecret = deps.secrets.mintToken();
	const base: AgentCheckoutSession = {
		id,
		revision: 0,
		status: "incomplete",
		currency: input.content.currency,
		lines: [],
		orderSecretHash: await deps.secrets.hash(orderSecret),
		channel: "other",
		networkKey: input.networkKey,
		createdAt: nowIso,
		updatedAt: nowIso,
		expiresAt: new Date(now.getTime() + AGENT_SESSION_TTL_MS).toISOString(),
		purgeAt: new Date(now.getTime() + AGENT_SESSION_RETENTION_MS).toISOString(),
		writes: [
			{
				key: input.idempotencyKey,
				operation: "create",
				fingerprint: input.fingerprint,
				revision: 1,
			},
		],
	};
	const rotated = await rotateHandoff(deps, applyContent(base, input.content, nowIso));
	const written = await deps.store.write(rotated.session, null);
	if (!written.ok) {
		// A racing replay of the same create wrote it first.
		return written.current === null
			? { ok: false, code: "write_conflict" }
			: { ok: true, replayed: true, session: written.current };
	}
	const result: CreateAgentSessionResult = {
		ok: true,
		replayed: false,
		session: written.session,
		orderSecret,
	};
	if (rotated.token !== undefined) result.handoffToken = rotated.token;
	return result;
}

type Mutation =
	| { ok: true; session: AgentCheckoutSession; handoffToken?: string }
	| AgentSessionFailure;

/**
 * A keyed write to an existing session: replay-or-conflict on the key recorded on
 * the session, else apply `mutate` and compare-and-set, retrying on a lost race.
 */
async function keyedWrite(
	deps: AgentSessionDeps,
	sessionId: AgentSessionId,
	request: KeyedRequest,
	operation: AgentSessionOperation,
	mutate: (session: AgentCheckoutSession, now: string) => Promise<Mutation>,
): Promise<AgentSessionWriteResult> {
	const refused = validateKey(request);
	if (refused !== null) return refused;
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		const current = await deps.store.get(sessionId);
		if (current === null) return { ok: false, code: "session_not_found" };
		const prior = current.writes.find((w) => w.key === request.idempotencyKey);
		if (prior !== undefined) {
			const same =
				prior.operation === operation &&
				deps.secrets.constantTimeEqual(prior.fingerprint, request.fingerprint);
			return same
				? { ok: true, replayed: true, session: current }
				: { ok: false, code: "idempotency_key_reused" };
		}
		const mutated = await mutate(current, deps.clock.now().toISOString());
		if (!mutated.ok) return mutated;
		const next: AgentCheckoutSession = {
			...mutated.session,
			writes: [
				...current.writes,
				{
					key: request.idempotencyKey,
					operation,
					fingerprint: request.fingerprint,
					revision: current.revision + 1,
				},
			].slice(-MAX_WRITE_RECORDS),
		};
		const written = await deps.store.write(next, current.revision);
		if (written.ok) {
			const result: AgentSessionWriteResult = {
				ok: true,
				replayed: false,
				session: written.session,
			};
			if (mutated.handoffToken !== undefined) result.handoffToken = mutated.handoffToken;
			return result;
		}
	}
	return { ok: false, code: "write_conflict" };
}

function refuseUnwritable(session: AgentCheckoutSession, now: string): AgentSessionFailure | null {
	if (!isOpenStatus(session.status)) return { ok: false, code: "session_closed" };
	if (isExpired(session, now)) return { ok: false, code: "session_expired" };
	return null;
}

/**
 * Replace the session's content (UCP `PUT`: full replacement). Issues a fresh
 * hand-off link, which kills any earlier one; a session left with no lines has no
 * link.
 */
export async function replaceSession(
	deps: AgentSessionDeps,
	input: KeyedRequest & { sessionId: AgentSessionId; content: AgentSessionContent },
): Promise<AgentSessionWriteResult> {
	const invalidContent = validateContent(input.content, limitsOf(deps));
	if (invalidContent !== null) return invalidContent;
	return keyedWrite(deps, input.sessionId, input, "replace", async (session, now) => {
		const refused = refuseUnwritable(session, now);
		if (refused !== null) return refused;
		const rotated = await rotateHandoff(deps, applyContent(session, input.content, now));
		const out: Mutation = { ok: true, session: rotated.session };
		if (rotated.token !== undefined) out.handoffToken = rotated.token;
		return out;
	});
}

/** Read a session. */
export async function getSession(
	deps: Pick<AgentSessionDeps, "store">,
	input: { sessionId: AgentSessionId },
): Promise<{ ok: true; session: AgentCheckoutSession } | AgentSessionFailure> {
	const session = await deps.store.get(input.sessionId);
	return session === null ? { ok: false, code: "session_not_found" } : { ok: true, session };
}

/**
 * Cancel the session. Its hand-off link is dead from here on. Releasing the
 * cart's holds is the caller's job (it owns the cart). Canceling a canceled
 * session answers it unchanged; an expired session may still be canceled.
 */
export async function cancelSession(
	deps: AgentSessionDeps,
	input: KeyedRequest & { sessionId: AgentSessionId },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "cancel", async (session, now) => {
		if (session.status === "completed") return { ok: false, code: "session_closed" };
		return { ok: true, session: { ...session, status: "canceled", updatedAt: now } };
	});
}

/**
 * UCP `complete`. The agent cannot pay, so this never completes: it answers the
 * session in `requires_escalation` with a fresh hand-off link for the shopper. A
 * session with no lines is `session_incomplete`.
 */
export async function completeSession(
	deps: AgentSessionDeps,
	input: KeyedRequest & { sessionId: AgentSessionId },
): Promise<AgentSessionWriteResult> {
	return keyedWrite(deps, input.sessionId, input, "complete", async (session, now) => {
		const refused = refuseUnwritable(session, now);
		if (refused !== null) return refused;
		if (session.lines.length === 0) return { ok: false, code: "session_incomplete" };
		const rotated = await rotateHandoff(deps, {
			...session,
			status: "requires_escalation",
			updatedAt: now,
		});
		const out: Mutation = { ok: true, session: rotated.session };
		if (rotated.token !== undefined) out.handoffToken = rotated.token;
		return out;
	});
}

/**
 * Issue a new hand-off link for an open session with lines. Only the token's
 * hash is stored; the raw token is returned this once. Any earlier link dies.
 */
export async function issueHandoff(
	deps: AgentSessionDeps,
	input: { sessionId: AgentSessionId },
): Promise<
	{ ok: true; session: AgentCheckoutSession; handoffToken: string } | AgentSessionFailure
> {
	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
		const current = await deps.store.get(input.sessionId);
		if (current === null) return { ok: false, code: "session_not_found" };
		const now = deps.clock.now().toISOString();
		const refused = refuseUnwritable(current, now);
		if (refused !== null) return refused;
		if (current.lines.length === 0) return { ok: false, code: "session_incomplete" };
		const rotated = await rotateHandoff(deps, { ...current, updatedAt: now });
		if (rotated.token === undefined) return { ok: false, code: "session_incomplete" };
		const written = await deps.store.write(rotated.session, current.revision);
		if (written.ok) return { ok: true, session: written.session, handoffToken: rotated.token };
	}
	return { ok: false, code: "write_conflict" };
}

/**
 * Redeem a hand-off link, once. On success the caller rebuilds the cart from the
 * returned session (re-reading prices and stock). Every failure leaves the
 * session as it was.
 */
export async function redeemHandoff(
	deps: Pick<AgentSessionDeps, "store" | "clock" | "secrets">,
	input: { token: string },
): Promise<{ ok: true; session: AgentCheckoutSession } | HandoffFailure> {
	if (input.token.length === 0) return { ok: false, code: "handoff_invalid" };
	const tokenHash = await deps.secrets.hash(input.token);
	const session = await deps.store.findByHandoffTokenHash(tokenHash);
	if (session === null) return { ok: false, code: "handoff_invalid" };
	if (session.status === "canceled") return { ok: false, code: "handoff_canceled" };
	if (session.status === "completed" || session.handoffUsedAt !== undefined) {
		return { ok: false, code: "handoff_used" };
	}
	const now = deps.clock.now().toISOString();
	if (isExpired(session, now)) return { ok: false, code: "handoff_expired" };
	const marked = await deps.store.markHandoffUsed(session.id, tokenHash, now);
	if (marked.ok) return { ok: true, session: marked.session };
	switch (marked.reason) {
		case "already_used":
			return { ok: false, code: "handoff_used" };
		case "closed":
			return { ok: false, code: "handoff_canceled" };
		default:
			// Rotated or purged between the read and the mark.
			return { ok: false, code: "handoff_invalid" };
	}
}

/**
 * Check an `order_secret` against the session's stored hash, in constant time.
 * An unknown session and a wrong secret get the same answer.
 */
export async function verifyOrderSecret(
	deps: Pick<AgentSessionDeps, "store" | "secrets">,
	input: { sessionId: AgentSessionId; secret: string },
): Promise<{ ok: true; session: AgentCheckoutSession } | OrderSecretFailure> {
	const hash = await deps.secrets.hash(input.secret);
	const session = await deps.store.get(input.sessionId);
	if (session === null || input.secret.length === 0) {
		return { ok: false, code: "order_secret_invalid" };
	}
	return deps.secrets.constantTimeEqual(hash, session.orderSecretHash)
		? { ok: true, session }
		: { ok: false, code: "order_secret_invalid" };
}
