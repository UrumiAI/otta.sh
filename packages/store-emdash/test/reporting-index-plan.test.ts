/**
 * The query plans behind the rollup sweep's listings (issue #572, #660 review), on
 * SQLite.
 *
 * The refresh lists the days whose product lines need building with
 * `{ productsDirty: 1 | null, date: { gte, lt } } ORDER BY date DESC LIMIT 10`, and a
 * month rebuild and the claim heal read a month's or a day's unstamped claims with
 * `{ appliedAt: null, date: … }`. The host never runs `ANALYZE`, so SQLite (and D1)
 * plans them without statistics, and with bound parameters. Given lone `productsDirty`
 * and `appliedAt` indexes it takes the `date` range instead and reads every day (every
 * claim) in it, built or not. The declarations are therefore the composites
 * `["productsDirty", "date"]` and `["appliedAt", "date"]`, and this suite pins the plans
 * they buy, and what they cannot: the host's numeric type guard keeps `productsDirty: 1`
 * off every expression index, so that page is the date range the history floor bounds.
 * Every plan sorts in a temporary B-tree: the host orders `NULL`s first with a `CASE`
 * no index carries.
 *
 * The last case is the control: the earlier single-field declaration must plan the
 * bad way here, or this suite could not tell the two apart. The indexes are built as
 * the host builds them (`coupon-index-plan.ts`).
 */
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import Database from "better-sqlite3";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";
import { expect, test } from "vitest";
import {
	collectionOf,
	EmdashReportingStore,
	REPORTING_APPLIED_COLLECTION,
	REPORTING_COLLECTIONS,
	REPORTING_DAILY_COLLECTION,
	type ReportingAppliedDoc,
	type ReportingDailyStoredDoc,
	type StorageAccess,
} from "../src/index.js";
import {
	createHostIndexes,
	hostIndexName,
	PLAN_PLUGIN_ID,
	statementRecorder,
	type SentStatement,
} from "./coupon-index-plan.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";

type HostDb = Parameters<typeof runMigrations>[0];
type Indexes = readonly (string | readonly string[])[];

const DAILY_COMPOSITE = hostIndexName(REPORTING_DAILY_COLLECTION, ["productsDirty", "date"]);
const APPLIED_COMPOSITE = hostIndexName(REPORTING_APPLIED_COLLECTION, ["appliedAt", "date"]);

/** The plan of every SELECT that filters on `field`, given these physical indexes. */
async function plansFor(
	daily: Indexes,
	applied: Indexes,
): Promise<{ stale: string[]; claims: string[] }> {
	const raw = new Database(":memory:");
	const recorder = statementRecorder();
	const db = new Kysely({
		dialect: new SqliteDialect({ database: raw }),
		log: (event) => recorder.log(event),
	}) as HostDb;
	try {
		await runMigrations(db);
		await createHostIndexes(db, REPORTING_DAILY_COLLECTION, daily);
		await createHostIndexes(db, REPORTING_APPLIED_COLLECTION, applied);
		const storage: StorageAccess = {};
		for (const [name, config] of Object.entries(REPORTING_LAYOUT)) {
			const indexes = [...(config.indexes ?? []), ...(config.uniqueIndexes ?? [])];
			storage[name] = new PluginStorageRepository(db, PLAN_PLUGIN_ID, name, indexes);
		}
		// Sixty days of history: a few dirty, most never built, a few built and clean, and
		// a claim per day, a few of them unstamped.
		const days = collectionOf<ReportingDailyStoredDoc>(storage, REPORTING_DAILY_COLLECTION);
		const claims = collectionOf<ReportingAppliedDoc>(storage, REPORTING_APPLIED_COLLECTION);
		for (let i = 0; i < 60; i++) {
			const date = new Date(Date.UTC(2026, 3, 1) + i * 86_400_000).toISOString().slice(0, 10);
			const productsDirty =
				i % 10 === 0 ? { productsDirty: 1 } : i % 7 === 0 ? { productsDirty: 0 } : {};
			await days.put(`USD:${date}`, {
				currency: "USD",
				date,
				epoch: 0,
				seq: 0,
				revenueOrders: 0,
				revenueCents: 0,
				refundEntries: 0,
				refundedCents: 0,
				updatedAt: "2026-07-01T00:00:00.000Z",
				...productsDirty,
			});
			await claims.put(`claim-${String(i)}`, {
				orderId: `o-${String(i)}`,
				kind: "transition",
				date,
				currency: "USD",
				fromState: null,
				toState: "paid",
				refundId: null,
				amountCents: null,
				claimedAt: "2026-07-01T00:00:00.000Z",
				appliedAt: i % 9 === 0 ? null : "2026-07-01T00:00:00.000Z",
				absorbedAt: null,
			});
		}
		const store = new EmdashReportingStore({
			storage,
			clock: new FixedClock(new Date("2026-07-02T00:00:00.000Z")),
		});
		recorder.take();
		await store.staleProductDays("2026-06-15", 10, { notBefore: "2026-04-05" });
		const stale = selectsOn(recorder.take(), "productsDirty");
		await store.buildMonth("2026-04");
		await store.unstampedClaimDays("2026-04", "2026-07-02T00:00:00.000Z", 5);
		// A limit of none reads nothing (#660 review); one of two reads the day's page.
		await store.stampSettledClaims("2026-04-10", "2026-06-01T00:00:00.000Z", 0);
		await store.stampSettledClaims("2026-04-10", "2026-06-01T00:00:00.000Z", 2);
		const claimReads = selectsOn(recorder.take(), "appliedAt");
		const explain = (s: SentStatement): string =>
			raw
				.prepare(`EXPLAIN QUERY PLAN ${s.sql}`)
				.all(...(s.parameters as unknown[]))
				.map((row) => (row as { detail: string }).detail)
				.join(" | ");
		return { stale: stale.map(explain), claims: claimReads.map(explain) };
	} finally {
		await db.destroy();
	}
}

