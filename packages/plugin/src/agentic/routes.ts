/**
 * ADR-0047 — the agentic checkout routes (UCP checkout sessions and the shopper
 * hand-off), PUBLIC like the storefront's. Each answers `NOT_FOUND` while the
 * store has not switched agentic checkout on (`settings:agenticEnabled`), so a
 * store that has not opted in exposes nothing.
 *
 * Orchestration only: the session rules are the domain's (`createAgentSession`
 * and friends), the cart and the quote are the commerce client's, and nothing
 * here computes money (see `cart-quote.ts`).
 *
 * PRIVACY. Answers carry the agent's own session (it supplied the buyer and the
 * address) and typed tokens; logs carry fixed lines and nothing from a request.
 * Refusals for an unknown or tampered token or secret write nothing (the domain's
 * lookup is by hash; nothing is created first).
 */
import {
	cancelAgentSession,
	completeAgentSession,
	createAgentSession,
	detachAgentSessionCart,
	getAgentSession,
	precheckAgentSessionCreate,
	claimAgentHandoff,
	finalizeAgentHandoff,
	productId as toProductId,
	precheckAgentSessionReplace,
	releaseAgentHandoffClaim,
	replaceAgentSession,
	sku as toSku,
	verifyAgentOrderSecret,
	type AgentSessionContent,
	type AgentSessionDeps,
	type AgentSessionId,
	type AgentSessionLine,
	type AgentSessionView,
	type OrderAddress,
} from "@urumi.ai/otta-domain";
import { WebCryptoAgentSessionSecrets } from "@urumi.ai/otta-store-emdash";
import { CART_LINE_MAX_QTY } from "../commerce/commerce-input.js";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import { makeCommerceClient } from "../commerce/make-commerce-client.js";
import { clientAddress, clientNetwork, networkKey } from "../payments/cod-request.js";
import type { CartWire, CommerceClient } from "../product-commerce/commerce-client.js";
import { cartCookieDescriptor, type CartCookieDescriptor } from "../storefront/cart-routes.js";
import { renderGuard, type RenderGuardFailure } from "../storefront/pdp-route.js";
import type { PluginContext, RouteHandler, SandboxedRequest } from "../types.js";
import { agenticCartKey, type AgenticCartKeyKind } from "./cart-key.js";
import {
	addAgentLines,
	buildAgentCart,
	quoteAgentCart,
	retryAgentLine,
	startAgentCart,
	type AgentMessage,
	type AgentSelection,
	type BuiltCart,
} from "./cart-quote.js";
import {
	fingerprintOf,
	orderAddressOf,
	parseAgentSessionInput,
	parseKeyedSessionInput,
	parseSecret,
	parseSessionId,
	selectionOf,
	type AgentSessionInput,
} from "./input.js";
import { readAgenticEnabled, readAgenticServerKey } from "./settings.js";

export const AGENTIC_SESSION_CREATE_ROUTE = "agentic/session/create";
export const AGENTIC_SESSION_GET_ROUTE = "agentic/session/get";
export const AGENTIC_SESSION_UPDATE_ROUTE = "agentic/session/update";
export const AGENTIC_SESSION_CANCEL_ROUTE = "agentic/session/cancel";
export const AGENTIC_SESSION_COMPLETE_ROUTE = "agentic/session/complete";
export const AGENTIC_HANDOFF_REDEEM_ROUTE = "agentic/handoff/redeem";
export const AGENTIC_ORDER_ROUTE = "agentic/order";
export const AGENTIC_STATUS_ROUTE = "agentic/status";

/** Every agentic route, for the tables that must name each one. */
export const AGENTIC_ROUTES = [
	AGENTIC_SESSION_CREATE_ROUTE,
	AGENTIC_SESSION_GET_ROUTE,
	AGENTIC_SESSION_UPDATE_ROUTE,
	AGENTIC_SESSION_CANCEL_ROUTE,
	AGENTIC_SESSION_COMPLETE_ROUTE,
	AGENTIC_HANDOFF_REDEEM_ROUTE,
	AGENTIC_ORDER_ROUTE,
	AGENTIC_STATUS_ROUTE,
] as const;

type NotFound = { ok: false; error: "NOT_FOUND" };
type InvalidInput = { ok: false; error: "INVALID_INPUT" };
/** The server key or the client's network cannot be had: fail closed. */
type Unavailable = { ok: false; error: "UNAVAILABLE" };
type Refused = { ok: false; reason: string };
type Common = NotFound | InvalidInput | Unavailable | Refused | RenderGuardFailure;

const NOT_FOUND: NotFound = { ok: false, error: "NOT_FOUND" };
const INVALID_INPUT: InvalidInput = { ok: false, error: "INVALID_INPUT" };
const UNAVAILABLE: Unavailable = { ok: false, error: "UNAVAILABLE" };

/** The session as an agent sees it: the domain's allowlisted view, less its cart
 *  id (a bearer for the cart — the agent never holds the shopper's). */
export interface AgentSessionWire {
	id: string;
	status: string;
	currency: string;
	lines: AgentSessionLine[];
	buyer: AgentSessionView["buyer"] | null;
	destination: OrderAddress | null;
	shippingMethodId: string | null;
	couponCode: string | null;
	quote: AgentSessionView["quote"] | null;
	expiresAt: string;
	orderId: string | null;
	/** A shopper redeemed a hand-off link: the agent may now only cancel. */
	handedOff: boolean;
}

