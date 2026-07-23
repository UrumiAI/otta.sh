import {
	cents,
	currency as toCurrency,
	orderId as toOrderId,
	type ClientAction,
	type Clock,
	type ConfirmationResult,
	type CreateIntentInput,
	type PaymentGateway,
	type PaymentIntentHandle,
	type RawConfirmation,
	type RefundInput,
	type RefundResult,
} from "@urumi/domain";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Default replay-window tolerance for the signed `t` timestamp — 300s, matching
 *  Stripe's own recommended default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface StripePaymentGatewayOptions {
	/**
	 * Stripe webhook signing secret (`whsec_…`). SERVICE-ENV ONLY (CLAUDE.md) —
	 * never in the plugin / `ctx.kv`. Used to HMAC-verify the raw webhook body.
	 */
	webhookSecret: string;
	/**
	 * Stripe secret key (`sk_…`); SERVICE-ENV ONLY (CLAUDE.md). Reserved for real
	 * intent creation (Phase 4 creates the client handle offline — see
	 * `createIntent`) AND now REQUIRED for the live refund path (ADR-0008): the
	 * refund-time pre-flight (`GET`) and `refunds.create` both authenticate with
	 * it. **Unset ⇒ `refundable` is false** — the adapter has no credential to call
	 * the refund API with, surfaced honestly rather than failing on first use.
	 */
	secretKey?: string;
	/**
	 * The outbound Stripe transport for the refund path (ADR-0008) — the test seam.
	 * Injected in tests with a mock playing recorded Stripe responses (keeping the
	 * suite offline, the same philosophy as the offline fake-Stripe webhook
	 * driver). In production, omit it: when `secretKey` is set the adapter builds a
	 * default `fetch`-backed transport ({@link createStripeHttpTransport}) — the
	 * repo's FIRST live outbound Stripe calls.
	 */
	transport?: StripeTransport;
	/** Injectable `fetch` for the DEFAULT http transport (used only when
	 *  `transport` is omitted and `secretKey` is set). Defaults to the global. */
	fetch?: typeof fetch;
	/** Freshness window for the signed `t` timestamp (replay hardening): a webhook
	 *  whose `|now − t|` exceeds this is rejected as INVALID_SIGNATURE even when the
	 *  HMAC matches. Defaults to {@link DEFAULT_TOLERANCE_SECONDS}. */
	toleranceSeconds?: number;
	/** Injectable time source for the freshness check; defaults to system time. */
	clock?: Clock;
}

/**
 * The outbound Stripe transport the refund path drives (ADR-0008). Two calls, both
 * requiring the real `secretKey`:
 *  - `readRefundedAmount` — the mandatory refund-time PRE-FLIGHT: read the
 *    charge/PaymentIntent's already-refunded + captured amounts so the adapter can
 *    fail closed on divergence BEFORE issuing anything.
 *  - `createRefund` — `POST /v1/refunds`, passing our `idempotencyKey` as Stripe's
 *    native `Idempotency-Key`.
 *
 * Every method returns a NORMALIZED result with an explicit error CLASS — never a
 * thrown Stripe SDK error — so the adapter maps a clean taxonomy (retryable /
 * terminal / ambiguous-timeout) into the port's {@link RefundResult}.
 */
export interface StripeTransport {
	readRefundedAmount(input: {
		providerRef: string;
		secretKey: string;
	}): Promise<StripePreflightResult>;
	createRefund(input: {
		providerRef: string;
		amountCents: number;
		idempotencyKey: string;
		secretKey: string;
	}): Promise<StripeCreateRefundResult>;
}

/** The provider's live refund view for the pre-flight (minor units). */
export interface StripeRefundedView {
	/** Amount already refunded provider-side (`amount_refunded`). */
	amountRefunded: number;
	/** Amount captured provider-side — the provider's own refund ceiling. */
	amountCaptured: number;
	currency: string;
}

/** A READ failure: `retryable` (network / 5xx — the read issued nothing, always
 *  safe to retry) or `terminal` (4xx — e.g. the charge id is unknown). */
export type StripePreflightResult =
	| { ok: true; view: StripeRefundedView }
	| { ok: false; class: "retryable" | "terminal" };

