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
import {
	FakeEmailSender,
	FIXTURE_INVENTORY,
	FIXTURE_ITEMS,
	FIXTURE_ORDERS,
	FixedClock,
} from "@urumi/domain/testing";
import { StripePaymentGateway, type StripeTransport } from "@urumi/payments-stripe";
import { createTestFacilitator, X402PaymentGateway } from "@urumi/payments-x402";
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
	/** Seed the shared Phase-7 reporting fixture (orders/totals/items/inventory)
	 *  so the reports HTTP contract asserts the same hand-computed numbers. */
	seedReportingFixture(): Promise<void>;
	/** Seed a bare order (orders + order_totals) with an EXACT
	 *  state/currency/buyerRef/createdAt/total for the admin Orders list tests. */
	seedOrder(row: {
		id: string;
		state: string;
		currency: string;
		buyerRef: string;
		customerId?: string | null;
		paymentMethod?: string | null;
		createdAt: string;
		totalCents: number;
		reconciliationFlag?: string | null;
	}): Promise<void>;
	/** Seed a captured `payments` row for an order (ADR-0008 refund tests) — the
	 *  ceiling's `Σ captured` source + the gateway refund's `providerRef` target. */
	seedPayment(row: {
		orderId: string;
		gateway: string;
		providerRef: string;
		amountCents: number;
		currency: string;
		status?: string;
	}): Promise<void>;
	/** Seed a bare `product_commerce` row with an EXACT `createdAt` (admin-UX
	 *  Increment 2, product list tests) — a direct insert, no upsert/
	 *  idempotency-key dance, mirroring `seedOrder`. `taxClass` (Increment 3
	 *  closeout) lets the tax-class delete-in-use tests seed a LIVE product
	 *  reference without going through the full upsert+edit dance. */
	seedProductRow(row: {
		id: string;
		sku?: string | null;
		title?: string | null;
		priceCents?: number | null;
		currency?: string;
		productKind?: "physical" | "digital";
		active?: boolean;
		createdAt: string;
		deletedAt?: string | null;
		taxClass?: string | null;
	}): Promise<void>;
	/** Seed a bare `coupons` row with an EXACT `createdAt` (admin-UX Increment 3,
	 *  coupon list tests) — a direct insert, no `create()`/clock dance,
	 *  mirroring `seedProductRow`. */
	seedCouponRow(row: {
		id: string;
		code: string;
		type?: "fixed_amount" | "percentage";
		amountCents?: number | null;
		rateBps?: number | null;
		capCents?: number | null;
		currency?: string | null;
		minSubtotalCents?: number | null;
		startsAt?: string | null;
		expiresAt?: string | null;
		maxUses?: number | null;
		maxUsesPerCustomer?: number | null;
		usesCount?: number;
		createdAt: string;
	}): Promise<void>;
	stop(): Promise<void>;
}

