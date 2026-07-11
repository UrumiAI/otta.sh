import { serve } from "@hono/node-server";
import {
	cents,
	currency,
	idempotencyKey,
	money,
	type PaymentGateway,
	type PaymentMethod,
	productId,
	sku,
} from "@urumi/domain";
import { FakeEmailSender, FixedClock } from "@urumi/domain/testing";
import { StripePaymentGateway } from "@urumi/payments-stripe";
import { createTestFacilitator, X402PaymentGateway } from "@urumi/payments-x402";
import {
	KyselyAddressStore,
	KyselyCartStore,
	KyselyCredentialVerifier,
	KyselyCustomerStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	KyselySessionStore,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createIsolatedPgSchema } from "@urumi/store-postgres/testing";
import { createApp } from "../../src/app.js";

/** Known test secrets so tests can sign valid Stripe webhooks / x402 proofs. */
export const STRIPE_WEBHOOK_SECRET = "whsec_test_service_phase4";
export const X402_FACILITATOR_SECRET = "x402_facilitator_test_service";

export interface TestServer {
	baseUrl: string;
	/** The X-Internal-Token value the server accepts (undefined ⇒ disabled). */
	internalToken: string | undefined;
	/** The in-memory email sender the server sends through (Phase 5) — tests read
	 *  the emitted magic-link token and assert exactly-once status emails. */
	emailSender: FakeEmailSender;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
	/** Seed a priced product (with title) + optional stock, for checkout tests. */
	seedProduct(input: {
		productId: string;
		sku: string;
		priceCents: number;
		title: string;
		kind: "physical" | "digital";
		onHand?: number;
	}): Promise<void>;
	/** Advance the server's injected Clock (fast-forward past a hold TTL). */
	advance(ms: number): void;
	stop(): Promise<void>;
}

export interface TestServerOptions {
	/** Shared secret for /internal/*; defaults to a per-server random token.
	 *  Pass `null` to start the server with the internal endpoints DISABLED. */
	internalToken?: string | null;
}

/**
 * Boot `createApp(deps)` on an ephemeral port with Postgres-backed stores in
 * an isolated schema (§0.6). Returns the base URL plus seed/onHand helpers
 * (there is no HTTP endpoint to seed stock).
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 8 });
	const db = iso.db;

	const internalToken =
		options.internalToken === null ? undefined : (options.internalToken ?? crypto.randomUUID());
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const productCommerce = new KyselyProductCommerceStore({ db, clock });
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
	const gateways: Partial<Record<PaymentMethod, PaymentGateway>> = {
		stripe: new StripePaymentGateway({ webhookSecret: STRIPE_WEBHOOK_SECRET }),
		x402: new X402PaymentGateway({
			facilitator: createTestFacilitator(X402_FACILITATOR_SECRET),
			payTo: "0xTEST",
			accepts: ["eip155:8453"],
		}),
	};
	const app = createApp({
		store,
		productCommerce,
		cartStore,
		orderStore,
		entitlementStore,
		paymentEventStore,
		customerStore,
		addressStore,
		sessionStore,
		credentialVerifier,
		emailSender,
		idGen: uuidIdGen,
		gateways,
		clock,
		internalToken,
	});

	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		internalToken,
		emailSender,
		async seed(skuValue, qty) {
			await db
				.insertInto("inventory")
				.values({ sku: skuValue, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(skuValue) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", skuValue)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async seedProduct(input) {
			await productCommerce.upsert(
				{
					productId: productId(input.productId),
					sku: sku(input.sku),
					price: money(cents(input.priceCents), currency("USD")),
					title: input.title,
					productKind: input.kind,
				},
				idempotencyKey(`seed-${input.productId}`),
			);
			if (input.kind === "physical") {
				await store.seedOnHand(input.sku, input.onHand ?? 0);
			}
		},
		advance(ms) {
			clock.advance(ms);
		},
		async stop() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
			await iso.teardown();
		},
	};
}