/** A `createRefund` failure class: `retryable` (definitely not processed — a 5xx
 *  Stripe explicitly did-not-process), `terminal` (a definite 4xx rejection), or
 *  `ambiguous` (network error / timeout — fate UNKNOWN, must be re-checked, never
 *  blind-retried). */
export type StripeCreateRefundResult =
	| { ok: true; refundId: string; amountCents: number; currency: string }
	| { ok: false; class: "retryable" | "terminal" | "ambiguous" };

/**
 * Stripe `PaymentGateway` adapter (§5, step 4.6). `verifyConfirmation` is the
 * correctness-critical path: it HMAC-verifies the `Stripe-Signature` header over
 * the **exact raw body** (no JSON re-parse before verify) using the scheme
 * `HMAC-SHA256(secret, "{t}.{rawBody}")`, then parses the event. All secrets live
 * here, never in the domain.
 *
 * `createIntent` returns the Stripe client-secret handle. Phase 4 constructs it
 * offline (deterministic, NO network) so the whole suite runs without Stripe; a
 * real deployment injects `secretKey` and calls `paymentIntents.create` here. The
 * webhook the buyer's payment triggers still carries `metadata.order_id`, which is
 * how settlement maps back to the order — so the offline handle is sufficient for
 * the verified-settlement contract.
 */
export class StripePaymentGateway implements PaymentGateway {
	readonly id = "stripe" as const;
	/** True iff a `secretKey` is configured (ADR-0008): the refund path needs it
	 *  for both the pre-flight read and `refunds.create`. Unset ⇒ the admin UI
	 *  honestly shows Stripe refunds as unavailable rather than the button no-oping. */
	readonly refundable: boolean;
	readonly #secret: string;
	readonly #secretKey: string | undefined;
	readonly #transport: StripeTransport | undefined;
	readonly #toleranceSeconds: number;
	readonly #clock: Clock;

	constructor(options: StripePaymentGatewayOptions) {
		if (options.webhookSecret.length === 0) {
			throw new Error("StripePaymentGateway requires a non-empty webhookSecret");
		}
		this.#secret = options.webhookSecret;
		const secretKey =
			options.secretKey !== undefined && options.secretKey.length > 0
				? options.secretKey
				: undefined;
		this.#secretKey = secretKey;
		// A credential is what makes refunds possible: with a secretKey but no
		// injected transport, build the default live fetch transport (the first real
		// outbound Stripe dependency in the repo). No secretKey ⇒ no transport ⇒
		// refundable:false.
		this.#transport =
			options.transport ??
			(secretKey !== undefined
				? createStripeHttpTransport({ fetch: options.fetch ?? globalThis.fetch })
				: undefined);
		this.refundable = secretKey !== undefined && this.#transport !== undefined;
		this.#toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
		this.#clock = options.clock ?? { now: () => new Date() };
	}

