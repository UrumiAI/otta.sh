import type { makePostgresPool } from "@urumi/store-postgres/pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorker, type WorkerEnv } from "../src/worker.js";

// Worker-entry unit tests over injected fakes (no PG): the factory closure
// owns the config + migration memos (D2), pools are per-request with
// try/finally teardown via ctx.waitUntil (D1), and pre-app failures surface as
// the standard 500 envelope — never an uncaught workerd exception.

type PgPool = ReturnType<typeof makePostgresPool>;

interface RecordedPool {
	ended: boolean;
	queries: string[];
}

/** A fake pg Pool factory satisfying exactly what kysely's PostgresDriver
 *  touches: `connect()` → client with `query`/`release`, `end()`, `ending`.
 *  `failFirstEnd` makes the FIRST `end()` call reject without marking the
 *  pool ended (simulating a rejecting `db.destroy()`); retries succeed. */
function fakePools(options: { failQueries?: boolean; failFirstEnd?: boolean } = {}): {
	pools: RecordedPool[];
	makePool: typeof makePostgresPool;
} {
	const pools: RecordedPool[] = [];
	const makePool = ((): PgPool => {
		const record: RecordedPool = { ended: false, queries: [] };
		pools.push(record);
		let endCalls = 0;
		const client = {
			query: (sql: string): Promise<{ command: string; rowCount: number; rows: never[] }> => {
				record.queries.push(sql);
				if (options.failQueries) return Promise.reject(new Error("fake query failure"));
				// Kysely only exposes numAffectedRows for mutation commands, so the
				// fake must echo the real command tag (e.g. the challenge prune reads
				// DeleteResult.numDeletedRows - a "SELECT" tag would make it NaN).
				const command = /^\s*(delete|insert|update)/i.exec(sql)?.[1]?.toUpperCase() ?? "SELECT";
				return Promise.resolve({ command, rowCount: 0, rows: [] });
			},
			release: (): void => {},
		};
		const pool = {
			ending: false,
			connect: () => Promise.resolve(client),
			end: (): Promise<void> => {
				endCalls++;
				if (options.failFirstEnd === true && endCalls === 1) {
					return Promise.reject(new Error("fake destroy failure"));
				}
				pool.ending = true;
				record.ended = true;
				return Promise.resolve();
			},
		};
		return pool as unknown as PgPool;
	}) as typeof makePostgresPool;
	return { pools, makePool };
}

function makeCtx(): {
	ctx: { waitUntil(promise: Promise<unknown>): void };
	settle(): Promise<void>;
} {
	const waits: Promise<unknown>[] = [];
	return {
		ctx: {
			waitUntil(promise: Promise<unknown>): void {
				waits.push(promise);
			},
		},
		async settle(): Promise<void> {
			await Promise.allSettled(waits);
		},
	};
}

const ENV: WorkerEnv = { HYPERDRIVE: { connectionString: "postgres://fake:fake@fake:5432/fake" } };
const CONTROLLER = { scheduledTime: 0, cron: "*/15 * * * *" };

