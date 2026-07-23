import { serve } from "@hono/node-server";
import {
	type CartDeps,
	dispatchOrderEmails,
	expireHolds,
	type PaymentGateway,
	type PaymentMethod,
} from "@urumi/domain";
import { StripePaymentGateway } from "@urumi/payments-stripe";
import {
	KyselyAddressStore,
	KyselyCartStore,
	KyselyCouponStore,
	KyselyCredentialVerifier,
	KyselyCustomerStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderNotesStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	KyselyReportingStore,
	KyselySessionStore,
	KyselySettingsStore,
	KyselyShippingRulesStore,
	KyselyTaxRulesStore,
	makePostgresDb,
	makePostgresPool,
	migrateToLatest,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createApp } from "./app.js";
import { resolveServiceConfig } from "./config.js";
import { ConsoleEmailSender, HttpEmailSender } from "./email/senders.js";
import { wireX402Gateway } from "./x402-wiring.js";

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
const orderNotesStore = new KyselyOrderNotesStore({ db, idGen: uuidIdGen, clock });
const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });
// Phase 6 (§6): shipping / tax / coupon rules stores.
const shippingRules = new KyselyShippingRulesStore({ db });
const taxRules = new KyselyTaxRulesStore({ db });
const couponStore = new KyselyCouponStore({ db, idGen: uuidIdGen, clock });
// Phase 7 (§6): read-only reporting + operational settings (service-DB tier).
const reportingStore = new KyselyReportingStore({ db, dialect: "postgres" });
const settingsStore = new KyselySettingsStore({ db, clock });

// Phase 5 (§4/§7): storefront customer identity, address book, sessions, magic-
// link verifier, and the email transport (the service sends directly — §6 ADR).
const customerStore = new KyselyCustomerStore({ db, idGen: uuidIdGen, clock });
const addressStore = new KyselyAddressStore({ db, idGen: uuidIdGen, clock });
const sessionStore = new KyselySessionStore({ db, idGen: uuidIdGen, clock });
const credentialVerifier = new KyselyCredentialVerifier({
	db,
	customerStore,
	idGen: uuidIdGen,
	clock,
});
const emailApiUrl = process.env.EMAIL_API_URL;
const emailSender =
	emailApiUrl !== undefined && emailApiUrl.length > 0
		? new HttpEmailSender({
				apiUrl: emailApiUrl,
				apiKey: process.env.EMAIL_API_KEY,
				from: process.env.EMAIL_FROM ?? "no-reply@urumi.local",
			})
		: new ConsoleEmailSender();
const storefrontBaseUrl = process.env.STOREFRONT_BASE_URL;

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
// x402 (review G4): FAIL-CLOSED wiring. The only available facilitator is the
// offline TEST one, so `wireX402Gateway` throws at startup when x402 env is
// set without the explicit X402_ALLOW_TEST_FACILITATOR=true opt-in, and warns
// loudly (non-production) when it is. See src/x402-wiring.ts.
const x402Gateway = wireX402Gateway(process.env);
if (x402Gateway !== undefined) {
	gateways.x402 = x402Gateway;
}

// Env-derived config (config.ts, shared with the Worker entry): hold TTL
// (default 15 min via CART_HOLD_TTL_MS), the /internal/* shared secret
// (INTERNAL_API_TOKEN — unset ⇒ 503, never silently open), and the write-gate
// secret (SERVICE_API_TOKEN — unset ⇒ open, today's behavior).
const { ttlMs, internalToken, serviceToken } = resolveServiceConfig(process.env);

const app = createApp({
	store,
	productCommerce,
	cartStore,
	orderStore,
	orderNotesStore,
	entitlementStore,
	paymentEventStore,
	shippingRules,
	taxRules,
	couponStore,
	reportingStore,
	settingsStore,
	customerStore,
	addressStore,
	sessionStore,
	credentialVerifier,
	emailSender,
	idGen: uuidIdGen,
	gateways,
	clock,
	ttlMs,
	checkoutTtlMs: ttlMs,
	internalToken,
	serviceToken,
	...(storefrontBaseUrl !== undefined ? { storefrontBaseUrl } : {}),
});
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`@urumi/service listening on :${port}`);

// Self-scheduled email outbox dispatcher + login-challenge prune (§5.8 +
// review round H1) — the Node convenience wiring (a Worker deployment drives
// POST /internal/dispatch-emails via the cron hook instead, which does both).
// Unref'd so it never keeps the process alive on its own.
const emailDispatchDeps = { orderStore, emailSender, customerStore, clock };
const emailSweepMs = Number(process.env.EMAIL_DISPATCH_INTERVAL_MS ?? 30_000);
setInterval(() => {
	void dispatchOrderEmails(emailDispatchDeps).catch((err: unknown) => {
		console.error("[service] email dispatch failed:", err);
	});
	void credentialVerifier.pruneChallenges(clock.now().toISOString()).catch((err: unknown) => {
		console.error("[service] login-challenge prune failed:", err);
	});
}, emailSweepMs).unref();

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
