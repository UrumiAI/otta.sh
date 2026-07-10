import { serve } from "@hono/node-server";
import {
	KyselyInventoryStore,
	makePostgresDb,
	makePostgresPool,
	migrateToLatest,
	uuidIdGen,
} from "@urumi/store-postgres";
import { createApp } from "./app.js";

// Bin entry (§0.6): wire the real pg-backed store and serve on PORT.
const connectionString = process.env.PG_CONNECTION_STRING;
if (connectionString === undefined) {
	throw new Error("PG_CONNECTION_STRING is required to start @urumi/service");
}

const pool = makePostgresPool({ connectionString });
const db = makePostgresDb(pool);
await migrateToLatest(db);

const store = new KyselyInventoryStore({
	db,
	idGen: uuidIdGen,
	clock: { now: () => new Date() },
});

const app = createApp({ store });
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`@urumi/service listening on :${port}`);
