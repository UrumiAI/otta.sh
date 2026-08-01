/**
 * Capture money on seeded orders, so the refund surfaces have something to
 * refund (INC-20).
 *
 * WHY THIS HAD TO BE WRITTEN DOWN. The audit seed produces 18 orders across
 * every state, and NOT ONE of them is refundable. That is not a seed defect: a
 * local stack runs the Stripe gateway in its offline mode
 * (`STRIPE_WEBHOOK_SECRET` set, `STRIPE_SECRET_KEY` unset), which mints
 * unpayable client secrets and never captures, so `capturedTotalCents` is 0 on
 * every order and `remainingCents` with it. Both Orders screens are correct to
 * render no refund control at all — and the refund specs on both tiers then
 * have nothing to exercise. The first INC-20 gate run discovered this the
 * expensive way, and the recipe that fixed it lived in a scratch file that
 * would have been thrown away, leaving the next person to rediscover it.
 *
 * WHAT IT DOES. Sends a `payment_intent.succeeded` webhook per order, signed
 * with the local webhook secret through `signStripeWebhook` — the SAME signing
 * helper the contract tests use, and the same `POST /webhooks/stripe` route
 * production uses. No database is touched, no credential is read from anywhere
 * but the environment, and nothing is faked past the signature: the service
 * verifies the HMAC and the freshness window exactly as it would for Stripe.
 *
 * SAFE BY CONSTRUCTION. Every endpoint is checked to be loopback before a
 * request is made — the same rule the e2e harness enforces for the same reason
 * (a shell that has been used to deploy exports `COMMERCE_SERVICE_URL` pointing
 * at real infrastructure), and this script MOVES MONEY-SHAPED RECORDS, so
 * pointing it at anything real is the failure to prevent. It also refuses to
 * run against a service whose Stripe gateway is live: `STRIPE_SECRET_KEY` being
 * set means captures are real, and a synthetic `payment_intent.succeeded` is
 * then a lie about money that actually exists.
 *
 * USAGE (after `seed-audit.mjs`, against a local stack):
 *
 *   COMMERCE_SERVICE_URL=http://127.0.0.1:3520 \
 *   INTERNAL_API_TOKEN=local-e2e-token \
 *   STRIPE_WEBHOOK_SECRET=whsec_e2e_offline \
 *     pnpm dlx tsx@4 sites/staging/scripts/capture-e2e-payments.ts
 */
import { signStripeWebhook } from "@otta-sh/payments-stripe";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLoopback(raw: string, label: string): string {
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		throw new Error(`${label} must be a URL, got ${raw}`);
	}
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			`${label} must point at loopback, got ${host} (from ${raw}). This script signs ` +
				`payment webhooks and must never be aimed at real infrastructure.`,
		);
	}
	return raw.replace(/\/$/, "");
}

const SERVICE = assertLoopback(
	process.env["COMMERCE_SERVICE_URL"] ?? "http://127.0.0.1:3500",
	"COMMERCE_SERVICE_URL",
);
const TOKEN = process.env["INTERNAL_API_TOKEN"] ?? "local-e2e-token";
const SECRET = process.env["STRIPE_WEBHOOK_SECRET"] ?? "whsec_e2e_offline";
/** How many paid orders to capture. Three is enough for the refund specs on
 *  both tiers and leaves the rest of the seed's state spread intact. */
const HOW_MANY = Number(process.env["OTTA_CAPTURE_COUNT"] ?? "3");

if ((process.env["STRIPE_SECRET_KEY"] ?? "").length > 0) {
	throw new Error(
		"STRIPE_SECRET_KEY is set, so this service's Stripe gateway is LIVE and its " +
			"captures are real. Synthesising payment_intent.succeeded against it would " +
			"record money that does not exist. Unset it, or point at a local service.",
	);
}

interface OrderRow {
	readonly id: string;
	readonly totalCents: number;
	readonly currency: string;
}

async function admin<T>(path: string): Promise<T> {
	const res = await fetch(`${SERVICE}${path}`, { headers: { "X-Internal-Token": TOKEN } });
	if (!res.ok) throw new Error(`GET ${path} → HTTP ${String(res.status)}`);
	return (await res.json()) as T;
}

const listed = await admin<{ orders?: readonly OrderRow[] }>("/admin/orders?states=paid");
const orders = (listed.orders ?? []).slice(0, HOW_MANY);
if (orders.length === 0) {
	console.warn("[capture] no paid orders — run the seed first; nothing to do.");
}

for (const order of orders) {
	const { body, signatureHeader } = signStripeWebhook(
		{
			eventId: `evt_e2e_${order.id.slice(0, 8)}`,
			type: "payment_intent.succeeded",
			paymentIntentId: `pi_e2e_${order.id.slice(0, 8)}`,
			orderId: order.id,
			amountCents: order.totalCents,
			currency: order.currency.toLowerCase(),
		},
		SECRET,
	);
	const res = await fetch(`${SERVICE}/webhooks/stripe`, {
		method: "POST",
		headers: { "content-type": "application/json", "stripe-signature": signatureHeader },
		// The BYTES, unchanged. `signStripeWebhook` returns a `Uint8Array` because
		// the HMAC is over exact bytes and a re-serialized body would not verify;
		// the cast is the DOM `BodyInit` lib not accepting a generically-typed
		// `Uint8Array`, not a conversion.
		body: body as BodyInit,
	});
	const after = await admin<{ capturedTotalCents: number; remainingCents: number }>(
		`/admin/orders/${order.id}/refunds`,
	);
	console.log(
		`[capture] ${order.id} webhook=${String(res.status)} ` +
			`captured=${String(after.capturedTotalCents)} remaining=${String(after.remainingCents)}`,
	);
}
