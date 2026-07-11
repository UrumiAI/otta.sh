import {
	type CartDeps,
	type Clock,
	dispatchOrderEmails,
	type EmailSender,
	type ExpireOrdersDeps,
	expireHolds,
	expireOrders,
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
} from "@urumi/store-postgres/pg";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { resolveServiceConfig, type ServiceConfig } from "./config.js";
import { ConsoleEmailSender, HttpEmailSender } from "./email/senders.js";
import { wireX402Gateway } from "./x402-wiring.js";

/**
 * Cloudflare Worker entry (plan D1–D5, D7). Imports ONLY the sqlite-free
 * `@urumi/store-postgres/pg` subpath so wrangler/esbuild never see the
 * better-sqlite3 native addon.
 *
 * Structural env/runtime types instead of `@cloudflare/workers-types`: the
 * ambient globals it injects collide with `@types/node` in this strict
 * tsconfig, and three small interfaces cover everything this file touches
 * (recorded as a reversible choice in the plan, D2).
 */
export interface WorkerEnv {
	/** Injected by the platform from the wrangler `hyperdrive` binding — the
	 *  origin credentials live platform-side, never in this repo. */
	HYPERDRIVE?: { connectionString?: string };
	CART_HOLD_TTL_MS?: string;
	INTERNAL_API_TOKEN?: string;
	SERVICE_API_TOKEN?: string;
	// Phase 4 gateway secrets — same names the Node bin reads from process.env;
	// on Workers each is a `wrangler secret put` entry. A gateway is wired only
	// when its secret is present (checkout with an unwired method throws at the
	// domain → the app's 500 envelope; the webhook route answers 503).
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_SECRET_KEY?: string;
	X402_PAYTO?: string;
	X402_FACILITATOR_SECRET?: string;
	X402_ACCEPTS?: string;
	X402_ALLOW_TEST_FACILITATOR?: string;
	// Phase 5 email transport + magic-link base URL — same names as the Node
	// bin. EMAIL_API_URL unset ⇒ ConsoleEmailSender (workers `console.log`,
	// visible in `wrangler tail`); set ⇒ HttpEmailSender over fetch.
	EMAIL_API_URL?: string;
	EMAIL_API_KEY?: string;
	EMAIL_FROM?: string;
	STOREFRONT_BASE_URL?: string;
}

export interface WorkerExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	/** Present on workerd's real ctx; optional so test stubs stay minimal. */
	passThroughOnException?(): void;
}

export interface WorkerScheduledController {
	scheduledTime: number;
	cron: string;
}

/** Test-only seams (D2): a bare `createWorker()` is what wrangler deploys. */
export interface CreateWorkerOverrides {
	makePool?: typeof makePostgresPool;
	migrate?: (db: ReturnType<typeof makePostgresDb>) => Promise<void>;
	clock?: Clock;
}

export interface UrumiWorker {
	fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response>;
	scheduled(
		controller: WorkerScheduledController,
		env: WorkerEnv,
		ctx: WorkerExecutionContext,
	): Promise<void>;
}

type Db = ReturnType<typeof makePostgresDb>;
type PgPool = ReturnType<typeof makePostgresPool>;

function requireConnectionString(env: WorkerEnv): string {
	const connectionString = env.HYPERDRIVE?.connectionString;
	if (connectionString === undefined || connectionString.length === 0) {
		throw new Error(
			'Missing Hyperdrive connection string: wrangler.jsonc needs a `hyperdrive` binding named "HYPERDRIVE" ' +
				"(with a provisioned Hyperdrive config id), the `nodejs_compat` compatibility flag, and " +
				"`compatibility_date` >= 2024-09-23 for pg over Hyperdrive to work.",
		);
	}
	return connectionString;
}

/** `db.destroy()` is a no-op when the driver never initialized (a request
 *  that ran no query), so end the pool explicitly as well — guarded by
 *  `pool.ending` because an initialized driver's destroy already ends it. */
async function destroyEventDb(db: Db, pool: PgPool): Promise<void> {
	try {
		await db.destroy();
	} finally {
		// Runs even when db.destroy() rejects: the sockets must close regardless
		// (the rejection still propagates to teardown's catch for logging).
		if (!pool.ending) await pool.end();
	}
}

