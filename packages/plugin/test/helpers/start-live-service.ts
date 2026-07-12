import { serve } from "@hono/node-server";
import { FakeEmailSender, FixedClock } from "@urumi/domain/testing";
import { StripePaymentGateway } from "@urumi/payments-stripe";
import { createApp } from "@urumi/service/app";
import {
	KyselyAddressStore,
	KyselyCartStore,
	KyselyCouponStore,
	KyselyCredentialVerifier,
	KyselyCustomerStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	KyselyReportingStore,
	KyselySessionStore,
	KyselySettingsStore,
	KyselyShippingRulesStore,
	KyselyTaxRulesStore,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createIsolatedPgSchema } from "@urumi/store-postgres/testing";

/** The Stripe webhook signing secret the live test service verifies against. */
export const LIVE_STRIPE_WEBHOOK_SECRET = "whsec_plugin_live_test";

export interface LiveService {
	baseUrl: string;
	host: string;
	/** The in-memory email sender — the account tests read the emitted magic-link
	 *  token from here to complete a login over the wire. */
	emailSender: FakeEmailSender;
	/** The X-Internal-Token the service accepts (undefined ⇒ guarded admin routes
	 *  answer 503). Exposed so the admin-orders live-client test can drive the
	 *  guarded `/admin/orders` reads. */
	internalToken: string | undefined;
	stop(): Promise<void>;
}

export interface StartLiveServiceOptions {
	/** Enable the guarded admin surface with this X-Internal-Token. Omitted ⇒ the
	 *  internal endpoints stay DISABLED (503), preserving the prior behavior. */
	internalToken?: string;
}

/**
 * Boots the REAL `@urumi/service` (`createApp`) on an ephemeral port,
 * Postgres-backed in an isolated schema — mirrors
 * `packages/service/test/helpers/start-test-server.ts` (Phase 0 §0.6), used
 * here so `HttpCommerceClient` (plan §6 step 6) is proven against the real
 * wire, not a hand-rolled stub.
 */
export async function startLiveService(
	options: StartLiveServiceOptions = {},
): Promise<LiveService> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 8 });
	const db = iso.db;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const productCommerce = new KyselyProductCommerceStore({ db, clock });
	// Phase 3 grew AppDeps with the cart surface; the plugin exercises only the
	// product routes here, but the real app wires everything.
	const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
	const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
	const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
	const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });
	const customerStore = new KyselyCustomerStore({ db, idGen: uuidIdGen, clock });
	const addressStore = new KyselyAddressStore({ db, idGen: uuidIdGen, clock });
	const sessionStore = new KyselySessionStore({ db, idGen: uuidIdGen, clock });
	const credentialVerifier = new KyselyCredentialVerifier({
		db,
		customerStore,
		idGen: uuidIdGen,
		clock,
	});
	const emailSender = new FakeEmailSender();
	const app = createApp({
		store,
		productCommerce,
		cartStore,
		orderStore,
		entitlementStore,
		paymentEventStore,
		shippingRules: new KyselyShippingRulesStore({ db }),
		taxRules: new KyselyTaxRulesStore({ db }),
		couponStore: new KyselyCouponStore({ db, idGen: uuidIdGen }),
		reportingStore: new KyselyReportingStore({ db, dialect: "postgres" }),
		settingsStore: new KyselySettingsStore({ db, clock }),
		customerStore,
		addressStore,
		sessionStore,
		credentialVerifier,
		emailSender,
		idGen: uuidIdGen,
		gateways: { stripe: new StripePaymentGateway({ webhookSecret: LIVE_STRIPE_WEBHOOK_SECRET }) },
		clock,
		...(options.internalToken !== undefined ? { internalToken: options.internalToken } : {}),
	});

	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		host: "127.0.0.1",
		emailSender,
		internalToken: options.internalToken,
		async stop() {
			await new Promise<void>((resolve, reject) => {
				server.close((err: Error | undefined) => (err ? reject(err) : resolve()));
			});
			await iso.teardown();
		},
	};
}