	/**
	 * Refund an order via Stripe (ADR-0008) — the repo's FIRST live outbound Stripe
	 * call. Mandatory refund-time pre-flight, then issue:
	 *  1. `refundable:false` (no `secretKey`) ⇒ `UNSUPPORTED` — never a blind call.
	 *  2. Read the charge/PI's live `amount_refunded` + captured amount. A failed
	 *     READ maps to `RETRYABLE`/`TERMINAL` — it issued nothing.
	 *  3. **Fail closed** (`PROVIDER_ALREADY_REFUNDED`, nothing issued) when the
	 *     provider has already refunded MORE than our local view (`priorRefunded`),
	 *     or when this refund would push `amount_refunded` past what was captured —
	 *     killing the dashboard-refund + app-refund double-refund failure mode.
	 *  4. Only then `refunds.create`, passing `idempotencyKey` as Stripe's native
	 *     `Idempotency-Key`. An errored create with UNKNOWN fate (network / timeout)
	 *     surfaces as `UNVERIFIED` — re-check before retrying, never a clean failure.
	 */
	async refund(input: RefundInput): Promise<RefundResult> {
		if (this.#secretKey === undefined || this.#transport === undefined) {
			return { ok: false, reason: "UNSUPPORTED" };
		}
		const pre = await this.#transport.readRefundedAmount({
			providerRef: input.providerRef,
			secretKey: this.#secretKey,
		});
		if (!pre.ok) {
			return { ok: false, reason: pre.class === "retryable" ? "RETRYABLE" : "TERMINAL" };
		}
		const { amountRefunded, amountCaptured } = pre.view;
		if (amountRefunded > input.priorRefunded || amountRefunded + input.amount > amountCaptured) {
			return { ok: false, reason: "PROVIDER_ALREADY_REFUNDED" };
		}
		const created = await this.#transport.createRefund({
			providerRef: input.providerRef,
			amountCents: input.amount,
			idempotencyKey: input.idempotencyKey,
			secretKey: this.#secretKey,
		});
		if (!created.ok) {
			if (created.class === "ambiguous") return { ok: false, reason: "UNVERIFIED" };
			return { ok: false, reason: created.class === "retryable" ? "RETRYABLE" : "TERMINAL" };
		}
		return {
			ok: true,
			refundRef: created.refundId,
			amount: cents(created.amountCents),
			currency: toCurrency(created.currency.toUpperCase()),
		};
	}

	async createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle> {
		const intentId = `pi_${input.orderId}`;
		const clientAction: ClientAction = {
			kind: "stripe_client_secret",
			clientSecret: `${intentId}_secret_${input.idempotencyKey}`,
		};
		return { gateway: this.id, intentId, clientAction };
	}

	async verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult> {
		if (raw.kind !== "webhook") return { ok: false, reason: "MALFORMED" };

		const signature = headerCaseInsensitive(raw.headers, "stripe-signature");
		if (signature === undefined) return { ok: false, reason: "INVALID_SIGNATURE" };

		const parts = parseSignatureHeader(signature);
		if (parts === undefined) return { ok: false, reason: "INVALID_SIGNATURE" };

		// Freshness window (replay hardening): the signed `t` must be within the
		// tolerance of now — a stale-but-correctly-signed webhook is rejected in
		// the same INVALID_SIGNATURE class (matching Stripe's own guidance).
		const timestampSec = Number(parts.timestamp);
		if (!Number.isFinite(timestampSec)) return { ok: false, reason: "INVALID_SIGNATURE" };
		const nowSec = Math.floor(this.#clock.now().getTime() / 1000);
		if (Math.abs(nowSec - timestampSec) > this.#toleranceSeconds) {
			return { ok: false, reason: "INVALID_SIGNATURE" };
		}

		// HMAC over the EXACT raw bytes — `{t}.{rawBody}` — never a re-serialized body.
		// ALL `v1` tags are tried (Stripe sends one per active signing secret during
		// secret rotation); any match accepts.
		const rawBody = Buffer.from(raw.body);
		const signedPayload = Buffer.concat([Buffer.from(`${parts.timestamp}.`), rawBody]);
		const expected = createHmac("sha256", this.#secret).update(signedPayload).digest("hex");
		if (!parts.v1s.some((candidate) => safeEqualHex(candidate, expected))) {
			return { ok: false, reason: "INVALID_SIGNATURE" };
		}

		let event: unknown;
		try {
			event = JSON.parse(rawBody.toString("utf8"));
		} catch {
			return { ok: false, reason: "MALFORMED" };
		}
		return normalizeEvent(event);
	}
}

/** The Stripe event types Phase 4 settles on. */
const SUCCEEDED = "payment_intent.succeeded";
const FAILED = "payment_intent.payment_failed";

function normalizeEvent(event: unknown): ConfirmationResult {
	if (typeof event !== "object" || event === null) return { ok: false, reason: "MALFORMED" };
	const e = event as {
		id?: unknown;
		type?: unknown;
		data?: { object?: Record<string, unknown> };
	};
	if (typeof e.id !== "string" || typeof e.type !== "string")
		return { ok: false, reason: "MALFORMED" };
	if (e.type !== SUCCEEDED && e.type !== FAILED) return { ok: false, reason: "UNKNOWN_EVENT" };

	const obj = e.data?.object;
	if (obj === undefined) return { ok: false, reason: "MALFORMED" };
	const providerRef = obj["id"];
	const amount = obj["amount"];
	const cur = obj["currency"];
	const metadata = obj["metadata"];
	const orderRef =
		typeof metadata === "object" && metadata !== null
			? (metadata as Record<string, unknown>)["order_id"]
			: undefined;
	if (
		typeof providerRef !== "string" ||
		typeof amount !== "number" ||
		typeof cur !== "string" ||
		typeof orderRef !== "string"
	) {
		return { ok: false, reason: "MALFORMED" };
	}
	return {
		ok: true,
		outcome: e.type === SUCCEEDED ? "succeeded" : "failed",
		orderId: toOrderId(orderRef),
		providerRef,
		amount: cents(amount),
		currency: toCurrency(cur.toUpperCase()),
		dedupeKey: e.id,
		gateway: "stripe",
	};
}

function parseSignatureHeader(header: string): { timestamp: string; v1s: string[] } | undefined {
	let timestamp: string | undefined;
	const v1s: string[] = [];
	for (const part of header.split(",")) {
		const [k, v] = part.split("=", 2);
		if (k === "t") timestamp = v;
		// Collect EVERY v1 tag: during secret rotation Stripe signs with each
		// active secret and sends one v1 per signature — any match must verify.
		else if (k === "v1" && v !== undefined) v1s.push(v);
	}
	if (timestamp === undefined || v1s.length === 0) return undefined;
	return { timestamp, v1s };
}

function headerCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

function safeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}

