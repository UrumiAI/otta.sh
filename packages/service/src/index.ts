import { serve } from "@hono/node-server";
import { type CartDeps, expireHolds, type PaymentGateway, type PaymentMethod } from "@urumi/domain";
import { StripePaymentGateway } from "@urumi/payments-stripe";
import { createTestFacilitator, X402PaymentGateway } from "@urumi/payments-x402";
import {
	KyselyCartStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	makePostgresDb,
	makePostgresPool,
	migrateToLatest,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createApp } from "./app.js";

// Bin entry (§0.6): wire the real pg-backed stores and serve on PORT.
const connectionString = process.env.PG_CONNECTION_STRING;
if (connectionString === undefined) {
	throw new Error("PG_CONNECTION_STRING is required to start @urumi/service");
}

const pool = makePostgresPool({ connectionString });
const db = makePostgresDb(pool);
await migrateToLatest(db);

const clock = { now: () => new Date() };
const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
const productCommerce = new KyselyProductCommerceStore({ db, clock });
const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });

// Payment gateways (§5). Secrets are SERVICE-ENV ONLY (CLAUDE.md) — never in the
// plugin / ctx.kv. A gateway is wired only when its secret is present.
const gateways: Partial<Record<PaymentMethod, PaymentGateway>> = {};
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (stripeWebhookSecret !== undefined && stripeWebhookSecret.length > 0) {
	gateways.stripe = new StripePaymentGateway({
		webhookSecret: stripeWebhookSecret,
		secretKey: process.env.STRIPE_SECRET_KEY,
	});
}
// x402: the challenge payTo + a server-side facilitator. The offline HMAC
// facilitator (X402_FACILITATOR_SECRET) is the v1 stand-in for a real
// `HTTPFacilitatorClient`-backed verifier; wire the latter for production.
const x402PayTo = process.env.X402_PAYTO;
const x402FacilitatorSecret = process.env.X402_FACILITATOR_SECRET;
if (
	x402PayTo !== undefined &&
	x402FacilitatorSecret !== undefined &&
	x402FacilitatorSecret.length > 0
) {
	gateways.x402 = new X402PaymentGateway({
		facilitator: createTestFacilitator(x402FacilitatorSecret),
		payTo: x402PayTo,
		accepts: (process.env.X402_ACCEPTS ?? "eip155:8453").split(","),
	});
}

// Hold TTL (§5): default 15 min, configurable via CART_HOLD_TTL_MS.
const ttlEnv = process.env.CART_HOLD_TTL_MS;
const ttlMs = ttlEnv === undefined ? undefined : Number(ttlEnv);
if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
	throw new Error(`CART_HOLD_TTL_MS must be a positive number, got "${ttlEnv}"`);
}

// Shared secret for /internal/* (INTERNAL_API_TOKEN). Unset ⇒ the internal
// endpoints answer 503 (disabled) — never silently open.
const internalToken = process.env.INTERNAL_API_TOKEN;

const app = createApp({
	store,
	productCommerce,
	cartStore,
	orderStore,
	entitlementStore,
	paymentEventStore,
	idGen: uuidIdGen,
	gateways,
	clock,
	ttlMs,
	checkoutTtlMs: ttlMs,
	internalToken,
});
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`@urumi/service listening on :${port}`);

// Self-scheduled sweep (§5) — the Node convenience wiring; a Worker deployment
// instead drives POST /internal/expire-holds via the plugin `cron` hook. Lazy
// on-read keeps correctness independent of this timer. Unref'd so it never
// keeps the process alive on its own.
const sweepDeps: CartDeps = { cartStore, inventoryStore: store, clock, ttlMs };
const sweepMs = Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 60_000);
setInterval(() => {
	void expireHolds(sweepDeps).catch((err: unknown) => {
		console.error("[service] hold sweep failed:", err);
	});
}, sweepMs).unref();
