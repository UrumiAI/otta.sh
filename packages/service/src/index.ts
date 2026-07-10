import { serve } from "@hono/node-server";
import { type CartDeps, expireHolds } from "@urumi/domain";
import {
	KyselyCartStore,
	KyselyInventoryStore,
	KyselyProductCommerceStore,
	makePostgresDb,
	makePostgresPool,
	migrateToLatest,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createApp } from "./app.js";

// Bin entry (§0.6): wire the real pg-backed stores and serve on PORT.
const connectionString = process.env.PG_CONNECTION_STRING;
if (connectionString === undefined) {
	throw new Error("PG_CONNECTION_STRING is required to start @urumi/service");
}

const pool = makePostgresPool({ connectionString });
const db = makePostgresDb(pool);
await migrateToLatest(db);

const clock = { now: () => new Date() };
const store = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
const productCommerce = new KyselyProductCommerceStore({ db, clock });
const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });

const app = createApp({ store, productCommerce, cartStore, clock });
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`@urumi/service listening on :${port}`);

// Self-scheduled sweep (§5) — the Node convenience wiring; a Worker deployment
// instead drives POST /internal/expire-holds via the plugin `cron` hook. Lazy
// on-read keeps correctness independent of this timer. Unref'd so it never
// keeps the process alive on its own.
const sweepDeps: CartDeps = { cartStore, inventoryStore: store, clock };
const sweepMs = Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 60_000);
setInterval(() => {
	void expireHolds(sweepDeps).catch((err: unknown) => {
		console.error("[service] hold sweep failed:", err);
	});
}, sweepMs).unref();
