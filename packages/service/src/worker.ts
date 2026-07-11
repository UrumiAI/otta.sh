import {
	type CartDeps,
	type Clock,
	type ExpireOrdersDeps,
	expireHolds,
	expireOrders,
	type PaymentGateway,
	type PaymentMethod,
} from "@urumi/domain";
import { StripePaymentGateway } from "@urumi/payments-stripe";
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
} from "@urumi/store-postgres/pg";
import type { Hono } from "hono";
import { createApp } from "./app.js";
import { resolveServiceConfig, type ServiceConfig } from "./config.js";
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
}

export interface WorkerExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
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
	await db.destroy();
	if (!pool.ending) await pool.end();
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
		if (configMemo.value.serviceToken === undefined && !warnedOpenGate) {
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
		config: ServiceConfig,
		gateways: Partial<Record<PaymentMethod, PaymentGateway>>,
	): Hono {
		const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
		const productCommerce = new KyselyProductCommerceStore({ db, clock });
		const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
		const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
		const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
		const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });
		return createApp({
			store,
			productCommerce,
			cartStore,
			orderStore,
			entitlementStore,
			paymentEventStore,
			idGen: uuidIdGen,
			gateways,
			clock,
			ttlMs: config.ttlMs,
			// Same knob as the Node bin: CART_HOLD_TTL_MS drives both TTLs.
			checkoutTtlMs: config.ttlMs,
			internalToken: config.internalToken,
			serviceToken: config.serviceToken,
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
				const app = buildApp(db, config, gateways);
				// Every route returns a buffered `c.json(...)` body, so `finally`
				// (which only DEFERS destroy via waitUntil) can never truncate it.
				return await app.fetch(request);
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
				const cartDeps: CartDeps = {
					cartStore,
					inventoryStore: store,
					clock,
					ttlMs: config.ttlMs,
				};
				const expireDeps: ExpireOrdersDeps = { orderStore, inventoryStore: store, clock };
				const reclaimed = await expireHolds(cartDeps);
				console.log(`[service] cron sweep reclaimed ${reclaimed}`);
				const expired = await expireOrders(expireDeps);
				console.log(`[service] cron sweep expired ${expired} orders`);
			} catch (err) {
				console.error("[service] hold sweep failed:", err);
			} finally {
				teardown(ctx, db, pool);
			}
		},
	};
}

export default createWorker();