/**
 * Marks an answer that carries a bearer secret (a live, payable hand-off token or
 * the order secret): the site MUST serve it `Cache-Control: no-store`.
 */
export const NO_STORE = { noStore: true } as const;

function sessionWire(view: AgentSessionView): AgentSessionWire {
	return {
		id: view.id,
		status: view.status,
		currency: view.currency,
		lines: view.lines.map((l) => ({ ...l })),
		buyer: view.buyer ?? null,
		destination: view.destination ?? null,
		shippingMethodId: view.shippingMethodId ?? null,
		couponCode: view.couponCode ?? null,
		quote: view.quote ?? null,
		expiresAt: view.expiresAt,
		orderId: view.orderId ?? null,
		handedOff: view.handedOff,
	};
}

/** The domain deps and the server key's bytes (the agentic cart keys are HMACs
 *  under it), or `null` (logged) when the server key cannot be had. */
async function agentDeps(
	ctx: PluginContext,
): Promise<{ deps: AgentSessionDeps; serverKey: Uint8Array } | null> {
	const key = await readAgenticServerKey(ctx);
	if (key === null) return null;
	const stores = createInProcessCommerceStores(ctx);
	return {
		serverKey: key,
		deps: {
			store: stores.agentSessionStore,
			clock: stores.clock,
			secrets: new WebCryptoAgentSessionSecrets(key),
			limits: { maxLineQuantity: CART_LINE_MAX_QTY },
		},
	};
}

/**
 * Run `body` only when agentic checkout is on (else `NOT_FOUND`, before anything
 * else is read) and the deps can be built (else `UNAVAILABLE`), under the
 * storefront's render guard.
 */
function guarded<T>(
	route: string,
	ctx: PluginContext,
	body: (deps: AgentSessionDeps, serverKey: Uint8Array) => Promise<T>,
): Promise<T | NotFound | Unavailable | RenderGuardFailure> {
	return renderGuard(route, async () => {
		if (!(await readAgenticEnabled(ctx))) return NOT_FOUND;
		const built = await agentDeps(ctx);
		if (built === null) return UNAVAILABLE;
		return body(built.deps, built.serverKey);
	});
}

/** The trusted network key of the request (the COD path: Cloudflare's client
 *  address, HMAC'd under the store's secret), never a client-supplied value. */
async function requestNetworkKey(
	ctx: PluginContext,
	request: SandboxedRequest | undefined,
): Promise<string | null> {
	// IPv6 aggregated to its /64 (ADR-0047): one host typically owns a whole /64,
	// and the per-network live cap means nothing if a caller can rotate addresses
	// inside it. (The COD path keeps its own, wider /48.)
	const network = clientNetwork(clientAddress(request), 64);
	return network === null ? null : networkKey(ctx, network);
}

/** Build, fill and quote the session's cart, then the content the domain stores. */
async function contentFor(
	client: CommerceClient,
	cartKey: string,
	input: AgentSessionInput,
	nowIso: string,
): Promise<{ content: AgentSessionContent; messages: AgentMessage[] } | Refused> {
	const built = await buildAgentCart(client, cartKey, input.lines, input.currency);
	if ("failed" in built) return { ok: false, reason: built.failed };
	return quotedContent(client, built, input, nowIso);
}

/** Quote a built cart and assemble the content the domain stores. */
async function quotedContent(
	client: CommerceClient,
	built: BuiltCart,
	input: AgentSessionInput,
	nowIso: string,
): Promise<{ content: AgentSessionContent; messages: AgentMessage[] }> {
	const quoted =
		built.lines.length === 0
			? { quote: undefined, messages: [] }
			: await quoteAgentCart(client, built.cartId, selectionOf(input), nowIso);
	const content: AgentSessionContent = {
		currency: built.currency,
		lines: built.lines,
		cartId: built.cartId,
		...(input.buyer !== undefined ? { buyer: input.buyer } : {}),
		...acceptedSelection(input, quoted),
		...(quoted.quote !== undefined ? { quote: quoted.quote } : {}),
	};
	return { content, messages: [...built.messages, ...quoted.messages] };
}

/**
 * The destination, shipping method and coupon the session may keep: ONLY those a
 * quote positively accepted (`applied`, refused parts dropped — their messages say
 * why). No quote made (no lines, or it failed for another reason) ⇒ none of them:
 * a session never advertises or pre-fills a selection nothing accepted.
 */
export function acceptedSelection(
	input: Pick<AgentSessionInput, "address" | "shippingMethodId" | "couponCode">,
	quoted: { applied?: AgentSelection },
): Pick<AgentSessionContent, "destination" | "shippingMethodId" | "couponCode"> {
	const applied = quoted.applied;
	if (applied === undefined) return {};
	return {
		...(applied.destination !== undefined && input.address !== undefined
			? { destination: orderAddressOf(input.address) }
			: {}),
		...(applied.shippingMethodId !== undefined
			? { shippingMethodId: applied.shippingMethodId }
			: {}),
		...(applied.couponCode !== undefined ? { couponCode: applied.couponCode } : {}),
	};
}

/**
 * An agent write's cart key, which no caller can compute: an HMAC under the
 * server key (`cart-key.ts`) of the write's scope, its key AND its body's
 * fingerprint — so two bodies racing under one key never share a cart, while a
 * same-body retry lands in the same cart (deduped by its line keys). The agent
 * knows every input but the server key, so it cannot name the cart, and the
 * storefront's `cart/create` refuses `agentic:` keys besides.
 */
