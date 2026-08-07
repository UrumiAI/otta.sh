import { customerId } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { type CompiledQuery, Kysely, PostgresDialect, sql } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import {
	KyselyOrderStore,
	makePostgresPool,
	makeSqliteDb,
	migrateToLatest,
	uuidIdGen,
} from "../src/index.js";
import type { Database, OrderStateColumn } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

const PENDING: OrderStateColumn = "pending";

// Pins the two `orders` lookup indices (0022_order_lookup_indices) at the DDL
// level, AND ties them to the real predicates `KyselyOrderStore` compiles —
// not a hand-restated copy of them. A plain column index survives a
// predicate rewrite; a functional index (idx_orders_buyer_ref_lower) or a
// partial index (idx_orders_customer_id) works for exactly the predicate
// shape it was built for — if `orderFilterConditions`/`linkGuestOrders`/
// `listForCustomer` is ever rewritten to a different fold, a `LIKE`, or a
// different NULL-handling, the index silently stops being used. A test that
// EXPLAINs its own hand-written SQL literal would not notice that (it would
// keep matching the unchanged index, not the changed production query), so
// the pg half below captures the ACTUAL compiled SQL Kysely sends for each
// real store call (via `Kysely`'s `log` hook) and EXPLAINs THAT.

const PG = process.env.PG_CONNECTION_STRING;

