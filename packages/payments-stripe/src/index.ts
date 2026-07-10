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
	/** Stripe secret key (`sk_…`); service-env only. Reserved for real intent
	 *  creation — Phase 4 creates the client handle offline (see `createIntent`). */
	secretKey?: string;
	/** Freshness window for the signed `t` timestamp (replay hardening): a webhook
	 *  whose `|now − t|` exceeds this is rejected as INVALID_SIGNATURE even when the
	 *  HMAC matches. Defaults to {@link DEFAULT_TOLERANCE_SECONDS}. */
	toleranceSeconds?: number;
	/** Injectable time source for the freshness check; defaults to system time. */
	clock?: Clock;
}

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
	readonly #secret: string;
	readonly #toleranceSeconds: number;
	readonly #clock: Clock;

	constructor(options: StripePaymentGatewayOptions) {
		if (options.webhookSecret.length === 0) {
			throw new Error("StripePaymentGateway requires a non-empty webhookSecret");
		}
		this.#secret = options.webhookSecret;
		this.#toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
		this.#clock = options.clock ?? { now: () => new Date() };
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
