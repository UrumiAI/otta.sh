import { orderId as toOrderId, sku as toSku } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import BetterSqlite3 from "better-sqlite3";
import { CompiledQuery, Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import {
	KyselyEntitlementStore,
	makePostgresPool,
	migrateToLatest,
	uuidIdGen,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// Pins the two `entitlements` lookup indices (0024_entitlement_lookup_indices)
// at the DDL level AND ties them to the predicate `KyselyEntitlementStore#check`
// actually compiles — never a hand-restated copy of it. `check` is the delivery
// gate (no active row ⇒ the file is not served), and its predicate is
// `state = ? AND sku = ? AND (order_id = ?)? AND (lower(buyer_ref) = ?)?`. The
// buyer half is served by a FUNCTIONAL index, which works for exactly the fold
// it was built for: if `check` is ever rewritten to `upper(buyer_ref)`, a
// different normalization, or a `LIKE`, the index silently stops being used. A
// test that EXPLAINed its own hand-written SQL literal would keep matching the
// unchanged index and stay green through that rewrite, so both halves below
// capture the ACTUAL compiled SQL the store sends (via `Kysely`'s `log` hook)
// and explain THAT.
//
// Node types, not plan text: EXPLAIN output wording varies across server
// versions, so the assertions are "the named index appears" + "no sequential
// scan node", never a byte-exact plan.

const BUYER_INDEX = "idx_entitlements_buyer_ref_lower";
const ORDER_INDEX = "idx_entitlements_order_id";

const PG = process.env.PG_CONNECTION_STRING;

const SKU = "DIG-1";
const TARGET_ORDER_ID = "ord_entitlement_target";
const TARGET_BUYER_REF = "Mixed.Case.Buyer@Example.com";

interface EntitlementRow {
	id: string;
	order_id: string;
	product_id: string | null;
	sku: string;
	buyer_ref: string;
	state: string;
	source: string;
	granted_at: string;
	grant_idempotency_key: string;
}

const GRANTED_AT = "2026-08-01T00:00:00.000Z";

/** Noise + the one row both scopes resolve to, so a plan has rows to reason about. */
function seedRows(): EntitlementRow[] {
	const noise: EntitlementRow[] = Array.from({ length: 20 }, (_, i) => ({
		id: `ent_noise_${i}`,
		order_id: `ord_noise_${i}`,
		product_id: null,
		sku: `NOISE-${i}`,
		buyer_ref: `noise_${i}@example.com`,
		state: "active",
		source: "order_paid",
		granted_at: GRANTED_AT,
		grant_idempotency_key: `idem_noise_${i}`,
	}));
	return [
		...noise,
		{
			id: "ent_target",
			order_id: TARGET_ORDER_ID,
			product_id: null,
			sku: SKU,
			buyer_ref: TARGET_BUYER_REF,
			state: "active",
			source: "order_paid",
			granted_at: GRANTED_AT,
			grant_idempotency_key: "idem_target",
		},
	];
}

function makeStore(db: Kysely<Database>): KyselyEntitlementStore {
	return new KyselyEntitlementStore({
		db,
		idGen: uuidIdGen,
		clock: new FixedClock(new Date(GRANTED_AT)),
	});
}

/**
 * Runs the three real `check` shapes against `store`, handing each one's
 * compiled statement to `explain`. Shared by both dialect halves so neither can
 * drift onto a different predicate than the other.
 */
async function explainEachCheckShape(
	store: KyselyEntitlementStore,
	captured: CompiledQuery[],
	explain: (query: CompiledQuery) => Promise<string>,
): Promise<{ orderScope: string; buyerScope: string; bothScopes: string }> {
	async function run(query: Parameters<KyselyEntitlementStore["check"]>[0]): Promise<string> {
		captured.length = 0;
		expect(await store.check(query)).toBe(true);
		const compiled = captured[0];
		expect(compiled, "no query was captured — did `check` short-circuit?").toBeDefined();
		return explain(compiled as CompiledQuery);
	}

	// (1) order scope — the storefront download capability (unguessable order id).
	const orderScope = await run({ orderId: toOrderId(TARGET_ORDER_ID), sku: toSku(SKU) });
	expect(captured[0]?.sql).toContain("order_id");
	// (2) buyer scope — the session path; a lower-normalized session email must
	//     match the mixed-case checkout ref, so the compare side is folded.
	const buyerScope = await run({ buyerRef: TARGET_BUYER_REF.toUpperCase(), sku: toSku(SKU) });
	expect(captured[0]?.sql).toContain("lower(buyer_ref)");
	// (3) both — the operator-authenticated shape, which ANDs the two.
	const bothScopes = await run({
		orderId: toOrderId(TARGET_ORDER_ID),
		buyerRef: TARGET_BUYER_REF.toUpperCase(),
		sku: toSku(SKU),
	});

	return { orderScope, buyerScope, bothScopes };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

test("sqlite: both indices exist and serve the real compiled `check` predicates", async () => {
	const database = new BetterSqlite3(":memory:");
	database.pragma("foreign_keys = ON");
	const captured: CompiledQuery[] = [];
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database }),
		log: (event) => {
			if (event.level === "query") captured.push(event.query);
		},
	});
	cleanups.push(() => db.destroy());
	await migrateToLatest(db);

	// -- 1. the definitions ------------------------------------------------
	const rows = await sql<{ name: string; sql: string | null }>`
		select name, sql from sqlite_master
		where type = 'index' and name in (${BUYER_INDEX}, ${ORDER_INDEX})
		order by name
	`.execute(db);
	const defs = Object.fromEntries(rows.rows.map((r) => [r.name, r.sql ?? ""]));

	// Isolate the parenthesised column list before checking order — the index
	// NAME also contains "buyer_ref"/"order_id", so a bare indexOf over the whole
	// statement would happily accept a permuted column list.
	function columnList(name: string): string {
		const stmt = defs[name] ?? "";
		const list = /\(((?:[^()]|\([^()]*\))*)\)\s*$/.exec(stmt)?.[1] ?? "";
		expect(list, `no column list found for ${name}`).not.toBe("");
		return list;
	}

	const buyerColumns = columnList(BUYER_INDEX);
	expect(buyerColumns).toContain("lower(buyer_ref)");
	expect(buyerColumns.indexOf("lower(buyer_ref)")).toBeLessThan(buyerColumns.indexOf("sku"));
	expect(buyerColumns.indexOf("sku")).toBeLessThan(buyerColumns.indexOf("state"));

	const orderColumns = columnList(ORDER_INDEX);
	expect(orderColumns.indexOf("order_id")).toBeLessThan(orderColumns.indexOf("sku"));
	expect(orderColumns.indexOf("sku")).toBeLessThan(orderColumns.indexOf("state"));

	await db.insertInto("entitlements").values(seedRows()).execute();
	await sql`analyze`.execute(db);

	// -- 2. the plans ------------------------------------------------------
	const store = makeStore(db);
	const plans = await explainEachCheckShape(store, captured, async (query) => {
		const explained = await db.executeQuery<{ detail: string }>(
			CompiledQuery.raw(`explain query plan ${query.sql}`, [...query.parameters]),
		);
		return explained.rows.map((r) => r.detail).join("\n");
	});

	// SQLite's planner reports `SEARCH … USING INDEX <name>` for an index-served
	// predicate and `SCAN <table>` for a full table scan.
	expect(plans.orderScope).toContain(ORDER_INDEX);
	expect(plans.orderScope).not.toContain("SCAN entitlements");
	expect(plans.buyerScope).toContain(BUYER_INDEX);
	expect(plans.buyerScope).not.toContain("SCAN entitlements");
	expect(plans.bothScopes).toMatch(new RegExp(`${BUYER_INDEX}|${ORDER_INDEX}`));
	expect(plans.bothScopes).not.toContain("SCAN entitlements");
});

