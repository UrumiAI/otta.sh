import { serve } from "@hono/node-server";
import { FixedClock } from "@urumi/domain/testing";
import { KyselyInventoryStore, KyselyProductCommerceStore, uuidIdGen } from "@urumi/store-postgres";
import { createIsolatedPgSchema } from "@urumi/store-postgres/testing";
import { createApp } from "../../src/app.js";

export interface TestServer {
	baseUrl: string;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
	stop(): Promise<void>;
}

/**
 * Boot `createApp(deps)` on an ephemeral port with Postgres-backed stores in
 * an isolated schema (§0.6). Returns the base URL plus seed/onHand helpers
 * (there is no HTTP endpoint to seed stock).
 */
export async function startTestServer(): Promise<TestServer> {
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
		async seed(sku, qty) {
			await db
				.insertInto("inventory")
				.values({ sku, on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async stop() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
			await iso.teardown();
		},
	};
}
