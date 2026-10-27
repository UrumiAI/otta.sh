import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { OTTA_PLUGIN_CAPABILITIES } from "@urumi.ai/otta-plugin";
import {
	EmdashProductCommerceStore,
	INVENTORY_COLLECTION,
	ORDERS_COLLECTION,
	REPORTING_DAILY_COLLECTION,
	SETTINGS_COLLECTION,
	SETTINGS_DOC_ID,
	systemClock,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	buttons,
	columnLabels,
	columnsOf,
	contextTexts,
	field,
	fieldIds,
	findBlocks,
	formFor,
	sectionHeading,
	sectionBlocks,
	type LooseBlock,
	sectionIds,
	tableWithId,
} from "./helpers/blocks.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

// §4.1 report/settings skeleton, §12.5: the admin Reports Block Kit page,
// proven under the REAL workerd-on-Node sandbox (not trusted in-process).
// em-dash renders the page by the single `admin` route with a
// `{type:"page_load", page:"/reports"}` BlockInteraction.
//
// SINCE INC-D3a THE DATA IS THE PLUGIN'S OWN. There is no `@otta-sh/service`
// deployment and no `ctx.http` call behind this screen: `makeAdminClients`
// hands the page an `InProcessReportingSettingsClient` that composes the
// `@urumi.ai/otta-domain` reporting use-cases over the `@urumi.ai/otta-store-emdash`
// adapters bound to `ctx.storage`. So every case below seeds DOCUMENTS instead
// of scripting a stub responder, and the four reports are read back through the
// same store the rest of the plugin writes:
//
//   revenue / orders-by-status  `reporting_daily/{currency}:{YYYY-MM-DD}`
//   top products                `orders`, over the FROZEN line snapshots
//   low stock                   `inventory`, titled through a live `sku_owners`
//                               claim on a live `product_commerce` row
//
// WHAT THAT COST, AND WHAT IT BOUGHT. The assertions that read the recorded
// REQUESTS — the `/reports/*` URLs, the `x-internal-token` header on each one
// (there is no admin token any more: ADR-0014 D3 deleted both tokens outright),
// and the `from`/`to`/`interval` query parameters — have no successor of the
// same shape, so each is re-aimed at something the DATA shows instead. That is
// a strictly stronger claim in the places it matters: a bound proven by a query
// string is a claim about what was ASKED, while a bound proven by which seeded
// day appears in the table is a claim about what was ANSWERED.
//
// ONE CASE MOVED OUT OF THIS SUITE, rather than being deleted. "Refunded falls
// back to the stated gap against a service whose buckets carry no refundedCents
// key" tested the renderer's em-dash fallback for an ABSENT `refundedCents`. No
// PRODUCER can omit the key any more — the in-process client emits it always,
// zero included — but the RENDERER still branches on it (`reports-page.ts`'s
// `readRefunded`, which also has to refuse a present-but-unusable figure), and a
// branch with no test is a branch that rots into a confident `$0.00` over an
// amount nobody reported. The claim never needed a transport, so it is now a
// direct unit test over the exported `buildReportsBlocks`:
// `test/reports-refunded-fallback.test.ts`.

/** Every seeded id is suffixed: the document store is shared by every sandbox
 *  suite in this process (see `sandbox/storage-bridge.ts`), and `lowStock`
 *  scans the WHOLE inventory collection rather than a window of it. */
const SFX = "rw";

/** An explicit period, so a test asserting on the day series is not a function
 *  of the day it runs on. The seeded revenue days (10 + 11 Jul) sit inside it
 *  and 12 Jul is the zero day. */
const RANGE = { from: "2026-07-10", to: "2026-07-12" } as const;

/** The default period is "the last 30 days, today included", so the cases whose
 *  SUBJECT is that default have to seed against the day they run on. */
const TODAY = new Date().toISOString().slice(0, 10);

/** The `YYYY-MM-DD` (UTC) `n` days before `day`. */
function dayBefore(day: string, n: number): string {
	return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** The stats block's items, in render order. */
function statItems(blocks: readonly LooseBlock[]): Array<Record<string, unknown>> {
	const stats = findBlocks(blocks, "stats")[0] as { items?: Array<Record<string, unknown>> };
	return stats?.items ?? [];
}

/** A chart block's ECharts option, by `block_id`. */
function chartOptions(blocks: readonly LooseBlock[], id: string): Record<string, unknown> {
	const chart = findBlocks(blocks, "chart").find((b) => b.block_id === id) as
		| { config?: { options?: Record<string, unknown> } }
		| undefined;
	return chart?.config?.options ?? {};
}

/** One series' data points, by series index. */
function seriesData(blocks: readonly LooseBlock[], id: string, index = 0): unknown[] {
	const series = (chartOptions(blocks, id)["series"] ?? []) as Array<{ data?: unknown[] }>;
	return series[index]?.data ?? [];
}

/** The sales chart's CURRENT series as `[day label, minor units, tooltip text]`. */
function salesPoints(blocks: readonly LooseBlock[]): Array<[string, number, string]> {
	const labels =
		((chartOptions(blocks, "reports:sales-chart")["xAxis"] ?? {}) as { data?: string[] }).data ??
		[];
	return (seriesData(blocks, "reports:sales-chart") as Array<[number, number, string]>).map(
		([i, amount, text]) => [labels[i] ?? "?", amount, text],
	);
}

/** The donut's slices as `[name, count]`. */
function statusSlices(blocks: readonly LooseBlock[]): Array<[string, number]> {
	return (
		seriesData(blocks, "reports:statuses-chart") as Array<{ name: string; value: number }>
	).map((d) => [d.name, d.value]);
}

/** The top-products bars as `[title, bar label]`. */
function topBars(blocks: readonly LooseBlock[]): Array<[string, string]> {
	const titles =
		((chartOptions(blocks, "reports:top-chart")["yAxis"] ?? {}) as { data?: string[] }).data ?? [];
	return (seriesData(blocks, "reports:top-chart") as Array<[number, number, string]>).map(
		([, i, text]) => [titles[i] ?? "?", text],
	);
}

/** "10 Jul" — the chart's day label for a `YYYY-MM-DD`. */
function dayLabel(day: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	}).format(new Date(`${day}T00:00:00.000Z`));
}

/** A table's rows, as plain records. */
function rowsOf(blocks: readonly LooseBlock[], id: string): Array<Record<string, unknown>> {
	return (tableWithId(blocks, id)?.rows ?? []) as Array<Record<string, unknown>>;
}

let sandbox: SandboxHandle;
let storage: StorageAccess;

function collection(name: string): NonNullable<StorageAccess[string]> {
	const target = storage[name];
	if (target === undefined) throw new Error(`no '${name}' collection`);
	return target;
}

