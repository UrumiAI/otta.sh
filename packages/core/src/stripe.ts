import type { PluginContext } from "emdash/plugin";

export type StripeFail = {
	ok: false;
	code: "STRIPE_UNAVAILABLE" | "STRIPE_REFUSED";
	message: string;
	status?: number;
	/** Stripe's error.param, when it names one (e.g. "customer_email"). */
	param?: string;
};
export type StripeResult<T> = { ok: true; value: T } | StripeFail;
export interface SessionView {
	id: string;
	url: string | null;
	status: "open" | "complete" | "expired";
	paymentStatus: "paid" | "unpaid" | "no_payment_required";
	amountTotal: number | null;
	/** Before discounts and taxes (Stripe: "Total of all items before discounts or taxes are applied"). */
	amountSubtotal: number | null;
	/** total_details.*; null when Stripe sent no total_details. */
	amountDiscount: number | null;
	amountShipping: number | null;
	amountTax: number | null;
	currency: string | null; // UPPER-cased
	paymentIntentId: string | null;
	email: string | null;
	shippingAddress: Record<string, unknown> | null;
	orderId: string | null;
	expiresAt: number | null;
	/** Unix seconds the session was created. */
	created?: number | null;
	/** metadata.otta_store: which Core install created the session. */
	storeTag?: string | null;
	/** What Stripe will actually offer (allowed_payment_method_types filters silently). */
	paymentMethodTypes?: string[] | null;
}
export interface CheckoutSessionInput {
	orderId: string;
	currency: string;
	lines: Array<{ name: string; unitAmount: number; qty: number }>;
	shipping: number;
	successUrl: string;
	cancelUrl: string;
	expiresAt: number;
	email: string | null;
	shippingCountries: string[];
	/** This install's store tag (the order's snapshot). */
	storeTag: string;
	/** Sends allow_promotion_codes (the order's snapshot, so retries send the same). */
	allowPromotionCodes: boolean;
}
export type WebhookEvent =
	| { id: string; type: string; session: SessionView }
	/** A refund changed on this payment: re-read its refunds (listRefunds). */
	| { id: string; type: string; refundOf: string };

/** Refund events Core listens to (Stripe recommends refund.created; charge.refunded also fires). */
const REFUND_EVENTS = ["charge.refunded", "refund.created", "refund.updated", "refund.failed"];

/**
 * Pinned on every call so account-default changes cannot move response shapes.
 * Changing it: read Stripe's changelog between the versions first. 2026-09-30
 * ("remove-payment-method-types-checkout-sessions") retired payment_method_types
 * on Checkout; Core uses allowed_payment_method_types and checks the result.
 * health.ts uses this same constant.
 */
export const API_VERSION = "2026-11-18.endive";
const BASE = "https://api.stripe.com/v1/checkout/sessions";
const EVENTS = [
	"checkout.session.completed",
	"checkout.session.expired",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
];

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const isUInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Flatten nested objects/arrays to Stripe's bracketed form keys. */
function enc(v: unknown, k: string, out: string[]): void {
	if (v === null || v === undefined) return;
	if (typeof v === "object")
		for (const [i, x] of Object.entries(v)) enc(x, k ? `${k}[${i}]` : i, out);
	else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
}

const fail = (code: StripeFail["code"], message: string, status?: number): StripeFail => ({
	ok: false,
	code,
	message,
	...(status ? { status } : {}),
});

function view(v: unknown): SessionView | null {
	const o = rec(v);
	if (!o) return null;
	const status = o.status as SessionView["status"];
	const paymentStatus = o.payment_status as SessionView["paymentStatus"];
	if (
		!str(o.id) ||
		!["open", "complete", "expired"].includes(status) ||
		!["paid", "unpaid", "no_payment_required"].includes(paymentStatus)
	)
		return null;
	const pi = rec(o.payment_intent);
	return {
		id: o.id as string,
		url: str(o.url),
		status,
		paymentStatus,
		amountTotal: num(o.amount_total),
		amountSubtotal: num(o.amount_subtotal),
		amountDiscount: num(rec(o.total_details)?.amount_discount),
		amountShipping: num(rec(o.total_details)?.amount_shipping),
		amountTax: num(rec(o.total_details)?.amount_tax),
		currency: str(o.currency)?.toUpperCase() ?? null,
		paymentIntentId: str(pi ? pi.id : o.payment_intent),
		email: str(rec(o.customer_details)?.email) ?? str(o.customer_email),
		shippingAddress: rec(rec(o.collected_information)?.shipping_details) ?? rec(o.shipping_details),
		orderId: str(rec(o.metadata)?.order_id),
		storeTag: str(rec(o.metadata)?.otta_store),
		created: num(o.created),
		expiresAt: num(o.expires_at),
		paymentMethodTypes: Array.isArray(o.payment_method_types)
			? o.payment_method_types.filter((x): x is string => typeof x === "string")
			: null,
	};
}