export async function agentCartKey(
	serverKey: Uint8Array,
	kind: Exclude<AgenticCartKeyKind, "shopper">,
	scope: string,
	idempotencyKey: string,
	fingerprint: string,
): Promise<string> {
	return agenticCartKey(serverKey, kind, [scope, idempotencyKey, fingerprint]);
}

// ── session/create ─────────────────────────────────────────────────────────

export type AgenticCreateResult =
	| {
			ok: true;
			noStore: true;
			replayed: boolean;
			session: AgentSessionWire;
			orderSecret: string;
			handoffToken: string | null;
			messages: AgentMessage[];
	  }
	| Common;

export function createAgenticSessionCreateHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticCreateResult> =>
		guarded(AGENTIC_SESSION_CREATE_ROUTE, ctx, async (deps, serverKey) => {
			const input = parseAgentSessionInput(routeCtx.input);
			if (input === null) return INVALID_INPUT;
			const net = await requestNetworkKey(ctx, routeCtx.request);
			if (net === null) return UNAVAILABLE;
			const request = {
				networkKey: net,
				idempotencyKey: input.idempotencyKey,
				fingerprint: await fingerprintOf(input, "create"),
			};
			// Ask the domain FIRST: a replay answers its stored session (no cart work,
			// no re-quote, so a replay is byte-stable), and a reused key or a hit cap
			// is refused before any cart is created or any stock is held.
			const pre = await precheckAgentSessionCreate(deps, request);
			if (!pre.proceed) return createAnswer(pre.result);
			const client = await makeCommerceClient(ctx);
			const built = await contentFor(
				client,
				await agentCartKey(serverKey, "create", net, input.idempotencyKey, request.fingerprint),
				input,
				deps.clock.now().toISOString(),
			);
			if (!("content" in built)) return built;
			const result = await createAgentSession(deps, {
				...request,
				content: built.content,
				messages: built.messages,
			});
			// Refused FOR GOOD after the build (a racer's body took the key): the cart
			// is this body's alone (its key carries the fingerprint), so release it.
			// A retryable refusal keeps it — see {@link isFinalRefusal}.
			if (!result.ok && isFinalRefusal(result.reason)) {
				await releaseBuilt(ctx, built.content.cartId);
			}
			return createAnswer(result);
		});
}

/** The answer, with the write's recorded messages (a replay's are the original's). */
function createAnswer(result: Awaited<ReturnType<typeof createAgentSession>>): AgenticCreateResult {
	if (!result.ok) return { ok: false, reason: result.reason };
	return {
		ok: true,
		...NO_STORE,
		replayed: result.replayed,
		session: sessionWire(result.session),
		orderSecret: result.orderSecret,
		handoffToken: result.handoffToken ?? null,
		messages: result.messages ?? [],
	};
}

/**
 * Whether a refusal after the keyed cart was built is FINAL for this key and body:
 * the key is recorded (a retry answers the refusal, never rebuilds), the session
 * can never take the write, or the domain refused the content itself (the same
 * body is refused again). Only then is the built cart released. Anything else — a
 * throw, a WRITE_CONFLICT, a cap race — keeps it: a same-key, same-body retry
 * rebuilds into that SAME keyed cart, whose completed line keys replay from the
 * lines it still holds, so emptying it would make the retry write a session with
 * no lines. Hold expiry reclaims a cart nobody retries.
 */
function isFinalRefusal(reason: string): boolean {
	return FINAL_REFUSALS.has(reason);
}

const FINAL_REFUSALS: ReadonlySet<string> = new Set([
	// The key is (or was) recorded: a retry answers the refusal, never rebuilds.
	"IDEMPOTENCY_KEY_REUSED",
	"IDEMPOTENCY_KEY_EXPIRED",
	// The session can never take this write.
	"SESSION_HANDED_OFF",
	"SESSION_CLOSED",
	"SESSION_EXPIRED",
	"SESSION_NOT_FOUND",
	"WRITE_LIMIT_REACHED",
	// The domain's content checks: the same body is refused the same way again.
	"TOO_MANY_LINES",
	"INVALID_QUANTITY",
	"DUPLICATE_SKU",
	"INVALID_REQUEST",
	"QUOTE_CURRENCY_MISMATCH",
	"QUOTE_PARTIAL_TOTAL",
]);

/** Release a cart this request built for a write the domain then refused. */
async function releaseBuilt(ctx: PluginContext, cartId: string | undefined): Promise<void> {
	if (cartId !== undefined) await releaseCart(ctx, cartId);
}

// ── session/get ────────────────────────────────────────────────────────────

export type AgenticGetResult =
	| { ok: true; noStore: true; session: AgentSessionWire; handoffToken: string | null }
	| Common;

export function createAgenticSessionGetHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticGetResult> =>
		guarded(AGENTIC_SESSION_GET_ROUTE, ctx, async (deps) => {
			const sessionId = parseSessionId(fieldOf(routeCtx.input, "sessionId"));
			if (sessionId === null) return { ok: false as const, reason: "SESSION_NOT_FOUND" };
			const result = await getAgentSession(deps, { sessionId });
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return {
				ok: true as const,
				...NO_STORE,
				session: sessionWire(result.session),
				handoffToken: result.handoffToken ?? null,
			};
		});
}

// ── session/update (a full replacement, UCP PUT) ───────────────────────────

export type AgenticWriteResult =
	| {
			ok: true;
			noStore: true;
			replayed: boolean;
			session: AgentSessionWire;
			handoffToken: string | null;
			messages: AgentMessage[];
	  }
	| Common;

export function createAgenticSessionUpdateHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticWriteResult> =>
		guarded(AGENTIC_SESSION_UPDATE_ROUTE, ctx, async (deps, serverKey) => {
			const sessionId = parseSessionId(fieldOf(routeCtx.input, "sessionId"));
			const input = parseAgentSessionInput(routeCtx.input);
			if (input === null) return INVALID_INPUT;
			if (sessionId === null) return { ok: false as const, reason: "SESSION_NOT_FOUND" };
			const request = {
				sessionId,
				idempotencyKey: input.idempotencyKey,
				fingerprint: await fingerprintOf(input, "replace"),
			};
			// Ask the domain FIRST, before any cart work: a replay answers its stored
			// result; a reused or retired key, the write cap, and a session that is
			// closed, expired or handed off (the shopper owns that cart) are refused
			// with no cart built or touched. Only a fresh, allowed write builds one.
			const pre = await precheckAgentSessionReplace(deps, request);
			if (!pre.proceed) return writeAnswer(pre.result);
			return replaceWithNewCart(ctx, deps, serverKey, request, input);
		});
}

/**
 * An update's cart work (ADR-0047). The previous agent cart stays ATTACHED and
 * holding its stock while the new cart is built, so a redeem landing during the
 * build re-adopts a cart that holds the stock (and this update is then refused
 * SESSION_HANDED_OFF, its new cart released). Only when the new cart is refused
 * OUT_OF_STOCK for lines the old cart holds is the old cart detached (one
 * compare-and-set: refused once handed off, a replay for this key's own body),
 * released, and those lines retried once. REMAINING WINDOW: on that retry path,
 * a redeem landing between the detach and this write finds no cart and rebuilds,
 * and it can lose the released stock to this update's retry. After a fresh write,
 * the old cart is released.
 *
 * The new cart is released only on a FINAL refusal ({@link isFinalRefusal}),
 * re-checked against the session (never a cart a same-body twin attached). A
 * throw or a retryable refusal leaves it holding its lines: a same-key, same-body
 * retry rebuilds into that same keyed cart (its line keys replay; a line it holds
 * under a refused base key is counted from the cart, see `alreadyInCart`). A session a failure left detached shows NO cart and NO quote (the detach
 * drops both), never totals no cart holds; its lines rebuild at redeem.
 */
async function replaceWithNewCart(
	ctx: PluginContext,
	deps: AgentSessionDeps,
	serverKey: Uint8Array,
	request: { sessionId: AgentSessionId; idempotencyKey: string; fingerprint: string },
	input: AgentSessionInput,
): Promise<AgenticWriteResult> {
	const { sessionId } = request;
	const client = await makeCommerceClient(ctx);
	const oldCartId = (await deps.store.get(sessionId))?.cartId;
	const started = await startAgentCart(
		client,
		await agentCartKey(serverKey, "replace", sessionId, input.idempotencyKey, request.fingerprint),
		input.currency,
	);
	if ("failed" in started) return { ok: false, reason: started.failed };
	const newCartId = started.cartId;
	let oldReleased = false;
	const added = await addAgentLines(client, newCartId, started.currency, input.lines);
	// A same-key retry of an update whose earlier attempt took the retry path:
	// that line's base key replays its consumed OUT_OF_STOCK, but the cart holds
	// the line (added under `:retry`). The session must match the cart.
	let { lines, messages } = await alreadyInCart(client, newCartId, input.lines, added);
	const retry = await heldByOldCart(client, oldCartId, input.lines, messages, deps);
	if (retry.length > 0) {
		const detached = await detachAgentSessionCart(deps, request);
		if (!detached.ok) {
			if (isFinalRefusal(detached.reason)) {
				await releaseUnlessAttached(ctx, deps, sessionId, newCartId);
			}
			return { ok: false, reason: detached.reason };
		}
		// This key's own body already wrote (a duplicate that lost the race):
		// answer it; the cart is that write's, so nothing is released.
		if (!detached.detached) return writeAnswer(detached.replay);
		if (detached.cartId !== undefined) {
			await releaseCart(ctx, detached.cartId);
			oldReleased = true;
		}
		({ lines, messages } = await retryLines(
			client,
			newCartId,
			input.lines,
			retry,
			lines,
			messages,
		));
	}
	const { content, messages: all } = await quotedContent(
		client,
		{ cartId: newCartId, currency: started.currency, lines, messages },
		input,
		deps.clock.now().toISOString(),
	);
	const result = await replaceAgentSession(deps, { ...request, content, messages: all });
	if (!result.ok) {
		if (isFinalRefusal(result.reason)) {
			await releaseUnlessAttached(ctx, deps, sessionId, newCartId);
		}
		return writeAnswer(result);
	}
	// The write moved the session to the new cart: the old one is nobody's.
	if (
		!result.replayed &&
		!result.session.handedOff &&
		!oldReleased &&
		oldCartId !== undefined &&
		oldCartId !== newCartId
	) {
		await releaseCart(ctx, oldCartId);
	}
	return writeAnswer(result);
}

/** One retry candidate: a requested line refused OUT_OF_STOCK whose stock the
 *  session's previous cart still holds. */
interface HeldRetry {
	index: number;
	sku: string;
}