/** The SELECTs over `_plugin_storage` whose filter names `field`. */
function selectsOn(statements: readonly SentStatement[], field: string): SentStatement[] {
	return statements.filter(
		(s) =>
			/^\s*select/i.test(s.sql) &&
			s.sql.includes("_plugin_storage") &&
			s.sql.includes(`'$.${field}'`),
	);
}

const declared = (collection: string): Indexes => REPORTING_COLLECTIONS[collection]?.indexes ?? [];

/** A SEARCH bound by the date range — never a SCAN, never the host's list index. */
const DATE_RANGE =
	/SEARCH _plugin_storage USING (COVERING )?INDEX \S+ \(plugin_id=\? AND collection=\? AND (<expr>=\? AND )?<expr>>\? AND <expr><\?\)/;

test("the never-built listing searches (productsDirty, date) on both terms; the dirty one, the date range", async () => {
	const { stale } = await plansFor(
		declared(REPORTING_DAILY_COLLECTION),
		declared(REPORTING_APPLIED_COLLECTION),
	);
	// The dirty page, then the never-built one.
	expect(stale).toHaveLength(2);
	const [dirty, unbuilt] = stale;
	// `productsDirty IS NULL` and the date range, both bound by the composite: the upgrade
	// backfill reads only the days it has still to build, and fewer every run.
	expect(unbuilt).toMatch(
		new RegExp(
			`USING INDEX ${DAILY_COMPOSITE} \\(plugin_id=\\? AND collection=\\? AND <expr>=\\? AND <expr>>\\? AND <expr><\\?\\)`,
		),
	);
	// `productsDirty: 1` is a NUMBER, which the host compares through a type guard
	// (`CASE WHEN json_type(…) IN ('integer','real') THEN … END = ?`) that no expression
	// index matches. So the dirty page is served by the date range alone — every day
	// document between the history floor and today, which the floor is what bounds.
	expect(dirty).toMatch(DATE_RANGE);
	for (const plan of stale)
		expect(plan).not.toMatch(/idx_plugin_storage_list|SCAN _plugin_storage/);
});

test("the unstamped-claim reads search (appliedAt, date), or the month's date range", async () => {
	const { claims } = await plansFor(
		declared(REPORTING_DAILY_COLLECTION),
		declared(REPORTING_APPLIED_COLLECTION),
	);
	// The month rebuild's count, the held month's list, and one day's stamping page; the
	// limit-0 stamp read nothing.
	expect(claims).toHaveLength(3);
	const [count, monthList, stampPage] = claims;
	// The count every month rebuild makes never touches a table row.
	expect(count).toMatch(new RegExp(`USING COVERING INDEX ${APPLIED_COMPOSITE} \\(`));
	expect(stampPage).toMatch(
		new RegExp(
			`USING INDEX ${APPLIED_COMPOSITE} \\(plugin_id=\\? AND collection=\\? AND <expr>=\\? AND <expr>=\\?\\)`,
		),
	);
	// Only for a month a claim holds off: SQLite takes the date range for the ORDER BY.
	expect(monthList).toMatch(DATE_RANGE);
	for (const plan of claims)
		expect(plan).not.toMatch(/idx_plugin_storage_list|SCAN _plugin_storage/);
});

test("control: with a lone productsDirty index, the never-built listing reads every day in the range", async () => {
	const { stale, claims } = await plansFor(
		["currency", "date", "productsDirty"],
		["date", "orderId", "appliedAt"],
	);
	expect(stale[1]).toMatch(DATE_RANGE);
	expect(stale[1]).not.toMatch(/productsDirty/);
	// And the month rebuild's count reads the month's claims rather than its unstamped ones.
	expect(claims[0]).not.toMatch(/appliedAt/);
});