const call = (ctx: PluginContext, key: string, path: string, body?: string, idem?: string) =>
	request(ctx, key, BASE + path, view, body, idem);

async function request<T>(
	ctx: PluginContext,
	key: string,
	url: string,
	parse: (v: unknown) => T | null,
	body?: string,
	idem?: string,
): Promise<StripeResult<T>> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${key}`,
		"Stripe-Version": API_VERSION,
	};
	if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
	if (idem) headers["Idempotency-Key"] = idem;
	let res;
	try {
		res = await ctx.http!.fetch(url, {
			method: body === undefined ? "GET" : "POST",
			headers,
			body,
		});
	} catch {
		return fail("STRIPE_UNAVAILABLE", "Stripe request failed");
	}
	const s = res.status;
	if (!res.ok) {
		let m = `Stripe returned ${s}`;
		// 409 / idempotency_error: another request with this key is in flight or
		// the key's first request is still being decided. Not a refusal: the
		// session may exist, so the caller must keep its holds and retry.
		if (s < 500 && s !== 429 && s !== 409) {
			let err: Rec | null = null;
			try {
				err = rec(rec(await res.json())?.error);
			} catch {}
			m = str(err?.["message"]) ?? m;
			if (err?.["type"] === "idempotency_error")
				return fail("STRIPE_UNAVAILABLE", m.split(key).join("***"), s);
			const param = str(err?.["param"]);
			return {
				...fail("STRIPE_REFUSED", m.split(key).join("***"), s),
				...(param ? { param } : {}),
			};
		}
		return fail("STRIPE_UNAVAILABLE", m, s);
	}
	let v: T | null = null;
	try {
		v = parse(await res.json());
	} catch {}
	return v ? { ok: true, value: v } : fail("STRIPE_UNAVAILABLE", "Unexpected Stripe response", s);
}

/**
 * Refunds of a payment, read fresh (events arrive unordered and can repeat, so
 * Core never adds up event deltas; it re-reads the truth). Refunds that are
 * pending, need action or succeeded count as refunded; failed or canceled ones
 * do not. One call; up to 100 refunds per payment.
 */
export function listRefunds(
	ctx: PluginContext,
	key: string,
	paymentIntentId: string,
): Promise<
	StripeResult<{
		refunds: Array<{ id: string; amount: number; status: string; currency: string | null }>;
		complete: boolean;
	}>
> {
	const url = `https://api.stripe.com/v1/refunds?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=100`;
	return request(ctx, key, url, (v) => {
		const o = rec(v);
		if (!o || !Array.isArray(o.data)) return null;
		const refunds: Array<{ id: string; amount: number; status: string; currency: string | null }> =
			[];
		for (const r of o.data) {
			const x = rec(r);
			const id = str(x?.id);
			const amount = num(x?.amount);
			const status = str(x?.status);
			if (!x || !id || amount === null || !status) return null;
			refunds.push({ id, amount, status, currency: str(x.currency)?.toUpperCase() ?? null });
		}
		return { refunds, complete: o.has_more !== true };
	});
}