async function heldByOldCart(
	client: CommerceClient,
	oldCartId: string | undefined,
	requested: AgentSessionInput["lines"],
	messages: readonly AgentMessage[],
	deps: AgentSessionDeps,
): Promise<HeldRetry[]> {
	const refused = messages
		.filter((m) => m.code === "OUT_OF_STOCK")
		.map((m) => /^lines\[(\d+)\]$/.exec(m.path))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Number(match[1]));
	if (refused.length === 0 || oldCartId === undefined) return [];
	const old = await client.getCart(oldCartId);
	if (!old.ok) return [];
	const nowIso = deps.clock.now().toISOString();
	const held: HeldRetry[] = [];
	for (const index of refused) {
		const want = requested[index];
		const line = old.cart.lines.find(
			(l) =>
				want !== undefined && l.productId === want.productId && allHeld({ lines: [l] }, nowIso),
		);
		if (line !== undefined) held.push({ index, sku: line.sku });
	}
	return held;
}

/** Retry each held line once; the lines come back in request order. */
async function retryLines(
	client: CommerceClient,
	cartId: string,
	requested: AgentSessionInput["lines"],
	retry: readonly HeldRetry[],
	lines: AgentSessionLine[],
	messages: AgentMessage[],
): Promise<{ lines: AgentSessionLine[]; messages: AgentMessage[] }> {
	const next = [...lines];
	let kept = [...messages];
	for (const { index, sku } of retry) {
		const want = requested[index];
		if (want === undefined) continue;
		const path = `lines[${String(index)}]`;
		const again = await retryAgentLine(client, cartId, {
			productId: want.productId,
			sku,
			quantity: want.quantity,
		});
		kept = kept.filter((m) => m.path !== path);
		if (again.ok) next.push(again.line);
		else kept.push({ code: again.reason, path });
	}
	const order = new Map(requested.map((l, i) => [l.productId, i]));
	const at = (productId: string): number => order.get(productId) ?? Number.MAX_SAFE_INTEGER;
	return {
		lines: next.toSorted((a, b) => at(a.productId) - at(b.productId)),
		messages: kept.toSorted((a, b) => messageLineIndex(a) - messageLineIndex(b)),
	};
}

/**
 * Lines refused OUT_OF_STOCK that the cart nevertheless holds (an earlier attempt
 * under this cart's key re-added them): counted as added, their messages dropped,
 * with the cart's own sku and quantity, so the session says what the cart holds.
 */
async function alreadyInCart(
	client: CommerceClient,
	cartId: string,
	requested: AgentSessionInput["lines"],
	added: { lines: AgentSessionLine[]; messages: AgentMessage[] },
): Promise<{ lines: AgentSessionLine[]; messages: AgentMessage[] }> {
	const refused = added.messages.filter(
		(m) => m.code === "OUT_OF_STOCK" && messageLineIndex(m) !== Number.MAX_SAFE_INTEGER,
	);
	if (refused.length === 0) return added;
	const cart = await client.getCart(cartId);
	if (!cart.ok) return added;
	const lines = [...added.lines];
	let messages = [...added.messages];
	for (const message of refused) {
		const want = requested[messageLineIndex(message)];
		const held = cart.cart.lines.find((l) => want !== undefined && l.productId === want.productId);
		if (want === undefined || held === undefined) continue;
		lines.push({
			productId: toProductId(want.productId),
			sku: toSku(held.sku),
			quantity: held.qty,
		});
		messages = messages.filter((m) => m !== message);
	}
	const order = new Map(requested.map((l, i) => [l.productId, i]));
	const at = (productId: string): number => order.get(productId) ?? Number.MAX_SAFE_INTEGER;
	return { lines: lines.toSorted((a, b) => at(a.productId) - at(b.productId)), messages };
}

/** A message's line index; non-line messages sort last. */
function messageLineIndex(m: AgentMessage): number {
	const match = /^lines\[(\d+)\]$/.exec(m.path);
	return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

/** Release `cartId` unless the session now points at it (a same-body twin's write). */
async function releaseUnlessAttached(
	ctx: PluginContext,
	deps: AgentSessionDeps,
	sessionId: AgentSessionId,
	cartId: string,
): Promise<void> {
	try {
		if ((await deps.store.get(sessionId))?.cartId === cartId) return;
	} catch {
		return;
	}
	await releaseCart(ctx, cartId);
}

function writeAnswer(result: Awaited<ReturnType<typeof replaceAgentSession>>): AgenticWriteResult {
	if (!result.ok) return { ok: false, reason: result.reason };
	return {
		ok: true,
		...NO_STORE,
		replayed: result.replayed,
		session: sessionWire(result.session),
		handoffToken: result.handoffToken ?? null,
		messages: result.messages ?? [],
	};
}

// ── session/cancel and session/complete ────────────────────────────────────

export function createAgenticSessionCancelHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticWriteResult> =>
		guarded(AGENTIC_SESSION_CANCEL_ROUTE, ctx, async (deps) => {
			const keyed = parseKeyedSessionInput(routeCtx.input);
			if (keyed === null) return INVALID_INPUT;
			const before = await deps.store.get(keyed.sessionId);
			const result = await cancelAgentSession(deps, {
				...keyed,
				fingerprint: `cancel:${keyed.idempotencyKey}`,
			});
			// Release the agent cart's holds (best-effort): only a cart the agent
			// built — never one a shopper redeemed into. Decided on the session AS THE
			// CANCEL LEFT IT: a redeem that won the race in between makes it handed
			// off, and then the cart is the shopper's and is never released.
			// The cart id is read from the STORE (the view never carries one): the
			// agent's own cart, never the shopper's (`shopperCartId`, a separate cart).
			if (result.ok && !result.replayed && !result.session.handedOff) {
				const cartId = (await deps.store.get(keyed.sessionId))?.cartId ?? before?.cartId;
				if (cartId !== undefined) await releaseCart(ctx, cartId);
			}
			return writeAnswer(result);
		});
}

