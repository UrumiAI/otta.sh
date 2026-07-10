import { serve } from "@hono/node-server";
import { FixedClock } from "@urumi/domain/testing";
import { createApp } from "@urumi/service/app";
import { KyselyInventoryStore, KyselyProductCommerceStore, uuidIdGen } from "@urumi/store-postgres";
import { createIsolatedPgSchema } from "@urumi/store-postgres/testing";

export interface LiveService {
	baseUrl: string;
	host: string;
	stop(): Promise<void>;
}

/**
 * Boots the REAL `@urumi/service` (`createApp`) on an ephemeral port,
 * Postgres-backed in an isolated schema — mirrors
 * `packages/service/test/helpers/start-test-server.ts` (Phase 0 §0.6), used
 * here so `HttpCommerceClient` (plan §6 step 6) is proven against the real
 * wire, not a hand-rolled stub.
 */
export async function startLiveService(): Promise<LiveService> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 8 });
	const db = iso.db;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

	const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const productCommerce = new KyselyProductCommerceStore({ db, clock });
	const app = createApp({ store, productCommerce });

	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		host: "127.0.0.1",
		async stop() {
			await new Promise<void>((resolve, reject) => {
				server.close((err: Error | undefined) => (err ? reject(err) : resolve()));
			});
			await iso.teardown();
		},
	};
}
