/**
 * ADR-0047: hand-validated input for the agentic routes (PUBLIC, ADR-0003). A
 * present-but-malformed field is `null` (the route's `INVALID_INPUT`), never a
 * silent drop. Bounds are the commerce client's own, so nothing that passes here
 * makes the client throw.
 */
import {
	AGENT_SESSION_ID_PREFIX,
	AGENT_SESSION_MAX_IDEMPOTENCY_KEY_LENGTH,
	AGENT_SESSION_MAX_LINES,
	agentSessionId,
	isWellFormedText,
	type AgentSessionBuyer,
	type AgentSessionId,
	type OrderAddress,
} from "@urumi.ai/otta-domain";
import { CART_LINE_MAX_QTY, isIdToken } from "../commerce/commerce-input.js";
import type { ShippingAddressWire } from "../product-commerce/commerce-client.js";
import { parseShippingAddress } from "../storefront/checkout-route-input.js";
import type { AgentLineRequest, AgentSelection } from "./cart-quote.js";

/** Session ids are `cs_` + base64url; anything else names no session. */
const SESSION_ID_SHAPE = /^cs_[A-Za-z0-9_-]{16,64}$/;
/** A hand-off token or order secret: base64url, bounded. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const BUYER_FIELD_MAX = 200;
const COUPON_MAX = 64;
const PRODUCT_ID_MAX = 200;
const SKU_MAX = 200;

export interface AgentSessionInput {
	idempotencyKey: string;
	currency?: string;
	lines: AgentLineRequest[];
	buyer?: AgentSessionBuyer;
	address?: ShippingAddressWire;
	shippingMethodId?: string;
	couponCode?: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Absent or null ⇒ undefined; otherwise a trimmed, well-formed, bounded string or `null`. */
function optionalText(value: unknown, max: number): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length <= max && isWellFormedText(trimmed) ? trimmed : null;
}

/** The session id named by `value`, or `null` when it cannot name one. */
export function parseSessionId(value: unknown): AgentSessionId | null {
	if (typeof value !== "string" || !SESSION_ID_SHAPE.test(value)) return null;
	return value.startsWith(AGENT_SESSION_ID_PREFIX) ? agentSessionId(value) : null;
}

/** A bearer secret (hand-off token, order secret), or `null`. */
export function parseSecret(value: unknown): string | null {
	return typeof value === "string" && SECRET_SHAPE.test(value) ? value : null;
}

export function parseIdempotencyKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return value.length > 0 &&
		value.length <= AGENT_SESSION_MAX_IDEMPOTENCY_KEY_LENGTH &&
		isWellFormedText(value)
		? value
		: null;
}

function parseLines(value: unknown): AgentLineRequest[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > AGENT_SESSION_MAX_LINES) return null;
	const lines: AgentLineRequest[] = [];
	for (const item of value) {
		const raw = record(item);
		if (raw === null) return null;
		const productId = optionalText(raw["productId"], PRODUCT_ID_MAX);
		if (typeof productId !== "string") return null;
		const sku = optionalText(raw["sku"], SKU_MAX);
		if (sku === null) return null;
		const quantity = raw["quantity"];
		if (
			typeof quantity !== "number" ||
			!Number.isSafeInteger(quantity) ||
			quantity < 1 ||
			quantity > CART_LINE_MAX_QTY
		) {
			return null;
		}
		lines.push({ productId, quantity, ...(sku !== undefined ? { sku } : {}) });
	}
	return lines;
}

function parseBuyer(value: unknown): AgentSessionBuyer | undefined | null {
	if (value === undefined || value === null) return undefined;
	const raw = record(value);
	if (raw === null) return null;
	const buyer: AgentSessionBuyer = {};
	for (const field of ["email", "firstName", "lastName", "phone"] as const) {
		const text = optionalText(raw[field], BUYER_FIELD_MAX);
		if (text === null) return null;
		if (text !== undefined) buyer[field] = text;
	}
	return Object.keys(buyer).length === 0 ? undefined : buyer;
}

/** The create/update body, or `null` for INVALID_INPUT. */
export function parseAgentSessionInput(input: unknown): AgentSessionInput | null {
	const raw = record(input);
	if (raw === null) return null;
	const idempotencyKey = parseIdempotencyKey(raw["idempotencyKey"]);
	if (idempotencyKey === null) return null;
	const lines = parseLines(raw["lines"]);
	if (lines === null) return null;
	const currency = optionalText(raw["currency"], 3);
	if (currency === null || (currency !== undefined && !/^[A-Z]{3}$/.test(currency))) return null;
	const buyer = parseBuyer(raw["buyer"]);
	if (buyer === null) return null;
	let address: ShippingAddressWire | undefined;
	if (raw["destination"] !== undefined && raw["destination"] !== null) {
		const parsed = parseShippingAddress(raw["destination"]);
		if (parsed === null) return null;
		address = parsed;
	}
	const shippingMethodId = optionalText(raw["shippingMethodId"], 128);
	if (
		shippingMethodId === null ||
		(shippingMethodId !== undefined && !isIdToken(shippingMethodId))
	) {
		return null;
	}
	const couponCode = optionalText(raw["couponCode"], COUPON_MAX);
	if (couponCode === null) return null;
	return {
		idempotencyKey,
		lines,
		...(currency !== undefined ? { currency } : {}),
		...(buyer !== undefined ? { buyer } : {}),
		...(address !== undefined ? { address } : {}),
		...(shippingMethodId !== undefined ? { shippingMethodId } : {}),
		...(couponCode !== undefined ? { couponCode } : {}),
	};
}

/** The quote selection a session input asks for. */
export function selectionOf(input: AgentSessionInput): AgentSelection {
	const a = input.address;
	return {
		...(a !== undefined
			? {
					destination: {
						country: a.country,
						...(a.region !== undefined ? { region: a.region } : {}),
						postalCode: a.postalCode,
						city: a.city,
					},
				}
			: {}),
		...(input.shippingMethodId !== undefined ? { shippingMethodId: input.shippingMethodId } : {}),
		...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
	};
}

/** The session's destination (the domain's `OrderAddress`: absent fields null). */
export function orderAddressOf(a: ShippingAddressWire): OrderAddress {
	return {
		name: a.name,
		line1: a.line1,
		line2: a.line2 ?? null,
		city: a.city,
		region: a.region ?? null,
		postalCode: a.postalCode,
		country: a.country,
		email: a.email ?? null,
		phone: a.phone ?? null,
	};
}

/**
 * The body's fingerprint for idempotent replay (at most 128 characters):
 * SHA-256 of the parsed body without its key, in a fixed field order.
 */
export async function fingerprintOf(input: AgentSessionInput, scope: string): Promise<string> {
	const { idempotencyKey: _key, ...body } = input;
	const canonical = JSON.stringify([
		scope,
		body.currency ?? null,
		body.lines.map((l) => [l.productId, l.sku ?? null, l.quantity]),
		body.buyer ?? null,
		body.address ?? null,
		body.shippingMethodId ?? null,
		body.couponCode ?? null,
	]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The keyed-write body of cancel/complete: the session and its key. */
export function parseKeyedSessionInput(
	input: unknown,
): { sessionId: AgentSessionId; idempotencyKey: string } | null {
	const raw = record(input);
	if (raw === null) return null;
	const sessionId = parseSessionId(raw["sessionId"]);
	const idempotencyKey = parseIdempotencyKey(raw["idempotencyKey"]);
	return sessionId === null || idempotencyKey === null ? null : { sessionId, idempotencyKey };
}
