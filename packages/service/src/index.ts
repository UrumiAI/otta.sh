import { serve } from "@hono/node-server";
import {
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

const app = createApp({ store, productCommerce });
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`@urumi/service listening on :${port}`);