/** Empty a collection. The store is process-scoped and three of the four
 *  reports scan a whole collection rather than an id, so a case's data has to
 *  be the ONLY data — otherwise a sibling suite's order decides this suite's
 *  top-products table. */
async function wipe(name: string): Promise<void> {
	const target = collection(name);
	for (;;) {
		const page = (await target.query({ limit: 100 })) as { items: ReadonlyArray<{ id: string }> };
		if (page.items.length === 0) return;
		for (const { id } of page.items) await target.delete(id);
	}
}

interface DaySeed {
	readonly day: string;
	readonly currency?: string;
	readonly revenueCents?: number;
	readonly refundedCents?: number;
	readonly refundEntries?: number;
	/** How many of the day's orders sit in each state RIGHT NOW. This is what
	 *  `ordersByStatus` folds — the page's Orders card and statuses table. */
	readonly stateCounts?: Record<string, number>;
	/** The orders behind `revenueCents` (`revenueOrders`). Defaults to one per
	 *  earning day; the Average order value card divides by it. */
	readonly revenueOrders?: number;
}

/** One `reporting_daily` document, written directly: the rollup is normally
 *  accrued by the order store's write hook one event at a time, and a report
 *  test has no business minting a whole order lifecycle to move a counter. */
async function seedDay(seed: DaySeed): Promise<void> {
	const currencyCode = seed.currency ?? "USD";
	const revenueCents = seed.revenueCents ?? 0;
	await collection(REPORTING_DAILY_COLLECTION).put(`${currencyCode}:${seed.day}`, {
		currency: currencyCode,
		date: seed.day,
		stateCounts: seed.stateCounts ?? {},
		// A bucket EXISTS when either half contributed; `revenueOrders` is the
		// contributor count behind the money, never the page's order count.
		revenueOrders: seed.revenueOrders ?? (revenueCents === 0 ? 0 : 1),
		revenueCents,
		refundEntries: seed.refundEntries ?? 0,
		refundedCents: seed.refundedCents ?? 0,
		updatedAt: `${seed.day}T00:00:00.000Z`,
	});
}

interface LineSeed {
	readonly productId: string;
	readonly title: string;
	readonly quantity: number;
	readonly unitPrice: number;
}

/** One order, for `topProducts` — the one report computed on READ, by scanning
 *  the window's orders over their frozen line snapshots. Only `state`, `items`
 *  and the indexed `createdAt` participate, so this document carries what that
 *  report reads and not a byte more. */
async function seedOrder(
	id: string,
	createdAt: string,
	items: readonly LineSeed[],
	state = "paid",
): Promise<void> {
	await collection(ORDERS_COLLECTION).put(id, {
		orderId: id,
		state,
		currency: "USD",
		createdAt,
		updatedAt: createdAt,
		items: items.map((line, index) => ({
			id: `${id}-line-${String(index)}`,
			productId: line.productId,
			sku: `SKU-${line.productId}`,
			title: line.title,
			unitPrice: line.unitPrice,
			currency: "USD",
			quantity: line.quantity,
			fulfillmentKind: "physical",
			reservationId: null,
		})),
	});
}

/** One `inventory` row. The title, when asked for, is seeded the REAL way —
 *  through the product store's own sku claim — because "a low-stock row is
 *  titled through a LIVE product claim, never with its sku" is a rule about
 *  that claim, and a hand-written `sku_owners` document would assert it against
 *  a shape nothing writes. */
async function seedStock(sku: string, onHand: number, title?: string): Promise<void> {
	await collection(INVENTORY_COLLECTION).put(sku, { sku, onHand, holds: {} });
	if (title === undefined) return;
	await new EmdashProductCommerceStore({ storage, clock: systemClock }).upsert(
		{
			productId: toProductId(`prod-${sku}`),
			title,
			sku: toSku(sku),
			price: { amount: cents(1999), currency: toCurrency("USD") },
		},
		idempotencyKey(`seed-${sku}`),
	);
}

