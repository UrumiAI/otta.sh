import { makePostgresDb, makePostgresPool, migrateToLatest } from "@otta-sh/store-postgres/pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createWorker, type WorkerEnv } from "../src/worker.js";

const PG = process.env.PG_CONNECTION_STRING;

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

// PG-gated Worker integration (tests 11–13): the full env → pool → migration →
// stores → app wiring through `worker.fetch`/`worker.scheduled` against real
// Postgres. Isolation: a dedicated schema, reached BOTH by the worker (a
// search_path-scoped connection string in the fake HYPERDRIVE binding) and by
// its lazy migration (`overrides.migrate` pins `migrationTableSchema` — an
// unqualified migrateToLatest matches migration tables by name across ALL
// schemas; the production single-schema default path is covered by the manual
// wrangler-dev verification).
describe.skipIf(PG === undefined)("Worker entry [Postgres]", () => {
	const connectionString = PG as string;
	const schema = `test_worker_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const scopedConnectionString = `${connectionString}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;

	const admin = makePostgresPool({ connectionString, max: 1 });
	const probePool = makePostgresPool({
		connectionString,
		max: 2,
		options: `-c search_path=${schema}`,
	});
	const probeDb = makePostgresDb(probePool);

	const migrate = (db: ReturnType<typeof makePostgresDb>): Promise<void> =>
		migrateToLatest(db, { migrationTableSchema: schema });

	async function onHand(sku: string): Promise<number> {
		const row = await probeDb
			.selectFrom("inventory")
			.select("on_hand")
			.where("sku", "=", sku)
			.executeTakeFirst();
		return row?.on_hand ?? 0;
	}

	async function seed(sku: string, qty: number): Promise<void> {
		await probeDb
			.insertInto("inventory")
			.values({ sku, on_hand: qty })
			.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
			.execute();
	}

	beforeAll(async () => {
		await admin.query(`CREATE SCHEMA "${schema}"`);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await probeDb.destroy();
		await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
		await admin.end();
	});

	test("test 11: e2e fetch round-trip — lazy migration, gated writes, on_hand decremented in the DB", async () => {
		const worker = createWorker({ migrate });
		const env: WorkerEnv = {
			HYPERDRIVE: { connectionString: scopedConnectionString },
			SERVICE_API_TOKEN: "worker-pg-secret",
		};
		const serviceHeader = { "X-Service-Token": "worker-pg-secret" };
		const { ctx, settle } = makeCtx();

		// First event: the schema is empty — /health both proves the wiring and
		// triggers the lazy migration.
		const health = await worker.fetch(new Request("http://worker.test/health"), env, ctx);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });
		const applied = await admin.query(`SELECT name FROM "${schema}".kysely_migration`);
		expect(applied.rows.length).toBeGreaterThanOrEqual(4); // all forward-only migrations ran

		await seed("SKU-WORKER", 5);

		// A tokenless write is rejected by the env-carried gate.
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

		// The full cart round-trip with the X-Service-Token write gate (ADR-0007).
		const created = await worker.fetch(
			new Request("http://worker.test/carts", {
				method: "POST",
				headers: { "content-type": "application/json", ...serviceHeader },
				body: "{}",
			}),
			env,
			ctx,
		);
		expect(created.status).toBe(201);
		const { cartId } = (await created.json()) as { cartId: string };

		const added = await worker.fetch(
			new Request(`http://worker.test/carts/${cartId}/lines`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "wk-1",
					...serviceHeader,
				},
				body: JSON.stringify({ sku: "SKU-WORKER", qty: 2 }),
			}),
			env,
			ctx,
		);
		expect(added.status).toBe(200);
		expect((await added.json()) as { ok: boolean }).toMatchObject({ ok: true });
		expect(await onHand("SKU-WORKER")).toBe(3);

		// Reads stay open: GET /carts/:id without any token.
		const read = await worker.fetch(new Request(`http://worker.test/carts/${cartId}`), env, ctx);
		expect(read.status).toBe(200);

		await settle();
	});

	test("test 12: scheduled reclaims expired holds against real PG with NO tokens in env", async () => {
		const worker = createWorker({ migrate });
		const env: WorkerEnv = {
			HYPERDRIVE: { connectionString: scopedConnectionString },
			CART_HOLD_TTL_MS: "1",
		};
		const { ctx, settle } = makeCtx();

		await seed("SKU-SWEEP-W", 5);
		const created = await worker.fetch(
			new Request("http://worker.test/carts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			env,
			ctx,
		);
		expect(created.status).toBe(201);
		const { cartId } = (await created.json()) as { cartId: string };
		const added = await worker.fetch(
			new Request(`http://worker.test/carts/${cartId}/lines`, {
				method: "POST",
				headers: { "content-type": "application/json", "Idempotency-Key": "wk-sweep-1" },
				body: JSON.stringify({ sku: "SKU-SWEEP-W", qty: 3 }),
			}),
			env,
			ctx,
		);
		expect(added.status).toBe(200);
		expect(await onHand("SKU-SWEEP-W")).toBe(2);

		// Let the 1ms TTL lapse, then run the cron handler.
		await new Promise((resolve) => setTimeout(resolve, 25));
		await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *" }, env, ctx);
		await settle();

		expect(await onHand("SKU-SWEEP-W")).toBe(5); // the hold's stock is back
	});

	test("test 13: /internal/expire-holds parity through worker.fetch (config-flow proof for the secrets)", async () => {
		// Both secrets set: the endpoint needs X-Service-Token AND X-Internal-Token.
		const worker = createWorker({ migrate });
		const env: WorkerEnv = {
			HYPERDRIVE: { connectionString: scopedConnectionString },
			SERVICE_API_TOKEN: "svc-w",
			INTERNAL_API_TOKEN: "int-w",
		};
		const { ctx, settle } = makeCtx();
		const url = "http://worker.test/internal/expire-holds";

		const both = await worker.fetch(
			new Request(url, {
				method: "POST",
				headers: { "X-Service-Token": "svc-w", "X-Internal-Token": "int-w" },
			}),
			env,
			ctx,
		);
		expect(both.status).toBe(200);
		expect((await both.json()) as { ok: boolean }).toMatchObject({ ok: true });

		const wrongInternal = await worker.fetch(
			new Request(url, {
				method: "POST",
				headers: { "X-Service-Token": "svc-w", "X-Internal-Token": "wrong" },
			}),
			env,
			ctx,
		);
		expect(wrongInternal.status).toBe(401);

		const missingService = await worker.fetch(
			new Request(url, { method: "POST", headers: { "X-Internal-Token": "int-w" } }),
			env,
			ctx,
		);
		expect(missingService.status).toBe(401);

		// INTERNAL_API_TOKEN absent from env: 503 (disabled), never silently open.
		const workerNoInternal = createWorker({ migrate });
		const envNoInternal: WorkerEnv = {
			HYPERDRIVE: { connectionString: scopedConnectionString },
			SERVICE_API_TOKEN: "svc-w",
		};
		const disabled = await workerNoInternal.fetch(
			new Request(url, { method: "POST", headers: { "X-Service-Token": "svc-w" } }),
			envNoInternal,
			ctx,
		);
		expect(disabled.status).toBe(503);

		await settle();
	});
});