/** Defer teardown past the response via waitUntil; never let it reject. */
function teardown(ctx: WorkerExecutionContext, db: Db | undefined, pool: PgPool | undefined): void {
	if (db === undefined || pool === undefined) return;
	ctx.waitUntil(
		destroyEventDb(db, pool).catch((err: unknown) => {
			console.error("[service] pool teardown failed:", err);
		}),
	);
}

/**
 * Worker factory. All cross-request memos (parsed config, the "migrations
 * done" promise) live in THIS closure — two instances share nothing (tests
 * are isolated by construction) while the deployed `export default
 * createWorker()` still gets per-isolate memoization (D2/D3).
 *
 * Per-event resources — pg Pool, Kysely db, stores, the Hono app — are
 * created fresh on every fetch/scheduled event and destroyed via
 * `ctx.waitUntil` in a `finally`: on workerd a TCP socket is bound to the
 * request that opened it, so a cached cross-request pool hangs or errors
 * with "Cannot perform I/O on behalf of a different request" (D1). `max: 5`
 * is plenty (Hyperdrive owns the real origin pool) and `idleTimeoutMillis: 0`
 * disables pg's idle-reaper timer, which would otherwise fire during a later
 * request and perform cross-request I/O.
 */
export function createWorker(overrides: CreateWorkerOverrides = {}): UrumiWorker {
	const makePool = overrides.makePool ?? makePostgresPool;
	const migrate = overrides.migrate ?? ((db: Db) => migrateToLatest(db));
	const clock: Clock = overrides.clock ?? { now: () => new Date() };

	// Config memo — env bindings are stable for a deployment, so the first
	// event's parse outcome (value OR error) holds for the isolate's lifetime.
	let configMemo: { ok: true; value: ServiceConfig } | { ok: false; error: unknown } | undefined;
	let warnedOpenGate = false;

	function getConfig(env: WorkerEnv): ServiceConfig {
		if (configMemo === undefined) {
			try {
				configMemo = { ok: true, value: resolveServiceConfig(env) };
			} catch (error) {
				configMemo = { ok: false, error };
			}
		}
		if (!configMemo.ok) throw configMemo.error;
		// Unset OR empty both leave the gate open (the middleware treats an
		// empty token as disabled) — warn once per isolate for either.
		const serviceToken = configMemo.value.serviceToken;
		if ((serviceToken === undefined || serviceToken.length === 0) && !warnedOpenGate) {
			warnedOpenGate = true;
			console.warn(
				"[service] SERVICE_API_TOKEN is unset — the write surface is OPEN. " +
					"Run `wrangler secret put SERVICE_API_TOKEN` once the CMS-side plugin threads the same token.",
			);
		}
		return configMemo.value;
	}

	// Gateway memo — mirrors the Node bin's wiring (index.ts) over the env
	// binding instead of process.env. Gateways hold secrets + node:crypto only
	// (no sockets), so unlike the pool they are safe to reuse across requests.
	// Wiring can THROW (x402's fail-closed test-facilitator opt-in, review G4);
	// the outcome — value or error — is memoized exactly like the config.
	let gatewaysMemo:
		| { ok: true; value: Partial<Record<PaymentMethod, PaymentGateway>> }
		| { ok: false; error: unknown }
		| undefined;

	function getGateways(env: WorkerEnv): Partial<Record<PaymentMethod, PaymentGateway>> {
		if (gatewaysMemo === undefined) {
			try {
				const gateways: Partial<Record<PaymentMethod, PaymentGateway>> = {};
				const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET;
				if (stripeWebhookSecret !== undefined && stripeWebhookSecret.length > 0) {
					gateways.stripe = new StripePaymentGateway({
						webhookSecret: stripeWebhookSecret,
						secretKey: env.STRIPE_SECRET_KEY,
						clock,
					});
				}
				const x402Gateway = wireX402Gateway(env);
				if (x402Gateway !== undefined) {
					gateways.x402 = x402Gateway;
				}
				gatewaysMemo = { ok: true, value: gateways };
			} catch (error) {
				gatewaysMemo = { ok: false, error };
			}
		}
		if (!gatewaysMemo.ok) throw gatewaysMemo.error;
		return gatewaysMemo.value;
	}

	// Email sender memo (Phase 5) — stateless like the gateways; HttpEmailSender
	// performs its fetch inside the current event, so cross-request reuse is
	// safe. Same env names as the Node bin; unset EMAIL_API_URL falls back to
	// ConsoleEmailSender (visible via `wrangler tail`).
	let emailSenderMemo: EmailSender | undefined;

	function getEmailSender(env: WorkerEnv): EmailSender {
		emailSenderMemo ??=
			env.EMAIL_API_URL !== undefined && env.EMAIL_API_URL.length > 0
				? new HttpEmailSender({
						apiUrl: env.EMAIL_API_URL,
						apiKey: env.EMAIL_API_KEY,
						from: env.EMAIL_FROM ?? "no-reply@urumi.local",
					})
				: new ConsoleEmailSender();
		return emailSenderMemo;
	}

	// Migrations: lazy, once per isolate, inside the first event (workers have
	// no boot phase and forbid top-level I/O). A rejection clears the memo so
	// the next event retries; cross-isolate races are serialized by kysely's
	// `kysely_migration_lock` and migrations are forward-only/idempotent (D3).
	let migrated: Promise<void> | undefined;

	function ensureMigrated(db: Db): Promise<void> {
		migrated ??= migrate(db).catch((err: unknown) => {
			migrated = undefined;
			throw err;
		});
		return migrated;
	}

	function makeEventDb(env: WorkerEnv): { pool: PgPool; db: Db } {
		const pool = makePool({
			connectionString: requireConnectionString(env),
			max: 5,
			idleTimeoutMillis: 0,
		});
		return { pool, db: makePostgresDb(pool) };
	}

	function buildApp(
		db: Db,
		env: WorkerEnv,
		config: ServiceConfig,
		gateways: Partial<Record<PaymentMethod, PaymentGateway>>,
	): Hono {
		const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
		const productCommerce = new KyselyProductCommerceStore({ db, clock });
		const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
		const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
		const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
		const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });
		// Phase 6 rules + Phase 7 reporting/settings (reporting is SQL-dialect-
		// aware; this entry is pg-only by construction).
		const shippingRules = new KyselyShippingRulesStore({ db });
		const taxRules = new KyselyTaxRulesStore({ db });
		const couponStore = new KyselyCouponStore({ db, idGen: uuidIdGen });
		const reportingStore = new KyselyReportingStore({ db, dialect: "postgres" });
		const settingsStore = new KyselySettingsStore({ db, clock });
		// Phase 5 customer identity + email surface — mirrors the Node bin.
		const customerStore = new KyselyCustomerStore({ db, idGen: uuidIdGen, clock });
		const addressStore = new KyselyAddressStore({ db, idGen: uuidIdGen, clock });
		const sessionStore = new KyselySessionStore({ db, idGen: uuidIdGen, clock });
		const credentialVerifier = new KyselyCredentialVerifier({
			db,
			customerStore,
			idGen: uuidIdGen,
			clock,
		});
		const storefrontBaseUrl = env.STOREFRONT_BASE_URL;
		return createApp({
			store,
			productCommerce,
			cartStore,
			orderStore,
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
			emailSender: getEmailSender(env),
			idGen: uuidIdGen,
			gateways,
			clock,
			ttlMs: config.ttlMs,
			// Same knob as the Node bin: CART_HOLD_TTL_MS drives both TTLs.
			checkoutTtlMs: config.ttlMs,
			internalToken: config.internalToken,
			serviceToken: config.serviceToken,
			...(storefrontBaseUrl !== undefined ? { storefrontBaseUrl } : {}),
		});
	}

	return {
		async fetch(request, env, ctx): Promise<Response> {
			let pool: PgPool | undefined;
			let db: Db | undefined;
			try {
				// Config resolves INSIDE the try — before any pool exists — so a bad
				// CART_HOLD_TTL_MS binding is the standard 500 envelope with zero
				// cleanup surface, never an uncaught workerd exception.
				const config = getConfig(env);
				const gateways = getGateways(env);
				({ pool, db } = makeEventDb(env));
				await ensureMigrated(db);
				const app = buildApp(db, env, config, gateways);
				// Every route returns a buffered `c.json(...)` body, so `finally`
				// (which only DEFERS destroy via waitUntil) can never truncate it.
				// env/ctx are threaded through for any future route that reads
				// `c.env`/`c.executionCtx` (no current route does — no behavior
				// change). workerd's real ctx satisfies Hono's ExecutionContext;
				// test stubs only carry waitUntil, which is all Hono itself calls.
				return await app.fetch(request, env, ctx as Parameters<typeof app.fetch>[2]);
			} catch (err) {
				console.error("[service] worker event failed:", err);
				return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
			} finally {
				teardown(ctx, db, pool);
			}
		},

		// The cron sweeps call the domain use-cases directly — no HTTP self-call,
		// so they need no secret and cannot silently degrade to a 503 no-op (D5).
		// Failures are logged, never thrown: hold correctness is carried by
		// lazy-on-read expiry, and order expiry's guarded flips are idempotent —
		// the next 15-min tick retries. Order expiry (Phase 4) is clock-driven
		// (NOT lazy-on-read), so this cron is its production driver on Workers —
		// the same janitor pattern the Node bin exposes via
		// `POST /internal/expire-orders`.
		async scheduled(_controller, env, ctx): Promise<void> {
			let pool: PgPool | undefined;
			let db: Db | undefined;
			try {
				const config = getConfig(env);
				({ pool, db } = makeEventDb(env));
				await ensureMigrated(db);
				const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
				const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
				const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
				const couponStore = new KyselyCouponStore({ db, idGen: uuidIdGen });
				const cartDeps: CartDeps = {
					cartStore,
					inventoryStore: store,
					clock,
					ttlMs: config.ttlMs,
				};
				// couponStore: Phase 6 (review I2) — expiry releases the order's coupon.
				const expireDeps: ExpireOrdersDeps = {
					orderStore,
					inventoryStore: store,
					couponStore,
					clock,
				};
				// Each janitor gets its OWN catch: a persistently failing hold sweep
				// must not starve order expiry (or vice versa), and each failure
				// carries its own label for diagnostics.
				try {
					const reclaimed = await expireHolds(cartDeps);
					console.log(`[service] cron sweep reclaimed ${reclaimed}`);
				} catch (err) {
					console.error("[service] hold sweep failed:", err);
				}
				try {
					const expired = await expireOrders(expireDeps);
					console.log(`[service] cron sweep expired ${expired} orders`);
				} catch (err) {
					console.error("[service] order sweep failed:", err);
				}
				// Phase 5 maintenance legs — the same pair the Node bin's
				// self-interval runs (and POST /internal/dispatch-emails triggers):
				// drain the order-email outbox (claims are atomic, at-least-once,
				// send failures retried next tick) and prune consumed/expired login
				// challenges. Same labels as index.ts.
				const customerStore = new KyselyCustomerStore({ db, idGen: uuidIdGen, clock });
				const credentialVerifier = new KyselyCredentialVerifier({
					db,
					customerStore,
					idGen: uuidIdGen,
					clock,
				});
				try {
					const sent = await dispatchOrderEmails({
						orderStore,
						emailSender: getEmailSender(env),
						customerStore,
						clock,
					});
					console.log(`[service] cron sweep sent ${sent} emails`);
				} catch (err) {
					console.error("[service] email dispatch failed:", err);
				}
				try {
					const pruned = await credentialVerifier.pruneChallenges(clock.now().toISOString());
					console.log(`[service] cron sweep pruned ${pruned} login challenges`);
				} catch (err) {
					console.error("[service] login-challenge prune failed:", err);
				}
			} catch (err) {
				// Setup failures only (config/binding/pool/migration) — the sweeps
				// catch their own.
				console.error("[service] cron event failed:", err);
			} finally {
				teardown(ctx, db, pool);
			}
		},
	};
}

export default createWorker();
