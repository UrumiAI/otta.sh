import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
} from "@otta-sh/domain";
import { CountingIdGen, FixedClock } from "@otta-sh/domain/testing";
import type {
	InsertQueryNode,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyOrderStore, makeSqliteDb, migrateToLatest } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";
import type { Kysely } from "kysely";

/**
 * The store-level half of the checkout write-batching guard: `createFromCart`
 * with N lines must persist `order_items` in EXACTLY ONE multi-row INSERT, never
 * a per-line loop of N single-row inserts. A regression fails THIS test, not just
 * a review. The behavioral membership cases (all N lines persist + reload) live
 * in the shared `orderStoreContract`; this file pins only the statement-count
 * invariant, which the contract suite cannot see.
 */

const USD = currency("USD");

/** Counts INSERT-INTO-`order_items` root statements. Kysely calls
 *  `transformQuery` once per executed root statement, so counting the ones whose
 *  target table is `order_items` yields the exact number of item-insert
 *  statements the create emitted. (BEGIN/COMMIT are driver-level, not routed
 *  through plugins, so the transaction wrapper is invisible here.) */
class OrderItemsInsertCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		const node = args.node;
		if (node.kind === "InsertQueryNode") {
			const insert = node as InsertQueryNode;
			if (insert.into?.table.identifier.name === "order_items") this.count++;
		}
		return node;
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

function orderItemsInsertBatchSuite(
	makeDb: () => Promise<Kysely<Database>>,
	dialect: string,
): void {
	describe(`createFromCart order_items insert count [${dialect}]`, () => {
		test("a 3-line create issues exactly one order_items INSERT statement", async () => {
			const db = await makeDb();
			const counter = new OrderItemsInsertCountingPlugin();
			const store = new KyselyOrderStore({
				db: db.withPlugin(counter),
				idGen: new CountingIdGen("oi"),
				clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
			});

			const { created, order } = await store.createFromCart({
				orderId: orderId("ord-batch"),
				cartId: "cart-batch",
				currency: USD,
				idempotencyKey: idempotencyKey("key-batch"),
				holdExpiresAt: "2026-07-10T00:15:00.000Z",
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
				lines: [
					{
						productId: productId("p1"),
						sku: sku("SKU-1"),
						title: "Widget",
						unitPrice: cents(500),
						currency: USD,
						quantity: 3,
						fulfillmentKind: "physical",
						reservationId: reservationId("res-1"),
					},
					{
						productId: productId("p2"),
						sku: sku("SKU-2"),
						title: "Gadget",
						unitPrice: cents(1200),
						currency: USD,
						quantity: 1,
						fulfillmentKind: "physical",
						reservationId: reservationId("res-2"),
					},
					{
						productId: productId("p3"),
						sku: sku("SKU-3"),
						title: "Ebook",
						unitPrice: cents(999),
						currency: USD,
						quantity: 2,
						fulfillmentKind: "digital",
						reservationId: null,
					},
				],
				totals: { subtotal: cents(4698), total: cents(4698), currency: USD },
			});

			expect(created).toBe(true);
			expect(order.lines).toHaveLength(3);
			// The batching invariant: ONE statement for N lines, not N.
			expect(counter.count).toBe(1);
		});
	});
}

orderItemsInsertBatchSuite(makeSqliteRawDb, "sqlite");

describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	orderItemsInsertBatchSuite(makePgRawDb, "pg");
});