export interface TestServerOptions {
	/** Shared secret for /internal/*; defaults to a per-server random token.
	 *  Pass `null` to start the server with the internal endpoints DISABLED. */
	internalToken?: string | null;
	/** SERVICE_API_TOKEN write gate; default unset (gate open — existing suites
	 *  exercise the ungated surface). */
	serviceToken?: string;
	/** ADR-0008: a Stripe `secretKey` + injected offline `transport` to make the
	 *  Stripe gateway `refundable:true` for the refund HTTP contract (default: no
	 *  secretKey ⇒ refundable:false ⇒ the manual record-only path). */
	stripeSecretKey?: string;
	stripeTransport?: StripeTransport;
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
	const orderNotesStore = new KyselyOrderNotesStore({ db, idGen: uuidIdGen, clock });
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
		stripe: new StripePaymentGateway({
			webhookSecret: STRIPE_WEBHOOK_SECRET,
			...(options.stripeSecretKey !== undefined ? { secretKey: options.stripeSecretKey } : {}),
			...(options.stripeTransport !== undefined ? { transport: options.stripeTransport } : {}),
		}),
		x402: new X402PaymentGateway({
			facilitator: createTestFacilitator(X402_FACILITATOR_SECRET),
			payTo: "0xTEST",
			accepts: ["eip155:8453"],
		}),
	};
	const shippingRules = new KyselyShippingRulesStore({ db });
	const taxRules = new KyselyTaxRulesStore({ db });
	const couponStore = new KyselyCouponStore({ db, idGen: uuidIdGen, clock });
	const reportingStore = new KyselyReportingStore({ db, dialect: "postgres" });
	const settingsStore = new KyselySettingsStore({ db, clock });
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
		internalToken,
		serviceToken: options.serviceToken,
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
		async seedReportingFixture() {
			for (const o of FIXTURE_ORDERS) {
				await db
					.insertInto("orders")
					.values({
						id: o.id,
						cart_id: null,
						currency: o.currency,
						state: o.state as never,
						idempotency_key: `seed-${o.id}`,
						hold_expires_at: o.createdAt,
						payment_method: null,
						buyer_ref: "seed",
						created_at: o.createdAt,
						updated_at: o.createdAt,
					})
					.execute();
				await db
					.insertInto("order_totals")
					.values({
						order_id: o.id,
						currency: o.currency,
						subtotal_cents: o.totalCents,
						discount_cents: 0,
						shipping_cents: 0,
						tax_cents: 0,
						total_cents: o.totalCents,
						applied_coupon_code: null,
						shipping_method_snapshot: null,
						tax_breakdown: null,
					})
					.execute();
			}
			for (const it of FIXTURE_ITEMS) {
				await db
					.insertInto("order_items")
					.values({
						id: `${it.orderId}-${it.productId}`,
						order_id: it.orderId,
						product_id: it.productId,
						sku: `sku-${it.productId}`,
						title: it.title,
						unit_price_cents: it.unitPriceCents,
						currency: "USD",
						quantity: it.quantity,
						fulfillment_kind: "physical",
						reservation_id: null,
					})
					.execute();
			}
			for (const inv of FIXTURE_INVENTORY) {
				await db
					.insertInto("inventory")
					.values({ sku: inv.sku, on_hand: inv.onHand })
					.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: inv.onHand }))
					.execute();
			}
		},
		async seedOrder(row) {
			await db
				.insertInto("orders")
				.values({
					id: row.id,
					cart_id: null,
					currency: row.currency,
					state: row.state as never,
					idempotency_key: `seed-${row.id}`,
					hold_expires_at: row.createdAt,
					payment_method: row.paymentMethod ?? null,
					buyer_ref: row.buyerRef,
					customer_id: row.customerId ?? null,
					reconciliation_flag: row.reconciliationFlag ?? null,
					created_at: row.createdAt,
					updated_at: row.createdAt,
				})
				.execute();
			await db
				.insertInto("order_totals")
				.values({
					order_id: row.id,
					currency: row.currency,
					subtotal_cents: row.totalCents,
					discount_cents: 0,
					shipping_cents: 0,
					tax_cents: 0,
					total_cents: row.totalCents,
					applied_coupon_code: null,
					shipping_method_snapshot: null,
					tax_breakdown: null,
				})
				.execute();
		},
		async seedPayment(row) {
			await db
				.insertInto("payments")
				.values({
					id: `pay-${row.orderId}-${row.providerRef}`,
					order_id: row.orderId,
					gateway: row.gateway,
					provider_ref: row.providerRef,
					amount_cents: row.amountCents,
					currency: row.currency,
					status: row.status ?? "succeeded",
					created_at: "2026-07-10T00:00:00.000Z",
				})
				.execute();
		},
		async seedProductRow(row) {
			await db
				.insertInto("product_commerce")
				.values({
					product_id: row.id,
					sku: row.sku ?? null,
					price_cents: row.priceCents ?? null,
					price_currency:
						row.priceCents !== undefined && row.priceCents !== null
							? (row.currency ?? "USD")
							: null,
					title: row.title ?? null,
					tax_class: row.taxClass ?? null,
					inventory_policy: "deny",
					weight_grams: null,
					length_mm: null,
					width_mm: null,
					height_mm: null,
					product_kind: row.productKind ?? "physical",
					active: (row.active ?? false) ? 1 : 0,
					deleted_at: row.deletedAt ?? null,
					idempotency_key: `seed-${row.id}`,
					content_updated_at: null,
					active_updated_at: null,
					created_at: row.createdAt,
					updated_at: row.createdAt,
				})
				.execute();
		},
		async seedCouponRow(row) {
			await db
				.insertInto("coupons")
				.values({
					id: row.id,
					code: row.code,
					type: row.type ?? "fixed_amount",
					amount_cents: row.amountCents ?? null,
					rate_bps: row.rateBps ?? null,
					cap_cents: row.capCents ?? null,
					currency: row.currency ?? null,
					min_subtotal_cents: row.minSubtotalCents ?? null,
					starts_at: row.startsAt ?? null,
					expires_at: row.expiresAt ?? null,
					max_uses: row.maxUses ?? null,
					max_uses_per_customer: row.maxUsesPerCustomer ?? null,
					uses_count: row.usesCount ?? 0,
					created_at: row.createdAt,
				})
				.execute();
		},
		async stop() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
			await iso.teardown();
		},
	};
}
