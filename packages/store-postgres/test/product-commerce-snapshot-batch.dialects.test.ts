import { cents, currency, idempotencyKey, money, productId, sku } from "@urumi/domain";
import { FixedClock } from "@urumi/domain/testing";
import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyProductCommerceStore, makeSqliteDb, migrateToLatest } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";
import type { Kysely } from "kysely";

/**
 * The store-level half of the checkout anti-N+1 guard: `getManyByProductId`
 * issues EXACTLY ONE SQL statement for a batch of N ids — the bulk snapshot
 * read must never fan back out into one query per id. A regression fails THIS
 * test, not just a review. (The caller-level half — that `createOrderFromCart`
 * and `POST /checkout/quote` actually call the bulk method once instead of
 * looping `getByProductId` — is pinned in the domain's create-order test.)
 *
 * The behavioral cases live in the shared `productCommerceStoreContract` (run
 * per dialect by `product-commerce-store-contract.dialects.test.ts`); this file
 * pins only the query-count invariant, which the contract suite cannot see.
 */

/** Counts root-query executions: Kysely calls `transformQuery` once per
 *  executed root statement, so the count IS the statement count. */
class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count++;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

const PG_ENABLED = Boolean(process.env.PG_CONNECTION_STRING);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function makeSqliteRawDb(): Promise<Kysely<Database>> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return db;
}

async function makePgRawDb(): Promise<Kysely<Database>> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return iso.db;
}

function snapshotBatchQueryCountSuite(
	makeDb: () => Promise<Kysely<Database>>,
	dialect: string,
): void {
	describe(`getManyByProductId query count [${dialect}]`, () => {
		test("getManyByProductId issues exactly one SQL query for a batch of N ids", async () => {
			const db = await makeDb();
			const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

			// Seed through an UNcounted store so setup writes don't pollute the count.
			const seedStore = new KyselyProductCommerceStore({ db, clock });
			const ids = [];
			for (let i = 0; i < 10; i++) {
				const pid = productId(`prod-snap-${i}`);
				ids.push(pid);
				await seedStore.upsert(
					{
						productId: pid,
						sku: sku(`SKU-SNAP-${i}`),
						price: money(cents(100 + i), currency("USD")),
						title: `Title ${i}`,
					},
					idempotencyKey(`k-snap-${i}`),
				);
			}

			const counter = new QueryCountingPlugin();
			const countedStore = new KyselyProductCommerceStore({
				db: db.withPlugin(counter),
				clock,
			});

			const map = await countedStore.getManyByProductId(ids);

			// The anti-N+1 invariant at the store level: ONE statement, N ids.
			expect(counter.count).toBe(1);
			expect(map.size).toBe(10);
		});

		test("an empty id batch issues zero SQL queries", async () => {
			const db = await makeDb();
			const counter = new QueryCountingPlugin();
			const store = new KyselyProductCommerceStore({
				db: db.withPlugin(counter),
				clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			});

			expect((await store.getManyByProductId([])).size).toBe(0);
			expect(counter.count).toBe(0);
		});
	});
}

snapshotBatchQueryCountSuite(makeSqliteRawDb, "sqlite");

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	snapshotBatchQueryCountSuite(makePgRawDb, "pg");
});