/** The Core order a PaymentIntent belongs to (our metadata.order_id), or null. One call. */
export function paymentIntentOrder(
	ctx: PluginContext,
	key: string,
	paymentIntentId: string,
): Promise<StripeResult<{ orderId: string | null }>> {
	const url = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`;
	return request(ctx, key, url, (v) => {
		const o = rec(v);
		return o && str(o.id) ? { orderId: str(rec(o.metadata)?.order_id) } : null;
	});
}

export function createCheckoutSession(
	ctx: PluginContext,
	secretKey: string,
	i: CheckoutSessionInput,
): Promise<StripeResult<SessionView>> {
	if (
		!i.lines.length ||
		!isUInt(i.shipping) ||
		i.lines.some((l) => !isUInt(l.unitAmount) || !isUInt(l.qty) || l.qty < 1)
	)
		return Promise.resolve(fail("STRIPE_REFUSED", "Invalid amounts"));
	const cur = i.currency.toLowerCase();
	const p: Rec = {
		mode: "payment",
		// Card only (card wallets included): no async payment methods, so a session that
		// expired can never be paid later (S-b). Since API 2026-09-30 Stripe refuses
		// payment_method_types on Checkout ("payment methods are now managed from your
		// Dashboard"); allowed_payment_method_types filters what the Dashboard enables.
		// Verified in test mode at the pinned version: payment_method_types => ["card"].
		allowed_payment_method_types: ["card"],
		// The buyer pays the store's currency and amount. With Adaptive Pricing on, a
		// webhook rendered in an older API version reports the buyer's converted
		// currency and amount, which the amount check (L5) would send to review.
		adaptive_pricing: { enabled: false },
		line_items: i.lines.map((l) => ({
			quantity: l.qty,
			price_data: { currency: cur, unit_amount: l.unitAmount, product_data: { name: l.name } },
		})),
		client_reference_id: i.orderId,
		metadata: { order_id: i.orderId, otta_store: i.storeTag },
		payment_intent_data: { metadata: { order_id: i.orderId, otta_store: i.storeTag } },
		success_url: i.successUrl,
		cancel_url: i.cancelUrl,
		expires_at: i.expiresAt,
		customer_email: i.email,
	};
	if (i.allowPromotionCodes) p.allow_promotion_codes = true;
	if (i.shippingCountries.length)
		p.shipping_address_collection = { allowed_countries: i.shippingCountries };
	if (i.shipping > 0)
		p.shipping_options = [
			{
				shipping_rate_data: {
					type: "fixed_amount",
					display_name: "Shipping",
					fixed_amount: { amount: i.shipping, currency: cur },
				},
			},
		];
	const out: string[] = [];
	enc(p, "", out);
	return call(ctx, secretKey, "", out.join("&"), `otta-core-${i.storeTag}-${i.orderId}`);
}

/**
 * Completed Checkout Sessions created since `sinceSec`, one page of up to 100.
 * One call. Lets the sweep record payments with no webhook configured.
 * Stripe's list API (docs.stripe.com/api/checkout/sessions/list) filters by
 * `status` and `created`, returns newest first, and pages with
 * `starting_after` (the last id of the previous page).
 */
export function listCompletedSessions(
	ctx: PluginContext,
	key: string,
	sinceSec: number,
	startingAfter: string | null = null,
): Promise<StripeResult<{ sessions: SessionView[]; complete: boolean; lastId: string | null }>> {
	const after = startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : "";
	const url = `${BASE}?status=complete&created[gte]=${Math.floor(sinceSec)}&limit=100${after}`;
	return request(ctx, key, url, (v) => {
		const o = rec(v);
		if (!o || !Array.isArray(o.data)) return null;
		const sessions: SessionView[] = [];
		for (const x of o.data) {
			const sv = view(x);
			if (sv) sessions.push(sv);
		}
		const last = rec(o.data[o.data.length - 1]);
		return { sessions, complete: o.has_more !== true, lastId: str(last?.id) };
	});
}

export const retrieveSession = (ctx: PluginContext, key: string, id: string) =>
	call(ctx, key, `/${encodeURIComponent(id)}`);

export const expireSession = (ctx: PluginContext, key: string, id: string) =>
	call(ctx, key, `/${encodeURIComponent(id)}/expire`, "");

const hmac = { name: "HMAC", hash: "SHA-256" };

function fromHex(h: string): Uint8Array<ArrayBuffer> | null {
	if (h.length % 2 || !/^[0-9a-f]*$/i.test(h)) return null;
	const o = new Uint8Array(h.length / 2);
	for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return o;
}

export async function verifyWebhook(
	secret: string,
	rawBody: Uint8Array,
	signature: string | undefined,
	nowSec: number,
): Promise<
	| { ok: true; event: WebhookEvent }
	| { ok: false; reason: "INVALID_SIGNATURE" | "MALFORMED" | "IGNORED" }
> {
	const bad = { ok: false, reason: "INVALID_SIGNATURE" } as const;
	let t: string | undefined;
	const v1: string[] = [];
	for (const part of (signature ?? "").split(",")) {
		const [k, v] = part.split("=", 2);
		if (k === "t") t = v;
		else if (k === "v1" && v !== undefined) v1.push(v);
	}
	if (t === undefined || !v1.length || !Number.isFinite(Number(t))) return bad;
	if (Math.abs(nowSec - Number(t)) > 300) return bad;
	const head = new TextEncoder().encode(`${t}.`);
	const msg = new Uint8Array(head.length + rawBody.length);
	msg.set(head);
	msg.set(rawBody, head.length);
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), hmac, false, [
		"verify",
	]);
	let ok = false;
	for (const c of v1) {
		const b = fromHex(c);
		if (b && (await crypto.subtle.verify("HMAC", key, b, msg))) ok = true;
	}
	if (!ok) return bad;
	let e: Rec | null;
	try {
		e = rec(JSON.parse(new TextDecoder().decode(rawBody)));
	} catch {
		e = null;
	}
	const id = str(e?.id);
	const type = str(e?.type);
	if (!id || !type) return { ok: false, reason: "MALFORMED" };
	const obj = rec(rec(e?.data)?.object);
	if (REFUND_EVENTS.includes(type)) {
		const piv = obj?.payment_intent;
		const pi = str(rec(piv)?.id) ?? str(piv);
		return pi && (obj?.object === "charge" || obj?.object === "refund")
			? { ok: true, event: { id, type, refundOf: pi } }
			: { ok: false, reason: "IGNORED" };
	}
	if (!EVENTS.includes(type)) return { ok: false, reason: "IGNORED" };
	const session = obj?.object === "checkout.session" ? view(obj) : null;
	// Signed, but not a session Core can read: acknowledge it (a 400 would make Stripe
	// retry for days and eventually disable the endpoint).
	return session ? { ok: true, event: { id, type, session } } : { ok: false, reason: "IGNORED" };
}