test("sqlite: both indices exist with the expected definitions", async () => {
	const db = makeSqliteDb(":memory:");
	try {
		await migrateToLatest(db);
		const rows = await sql<{ name: string; sql: string | null }>`
			select name, sql from sqlite_master
			where type = 'index' and name in ('idx_orders_customer_id', 'idx_orders_buyer_ref_lower')
			order by name
		`.execute(db);
		const defs = Object.fromEntries(rows.rows.map((r) => [r.name, r.sql]));

		expect(defs["idx_orders_buyer_ref_lower"]).toContain("lower(buyer_ref)");

		const customerIdx = defs["idx_orders_customer_id"] ?? "";
		// Match the parenthesised COLUMN LIST specifically, not the whole
		// statement — `indexOf("customer_id")` alone would also match inside the
		// index NAME (`idx_orders_customer_id`), so a deliberately permuted
		// `(created_at, customer_id, id)` index would satisfy a bare
		// `indexOf("customer_id") < indexOf("created_at")` check even though the
		// column order is wrong. Isolate `(...)` first, then check order inside it.
		const columnList = /\(([^()]*)\)/.exec(customerIdx)?.[1] ?? "";
		expect(columnList).not.toBe("");
		expect(columnList).toContain("customer_id");
		expect(columnList).toContain("created_at");
		expect(columnList.indexOf("customer_id")).toBeLessThan(columnList.indexOf("created_at"));
		expect(columnList.indexOf("created_at")).toBeLessThan(columnList.lastIndexOf("id"));
		expect(customerIdx.toLowerCase()).toContain("where");
		expect(customerIdx.toLowerCase()).toContain("is not null");
	} finally {
		await db.destroy();
	}
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

describe.skipIf(PG === undefined)("postgres: order lookup indices [pg]", () => {
	test("both indices exist with the expected definitions, and the REAL compiled predicates use them", async () => {
		if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
		const iso = await createIsolatedPgSchema(PG, { poolMax: 1 });
		cleanups.push(() => iso.teardown());

		// -- 1. pin the definitions -----------------------------------------
		const idxRows = await sql<{ indexname: string; indexdef: string }>`
			select indexname, indexdef from pg_indexes
			where schemaname = ${iso.schema} and tablename = 'orders'
			and indexname in ('idx_orders_customer_id', 'idx_orders_buyer_ref_lower')
			order by indexname
		`.execute(iso.db);
		const defs = Object.fromEntries(idxRows.rows.map((r) => [r.indexname, r.indexdef]));

		expect(defs["idx_orders_buyer_ref_lower"]).toBe(
			`CREATE INDEX idx_orders_buyer_ref_lower ON ${iso.schema}.orders USING btree (lower(buyer_ref))`,
		);
		expect(defs["idx_orders_customer_id"]).toBe(
			`CREATE INDEX idx_orders_customer_id ON ${iso.schema}.orders USING btree (customer_id, created_at, id) WHERE (customer_id IS NOT NULL)`,
		);

		// -- 2. a SEPARATE, logged, single-connection pool bound to the same ---
		// schema. `max: 1` means every query below — seeds, the real store
		// calls, and the raw EXPLAINs — shares the one physical connection, so
		// a session-level `enable_seqscan = off` (cheap, low-row-count way to
		// force an index path without needing thousands of rows) holds for all
		// of them without needing a transaction wrapper (which `KyselyOrderStore`
		// can't be constructed over — it's typed `Kysely<Database>`, not
		// `Transaction<Database>`).
		const capturedQueries: CompiledQuery[] = [];
		const pool = makePostgresPool({
			connectionString: PG,
			max: 1,
			options: `-c search_path=${iso.schema}`,
		});
		const loggedDb = new Kysely<Database>({
			dialect: new PostgresDialect({ pool }),
			log: (event) => {
				if (event.level === "query") capturedQueries.push(event.query);
			},
		});
		cleanups.push(() => loggedDb.destroy());

		await sql`set enable_seqscan = off`.execute(loggedDb);

		const now = new Date().toISOString();
		const noise = Array.from({ length: 20 }, (_, i) => ({
			id: `noise_${i}`,
			cart_id: null,
			currency: "USD",
			state: PENDING,
			idempotency_key: `idem_noise_${i}`,
			hold_expires_at: now,
			payment_method: null,
			buyer_ref: `noise_${i}@example.com`,
			customer_id: null,
			reconciliation_flag: null,
			created_at: now,
			updated_at: now,
		}));
		const listForCustomerTargetId = "order_listforcustomer_target";
		const linkGuestTargetBuyerRef = "Mixed.Case.LinkGuest@Example.com";
		const unionTargetCustomerId = "cus_union_target";
		const unionTargetBuyerRef = "Mixed.Case.Union@Example.com";
		await loggedDb
			.insertInto("orders")
			.values([
				...noise,
				{
					id: listForCustomerTargetId,
					cart_id: null,
					currency: "USD",
					state: PENDING,
					idempotency_key: "idem_listforcustomer_target",
					hold_expires_at: now,
					payment_method: null,
					buyer_ref: "listforcustomer_target@example.com",
					customer_id: "cus_listforcustomer_target",
					reconciliation_flag: null,
					created_at: now,
					updated_at: now,
				},
				{
					id: "order_linkguest_target",
					cart_id: null,
					currency: "USD",
					state: PENDING,
					idempotency_key: "idem_linkguest_target",
					hold_expires_at: now,
					payment_method: null,
					buyer_ref: linkGuestTargetBuyerRef,
					customer_id: null,
					reconciliation_flag: null,
					created_at: now,
					updated_at: now,
				},
				{
					id: "order_union_target",
					cart_id: null,
					currency: "USD",
					state: PENDING,
					idempotency_key: "idem_union_target",
					hold_expires_at: now,
					payment_method: null,
					buyer_ref: unionTargetBuyerRef,
					customer_id: unionTargetCustomerId,
					reconciliation_flag: null,
					created_at: now,
					updated_at: now,
				},
			])
			.execute();
		// `listForCustomer` fans out into `#loadById`, which throws without a
		// matching `order_totals` row (`executeTakeFirstOrThrow`) — only the one
		// row that predicate (1) actually matches needs one.
		await loggedDb
			.insertInto("order_totals")
			.values({
				order_id: listForCustomerTargetId,
				currency: "USD",
				subtotal_cents: 0,
				discount_cents: 0,
				shipping_cents: 0,
				tax_cents: 0,
				total_cents: 0,
			})
			.execute();
		await sql`analyze orders`.execute(loggedDb);

		const store = new KyselyOrderStore({
			db: loggedDb,
			idGen: uuidIdGen,
			clock: new FixedClock(new Date("2026-08-01T00:00:00.000Z")),
		});

		async function explainCaptured(query: CompiledQuery | undefined): Promise<string> {
			expect(query, "no query was captured — did the store method run?").toBeDefined();
			const q = query as CompiledQuery;
			const result = await pool.query(`explain ${q.sql}`, [...q.parameters]);
			return (result.rows as Array<{ "QUERY PLAN": string }>)
				.map((r) => r["QUERY PLAN"])
				.join("\n");
		}

		// -- (1) listForCustomer: `.where("customer_id", "=", customerId)
		//        .orderBy("created_at").orderBy("id")` — capture the FIRST query
		//        it issues; the row-fan-out `#loadById` calls (order_items,
		//        order_totals, …) that follow are irrelevant here and are issued
		//        strictly AFTER this one (sequential `await`s in the source).
		capturedQueries.length = 0;
		await store.listForCustomer(customerId("cus_listforcustomer_target"));
		const listForCustomerSql = capturedQueries[0];
		expect(listForCustomerSql?.sql).toContain('"customer_id"');
		const text1 = await explainCaptured(listForCustomerSql);
		expect(text1).toContain("idx_orders_customer_id");
		expect(text1).not.toContain("Sort");

		// -- (2) linkGuestOrders: `where(sql\`lower(buyer_ref)\`, "=",
		//        buyerRef.toLowerCase())`. This is a single UPDATE statement —
		//        no fan-out — so it's the only captured query. Executes for
		//        real (mutates the target row); re-EXPLAINing the identical
		//        captured statement afterward is a pure plan lookup, not a
		//        second execution, so that's harmless.
		capturedQueries.length = 0;
		await store.linkGuestOrders(customerId("cus_irrelevant"), linkGuestTargetBuyerRef);
		const linkGuestSql = capturedQueries[0];
		expect(linkGuestSql?.sql).toContain("lower(buyer_ref)");
		const text2 = await explainCaptured(linkGuestSql);
		expect(text2).toContain("idx_orders_buyer_ref_lower");

		// -- (3) orderFilterConditions customer key (via `countOrders`, the
		//        single-query half of the shared predicate builder):
		//        `customer_id = :id OR lower(buyer_ref) = lower(:buyerRef)`.
		capturedQueries.length = 0;
		await store.countOrders({
			customer: { customerId: unionTargetCustomerId, buyerRef: unionTargetBuyerRef },
		});
		const unionSql = capturedQueries[0];
		expect(unionSql?.sql).toContain("lower(orders.buyer_ref)");
		const text3 = await explainCaptured(unionSql);
		expect(text3).toContain("idx_orders_customer_id");
		expect(text3).toContain("idx_orders_buyer_ref_lower");
	}, 30_000);
});