// -- default live Stripe transport (ADR-0008; the first real outbound calls) --

const STRIPE_API_BASE = "https://api.stripe.com";

export interface StripeHttpTransportOptions {
	fetch: typeof fetch;
	/** Override the API base (tests point it at a recorder; defaults to Stripe). */
	baseUrl?: string;
}

/**
 * The default `fetch`-backed {@link StripeTransport} (ADR-0008) — used in
 * production when a `secretKey` is set and no transport is injected. Every call
 * classifies failures explicitly so the adapter never leaks a thrown error into
 * the port result:
 *  - a fetch REJECTION (network error / timeout) on the READ is `retryable`
 *    (nothing issued), on the CREATE is `ambiguous` (fate unknown — must re-check);
 *  - a 5xx is `retryable` on the read and `ambiguous` on the create (Stripe may or
 *    may not have processed a create it 5xx'd on);
 *  - a 4xx is `terminal` (a definite rejection — unknown id, invalid amount, …).
 *
 * The pre-flight reads the PaymentIntent's `latest_charge` (expanded) for
 * `amount_refunded` + `amount_captured`; a bare charge id (`ch_…`) is read
 * directly. This is the first cut of the live integration — the offline mock
 * transport is what the contract suite exercises byte-for-byte.
 */
export function createStripeHttpTransport(options: StripeHttpTransportOptions): StripeTransport {
	const doFetch = options.fetch;
	const base = (options.baseUrl ?? STRIPE_API_BASE).replace(/\/$/, "");

	return {
		async readRefundedAmount({ providerRef, secretKey }): Promise<StripePreflightResult> {
			const isCharge = providerRef.startsWith("ch_");
			const url = isCharge
				? `${base}/v1/charges/${encodeURIComponent(providerRef)}`
				: `${base}/v1/payment_intents/${encodeURIComponent(providerRef)}?expand[]=latest_charge`;
			let res: Response;
			try {
				res = await doFetch(url, { method: "GET", headers: stripeAuthHeaders(secretKey) });
			} catch {
				return { ok: false, class: "retryable" }; // network error — read issued nothing
			}
			if (!res.ok) {
				return { ok: false, class: res.status >= 500 ? "retryable" : "terminal" };
			}
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				return { ok: false, class: "retryable" };
			}
			const charge = isCharge ? body : (body as { latest_charge?: unknown }).latest_charge;
			const view = refundedViewOf(charge);
			if (view === null) return { ok: false, class: "terminal" };
			return { ok: true, view };
		},

		async createRefund({
			providerRef,
			amountCents,
			idempotencyKey,
			secretKey,
		}): Promise<StripeCreateRefundResult> {
			const form = new URLSearchParams();
			// A PI id vs a bare charge id — target the right Stripe param.
			form.set(providerRef.startsWith("ch_") ? "charge" : "payment_intent", providerRef);
			form.set("amount", String(amountCents));
			let res: Response;
			try {
				res = await doFetch(`${base}/v1/refunds`, {
					method: "POST",
					headers: {
						...stripeAuthHeaders(secretKey),
						"content-type": "application/x-www-form-urlencoded",
						// Stripe's NATIVE idempotency — a replay re-calls nothing provider-side.
						"idempotency-key": idempotencyKey,
					},
					body: form.toString(),
				});
			} catch {
				// Network error / timeout — the refund's fate is UNKNOWN. Never retry blind.
				return { ok: false, class: "ambiguous" };
			}
			if (!res.ok) {
				// A 5xx on a CREATE is ambiguous (Stripe may have processed it); a 4xx is
				// a definite terminal rejection.
				return { ok: false, class: res.status >= 500 ? "ambiguous" : "terminal" };
			}
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				return { ok: false, class: "ambiguous" };
			}
			const refund = createdRefundOf(body);
			if (refund === null) return { ok: false, class: "ambiguous" };
			return { ok: true, ...refund };
		},
	};
}

