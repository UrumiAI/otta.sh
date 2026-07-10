import { serve } from "@hono/node-server";
import { FixedClock } from "@urumi/domain/testing";
import {
	KyselyCartStore,
	KyselyInventoryStore,
	KyselyProductCommerceStore,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createIsolatedPgSchema } from "@urumi/store-postgres/testing";
import { createApp } from "../../src/app.js";

export interface TestServer {
	baseUrl: string;
	/** The X-Internal-Token value the server accepts (undefined ⇒ disabled). */
	internalToken: string | undefined;
	seed(sku: string, qty: number): Promise<void>;
	onHand(sku: string): Promise<number>;
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
	const app = createApp({ store, productCommerce, cartStore, clock, internalToken });

	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		internalToken,
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