describe.skipIf(PG === undefined)("postgres: entitlement lookup indices [pg]", () => {
	test("both indices exist with the expected definitions, and the REAL compiled predicates use them", async () => {
		if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
		const iso = await createIsolatedPgSchema(PG, { poolMax: 1 });
		cleanups.push(() => iso.teardown());

		// -- 1. pin the definitions -----------------------------------------
		const idxRows = await sql<{ indexname: string; indexdef: string }>`
			select indexname, indexdef from pg_indexes
			where schemaname = ${iso.schema} and tablename = 'entitlements'
			and indexname in (${BUYER_INDEX}, ${ORDER_INDEX})
			order by indexname
		`.execute(iso.db);
		const defs = Object.fromEntries(idxRows.rows.map((r) => [r.indexname, r.indexdef]));

		expect(defs[BUYER_INDEX]).toBe(
			`CREATE INDEX ${BUYER_INDEX} ON ${iso.schema}.entitlements USING btree (lower(buyer_ref), sku, state)`,
		);
		expect(defs[ORDER_INDEX]).toBe(
			`CREATE INDEX ${ORDER_INDEX} ON ${iso.schema}.entitlements USING btree (order_id, sku, state)`,
		);

		// -- 2. a separate, logged, single-connection pool on the same schema.
		// `max: 1` means the seeds, the real store calls and the EXPLAINs all
		// share one physical connection, so a session-level `enable_seqscan =
		// off` (the cheap, low-row-count way to force the index path without
		// seeding thousands of rows) holds for all of them without a
		// transaction wrapper — which `KyselyEntitlementStore` cannot be
		// constructed over anyway (it is typed `Kysely<Database>`).
		const captured: CompiledQuery[] = [];
		const pool = makePostgresPool({
			connectionString: PG,
			max: 1,
			options: `-c search_path=${iso.schema}`,
		});
		const loggedDb = new Kysely<Database>({
			dialect: new PostgresDialect({ pool }),
			log: (event) => {
				if (event.level === "query") captured.push(event.query);
			},
		});
		cleanups.push(() => loggedDb.destroy());

		await sql`set enable_seqscan = off`.execute(loggedDb);
		await loggedDb.insertInto("entitlements").values(seedRows()).execute();
		await sql`analyze entitlements`.execute(loggedDb);

		const store = makeStore(loggedDb);
		const plans = await explainEachCheckShape(store, captured, async (query) => {
			const result = await pool.query(`explain ${query.sql}`, [...query.parameters]);
			return (result.rows as Array<{ "QUERY PLAN": string }>)
				.map((r) => r["QUERY PLAN"])
				.join("\n");
		});

		expect(plans.orderScope).toContain(ORDER_INDEX);
		expect(plans.orderScope).not.toContain("Seq Scan");
		expect(plans.buyerScope).toContain(BUYER_INDEX);
		expect(plans.buyerScope).not.toContain("Seq Scan");
		// Both scopes together: either index resolves it, the other axis is a
		// filter. The invariant is only that neither axis falls back to a scan.
		expect(plans.bothScopes).toMatch(new RegExp(`${BUYER_INDEX}|${ORDER_INDEX}`));
		expect(plans.bothScopes).not.toContain("Seq Scan");
	}, 30_000);
});
