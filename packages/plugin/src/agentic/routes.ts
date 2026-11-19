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
	getAgentSession,
	isAgentSessionHandedOff,
	recordAgentHandoffCart,
	redeemAgentHandoff,
	replaceAgentSession,
	verifyAgentOrderSecret,
	type AgentSessionContent,
	type AgentSessionDeps,
	type AgentSessionLine,
	type AgentSessionView,
	type OrderAddress,
} from "@urumi.ai/otta-domain";
import { hashToken, WebCryptoAgentSessionSecrets } from "@urumi.ai/otta-store-emdash";
import { CART_LINE_MAX_QTY } from "../commerce/commerce-input.js";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import { makeCommerceClient } from "../commerce/make-commerce-client.js";
import { codRequestFacts, networkKey } from "../payments/cod-request.js";
import type { CartWire, CommerceClient } from "../product-commerce/commerce-client.js";
import { cartCookieDescriptor, type CartCookieDescriptor } from "../storefront/cart-routes.js";
import { renderGuard, type RenderGuardFailure } from "../storefront/pdp-route.js";
import type { PluginContext, RouteHandler, SandboxedRequest } from "../types.js";
import { addAgentLines, buildAgentCart, quoteAgentCart, type AgentMessage } from "./cart-quote.js";
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

/** The domain deps, or `null` (logged) when the server key cannot be had. */
async function agentDeps(ctx: PluginContext): Promise<AgentSessionDeps | null> {
	const key = await readAgenticServerKey(ctx);
	if (key === null) return null;
	const stores = createInProcessCommerceStores(ctx);
	return {
		store: stores.agentSessionStore,
		clock: stores.clock,
		secrets: new WebCryptoAgentSessionSecrets(key),
		limits: { maxLineQuantity: CART_LINE_MAX_QTY },
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
	body: (deps: AgentSessionDeps) => Promise<T>,
): Promise<T | NotFound | Unavailable | RenderGuardFailure> {
	return renderGuard(route, async () => {
		if (!(await readAgenticEnabled(ctx))) return NOT_FOUND;
		const deps = await agentDeps(ctx);
		if (deps === null) return UNAVAILABLE;
		return body(deps);
	});
}

/** The trusted network key of the request (the COD path: Cloudflare's client
 *  address, HMAC'd under the store's secret), never a client-supplied value. */
async function requestNetworkKey(
	ctx: PluginContext,
	request: SandboxedRequest | undefined,
): Promise<string | null> {
	const network = codRequestFacts(request).network;
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
	const quoted =
		built.lines.length === 0
			? { quote: undefined, messages: [] }
			: await quoteAgentCart(client, built.cartId, selectionOf(input), nowIso);
	const content: AgentSessionContent = {
		currency: built.currency,
		lines: built.lines,
		cartId: built.cartId,
		...(input.buyer !== undefined ? { buyer: input.buyer } : {}),
		...(input.address !== undefined ? { destination: orderAddressOf(input.address) } : {}),
		...(input.shippingMethodId !== undefined ? { shippingMethodId: input.shippingMethodId } : {}),
		...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
		...(quoted.quote !== undefined ? { quote: quoted.quote } : {}),
	};
	return { content, messages: [...built.messages, ...quoted.messages] };
}

/** A cart key no caller can name: a digest of the write's scope and its key. */
async function agentCartKey(kind: string, scope: string, idempotencyKey: string): Promise<string> {
	return `agentic:${kind}:${await hashToken(`${scope}\u0000${idempotencyKey}`)}`;
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
		guarded(AGENTIC_SESSION_CREATE_ROUTE, ctx, async (deps) => {
			const input = parseAgentSessionInput(routeCtx.input);
			if (input === null) return INVALID_INPUT;
			const net = await requestNetworkKey(ctx, routeCtx.request);
			if (net === null) return UNAVAILABLE;
			const client = await makeCommerceClient(ctx);
			const built = await contentFor(
				client,
				await agentCartKey("create", net, input.idempotencyKey),
				input,
				deps.clock.now().toISOString(),
			);
			if (!("content" in built)) return built;
			const result = await createAgentSession(deps, {
				networkKey: net,
				idempotencyKey: input.idempotencyKey,
				fingerprint: await fingerprintOf(input, "create"),
				content: built.content,
			});
			if (!result.ok) return { ok: false as const, reason: result.reason };
			return {
				ok: true as const,
				...NO_STORE,
				replayed: result.replayed,
				session: sessionWire(result.session),
				orderSecret: result.orderSecret,
				handoffToken: result.handoffToken ?? null,
				messages: built.messages,
			};
		});
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
		guarded(AGENTIC_SESSION_UPDATE_ROUTE, ctx, async (deps) => {
			const sessionId = parseSessionId(fieldOf(routeCtx.input, "sessionId"));
			const input = parseAgentSessionInput(routeCtx.input);
			if (input === null) return INVALID_INPUT;
			if (sessionId === null) return { ok: false as const, reason: "SESSION_NOT_FOUND" };
			// Read first: a session that cannot be written gets no cart built for it.
			const current = await getAgentSession(deps, { sessionId });
			if (!current.ok) return { ok: false as const, reason: current.reason };
			const client = await makeCommerceClient(ctx);
			const built = await contentFor(
				client,
				await agentCartKey("replace", sessionId, input.idempotencyKey),
				input,
				deps.clock.now().toISOString(),
			);
			if (!("content" in built)) return built;
			const result = await replaceAgentSession(deps, {
				sessionId,
				idempotencyKey: input.idempotencyKey,
				fingerprint: await fingerprintOf(input, "replace"),
				content: built.content,
			});
			return writeAnswer(result, built.messages);
		});
}

function writeAnswer(
	result: Awaited<ReturnType<typeof replaceAgentSession>>,
	messages: AgentMessage[],
): AgenticWriteResult {
	if (!result.ok) return { ok: false, reason: result.reason };
	return {
		ok: true,
		...NO_STORE,
		replayed: result.replayed,
		session: sessionWire(result.session),
		handoffToken: result.handoffToken ?? null,
		messages,
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
			// built — never one a shopper redeemed into.
			if (result.ok && !result.replayed && before !== null && !isAgentSessionHandedOff(before)) {
				const cartId = before.cartId;
				if (cartId !== undefined) await releaseCart(ctx, cartId);
			}
			return writeAnswer(result, []);
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
			return writeAnswer(result, []);
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

/** The cart holds exactly the session's lines, and can still be checked out. */
function cartMatches(cart: CartWire, lines: readonly AgentSessionLine[]): boolean {
	if (cart.state !== "active" || cart.orderId !== null) return false;
	if (cart.lines.length !== lines.length) return false;
	const want = new Map(lines.map((l) => [`${l.productId}\u0000${l.sku}`, l.quantity]));
	return cart.lines.every((l) => want.get(`${l.productId ?? ""}\u0000${l.sku}`) === l.qty);
}

/**
 * The shopper's half (ADR-0047 "hand-off link"): the link is marked used
 * ATOMICALLY first (exactly one of any number of racing redeems wins), then the
 * session's cart is re-adopted when it still holds the same lines, else a new cart
 * is built from them. Prices are never carried: the checkout the shopper lands on
 * re-quotes the cart from scratch. The cart is marked agent-originated by pointing
 * the session at it, which is what attributes the order placed from it.
 */
export function createAgenticHandoffRedeemHandler(): RouteHandler<unknown> {
	return (routeCtx, ctx): Promise<AgenticRedeemResult> =>
		guarded(AGENTIC_HANDOFF_REDEEM_ROUTE, ctx, async (deps) => {
			const token = parseSecret(fieldOf(routeCtx.input, "token"));
			if (token === null) return { ok: false as const, reason: "HANDOFF_INVALID" };
			const redeemed = await redeemAgentHandoff(deps, { token });
			if (!redeemed.ok) return { ok: false as const, reason: redeemed.reason };
			const session = redeemed.session;
			const client = await makeCommerceClient(ctx);
			let cartId: string | null = null;
			let messages: AgentMessage[] = [];
			if (session.cartId !== undefined) {
				const existing = await client.getCart(session.cartId);
				if (existing.ok && cartMatches(existing.cart, session.lines)) cartId = session.cartId;
			}
			if (cartId === null) {
				// Single-use, so no replay to dedupe: a fresh cart each time.
				const { cartId: fresh } = await client.createCart(session.currency);
				const added = await addAgentLines(
					client,
					fresh,
					session.currency,
					session.lines.map((l) => ({ productId: l.productId, sku: l.sku, quantity: l.quantity })),
				);
				messages = added.messages;
				if (added.lines.length === 0) {
					return { ok: false as const, reason: "HANDOFF_NO_LINES" as const, messages };
				}
				cartId = fresh;
			}
			const marked = await recordAgentHandoffCart(deps, { sessionId: session.id, cartId });
			if (!marked.ok) {
				// Reason code only: the order placed from this cart goes unattributed.
				console.warn(`[otta] agentic: redeemed cart not marked (${marked.reason})`);
			}
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
		});
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