function silence() {
	return {
		error: vi.spyOn(console, "error").mockImplementation(() => {}),
		log: vi.spyOn(console, "log").mockImplementation(() => {}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createWorker fetch", () => {
	test("test 5: a missing/empty HYPERDRIVE binding is a logged descriptive error and a wire 500 envelope", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const env of [{}, { HYPERDRIVE: { connectionString: "" } }] satisfies WorkerEnv[]) {
			const { pools, makePool } = fakePools();
			const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { ctx, settle } = makeCtx();

			const res = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
			await settle();

			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ ok: false, error: "internal_error" });
			expect(pools.length).toBe(0); // failed before any pool existed
			const logged = errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
			expect(logged).toContain("HYPERDRIVE");
			expect(logged).toContain("nodejs_compat");
			errorSpy.mockRestore();
		}
	});

	test("test 6: migration runs once per factory instance across many fetches", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const migrate = vi.fn(() => Promise.resolve());
		const { makePool } = fakePools();
		const worker = createWorker({ makePool, migrate });
		const { ctx, settle } = makeCtx();

		for (let i = 0; i < 3; i++) {
			const res = await worker.fetch(new Request("http://worker.test/health"), ENV, ctx);
			expect(res.status).toBe(200);
		}
		await settle();
		expect(migrate).toHaveBeenCalledTimes(1);

		// A second instance shares nothing: it migrates independently.
		const worker2 = createWorker({ makePool, migrate });
		const second = makeCtx();
		await worker2.fetch(new Request("http://worker.test/health"), ENV, second.ctx);
		await second.settle();
		expect(migrate).toHaveBeenCalledTimes(2);
	});

	test("test 7: a rejected migration is a 500, destroys its own pool, and clears the memo for a retry", async () => {
		const { error } = silence();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const migrate = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("migration boom"))
			.mockResolvedValue(undefined);
		const { pools, makePool } = fakePools();
		const worker = createWorker({ makePool, migrate });

		const first = makeCtx();
		const failed = await worker.fetch(new Request("http://worker.test/health"), ENV, first.ctx);
		await first.settle();
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ ok: false, error: "internal_error" });
		expect(pools.length).toBe(1);
		expect(pools[0]?.ended).toBe(true); // the failing event's pool is NOT abandoned
		expect(error).toHaveBeenCalled();

		const second = makeCtx();
		const retried = await worker.fetch(new Request("http://worker.test/health"), ENV, second.ctx);
		await second.settle();
		expect(retried.status).toBe(200);
		expect(migrate).toHaveBeenCalledTimes(2); // memo cleared on rejection
		expect(pools.length).toBe(2); // a fresh pool per event
		expect(pools[1]?.ended).toBe(true);
	});

	test("test 8: a new pool per request, every pool ended once waitUntil settles", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pools, makePool } = fakePools();
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const { ctx, settle } = makeCtx();

		await worker.fetch(new Request("http://worker.test/health"), ENV, ctx);
		await worker.fetch(new Request("http://worker.test/health"), ENV, ctx);
		await settle();

		expect(pools.length).toBe(2); // never reused across requests
		expect(pools.every((pool) => pool.ended)).toBe(true);
	});

	test("test 8b: a config-parse failure is a 500 with ZERO pools, and the error is memoized", async () => {
		const { error } = silence();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pools, makePool } = fakePools();
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const env: WorkerEnv = { ...ENV, CART_HOLD_TTL_MS: "abc" };
		const { ctx, settle } = makeCtx();

		const first = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		expect(first.status).toBe(500);
		expect(await first.json()).toEqual({ ok: false, error: "internal_error" });
		expect(pools.length).toBe(0); // config resolves before any pool exists

		const second = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		expect(second.status).toBe(500);
		await settle();
		expect(pools.length).toBe(0); // parse error memoized — makePool never called
		const logged = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
		expect(logged).toContain("CART_HOLD_TTL_MS");
	});

	test("test 9: config flows from the env binding, not process.env (SERVICE_API_TOKEN gates writes)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(process.env.SERVICE_API_TOKEN).toBeUndefined();
		const { makePool } = fakePools();
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const env: WorkerEnv = { ...ENV, SERVICE_API_TOKEN: "worker-secret" };
		const { ctx, settle } = makeCtx();

		const health = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		expect(health.status).toBe(200);

		const tokenless = await worker.fetch(
			new Request("http://worker.test/carts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			env,
			ctx,
		);
		expect(tokenless.status).toBe(401);
		expect(await tokenless.json()).toEqual({ ok: false, error: "unauthorized" });

		// The env-carried gate reads X-Service-Token (ADR-0007): the same POST with
		// the matching header passes the write gate. It lands on /internal (whose
		// own INTERNAL_API_TOKEN is unset here → 503 disabled), so a NON-401 status
		// proves the gate honored the header — no DB round-trip needed.
		const withServiceToken = await worker.fetch(
			new Request("http://worker.test/internal/expire-holds", {
				method: "POST",
				headers: { "X-Service-Token": "worker-secret" },
			}),
			env,
			ctx,
		);
		expect(withServiceToken.status).toBe(503);
		await settle();
	});

	test("the one-time open-gate warning fires for an EMPTY SERVICE_API_TOKEN too (empty opens the gate)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { makePool } = fakePools();
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const env: WorkerEnv = { ...ENV, SERVICE_API_TOKEN: "" };
		const { ctx, settle } = makeCtx();

		await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		await settle();

		const warnings = warn.mock.calls
			.map((call) => call.map(String).join(" "))
			.filter((line) => line.includes("SERVICE_API_TOKEN"));
		expect(warnings).toHaveLength(1); // fired, and only once per isolate

		// A set token never warns.
		const warned = createWorker({ makePool, migrate: () => Promise.resolve() });
		warn.mockClear();
		await warned.fetch(
			new Request("http://worker.test/health"),
			{ ...ENV, SERVICE_API_TOKEN: "tok" },
			ctx,
		);
		await settle();
		expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain("SERVICE_API_TOKEN");
	});

	test("Phase 4 gateways wire from the env binding; the webhook stays service-token-exempt", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { makePool } = fakePools();
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const { ctx, settle } = makeCtx();
		const env: WorkerEnv = {
			...ENV,
			SERVICE_API_TOKEN: "worker-secret",
			STRIPE_WEBHOOK_SECRET: "whsec_worker_unit",
		};
		const webhook = () =>
			worker.fetch(
				new Request("http://worker.test/webhooks/stripe", {
					method: "POST",
					headers: { "content-type": "application/json", "Stripe-Signature": "t=1,v1=bad" },
					body: JSON.stringify({ id: "evt_1" }),
				}),
				env,
				ctx,
			);
		// No X-Service-Token, gateway wired from env: the request reaches the route
		// and is rejected by its OWN Stripe-Signature verification (400), never the gate.
		const res = await webhook();
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });

		// Without the secret, a separate instance answers 503 (gateway unwired).
		const bare = createWorker({ makePool, migrate: () => Promise.resolve() });
		const noGateway = await bare.fetch(
			new Request("http://worker.test/webhooks/stripe", { method: "POST", body: "{}" }),
			ENV,
			ctx,
		);
		expect(noGateway.status).toBe(503);
		await settle();
	});

	test("misconfigured x402 env (no test-facilitator opt-in) is the 500 envelope, memoized before any pool", async () => {
		const { error } = silence();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pools, makePool } = fakePools();
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const env: WorkerEnv = {
			...ENV,
			X402_PAYTO: "0xTEST",
			X402_FACILITATOR_SECRET: "s3cret",
			// X402_ALLOW_TEST_FACILITATOR deliberately absent — fail closed (G4).
		};
		const { ctx, settle } = makeCtx();

		const first = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		expect(first.status).toBe(500);
		expect(await first.json()).toEqual({ ok: false, error: "internal_error" });
		const second = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		expect(second.status).toBe(500);
		await settle();
		expect(pools.length).toBe(0); // wiring failed before any pool existed; error memoized
		const logged = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
		expect(logged).toContain("X402_ALLOW_TEST_FACILITATOR");
	});
});

