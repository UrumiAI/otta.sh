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
 * Phase 2 §7 step 2 invariant guard (§6 "protect this from refactoring"):
 * `listCommerceByIds` issues EXACTLY ONE SQL statement for a batch of N ids,
 * `inStock` included — the intra-service `product_commerce ⋈ inventory` join
 * must never be split into a commerce query + a separate inventory query. A
 * regression fails THIS test, not just a review.
 *
 * The behavioral cases themselves live in the shared
 * `productCommerceStoreContract` (run per dialect by
 * `product-commerce-store-contract.dialects.test.ts`); this file pins only
 * the query-count invariant, which the contract suite cannot see.
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

function batchQueryCountSuite(makeDb: () => Promise<Kysely<Database>>, dialect: string): void {
	describe(`listCommerceByIds query count [${dialect}]`, () => {
		test("listCommerceByIds issues exactly one SQL query for a batch of N ids, including inStock", async () => {
			const db = await makeDb();
			const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));

			// Seed through an UNcounted store/connection so setup writes don't
			// pollute the count.
			const seedStore = new KyselyProductCommerceStore({ db, clock });
			const ids = [];
			for (let i = 0; i < 25; i++) {
				const pid = productId(`prod-count-${i}`);
				ids.push(pid);
				await seedStore.upsert(
					{
						productId: pid,
						sku: sku(`SKU-COUNT-${i}`),
						price: money(cents(100 + i), currency("USD")),
					},
					idempotencyKey(`k-count-${i}`),
				);
			}
			// Half the skus get an inventory row (in stock), half none — so the
			// single statement demonstrably carried BOTH outcomes of the join.
			for (let i = 0; i < 25; i += 2) {
				await db
					.insertInto("inventory")
					.values({ sku: `SKU-COUNT-${i}`, on_hand: 3 })
					.execute();
			}

			const counter = new QueryCountingPlugin();
			const countedStore = new KyselyProductCommerceStore({
				db: db.withPlugin(counter),
				clock,
			});

			const views = await countedStore.listCommerceByIds(ids);

			expect(counter.count).toBe(1);
			expect(views).toHaveLength(25);
			expect(views.filter((v) => v.inStock)).toHaveLength(13);
			expect(views.filter((v) => !v.inStock)).toHaveLength(12);
		});

		test("an empty id batch issues zero SQL queries", async () => {
			const db = await makeDb();
			const counter = new QueryCountingPlugin();
			const store = new KyselyProductCommerceStore({
				db: db.withPlugin(counter),
				clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			});

			expect(await store.listCommerceByIds([])).toEqual([]);
			expect(counter.count).toBe(0);
		});
	});
}

batchQueryCountSuite(makeSqliteRawDb, "sqlite");

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	batchQueryCountSuite(makePgRawDb, "pg");
});