/** Remove every line of `cartId`, releasing its holds. Never throws (logged). */
async function releaseCart(ctx: PluginContext, cartId: string): Promise<void> {
	try {
		const client = await makeCommerceClient(ctx);
		const cart = await client.getCart(cartId);
		if (!cart.ok || cart.cart.state !== "active") return;
		for (const line of cart.cart.lines) {
			await client.removeCartLine(cartId, line.lineId, `agentic:${cartId}:cancel:${line.lineId}`);
		}
	} catch {
		console.error("[otta] agentic: a canceled session's cart holds could not be released");
	}
}

export function createAgenticSessionCompleteHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticWriteResult> =>
		guarded(AGENTIC_SESSION_COMPLETE_ROUTE, ctx, async (deps) => {
			const keyed = parseKeyedSessionInput(routeCtx.input);
			if (keyed === null) return INVALID_INPUT;
			const result = await completeAgentSession(deps, {
				...keyed,
				fingerprint: `complete:${keyed.idempotencyKey}`,
			});
			return writeAnswer(result);
		});
}

// ── handoff/redeem ─────────────────────────────────────────────────────────

/** What the shopper's checkout form is filled with. Absent ⇒ null. */
export interface AgentHandoffPrefill {
	email: string | null;
	phone: string | null;
	address: OrderAddress | null;
	shippingMethodId: string | null;
	couponCode: string | null;
}

export type AgenticRedeemResult =
	| {
			ok: true;
			noStore: true;
			cartId: string;
			cookie: CartCookieDescriptor;
			prefill: AgentHandoffPrefill;
			/** Lines the shopper's cart could not take (no longer sold, out of stock). */
			messages: AgentMessage[];
	  }
	/** The link was good but not ONE line fits a cart: no cart, no cookie. */
	| { ok: false; reason: "HANDOFF_NO_LINES"; messages: AgentMessage[] }
	| Common;

/**
 * Every line's stock is still held for this cart: a live reservation, or a line
 * that takes none (a digital product: no reservation and no deadline). A line
 * whose hold has lapsed (or that lost its reservation) is not held.
 */
export function allHeld(cart: Pick<CartWire, "lines">, nowIso: string): boolean {
	return cart.lines.every((l) =>
		l.reservationId === null ? l.expiresAt === null : l.expiresAt === null || l.expiresAt > nowIso,
	);
}

/** The browser's redeemer nonce cookie (ADR-0047). The site's landing GET for a
 *  hand-off link sets it (a random value, once per browser) and its redeem shim
 *  reads it back and passes it as the route's `redeemer` input: a sandboxed route
 *  never sees a cookie header. Missing ⇒ `HANDOFF_REDEEMER_MISSING`, retryable. */
export const AGENTIC_REDEEMER_COOKIE_NAME = "otta_agentic_redeemer";
/** The nonce outlives the hand-off's re-entry window (15 min) comfortably. */
export const AGENTIC_REDEEMER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

/** The cookie the site sets on the landing GET, in the cart cookie's shape. */
export function agenticRedeemerCookieDescriptor(nonce: string): CartCookieDescriptor {
	return {
		...cartCookieDescriptor(nonce),
		name: AGENTIC_REDEEMER_COOKIE_NAME,
		maxAgeSeconds: AGENTIC_REDEEMER_COOKIE_MAX_AGE_SECONDS,
	};
}

/**
 * The shopper's half (ADR-0047 "hand-off link"), in three steps so no transient
 * failure kills the link:
 *  1. CLAIM the link with a short lease (`claimAgentHandoff`): other redeems get
 *     `HANDOFF_IN_PROGRESS` and agent writes are held off; nothing is spent yet.
 *  2. Build the SHOPPER'S cart: a cart keyed by an HMAC under the server key of
 *     the session and the token, so a retry (any claim) converges on the same one
 *     and the agent can never name it. The agent's cart is never handed over.
 *     Lines a prior attempt left held are kept; an OUT_OF_STOCK line whose stock
 *     the agent's cart holds is moved over (removed there, added here).
 *  3. FINALIZE (`finalizeAgentHandoff`) records it as `shopperCartId`; only then
 *     are the agent cart's holds released and the cookie answered.
 * ANY failure after the claim — a throw included — releases the claim, so the
 * link can be redeemed again at once. A cart that takes no line is
 * `HANDOFF_NO_LINES` and never finalizes. The same browser re-opening a
 * finalized link re-enters the same cart, unless it has become an order.
 * Prices are never carried: the checkout re-quotes the cart from scratch.
 */
export function createAgenticHandoffRedeemHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticRedeemResult> =>
		guarded(AGENTIC_HANDOFF_REDEEM_ROUTE, ctx, async (deps, serverKey) => {
			const token = parseSecret(fieldOf(routeCtx.input, "token"));
			if (token === null) return { ok: false as const, reason: "HANDOFF_INVALID" };
			const raw = fieldOf(routeCtx.input, "redeemer");
			const redeemer = typeof raw === "string" ? raw : "";
			const claimed = await claimAgentHandoff(deps, { token, redeemer });
			if (!claimed.ok) return { ok: false as const, reason: claimed.reason };
			if (claimed.status === "reentered") {
				const client = await makeCommerceClient(ctx);
				// Never hand back a cart a checkout already turned into an order.
				const cart = await client.getCart(claimed.shopperCartId);
				if (!cart.ok || cart.cart.state !== "active" || cart.cart.orderId !== null) {
					return { ok: false as const, reason: "HANDOFF_USED" };
				}
				return redeemAnswer(claimed.session, claimed.shopperCartId, []);
			}
			const release = async (): Promise<void> => {
				try {
					await releaseAgentHandoffClaim(deps, {
						sessionId: claimed.session.id,
						claimId: claimed.claimId,
					});
				} catch {
					console.error("[otta] agentic: a hand-off claim could not be released");
				}
			};
			try {
				// Inside the try: a client that cannot be made still releases the claim.
				const client = await makeCommerceClient(ctx);
				const built = await buildShopperCart(ctx, client, deps, serverKey, token, claimed);
				if (built.lines === 0) {
					await release();
					return {
						ok: false as const,
						reason: "HANDOFF_NO_LINES" as const,
						messages: built.messages,
					};
				}
				const done = await finalizeAgentHandoff(deps, {
					sessionId: claimed.session.id,
					claimId: claimed.claimId,
					cartId: built.cartId,
				});
				if (!done.ok) {
					// The session can never take this cart: free its holds. A lost claim
					// keeps it: every claim of this link builds the SAME cart (keyed by the
					// session and token), so a release here would strip a takeover claim
					// mid-build; one nobody takes over frees at its hold expiry.
					if (SHOPPER_CART_DEAD.has(done.reason)) {
						await releaseUnlessShoppers(ctx, deps, claimed.session.id, built.cartId);
					} else {
						await release();
					}
					return { ok: false as const, reason: done.reason };
				}
				const agentCartId = claimed.agentCartId;
				if (agentCartId !== undefined && agentCartId !== done.shopperCartId) {
					await releaseCart(ctx, agentCartId);
				}
				return redeemAnswer(done.session, done.shopperCartId, built.messages);
			} catch (err) {
				await release();
				throw err;
			}
		});
}

/** Finalize refusals after which this claim's cart may be nobody's (checked
 *  against the session first: a claim that took over may have finalized it). */
const SHOPPER_CART_DEAD: ReadonlySet<string> = new Set([
	"HANDOFF_CANCELED",
	"HANDOFF_EXPIRED",
	"SESSION_NOT_FOUND",
]);

/** Release `cartId` unless the session records it as the shopper's. */
async function releaseUnlessShoppers(
	ctx: PluginContext,
	deps: AgentSessionDeps,
	sessionId: AgentSessionId,
	cartId: string,
): Promise<void> {
	try {
		if ((await deps.store.get(sessionId))?.shopperCartId === cartId) return;
	} catch {
		return;
	}
	await releaseCart(ctx, cartId);
}

function redeemAnswer(
	session: AgentSessionView,
	cartId: string,
	messages: AgentMessage[],
): AgenticRedeemResult {
	const buyer = session.buyer;
	const address = session.destination ?? null;
	return {
		ok: true as const,
		...NO_STORE,
		cartId,
		cookie: cartCookieDescriptor(cartId),
		prefill: {
			email: buyer?.email ?? address?.email ?? null,
			phone: buyer?.phone ?? address?.phone ?? null,
			address,
			shippingMethodId: session.shippingMethodId ?? null,
			couponCode: session.couponCode ?? null,
		},
		messages,
	};
}

/**
 * Step 2 of the redeem: the shopper's cart, holding every session line it can.
 * Keyed by an HMAC of the session and the token under the server key, so every
 * claim of this link lands in ONE cart. A line it already holds (a prior
 * attempt's, still held, same sku and quantity) is kept; any other line in it is
 * removed first. New lines go in under claim-scoped keys (a refusal one claim
 * consumed never replays into the next). A line refused OUT_OF_STOCK whose stock
 * the agent's cart still holds is moved: added here first, and only if that is
 * still refused for stock is the agent's line removed and the add tried once
 * more. Last, each line is capped at the session's quantity (`capLines`).
 */