describe("createWorker scheduled", () => {
	test("test 10: the sweep runs once per event with NO tokens in env, and tears its pool down", async () => {
		const { log } = silence();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const migrate = vi.fn(() => Promise.resolve());
		const { pools, makePool } = fakePools();
		const worker = createWorker({ makePool, migrate });
		const { ctx, settle } = makeCtx();

		await worker.scheduled(CONTROLLER, ENV, ctx); // ENV carries no tokens at all
		await settle();

		expect(migrate).toHaveBeenCalledTimes(1);
		// All four janitors run once per event: the hold sweep, the Phase-4
		// order-expiry sweep (clock-driven, no lazy-on-read fallback), and the
		// Phase-5 email-outbox drain + login-challenge prune.
		const sweepLogs = log.mock.calls
			.map((call) => call.map(String).join(" "))
			.filter((line) => line.includes("cron sweep"));
		expect(sweepLogs).toEqual([
			"[service] cron sweep reclaimed 0",
			"[service] cron sweep expired 0 orders",
			"[service] cron sweep sent 0 emails",
			"[service] cron sweep pruned 0 login challenges",
		]);
		expect(pools.length).toBe(1);
		expect(pools[0]?.ended).toBe(true);
	});

	test("test 10 (failure): each sweep has its own catch — a failing hold sweep does not starve order expiry, labels are distinct, the pool is still destroyed", async () => {
		const { error } = silence();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pools, makePool } = fakePools({ failQueries: true });
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const { ctx, settle } = makeCtx();

		await expect(worker.scheduled(CONTROLLER, ENV, ctx)).resolves.toBeUndefined();
		await settle();

		const logged = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
		// The hold sweep rejected AND the order sweep still ran (its own,
		// distinctly-labeled rejection proves it was reached).
		expect(logged).toContain("hold sweep failed");
		expect(logged).toContain("order sweep failed");
		expect(pools.length).toBe(1);
		expect(pools[0]?.ended).toBe(true);
	});

	test("teardown: a rejecting db.destroy() cannot skip pool.end()", async () => {
		const { error } = silence();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// scheduled runs real queries, so kysely's driver initializes and
		// db.destroy() reaches pool.end() — whose first call rejects here.
		const { pools, makePool } = fakePools({ failFirstEnd: true });
		const worker = createWorker({ makePool, migrate: () => Promise.resolve() });
		const { ctx, settle } = makeCtx();

		await worker.scheduled(CONTROLLER, ENV, ctx);
		await settle();

		expect(pools.length).toBe(1);
		expect(pools[0]?.ended).toBe(true); // the finally-side end() still ran
		const logged = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
		expect(logged).toContain("pool teardown failed"); // rejection surfaced, not swallowed silently
	});
});
