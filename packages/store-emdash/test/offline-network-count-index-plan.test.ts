/**
 * The query plan behind the per-network COD count (`countOpenOfflineOrders`'
 * `byClient`, ADR-0044 §7, #678), on SQLite.
 *
 * The host never runs `ANALYZE`, so SQLite (and D1) plans without statistics, and
 * between two indexes that each bind one equality term it takes the one created
 * last — the trap #619 hit (`coupon-recount-index-plan.test.ts`). `orders` declares
 * `offlineClientKey` alone and, after it, the `["state", "createdAt"]` composite.
 * A count on `offlineClientKey = ? AND state = ?` (or a one-value `IN`) therefore
 * reads EVERY `awaiting_payment` order in the store through the composite and
 * tests each one's key, instead of the handful that carry this network's key.
 *
 * The first case pins the plan the store's count gets: a SEARCH on the
 * `offlineClientKey` index. The second is the control: the `state = ?` predicate,
 * run against the same indexes, must plan onto the composite here, or this suite
 * could not tell the two apart. No index is added or changed for this — an index
 * change rebuilds every store's indexes on its first request under EmDash 1.5.0.
 */
import { cents, currency, idempotencyKey, orderId, productId, sku } from "@urumi.ai/otta-domain";
import Database from "better-sqlite3";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { expect, test } from "vitest";
import { ORDER_COLLECTIONS, ORDERS_COLLECTION, type StorageAccess } from "../src/index.js";
import {
	createHostIndexes,
	hostIndexName,
	PLAN_PLUGIN_ID,
	type SentStatement,
	statementRecorder,
} from "./coupon-index-plan.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

type HostDb = Parameters<typeof runMigrations>[0];

const USD = currency("USD");
const NETWORK = "hmac-of-network";
const KEY_INDEX = hostIndexName(ORDERS_COLLECTION, ["offlineClientKey"]);
const COMPOSITE = hostIndexName(ORDERS_COLLECTION, ["state", "createdAt"]);

/** The `count()` statements that filter on the network key. */
function networkCounts(statements: readonly SentStatement[]): SentStatement[] {
	return statements.filter(
		(s) =>
			/count\(/i.test(s.sql) &&
			s.sql.includes("'$.offlineClientKey'") &&
			s.sql.includes("_plugin_storage"),
	);
}

/**
 * Build the declared order indexes as the host would, seed open COD orders, then
 * run `count` and return the plan SQLite chooses for the network count it sent.
 */
async function networkCountPlan(
	count: (storage: StorageAccess, store: ReturnType<typeof makeOrderHarness>) => Promise<unknown>,
): Promise<string> {
	const raw = new Database(":memory:");
	const recorder = statementRecorder();
	const db = new Kysely({
		dialect: new SqliteDialect({ database: raw }),
		log: (event) => recorder.log(event),
	}) as HostDb;
	try {
		await runMigrations(db);
		const declared = ORDER_COLLECTIONS[ORDERS_COLLECTION]?.indexes ?? [];
		await createHostIndexes(db, ORDERS_COLLECTION, declared);
		const storage: StorageAccess = {};
		for (const [name, config] of Object.entries(ORDER_LAYOUT)) {
			const indexes = [...(config.indexes ?? []), ...(config.uniqueIndexes ?? [])];
			storage[name] = new PluginStorageRepository(db, PLAN_PLUGIN_ID, name, indexes);
		}
		const h = makeOrderHarness(storage);
		const store = h.settleDeps.orderStore;
		for (let i = 0; i < 3; i++) {
			const oid = orderId(`ord-plan-${String(i)}`);
			await store.createFromCart({
				orderId: oid,
				cartId: null,
				currency: USD,
				idempotencyKey: idempotencyKey(`plan-${String(i)}`),
				holdExpiresAt: "2026-07-10T00:15:00.000Z",
				buyerRef: `buyer-${String(i)}@example.com`,
				paymentMethod: "cod",
				offlineClientKey: i === 0 ? "another-network" : NETWORK,
				lines: [
					{
						productId: productId("p1"),
						sku: sku("DIG-1"),
						title: "Widget",
						unitPrice: cents(500),
						currency: USD,
						quantity: 1,
						fulfillmentKind: "digital",
						reservationId: null,
					},
				],
				totals: { subtotal: cents(500), total: cents(500), currency: USD },
			});
			await store.transition({
				orderId: oid,
				fromState: "pending",
				toState: "awaiting_payment",
				idempotencyKey: idempotencyKey(`place-plan-${String(i)}`),
				enqueueEmail: false,
			});
		}
		recorder.take();
		await count(storage, h);
		const counts = networkCounts(recorder.take());
		expect(counts).toHaveLength(1);
		const [sent] = counts;
		if (sent === undefined) throw new Error("no network count was sent");
		return raw
			.prepare(`EXPLAIN QUERY PLAN ${sent.sql}`)
			.all(...(sent.parameters as unknown[]))
			.map((row) => (row as { detail: string }).detail)
			.join(" | ");
	} finally {
		await db.destroy();
	}
}

test("the per-network count searches the offlineClientKey index, never the state composite", async () => {
	const plan = await networkCountPlan(async (_storage, h) => {
		expect(
			await h.settleDeps.orderStore.countOpenOfflineOrders({
				buyerRef: "nobody@example.com",
				clientKey: NETWORK,
			}),
		).toEqual({ byBuyer: 0, byClient: 2 });
	});
	expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${KEY_INDEX} \\(`));
	expect(plan).not.toContain(COMPOSITE);
});

test("control: offlineClientKey AND state = awaiting_payment plans onto the composite created last", async () => {
	const plan = await networkCountPlan(async (storage) => {
		const orders = storage[ORDERS_COLLECTION];
		if (orders === undefined) throw new Error("no orders collection");
		expect(await orders.count({ offlineClientKey: NETWORK, state: "awaiting_payment" })).toBe(2);
	});
	expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${COMPOSITE} \\(`));
});