async function buildShopperCart(
	ctx: PluginContext,
	client: CommerceClient,
	deps: AgentSessionDeps,
	serverKey: Uint8Array,
	token: string,
	claimed: { claimId: string; session: AgentSessionView; agentCartId?: string },
): Promise<{ cartId: string; lines: number; messages: AgentMessage[] }> {
	const { session, claimId } = claimed;
	const nowIso = deps.clock.now().toISOString();
	const requested = session.lines.map((l) => ({
		productId: l.productId as string,
		sku: l.sku as string,
		quantity: l.quantity,
	}));
	const key = await agenticCartKey(serverKey, "shopper", [session.id, token]);
	const { cartId } = await client.createCart(session.currency, key);
	const read = await client.getCart(cartId);
	if (!read.ok || read.cart.state !== "active" || read.cart.orderId !== null) {
		throw new Error("the shopper's cart cannot be used");
	}
	const kept = new Set<string>();
	for (const line of read.cart.lines) {
		const want = requested.find((r) => r.productId === line.productId);
		const keep =
			want !== undefined &&
			!kept.has(want.productId) &&
			want.sku === line.sku &&
			want.quantity === line.qty &&
			allHeld({ lines: [line] }, nowIso);
		if (keep) {
			kept.add(line.productId ?? "");
			continue;
		}
		await client.removeCartLine(
			cartId,
			line.lineId,
			`agentic:${cartId}:${claimId}:drop:${line.lineId}`,
		);
	}
	const toAdd = requested.map((r) => (kept.has(r.productId) ? null : r));
	const added = await addAgentLines(
		client,
		cartId,
		session.currency,
		toAdd.filter((r): r is NonNullable<typeof r> => r !== null),
		claimId,
	);
	// `addAgentLines` indexes its messages over the lines it was given: map them
	// back to the session's own line indexes.
	const indexOf = toAdd.flatMap((r, i) => (r === null ? [] : [i]));
	let messages = added.messages.map((m) => {
		const at = /^lines\[(\d+)\]$/.exec(m.path);
		const original = at === null ? undefined : indexOf[Number(at[1])];
		return original === undefined ? m : { ...m, path: `lines[${String(original)}]` };
	});
	let lines = kept.size + added.lines.length;
	const agentCartId = claimed.agentCartId;
	const outOfStock = messages.filter((m) => m.code === "OUT_OF_STOCK");
	if (outOfStock.length > 0 && agentCartId !== undefined) {
		const agentCart = await client.getCart(agentCartId);
		for (const message of outOfStock) {
			const want = requested[messageLineIndex(message)];
			if (!agentCart.ok || want === undefined) continue;
			const held = agentCart.cart.lines.find(
				(l) => l.productId === want.productId && allHeld({ lines: [l] }, nowIso),
			);
			if (held === undefined) continue;
			// Add first: stock freed since the refusal goes straight to the shopper,
			// and the agent's hold is only given up for a line that still needs it.
			let again = await retryAgentLine(client, cartId, want, `${claimId}:handover`);
			if (again.ok || again.reason === "OUT_OF_STOCK") {
				await client.removeCartLine(
					agentCartId,
					held.lineId,
					`agentic:${agentCartId}:${claimId}:handover:${held.lineId}`,
				);
			}
			if (!again.ok && again.reason === "OUT_OF_STOCK") {
				again = await retryAgentLine(client, cartId, want, claimId);
			}
			messages = messages.filter((m) => m !== message);
			if (again.ok) lines++;
			else messages.push({ code: again.reason, path: message.path });
		}
		messages = messages.toSorted((a, b) => messageLineIndex(a) - messageLineIndex(b));
	}
	await capLines(client, cartId, requested, claimId);
	return { cartId, lines, messages };
}

/**
 * At most the session's quantity of each line: an add re-adding a sku merges
 * into its line, so two claims of one link adding at once could double it. A
 * refused cap is retried once on a fresh read of the cart (under a fresh key: a
 * refused key replays its refusal); refused again, the attempt fails (throws),
 * so its claim is released rather than a doubled line handed over.
 */
async function capLines(
	client: CommerceClient,
	cartId: string,
	requested: ReadonlyArray<{ productId: string; quantity: number }>,
	claimId: string,
): Promise<void> {
	for (const attempt of ["cap", "cap-retry"] as const) {
		const read = await client.getCart(cartId);
		if (!read.ok) throw new Error("the shopper's cart cannot be read");
		let refused = false;
		for (const line of read.cart.lines) {
			const want = requested.find((r) => r.productId === line.productId);
			if (want === undefined || line.qty <= want.quantity) continue;
			const capped = await client.adjustCartLine(
				cartId,
				line.lineId,
				want.quantity,
				`agentic:${cartId}:${claimId}:${attempt}:${line.lineId}`,
			);
			if (!capped.ok) refused = true;
		}
		if (!refused) return;
	}
	throw new Error("a shopper's line could not be capped at the session's quantity");
}

// ── order (status by order secret) ─────────────────────────────────────────

export type AgenticOrderResult =
	| {
			ok: true;
			sessionStatus: string;
			/** The order the hand-off placed, its state only; null before one exists. */
			order: { id: string; state: string } | null;
	  }
	| Common;

export function createAgenticOrderHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticOrderResult> =>
		guarded(AGENTIC_ORDER_ROUTE, ctx, async (deps) => {
			const sessionId = parseSessionId(fieldOf(routeCtx.input, "sessionId"));
			const secret = parseSecret(fieldOf(routeCtx.input, "orderSecret"));
			if (sessionId === null || secret === null) {
				return { ok: false as const, reason: "ORDER_SECRET_INVALID" };
			}
			const verified = await verifyAgentOrderSecret(deps, { sessionId, secret });
			if (!verified.ok) return { ok: false as const, reason: verified.reason };
			const orderId = verified.session.orderId;
			if (orderId === undefined) {
				return { ok: true as const, sessionStatus: verified.session.status, order: null };
			}
			const client = await makeCommerceClient(ctx);
			const order = await client.getPublicOrder(orderId);
			return {
				ok: true as const,
				sessionStatus: verified.session.status,
				order: order.ok ? { id: orderId, state: order.order.state } : null,
			};
		});
}

// ── status ─────────────────────────────────────────────────────────────────

export type AgenticStatusResult = { ok: true; enabled: true } | NotFound | RenderGuardFailure;

/** Whether this store takes agentic checkouts: `NOT_FOUND` while it does not. */
export function createAgenticStatusHandler(): RouteHandler<unknown> {
	return (_routeCtx, ctx): Promise<AgenticStatusResult> =>
		renderGuard(AGENTIC_STATUS_ROUTE, async () =>
			(await readAgenticEnabled(ctx)) ? { ok: true as const, enabled: true as const } : NOT_FOUND,
		);
}

function fieldOf(input: unknown, field: string): unknown {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)[field]
		: undefined;
}