function reports(
	input: Record<string, unknown> = {},
): Promise<{ result: unknown } | { error: string }> {
	return sandbox.invokeRoute("admin", { type: "page_load", page: "/reports", ...input });
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	// NO allowed hosts. This screen makes no request at all now, and an empty
	// allowlist is what says so on every case at once.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 120_000);

afterAll(async () => {
	await sandbox?.close();
});

beforeEach(async () => {
	await collection(SETTINGS_COLLECTION).delete(SETTINGS_DOC_ID);
	await wipe(REPORTING_DAILY_COLLECTION);
	await wipe(ORDERS_COLLECTION);
	await wipe(INVENTORY_COLLECTION);
});

/** The seeded shape most cases share, inside {@link RANGE}: $30.00 on 10 Jul
 *  with $2.50 refunded, $55.00 on 11 Jul with nothing refunded, and 12 Jul
 *  silent — the three cases the day series must render differently from each
 *  other. Three `paid` orders across the two days, one Gadget sale, one
 *  out-of-stock sku. */
async function seedStandardRange(): Promise<void> {
	await seedDay({
		day: "2026-07-10",
		revenueCents: 3000,
		refundedCents: 250,
		refundEntries: 1,
		stateCounts: { paid: 1 },
	});
	await seedDay({
		day: "2026-07-11",
		revenueCents: 5500,
		stateCounts: { paid: 2 },
		revenueOrders: 2,
	});
	await seedOrder(`ord-gadget-${SFX}`, "2026-07-11T09:00:00.000Z", [
		{ productId: "p2", title: "Gadget", quantity: 4, unitPrice: 1000 },
	]);
	await seedStock(`SKU-A-${SFX}`, 0, "Aluminum Water Bottle");
}

/** The same shape, dated so the DEFAULT period covers it — for the cases whose
 *  subject is that default rather than a chosen range. */
async function seedStandardDefault(): Promise<void> {
	await seedDay({
		day: dayBefore(TODAY, 1),
		revenueCents: 3000,
		refundedCents: 250,
		refundEntries: 1,
		stateCounts: { paid: 1 },
	});
	await seedDay({ day: TODAY, revenueCents: 5500, stateCounts: { paid: 2 }, revenueOrders: 2 });
	await seedOrder(`ord-gadget-${SFX}`, `${TODAY}T09:00:00.000Z`, [
		{ productId: "p2", title: "Gadget", quantity: 4, unitPrice: 1000 },
	]);
	await seedStock(`SKU-A-${SFX}`, 0, "Aluminum Water Bottle");
}

describe("Reports admin page (workerd sandbox)", () => {
	test("Reports page renders sales, orders, orders-by-status, top-products and low-stock sections from the plugin's own store", async () => {
		await seedStandardRange();

		const blocks = blocksOf(await reports(RANGE));
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// One always-open section per report, each a `header` resolved by
		// `block_id`, never by its text — in this order, nothing collapsed.
		expect(sectionIds(blocks)).toEqual([
			"reports:sales",
			"reports:orders",
			"reports:statuses",
			"reports:top",
			"reports:low",
		]);
		expect(findBlocks(blocks, "accordion")).toEqual([]);
		// Each section holds its own report's chart (low stock stays a table: it
		// is a to-do list, not a trend).
		expect(sectionBlocks(blocks, "reports:sales").map((b) => b.block_id)).toContain(
			"reports:sales-chart",
		);
		expect(sectionBlocks(blocks, "reports:orders").map((b) => b.block_id)).toContain(
			"reports:orders-chart",
		);
		expect(sectionBlocks(blocks, "reports:statuses").map((b) => b.block_id)).toContain(
			"reports:statuses-chart",
		);
		expect(sectionBlocks(blocks, "reports:top").map((b) => b.block_id)).toContain(
			"reports:top-chart",
		);
		expect(sectionBlocks(blocks, "reports:low").map((b) => b.block_id)).toEqual([
			"reports:low-table",
		]);
		// The 30-row revenue table is gone: the chart replaces it.
		expect(findBlocks(blocks, "table")).toHaveLength(1);
		expect(findBlocks(blocks, "chart")).toHaveLength(4);

		// ALL FOUR REPORTS WERE ACTUALLY ANSWERED — four DIFFERENT seeded facts,
		// each from its own collection, each in its own section.
		expect(salesPoints(blocks)).toEqual([
			["10 Jul", 3000, "$30.00"],
			["11 Jul", 5500, "$55.00"],
			["12 Jul", 0, "$0.00"],
		]);
		expect(seriesData(blocks, "reports:orders-chart")).toEqual([1, 2, 0]);
		expect(statusSlices(blocks)).toEqual([["paid (3)", 3]]);
		expect(topBars(blocks)).toEqual([["Gadget", "$40.00 · 4 sold"]]);
		expect(rowsOf(blocks, "reports:low-table")).toEqual([
			{ title: "Aluminum Water Bottle", sku: `SKU-A-${SFX}`, onHand: "0 · Out of stock" },
		]);
	});

	test("the sales chart states money as currency (never raw minor units) on its axis and in its tooltips", async () => {
		await seedStandardRange();

		const blocks = blocksOf(await reports(RANGE));
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// Every money string a viewer can SEE is formatted: the tooltip text of
		// both series, and the money axis's tick labels. The plotted values stay
		// integer minor units, which no viewer sees.
		expect(salesPoints(blocks).map(([, , text]) => text)).toEqual(["$30.00", "$55.00", "$0.00"]);
		const [, ticks] = chartOptions(blocks, "reports:sales-chart")["yAxis"] as Array<{
			data: string[];
		}>;
		expect(ticks?.data).toEqual(["$0", "$20", "$40", "$60"]);
		// The comparison series names its own (earlier) dates.
		expect(seriesData(blocks, "reports:sales-chart", 1)).toEqual([
			[0, 0, "$0.00 · 7 Jul"],
			[1, 0, "$0.00 · 8 Jul"],
			[2, 0, "$0.00 · 9 Jul"],
		]);
		// Day labels are date-only (M-6) — no timestamp anywhere.
		expect(salesPoints(blocks).map(([day]) => day)).toEqual(["10 Jul", "11 Jul", "12 Jul"]);

		// The `stats` block carries pre-formatted money too, and its change line
		// names the period it compares with — here an empty one, so no percentage.
		expect(statItems(blocks)[0]).toEqual({
			label: "Total sales",
			value: "$85.00",
			description: "No data in previous 3 days",
		});
	});

	test("all FOUR stat slots are filled — Total sales, Orders, Average order value, Refunded", async () => {
		await seedStandardDefault();

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// R-16 caps the block at four, and DESIGNER §6's finding was that one of
		// the four was used — an unlabelled figure alone in a bordered card.
		const items = statItems(blocks);
		expect(items).toHaveLength(4);
		expect(items.map((i) => i.label)).toEqual([
			"Total sales",
			"Orders",
			"Average order value",
			"Refunded",
		]);
		// Money is pre-formatted through formatMoney; the order count is a count.
		expect(items[0]?.value).toBe("$85.00");
		expect(items[1]?.value).toBe("3");
		// Orders counts EVERY status, so Total sales ÷ Orders does not equal the
		// AOV beside it — the line under the cards names the paid subset so that
		// reads as two different questions rather than as an arithmetic error.
		expect(contextTexts(blocks)).toContainEqual(
			expect.stringContaining("Orders counts every status (3 paid)."),
		);
		// 8500 over the 3 USD orders behind that revenue (`revenueOrders`).
		expect(items[2]?.value).toBe("$28.33");
		// The refunded AMOUNT is a real figure: 250 on the earlier day + 0 on
		// today, formatted through formatMoney like every other money value on
		// this screen. The description names the cohort and reconciles the amount
		// with the count beside it — no day counter here reports a `refunded`
		// ORDER at all, yet money still came back, which is exactly what a partial
		// refund looks like.
		expect(items[3]?.value).toBe("$2.50");
		// Nothing was seeded in the previous 30 days: no percentage is invented.
		expect(items.map((i) => i.description)).toEqual([
			"No data in previous 30 days",
			"No data in previous 30 days",
			"No data in previous 30 days",
			"No data in previous 30 days",
		]);
		expect(items.map((i) => i.trend)).toEqual([undefined, undefined, undefined, undefined]);
	});

	test("each card states its change against the previous period of equal length, read from the same rollup", async () => {
		await seedStandardDefault();
		// The previous 30 days (30–59 days back): $42.50 over one paid order, and
		// $5.00 refunded. The day just before the period (30 back) is in it too.
		await seedDay({
			day: dayBefore(TODAY, 40),
			revenueCents: 4250,
			refundedCents: 500,
			refundEntries: 1,
			stateCounts: { paid: 1 },
		});
		// 60 days back is outside both periods and must move nothing.
		await seedDay({ day: dayBefore(TODAY, 60), revenueCents: 99_999, stateCounts: { paid: 9 } });

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		const items = statItems(blocks);
		// 8500 vs 4250: doubled.
		expect(items[0]).toMatchObject({ description: "+100% vs previous 30 days", trend: "up" });
		// 3 orders vs 1.
		expect(items[1]).toMatchObject({ description: "+200% vs previous 30 days" });
		expect(items[1]).not.toHaveProperty("trend");
		// $28.33 vs $42.50.
		expect(items[2]).toMatchObject({ description: "\u221233% vs previous 30 days", trend: "down" });
		// $2.50 vs $5.00 refunded — signed, but no arrow: the renderer colours an
		// arrow by direction, and less refunded is not "bad" red.
		expect(items[3]).toEqual({
			label: "Refunded",
			value: "$2.50",
			description: "\u221250% vs previous 30 days",
		});
		// The dashed comparison line carries the previous period's money.
		const previous = seriesData(blocks, "reports:sales-chart", 1) as Array<
			[number, number, string]
		>;
		expect(previous.reduce((sum, [, amount]) => sum + amount, 0)).toBe(4250);
		expect(contextTexts(blocks)[0]).toMatch(/ \(UTC\) · compared with /);
	});

	test("Refunded renders $0.00 — not an em-dash — when the store reports zero refunds", async () => {
		await seedDay({ day: TODAY, revenueCents: 3000, stateCounts: { paid: 1 } });

		const items = statItems(blocksOf(await reports()));
		// A period in which nothing was refunded is a FACT, and a merchant is
		// entitled to read it as one. The em-dash is reserved for questions with
		// no answer — it must never stand in for a zero the report returned.
		//
		// And zero is now the ONLY way this can read: the in-process client emits
		// `refundedCents` on every bucket, zero included, so the renderer's
		// "absent key" arm (which the deleted legacy-wire case covered) has no
		// producer left at all.
		expect(items[3]?.value).toBe("$0.00");
	});

	test("a REFUND-ONLY currency never becomes a phantom revenue card — the USD store keeps its four cards, its AOV, its per-product revenue and its zero-fill", async () => {
		await seedStandardRange();
		// A USD store that took one EUR order and refunded it in full. The EUR
		// order is `refunded`, so the revenue-counting allow-list gives it NO
		// revenue — the bucket exists only because money came back, and reading it
		// as a currency the store trades in would flip this whole screen into
		// multi-currency mode off one refund.
		await seedDay({
			day: "2026-07-11",
			currency: "EUR",
			revenueCents: 0,
			refundedCents: 4500,
			refundEntries: 1,
		});

		const blocks = blocksOf(await reports(RANGE));
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		const items = statItems(blocks);

		// ONE revenue card, in the currency the store actually earns in — no
		// `€0.00` phantom, and therefore no second card eating R-16's cap.
		expect(items.map((i) => i.label)).toEqual([
			"Total sales",
			"Orders",
			"Average order value",
			"Refunded",
		]);
		// THE REFUNDED CARD SURVIVES — the card this whole increment exists for is
		// exactly the one the phantom used to truncate off the end.
		expect(items[3]?.value).toBe("$2.50");
		// AOV still computes (it dashes out on a genuinely multi-currency window).
		expect(items[2]?.value).not.toBe("—");
		// Per-product revenue is still attributed rather than suppressed.
		expect(blocks.some((b) => String(b.text ?? "").includes("spans more than one currency"))).toBe(
			false,
		);
		// The chart survives: three continuous days, 12 Jul at $0.00 — a
		// multi-currency window would have fallen back to a sparse table.
		expect(salesPoints(blocks).map(([day, , text]) => [day, text])).toEqual([
			["10 Jul", "$30.00"],
			["11 Jul", "$55.00"],
			["12 Jul", "$0.00"],
		]);
		expect(tableWithId(blocks, "reports:revenue-table")).toBeUndefined();
		// And the EUR money is NOT swallowed: it is stated, in its own currency,
		// beside the cards that cannot hold it.
		const notes = blocks.filter((b) => b.type === "context").map((b) => String(b.text));
		expect(notes.some((t) => t.includes("Also refunded: €45.00"))).toBe(true);
	});

	test("an all-refunds window states the figure on the card rather than dashing out", async () => {
		// Nothing earned, one order refunded: there IS a currency here, so the
		// card states its figure instead of pleading ignorance.
		await seedDay({
			day: TODAY,
			currency: "EUR",
			revenueCents: 0,
			refundedCents: 4500,
			refundEntries: 1,
		});

		const blocks = blocksOf(await reports());
		const items = statItems(blocks);
		// No revenue card claims a figure…
		expect(items[0]?.value).toBe("—");
		// …but the refund is money that genuinely moved, in a currency the page
		// can name, so it renders — and is not doubled into a second note.
		const refunded = items.find((i) => String(i.label).startsWith("Refunded"));
		expect(refunded?.value).toBe("€45.00");
		expect(
			blocks
				.filter((b) => b.type === "context")
				.some((b) => String(b.text).includes("Also refunded")),
		).toBe(false);
	});

	test("the Refunded card discloses BOTH of its caveats: the figure is retro-mutable, and in-progress refunds are excluded", async () => {
		await seedStandardDefault();

		// Stated once, in the line under the cards (each card's own description is
		// its change against the previous period).
		const description = contextTexts(blocksOf(await reports())).join(" ");
		// (a) A July order refunded in September moves July's figure — a closed
		// period re-run later does not have to match what it read at the time.
		expect(description).toMatch(/later refund changes this figure/i);
		// (b) `reserved`/`unverified` ledger rows are excluded, so a store sitting
		// on an ambiguous refund reads LOWER here than its order screens suggest.
		expect(description).toMatch(/refunds in progress are excluded/i);
	});

	test("AOV renders an em-dash, never $0.00, when there are no orders to average", async () => {
		// Nothing seeded at all: `beforeEach` emptied every collection the four
		// reports read, so all four answer honestly empty.
		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const items = statItems(blocks);
		// A division with no answer is not zero, and "unknown" must never render
		// as money — every money-bearing tile falls back to the em-dash.
		expect(items.map((i) => i.value)).toEqual(["—", "0", "—", "—"]);
		expect(items.map((i) => i.value)).not.toContain("$0.00");
	});

	test("Reports page fails closed with an error block when the commerce store is absent, never throws", async () => {
		// A boot with NO document store. The in-process clients build every
		// commerce adapter over `ctx.storage`, so this throws while the client is
		// being CONSTRUCTED — the failure mode the handler moved its construction
		// inside the `try` for, and the one the old allowlist rejection stood in
		// for when this data came over `ctx.http`.
		const starved = await loadPluginInSandbox({ allowedHosts: [] });
		try {
			const blocks = blocksOf(
				await starved.invokeRoute("admin", { type: "page_load", page: "/reports" }),
			);
			assertBlockContract(blocks, { screen: "reports", level: "list" });
			const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
			expect(banner).toBeDefined();
			// E-7's normative copy: names the symptom, never a raw status/URL, and
			// says a console bug is a live possibility (X-42) — not just "unreachable".
			const text = `${String(banner?.title ?? "")} ${String(banner?.description ?? "")}`;
			expect(text).not.toMatch(/HTTP \d|\/reports\//);
			expect(text).toMatch(/fault in the console itself/);
			// Fail CLOSED means no half-rendered screen: not one report table or chart.
			expect(findBlocks(blocks, "table")).toHaveLength(0);
			expect(findBlocks(blocks, "chart")).toHaveLength(0);
		} finally {
			await starved.close();
		}
	});

	test("a reports:page no-op action re-renders the page instead of falling through to a blank console", async () => {
		await seedStandardDefault();

		// §12.5: nothing can fire this today (no next_cursor, sortable
		// forbidden), but the id must be REGISTERED in the same change as the
		// tables that set it — this is the trap that arms itself later.
		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "block_action",
				action_id: "reports:page",
				value: {},
			}),
		);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		expect(blocks.length).toBeGreaterThan(0);
		expect(sectionBlocks(blocks, "reports:sales").length).toBeGreaterThan(0);
	});

	test("multi-currency stats are ordered ALPHABETICALLY, never by revenue — and the ranking gap is disclosed to the operator", async () => {
		// USD earns far more than EUR — a revenue-sorted list would put USD first.
		// Alphabetically ("EUR" < "USD") EUR comes first. The fix is proven by
		// which order actually comes back.
		await seedDay({ day: TODAY, currency: "USD", revenueCents: 90_000 });
		await seedDay({ day: TODAY, currency: "EUR", revenueCents: 1_000 });
		await seedOrder(`ord-widget-${SFX}`, `${TODAY}T09:00:00.000Z`, [
			{ productId: "p1", title: "Widget", quantity: 1, unitPrice: 500 },
		]);

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// BLOCKER FIX: selection AND order are alphabetical by currency code, not
		// a comparison of revenue (or any other magnitude) across currencies.
		const items = statItems(blocks);
		expect(items.slice(0, 2)).toMatchObject([
			{ label: "Total sales (EUR)", value: "€10.00" },
			{ label: "Total sales (USD)", value: "$900.00" },
		]);
		// R-16's cap still holds with the per-currency cards in front, and the
		// money tiles that CANNOT be computed across currencies say so rather than
		// dividing a sum of EUR and USD minor units by a currency-less count.
		expect(items.length).toBeLessThanOrEqual(4);
		const aov = items.find((i) => String(i.label).startsWith("Average order value"));
		expect(aov?.value).toBe("—");
		expect(String(aov?.description)).toMatch(/several currencies/);

		// DA-7: the ordering rule (alphabetical, because amounts in different
		// currencies are never compared) is disclosed to the OPERATOR, inside the
		// sales section — and ONLY when it actually applies (multi-currency).
		const revenueGroupText = sectionBlocks(blocks, "reports:sales")
			.filter((b) => b.type === "context")
			.map((b) => b.text);
		expect(revenueGroupText.some((t) => /alphabetically by currency code/.test(String(t)))).toBe(
			true,
		);

		// Top products carries no currency of its own, so it cannot be safely
		// formatted across more than one — same "—" fallback as before, but with
		// its own explanatory line inside the "Top products" group.
		// Ranked by units, stating no money at all.
		expect(topBars(blocks)).toEqual([["Widget", "1 sold"]]);
		const topGroupText = sectionBlocks(blocks, "reports:top")
			.filter((b) => b.type === "context")
			.map((b) => b.text);
		expect(topGroupText.some((t) => /more than one currency/.test(String(t)))).toBe(true);
	});

	test("a multi-currency period's top products are the server's UNITS ranking, so 'Ranked by units' is true", async () => {
		await seedDay({ day: TODAY, currency: "USD", revenueCents: 90_000 });
		await seedDay({ day: TODAY, currency: "EUR", revenueCents: 1_000 });
		// By revenue Atlas leads ($900 from 1 unit); by units Bolt does (5 × $1).
		await seedOrder(`ord-atlas-${SFX}`, `${TODAY}T09:00:00.000Z`, [
			{ productId: "pa", title: "Atlas", quantity: 1, unitPrice: 90_000 },
		]);
		await seedOrder(`ord-bolt-${SFX}`, `${TODAY}T10:00:00.000Z`, [
			{ productId: "pb", title: "Bolt", quantity: 5, unitPrice: 100 },
		]);

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		expect(topBars(blocks)).toEqual([
			["Bolt", "5 sold"],
			["Atlas", "1 sold"],
		]);
		const topGroupText = sectionBlocks(blocks, "reports:top").map((b) => String(b.text));
		expect(topGroupText.some((t) => t.startsWith("Ranked by units"))).toBe(true);
	});

	test("single-currency reports carry NEITHER disclosure line (T-8a: a caveat that cannot apply is noise)", async () => {
		await seedStandardDefault();

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		expect(
			sectionBlocks(blocks, "reports:sales").some(
				(b) => b.type === "context" && /alphabetically by currency code/.test(String(b.text)),
			),
		).toBe(false);
		expect(
			sectionBlocks(blocks, "reports:top").some(
				(b) => b.type === "context" && /more than one currency/.test(String(b.text)),
			),
		).toBe(false);
	});

	test("the DEFAULT period is whole days: 30 day points, both bounds exact, and re-submitting the untouched prefill asks the identical question", async () => {
		const first = dayBefore(TODAY, 29);
		// Three day documents, placed to pin BOTH bounds by what comes back: the
		// 30th day back is the first row, the day before it must not appear at
		// all, and today's whole-day document must appear at its full value.
		await seedDay({ day: first, revenueCents: 1000 });
		await seedDay({ day: dayBefore(TODAY, 30), revenueCents: 7777 });
		await seedDay({ day: TODAY, revenueCents: 3000 });

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// The default used to be instant-based (`now - 30d` → `now`) while every
		// surface above it presents whole days — so the subtitle said "1 Jul – 31
		// Jul" while the window ran mid-afternoon to mid-afternoon, the first row
		// was a partial day drawn as a whole one, and "last 30 days" spanned 31
		// rows. Nothing pinned the bounds, which is why the gate stayed green.
		//
		// The old bound assertions read the request's `from`/`to` query string.
		// There is no request now, so they are re-aimed at the ANSWER, which
		// states the same rule more strongly:
		//  - `from` is midnight of the 30th day back — that day's $10.00 is the
		//    first row, and the day before it (a conspicuous $77.77) is absent;
		//  - `to` is the END of today, not its midnight. A day document can only
		//    answer for a day the window covers WHOLE, so a `to` at midnight would
		//    have excluded today's document and recomputed the day from its orders
		//    instead — of which there are none, leaving $0.00 in that last row.
		const points = salesPoints(blocks);
		expect(points).toHaveLength(30);
		expect(points[0]).toEqual([dayLabel(first), 1000, "$10.00"]);
		expect(points[29]).toEqual([dayLabel(TODAY), 3000, "$30.00"]);
		expect(points.map(([, amount]) => amount)).not.toContain(7777);
		// The day before the period is the LAST day of the comparison period.
		const previous = seriesData(blocks, "reports:sales-chart", 1) as Array<
			[number, number, string]
		>;
		expect(previous[29]?.[1]).toBe(7777);

		// Choosing "Custom range" opens the From/To form prefilled with the
		// default period: submitting it untouched must ask the identical question,
		// or the same screen would answer differently under an unchanged subtitle.
		const custom = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "block_action",
				action_id: "reports:period",
				value: "Custom range",
			}),
		);
		assertBlockContract(custom, { screen: "reports", level: "list" });
		const form = formFor(custom, "reports:apply-range");
		const resubmitted = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "reports:apply-range",
				block_id: form?.block_id,
				values: {
					from: field(form, "from")?.initial_value,
					to: field(form, "to")?.initial_value,
				},
			}),
		);
		expect(salesPoints(resubmitted)).toEqual(points);
		expect(statItems(resubmitted)[0]?.value).toBe(statItems(blocks)[0]?.value);
		expect(contextTexts(resubmitted)[0]).toBe(contextTexts(blocks)[0]);
	});

	test("the period select applies a preset at once, and a period past 92 days charts 7-day points", async () => {
		await seedStandardDefault();

		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "block_action",
				action_id: "reports:period",
				value: "Last 365 days",
			}),
		);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		// The select REMOUNTS showing the choice: its block id names the preset.
		const picker = findBlocks(blocks, "actions").find((b) =>
			String(b.block_id).startsWith("reports:period"),
		);
		expect(picker?.block_id).toBe("reports:period-365d");
		const select = ((picker?.elements ?? []) as Array<Record<string, unknown>>)[0];
		expect(select).toMatchObject({
			type: "select",
			action_id: "reports:period",
			initial_value: "Last 365 days",
		});
		// No custom form for a preset.
		expect(formFor(blocks, "reports:apply-range")).toBeUndefined();
		// 365 days → 53 points of 7 days from the period's first day; the whole
		// period's sales still add up.
		const points = salesPoints(blocks);
		expect(points).toHaveLength(53);
		expect(points.reduce((sum, [, amount]) => sum + amount, 0)).toBe(8500);
		expect(contextTexts(blocks).some((t) => t.includes("One point per week"))).toBe(true);
		expect(statItems(blocks)[0]?.description).toMatch(/previous 365 days$/);
	});

	test("INC-13: the absorbed formatter left this screen's rendering byte-identical, and it states no wire timestamp", async () => {
		// Reports' `formatDay` and its three day helpers moved into
		// `scaffold/datetime.ts`; every other assertion in this file is unchanged
		// and green, which is what says the absorption preserved behaviour. This
		// test adds the half those assertions do not cover: the screen renders no
		// raw instant on any of its states.
		await seedStandardRange();

		const asDefault = blocksOf(await reports());
		assertBlockContract(asDefault, { screen: "reports", level: "list" });

		const ranged = blocksOf(await reports(RANGE));
		assertBlockContract(ranged, { screen: "reports", level: "list" });
		// Day-only bounds keep rendering as days — INC-13 governs INSTANTS, and a
		// period the operator typed as a calendar date stays one.
		expect(contextTexts(ranged)[0]).toMatch(/^10 Jul – 12 Jul 2026 \(UTC\)/);
	});

	test("the subtitle states the active period in absolute dates, and the From/To form prefills it", async () => {
		await seedStandardRange();

		const blocks = blocksOf(await reports(RANGE));
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// P0-3: the page used to state the DEFINITION of revenue and never the
		// window it applied it to.
		expect(contextTexts(blocks)[0]).toMatch(/^10 Jul – 12 Jul 2026 \(UTC\) · /);

		// The control that was missing entirely: two date fields whose submit
		// re-enters this handler.
		const form = formFor(blocks, "reports:apply-range");
		expect(form).toBeDefined();
		expect(fieldIds(form)).toEqual(["from", "to"]);
		expect(field(form, "from")?.type).toBe("date_input");
		expect(field(form, "to")?.type).toBe("date_input");
		// Prefilled with the period being rendered, so the form always shows what
		// the figures beneath it are for.
		expect(field(form, "from")?.initial_value).toBe("2026-07-10");
		expect(field(form, "to")?.initial_value).toBe("2026-07-12");
		// And the select says the period is a custom one.
		expect(buttons(blocks).find((e) => e.action_id === "reports:period")?.initial_value).toBe(
			"Custom range",
		);
	});

	test("submitting the From/To form re-renders the page for that period — the id round-trips, never {blocks: []}", async () => {
		await seedStandardRange();
		// An order placed at 18:00 on the LAST day of the period. Top products is
		// the report computed from the orders themselves, instant by instant, so
		// this row exists only if the window's `to` bound covers the whole day.
		await seedOrder(`ord-lateday-${SFX}`, "2026-07-12T18:00:00.000Z", [
			{ productId: "p9", title: "Late Sale", quantity: 2, unitPrice: 1500 },
		]);

		// The blank-console trap: an action id absent from REPORTS_ACTION_IDS
		// falls through the dispatcher to its `{blocks: []}` fallback. This id
		// fires on every period change, so the registration is load-bearing.
		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "reports:apply-range",
				values: { from: RANGE.from, to: RANGE.to },
			}),
		);
		expect(blocks.length).toBeGreaterThan(0);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// The rendered period changed with the submission…
		expect(contextTexts(blocks)[0]).toMatch(/^10 Jul – 12 Jul 2026 \(UTC\)/);
		expect(statItems(blocks)[1]?.description).toMatch(/previous 3 days$/);
		expect(salesPoints(blocks).map(([day]) => day)).toEqual(["10 Jul", "11 Jul", "12 Jul"]);
		// …and so did the window the REPORTS were computed over: the `to` bound
		// covers the whole last day, so an order placed on 12 Jul at 18:00 is not
		// silently dropped from the period the operator asked for.
		expect(topBars(blocks).map(([title]) => title)).toContain("Late Sale");
	});

	test("a backwards range renders the page with a banner and the default period — never a 4xx", async () => {
		await seedStandardDefault();

		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "reports:apply-range",
				values: { from: "2026-07-31", to: "2026-07-01" },
			}),
		);
		// G5: a non-2xx unmounts the whole block tree; an error is a banner INSIDE
		// a 200, with the page still rendered around it.
		expect(blocks.length).toBeGreaterThan(0);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "alert");
		expect(String(banner?.title)).toContain("last 30 days");
		expect(String(banner?.description)).toMatch(/From date falls after the To date/);
		// The substitution is never silent: the figures are labelled for the
		// period actually rendered.
		expect(statItems(blocks)[0]?.description).toMatch(/previous 30 days$/);
		expect(salesPoints(blocks)).toHaveLength(30);
		expect(sectionHeading(blocks, "reports:sales")).toBeDefined();
		// The form stays open so the operator can correct the dates.
		expect(formFor(blocks, "reports:apply-range")).toBeDefined();
	});

	test("the 400-day cap is judged on the SNAPPED period, so a range that exceeds it only once whole days apply still gets the banner", async () => {
		await seedStandardDefault();

		// 399 days apart as instants, 401 as whole days — so a cap checked on the
		// RAW bounds waved it through, the reports ran over an over-wide window
		// (which the domain refuses: `MAX_REPORT_RANGE_DAYS`), and the page
		// collapsed into the generic fail-closed banner, which names a console bug
		// and never the cap the operator actually hit.
		const blocks = blocksOf(
			await reports({ from: "2025-01-01T23:59:00.000Z", to: "2026-02-05T00:01:00.000Z" }),
		);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "alert");
		expect(String(banner?.description)).toBe(
			"A reporting period covers up to 400 days. Choose a shorter one.",
		);
		// The page still renders, for the default period — not the fail-closed shell.
		expect(findBlocks(blocks, "chart")).toHaveLength(4);
		expect(salesPoints(blocks)).toHaveLength(30);
		expect(findBlocks(blocks, "banner").some((b) => b.variant === "error")).toBe(false);

		// The boundary itself has not moved: 400 whole days is still accepted —
		// and accepted now means ANSWERED, since the reports run in this process:
		// no cap banner, and no E-7 shell from the domain's own refusal either.
		const atCap = blocksOf(await reports({ from: "2026-01-01", to: "2027-02-04" }));
		expect(findBlocks(atCap, "banner")).toHaveLength(0);
		expect(salesPoints(atCap)).toHaveLength(58); // 400 days in 7-day points
	});

	test("the low-stock group states the threshold its rows were selected by", async () => {
		await seedStandardRange();

		const blocks = blocksOf(await reports(RANGE));
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// "Low stock (1)" never said low compared to WHAT, and the threshold lives
		// two screens away in Settings — it is the settings store's
		// `lowStockThreshold`, at its domain default of 5 here.
		expect(String(sectionHeading(blocks, "reports:low")?.text)).toBe(
			"Low stock (1) — at or below 5",
		);
		expect(String(sectionHeading(blocks, "reports:sales")?.text)).toBe("Total sales over time");
	});

	test("a failed settings read degrades only the low-stock label (#287)", async () => {
		await seedStandardRange();
		await seedStock(`SKU-B-${SFX}`, 5);
		await seedStock(`SKU-C-${SFX}`, 6);
		const settings = collection(SETTINGS_COLLECTION);
		const get = settings.get;
		settings.get = async () => {
			throw new Error("injected settings read failure");
		};
		try {
			const blocks = blocksOf(await reports(RANGE));
			assertBlockContract(blocks, { screen: "reports", level: "list" });
			expect(findBlocks(blocks, "chart")).toHaveLength(4);
			expect(statItems(blocks)[0]?.value).toBe("$85.00");
			expect(statusSlices(blocks)).toEqual([["paid (3)", 3]]);
			expect(topBars(blocks)).toEqual([["Gadget", "$40.00 · 4 sold"]]);
			expect(rowsOf(blocks, "reports:low-table").map((row) => row.sku)).toEqual([
				`SKU-A-${SFX}`,
				`SKU-B-${SFX}`,
			]);
			expect(sectionHeading(blocks, "reports:low")?.text).toBe("Low stock (2)");
			expect(findBlocks(blocks, "banner")).toHaveLength(0);
		} finally {
			settings.get = get;
		}
	});

	test.each([0, 8])("low-stock rows and label use the saved threshold %i", async (threshold) => {
		await collection(SETTINGS_COLLECTION).put(SETTINGS_DOC_ID, {
			holdTtlMinutes: 15,
			lowStockThreshold: threshold,
		});
		await seedStock(`SKU-A-${SFX}`, threshold);
		await seedStock(`SKU-B-${SFX}`, threshold + 1);

		const blocks = blocksOf(await reports(RANGE));
		expect(rowsOf(blocks, "reports:low-table").map((row) => row.sku)).toEqual([`SKU-A-${SFX}`]);
		expect(sectionHeading(blocks, "reports:low")?.text).toBe(
			`Low stock (1) — at or below ${threshold}`,
		);
	});

	test("a failed PREVIOUS-period read costs only the comparison — the period's own figures still render", async () => {
		await seedStandardRange();
		// Fail exactly the rollup reads for 7–9 Jul (RANGE's previous period):
		// both the previous revenue and the previous orders-by-status read them.
		const daily = collection(REPORTING_DAILY_COLLECTION);
		const query = daily.query;
		daily.query = async (options) => {
			const where = (options as { where?: { date?: { gte?: unknown } } } | undefined)?.where;
			if (where?.date?.gte === "2026-07-07") {
				throw new Error("injected previous-period read failure");
			}
			return query.call(daily, options);
		};
		try {
			const blocks = blocksOf(await reports(RANGE));
			assertBlockContract(blocks, { screen: "reports", level: "list" });
			expect(findBlocks(blocks, "banner")).toHaveLength(0);
			expect(statItems(blocks)).toMatchObject([
				{ label: "Total sales", value: "$85.00", description: "No comparison available" },
				{ label: "Orders", value: "3", description: "No comparison available" },
				{ label: "Average order value", value: "$28.33", description: "No comparison available" },
				{ label: "Refunded", value: "$2.50", description: "No comparison available" },
			]);
			expect(findBlocks(blocks, "chart")).toHaveLength(4);
			expect(
				sectionBlocks(blocks, "reports:sales").some((b) =>
					String(b.text).includes("The previous period could not be loaded."),
				),
			).toBe(true);
		} finally {
			daily.query = query;
		}
	});

	test("a low-stock query failure still fails the reports page closed", async () => {
		await seedStandardRange();
		const inventory = collection(INVENTORY_COLLECTION);
		const query = inventory.query;
		inventory.query = async () => {
			throw new Error("injected inventory query failure");
		};
		try {
			const blocks = blocksOf(await reports(RANGE));
			expect(findBlocks(blocks, "table")).toHaveLength(0);
			expect(findBlocks(blocks, "chart")).toHaveLength(0);
			expect(findBlocks(blocks, "banner").find((b) => b.variant === "error")?.title).toBe(
				"Reports are unavailable",
			);
		} finally {
			inventory.query = query;
		}
	});

	test("low-stock rows render Title, then SKU, then On hand — the SKU→title map operators used to keep in their head", async () => {
		await seedStock(`SKU-A-${SFX}`, 0, "Aluminum Water Bottle");

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const table = tableWithId(blocks, "reports:low-table");
		expect(columnLabels(table)).toEqual(["Title", "SKU", "On hand"]);
		// X-4 (T-5): this report is every row at or below SOME threshold by
		// construction, so a badge column here could legitimately render the
		// identical value on every row of a real response — pin plain text so a
		// future change can't silently reintroduce a badge column on it.
		expect(columnsOf(table).filter((c) => c.format === "badge")).toEqual([]);
		expect(rowsOf(blocks, "reports:low-table")).toEqual([
			{ title: "Aluminum Water Bottle", sku: `SKU-A-${SFX}`, onHand: "0 · Out of stock" },
		]);
	});

	test("INC-10: Orders by status speaks the Orders screen's words, with every count on the chart", async () => {
		await seedDay({
			day: TODAY,
			revenueCents: 5000,
			stateCounts: { paid: 12, shipped: 4, failed: 2, refunded: 1 },
		});

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// The words are the Orders screen's own (`orderStateCell`), not a second
		// vocabulary for the same field: the dead ends mark themselves, the rest
		// stay bare — and every slice carries its count, so the numbers are on
		// the chart, not only in a tooltip. Largest slice first.
		expect(statusSlices(blocks)).toEqual([
			["paid (12)", 12],
			["shipped (4)", 4],
			["failed · closed (2)", 2],
			["refunded · closed (1)", 1],
		]);
	});

	test("a null title renders (untitled) and NEVER falls back to the SKU — they are different facts", async () => {
		// No product claims this sku, so the report can only answer "we do not
		// know its name" — one of the four distinct causes of a null title.
		await seedStock(`SKU-B-${SFX}`, 3);

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const rows = rowsOf(blocks, "reports:low-table");
		expect(rows).toEqual([{ title: "(untitled)", sku: `SKU-B-${SFX}`, onHand: "3 · Low" }]);
		// A null title is a distinct fact from a missing SKU (the row already
		// states the SKU in its own column) — the title cell never echoes it.
		expect(rows[0]?.title).not.toBe(`SKU-B-${SFX}`);
	});

	test("On hand states Out of stock at 0 and Low for the 1..threshold band, per the stock-visibility rendering rule", async () => {
		await seedStock(`SKU-A-${SFX}`, 0, "Out-of-stock Item");
		await seedStock(`SKU-B-${SFX}`, 1, "Barely-low Item");
		await seedStock(`SKU-C-${SFX}`, 5, "Low Item");

		const blocks = blocksOf(await reports());
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// THE SEPARATOR IS THE PRODUCTS LIST'S (INC-10): this screen shipped
		// `0 / Out of stock` against an unmerged sibling that then landed with
		// `0 · Out of stock`, and one fact spelled two ways one screen apart is
		// exactly what this pass exists to close.
		expect(rowsOf(blocks, "reports:low-table").map((r) => r.onHand)).toEqual([
			"0 · Out of stock",
			"1 · Low",
			"5 · Low",
		]);
	});

	test("the sales series is continuous across a zero-revenue gap", async () => {
		// Two days of sales with a three-day hole between them. The report returns
		// only the days that had revenue: an empty period is OMITTED rather than
		// zero-filled, because zero-filling is the renderer's job.
		await seedDay({ day: "2026-07-01", revenueCents: 1000 });
		await seedDay({ day: "2026-07-05", revenueCents: 2000 });

		const blocks = blocksOf(await reports({ from: "2026-07-01", to: "2026-07-05" }));
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// A month of steady sales and a month with a three-week hole used to
		// render identically. The zero days are the shape.
		expect(salesPoints(blocks)).toEqual([
			["1 Jul", 1000, "$10.00"],
			["2 Jul", 0, "$0.00"],
			["3 Jul", 0, "$0.00"],
			["4 Jul", 0, "$0.00"],
			["5 Jul", 2000, "$20.00"],
		]);
		expect(seriesData(blocks, "reports:orders-chart")).toEqual([1, 0, 0, 0, 1]);
	});

	test("92 days is charted a point per day; one day more folds into 7-day points, and says so", async () => {
		await seedDay({ day: "2026-07-10", revenueCents: 3000, refundedCents: 250, refundEntries: 1 });
		await seedDay({ day: "2026-07-11", revenueCents: 5500 });

		const render = async (from: string, to: string) => {
			const blocks = blocksOf(await reports({ from, to }));
			assertBlockContract(blocks, { screen: "reports", level: "list" });
			return {
				points: salesPoints(blocks),
				notes: sectionBlocks(blocks, "reports:sales").map((b) => String(b.text)),
			};
		};

		// 1 May – 31 Jul is exactly 92 days: one point per day.
		const at92 = await render("2026-05-01", "2026-07-31");
		expect(at92.points).toHaveLength(92);
		expect(at92.notes.some((t) => t.includes("One point per day"))).toBe(true);

		// 93 days: 13 weeks + 2 days → 14 points from 30 Apr; 10 + 11 Jul both
		// fall in the week starting 9 Jul.
		const at93 = await render("2026-04-30", "2026-07-31");
		expect(at93.points).toHaveLength(14);
		expect(at93.points.filter(([, amount]) => amount > 0)).toEqual([["9 Jul", 8500, "$85.00"]]);
		expect(at93.notes.some((t) => t.includes("One point per week"))).toBe(true);
	});

	test("a multi-currency window lists sales per day per currency instead of charting them, and the tiles that do not fit are named", async () => {
		await seedDay({ day: "2026-07-10", currency: "USD", revenueCents: 3000 });
		await seedDay({ day: "2026-07-10", currency: "EUR", revenueCents: 1000 });

		const blocks = blocksOf(await reports(RANGE));
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// Filling a multi-currency window is a day × currency cross product: a
		// quiet currency would contribute more $0.00 rows than there are real
		// ones, reading as activity that never happened. Sparse, and said.
		expect(rowsOf(blocks, "reports:revenue-table")).toEqual([
			{ bucketStart: "2026-07-10", revenue: "€10.00" },
			{ bucketStart: "2026-07-10", revenue: "$30.00" },
		]);
		expect(findBlocks(blocks, "chart").map((b) => b.block_id)).not.toContain("reports:sales-chart");
		expect(
			sectionBlocks(blocks, "reports:sales").some((b) =>
				String(b.text).includes("Days with no sales are omitted."),
			),
		).toBe(true);

		// Two revenue cards + Orders fill R-16's four, so Refunded falls off the
		// end — and a card that vanishes without a word is the silence this
		// increment exists to remove. Tile ORDER is unchanged.
		expect(statItems(blocks).map((i) => i.label)).toEqual([
			"Total sales (EUR)",
			"Total sales (USD)",
			"Orders",
			"Average order value",
		]);
		expect(contextTexts(blocks)).toContain(
			"Refunded is not shown: the four cards are taken by one sales card per currency.",
		);
	});

	test("Reports page manifest declares only content:read + network:request, no storage/kv/db capability", () => {
		// UNCHANGED BY INC-D3a, and worth restating now that this screen's data
		// comes from `ctx.storage`: the capability vocabulary has no string for
		// the document store. `ctx.storage` is granted by the descriptor's
		// declared collections, not by a capability, so a plugin holding ALL of
		// its commercial state still declares exactly these three (email:send is
		// the host's email pipeline, ADR-0031 — not storage, not egress).
		expect(OTTA_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request", "email:send"]);
		expect(OTTA_PLUGIN_CAPABILITIES).not.toContain("network:request:unrestricted");
		for (const cap of OTTA_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("kv")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
	});
});