/** Bearer auth header for the live Stripe REST calls (secret stays adapter-side). */
function stripeAuthHeaders(secretKey: string): Record<string, string> {
	return { authorization: `Bearer ${secretKey}` };
}

/** Parse a Stripe charge object into the refunded view, or null if malformed. */
function refundedViewOf(charge: unknown): StripeRefundedView | null {
	if (typeof charge !== "object" || charge === null) return null;
	const c = charge as { amount_refunded?: unknown; amount_captured?: unknown; currency?: unknown };
	if (
		typeof c.amount_refunded !== "number" ||
		typeof c.amount_captured !== "number" ||
		typeof c.currency !== "string"
	) {
		return null;
	}
	return {
		amountRefunded: c.amount_refunded,
		amountCaptured: c.amount_captured,
		currency: c.currency,
	};
}

/** Parse a Stripe refund object into the created-refund result, or null. */
function createdRefundOf(
	refund: unknown,
): { refundId: string; amountCents: number; currency: string } | null {
	if (typeof refund !== "object" || refund === null) return null;
	const r = refund as { id?: unknown; amount?: unknown; currency?: unknown };
	if (typeof r.id !== "string" || typeof r.amount !== "number" || typeof r.currency !== "string") {
		return null;
	}
	return { refundId: r.id, amountCents: r.amount, currency: r.currency };
}

// -- offline fake-Stripe driver (test/proxy helper; NO network) --------------

export interface StripeEventInput {
	eventId: string;
	type: "payment_intent.succeeded" | "payment_intent.payment_failed";
	paymentIntentId: string;
	orderId: string;
	amountCents: number;
	/** ISO-4217 (any case); Stripe emits lowercase. */
	currency: string;
}

export interface SignedStripeWebhook {
	body: Uint8Array;
	signatureHeader: string;
}

/**
 * The offline fake-Stripe driver: build a Stripe event body and a valid
 * `Stripe-Signature` header signed with `secret` — NO network. Used by the
 * contract/tamper tests and the plugin webhook-proxy byte-exact test.
 */
export function signStripeWebhook(
	input: StripeEventInput,
	secret: string,
	opts: { timestamp?: number } = {},
): SignedStripeWebhook {
	const event = {
		id: input.eventId,
		type: input.type,
		data: {
			object: {
				id: input.paymentIntentId,
				amount: input.amountCents,
				currency: input.currency.toLowerCase(),
				metadata: { order_id: input.orderId },
			},
		},
	};
	const body = new TextEncoder().encode(JSON.stringify(event));
	// Default to NOW so the signed webhook passes the gateway's freshness window;
	// tests exercising staleness pass an explicit past timestamp.
	const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
	const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]);
	const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");
	return { body, signatureHeader: `t=${timestamp},v1=${v1}` };
}
