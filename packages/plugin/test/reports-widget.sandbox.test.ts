import { OTTA_PLUGIN_CAPABILITIES } from "@otta-sh/plugin";
import { afterEach, describe, expect, test } from "vitest";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	contextTexts,
	field,
	fieldIds,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	type LooseBlock,
	openGroupIds,
	tableWithId,
} from "./helpers/blocks.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// §4.1 report/settings skeleton, §12.5: the admin Reports Block Kit page,
// proven under the REAL workerd-on-Node sandbox (not trusted in-process).
// Data reaches the page ONLY via ctx.http → the stub standing in for
// @otta-sh/service. em-dash renders the page by the single `admin` route with a
// `{type:"page_load", page:"/reports"}` BlockInteraction — NO token in the
// interaction; the admin token is sourced from write-only ctx.kv (seeded here
// via the Settings `save-token` action).

const ADMIN_TOKEN = "admin-token-xyz";

/** Seed the write-only admin token into the sandbox's ctx.kv via the Settings
 *  form's `save-token` action (the only way to reach the worker's in-memory kv),
 *  then clear the stub's recorded requests so the assertions see only the
 *  reports reads. */
async function seedAdminToken(sandbox: SandboxHandle, stub: StubCommerceServer): Promise<void> {
	await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-token",
		values: { internalToken: ADMIN_TOKEN },
	});
	stub.requests.length = 0;
}

function reportsResponder(req: { url: string }): { status: number; body: unknown } {
	if (req.url.startsWith("/reports/revenue")) {
		return {
			status: 200,
			body: {
				ok: true,
				buckets: [
					{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "USD", revenueCents: 3000 },
					{ bucketStart: "2026-07-11T00:00:00.000Z", currency: "USD", revenueCents: 5500 },
				],
			},
		};
	}
	if (req.url.startsWith("/reports/orders-by-status")) {
		return { status: 200, body: { ok: true, counts: [{ status: "paid", orderCount: 3 }] } };
	}
	if (req.url.startsWith("/reports/top-products")) {
		return {
			status: 200,
			body: {
				ok: true,
				products: [{ productId: "p2", titleSnapshot: "Gadget", qtySold: 4, revenueCents: 4000 }],
			},
		};
	}
	if (req.url.startsWith("/reports/low-stock")) {
		return { status: 200, body: { ok: true, rows: [{ sku: "SKU-A", onHand: 0 }] } };
	}
	// The low-stock THRESHOLD is a label, not a figure — the page reads it from
	// the same settings endpoint the Settings screen writes.
	if (req.url.startsWith("/settings")) {
		return {
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		};
	}
	return { status: 404, body: { error: "unknown" } };
}

/** An explicit period, so a test asserting on the day series is not a function
 *  of the day it runs on. The stub's two revenue buckets (10 + 11 Jul) sit
 *  inside it and 12 Jul is the zero day. */
const RANGE = { from: "2026-07-10", to: "2026-07-12" } as const;

/** The stats block's items, in render order. */
function statItems(blocks: readonly LooseBlock[]): Array<Record<string, unknown>> {
	const stats = findBlocks(blocks, "stats")[0] as { items?: Array<Record<string, unknown>> };
	return stats?.items ?? [];
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

describe("Reports admin page (workerd sandbox)", () => {
	test("Reports page renders revenue, orders-by-status, top-products, and low-stock groups via ctx.http only", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", {
			type: "page_load",
			page: "/reports",
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// §12.5: the four legacy `section` "headings" become accordion labels
		// (P-2 — `section` is never a heading) — one accordion per report,
		// resolved by `block_id`, never by label (D-6 makes labels dynamic).
		expect(group(blocks, "reports:revenue")).toBeDefined();
		expect(group(blocks, "reports:statuses")).toBeDefined();
		expect(group(blocks, "reports:top")).toBeDefined();
		expect(group(blocks, "reports:low")).toBeDefined();
		// S-3: exactly one group is open, and it is "Revenue by day".
		expect(openGroupIds(blocks)).toEqual(["reports:revenue"]);

		// Each report's data made it into a table, one per group.
		const tables = findBlocks(blocks, "table");
		expect(tables).toHaveLength(4);
		expect(tableWithId(blocks, "reports:revenue-table")).toBeDefined();

		// All four report endpoints were hit over ctx.http.
		const urls = (stub.requests ?? []).map((r) => r.url.split("?")[0]);
		expect(urls).toEqual(
			expect.arrayContaining([
				"/reports/revenue",
				"/reports/orders-by-status",
				"/reports/top-products",
				"/reports/low-stock",
			]),
		);
		// The admin token was forwarded as X-Internal-Token on every guarded read
		// (review J5) — sourced from write-only ctx.kv, not the interaction body.
		for (const req of stub.requests) {
			expect(req.headers["x-internal-token"]).toBe(ADMIN_TOKEN);
		}
	});

	test("Reports revenue table formats money (never raw minor units) and never a Currency column", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", {
			type: "page_load",
			page: "/reports",
			...RANGE,
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const revenueTable = tableWithId(blocks, "reports:revenue-table");
		const columns = (revenueTable?.columns ?? []) as Array<Record<string, unknown>>;
		expect(columns.map((c) => c.label)).not.toContain("Currency");
		const rows = (revenueTable?.rows ?? []) as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.revenue)).toEqual(["$30.00", "$55.00", "$0.00"]);
		// Bucket periods are date-only (M-6) — no millisecond timestamp.
		expect(rows.map((r) => r.bucketStart)).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);

		// The `stats` block carries pre-formatted money too, with NO "integer
		// minor units" description (M-1 — that description was the bug), and every
		// label states the period the figure covers.
		expect(statItems(blocks)[0]).toEqual({
			label: "Revenue (USD) — 10 Jul – 12 Jul 2026",
			value: "$85.00",
		});
	});

	test("all FOUR stat slots are filled — Revenue, Orders, AOV, Refunded — each labelled with its period", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// R-16 caps the block at four, and DESIGNER §6's finding was that one of
		// the four was used — an unlabelled figure alone in a bordered card.
		const items = statItems(blocks);
		expect(items).toHaveLength(4);
		expect(items.map((i) => i.label)).toEqual([
			// The currency is stated ONCE, in the label, never per row (G1).
			"Revenue (USD) — last 30 days",
			"Orders — last 30 days",
			"AOV (USD) — last 30 days",
			"Refunded (USD) — last 30 days",
		]);
		// Money is pre-formatted through formatMoney; the order count is a count.
		expect(items[0]?.value).toBe("$85.00");
		expect(items[1]?.value).toBe("3");
		// 8500 over the 3 `paid` orders the stub reports.
		expect(items[2]?.value).toBe("$28.33");
		expect(items[2]?.description).toBe("Average order value across 3 paid orders");
		// The refunded AMOUNT is absent from the reporting wire (the revenue
		// allow-list excludes refunded orders and orders-by-status carries counts
		// only). It renders as a stated gap — never as $0.00, and never quietly
		// relabelled as the count so the tile looks full.
		expect(items[3]?.value).toBe("—");
		expect(String(items[3]?.description)).toMatch(/needs a service change/);
	});

	test("AOV renders an em-dash, never $0.00, when there are no orders to average", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) => {
			if (req.url.startsWith("/reports/revenue")) {
				return { status: 200, body: { ok: true, buckets: [] } };
			}
			if (req.url.startsWith("/reports/orders-by-status")) {
				return { status: 200, body: { ok: true, counts: [] } };
			}
			if (req.url.startsWith("/reports/top-products")) {
				return { status: 200, body: { ok: true, products: [] } };
			}
			if (req.url.startsWith("/reports/low-stock")) {
				return { status: 200, body: { ok: true, rows: [] } };
			}
			return { status: 200, body: { ok: true, settings: { lowStockThreshold: 5 } } };
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const items = statItems(blocks);
		// A division with no answer is not zero, and "unknown" must never render
		// as money — every money-bearing tile falls back to the em-dash.
		expect(items.map((i) => i.value)).toEqual(["—", "0", "—", "—"]);
		expect(items.map((i) => i.value)).not.toContain("$0.00");
	});

	test("Reports page fails closed with an error block when ctx.http rejects, never throws", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		// Allowlist EXCLUDES the stub → ctx.http.fetch throws before egress.
		sandbox = await loadPluginInSandbox({
			allowedHosts: ["definitely-not-the-stub.example"],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		// E-7's normative copy: names the symptom, never a raw status/URL, and
		// says a console bug is a live possibility (X-42) — not just "unreachable".
		const text = `${String(banner?.title ?? "")} ${String(banner?.description ?? "")}`;
		expect(text).not.toMatch(/HTTP \d|\/reports\//);
		expect(text).toMatch(/fault in the console itself/);
		// The allowlist blocked egress: no request ever reached the stub.
		expect(stub.requests).toHaveLength(0);
	});

	test("a reports:page no-op action re-renders the page instead of falling through to a blank console", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		// §12.5: nothing can fire this today (no next_cursor, sortable
		// forbidden), but the id must be REGISTERED in the same change as the
		// tables that set it — this is the trap that arms itself later.
		const outcome = await sandbox.invokeRoute("admin", {
			type: "block_action",
			action_id: "reports:page",
			value: {},
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		expect(blocks.length).toBeGreaterThan(0);
		expect(groupBlocks(blocks, "reports:revenue").length).toBeGreaterThan(0);
	});

	test("multi-currency stats are ordered ALPHABETICALLY, never by revenue — and the wire-gap is disclosed to the operator", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) => {
			if (req.url.startsWith("/reports/revenue")) {
				return {
					status: 200,
					body: {
						ok: true,
						// USD earns far more than EUR — a revenue-sorted list would put
						// USD first. Alphabetically ("EUR" < "USD") EUR comes first. The
						// fix is proven by which order actually comes back.
						buckets: [
							{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "USD", revenueCents: 90_000 },
							{ bucketStart: "2026-07-10T00:00:00.000Z", currency: "EUR", revenueCents: 1_000 },
						],
					},
				};
			}
			if (req.url.startsWith("/reports/orders-by-status")) {
				return { status: 200, body: { ok: true, counts: [] } };
			}
			if (req.url.startsWith("/reports/top-products")) {
				return {
					status: 200,
					body: {
						ok: true,
						products: [{ productId: "p1", titleSnapshot: "Widget", qtySold: 1, revenueCents: 500 }],
					},
				};
			}
			if (req.url.startsWith("/reports/low-stock")) {
				return { status: 200, body: { ok: true, rows: [] } };
			}
			return { status: 404, body: { error: "unknown" } };
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// BLOCKER FIX: selection AND order are alphabetical by currency code, not
		// a comparison of revenue (or any other magnitude) across currencies.
		const items = statItems(blocks);
		expect(items.slice(0, 2)).toEqual([
			{ label: "Revenue (EUR) — last 30 days", value: "€10.00" },
			{ label: "Revenue (USD) — last 30 days", value: "$900.00" },
		]);
		// R-16's cap still holds with the per-currency cards in front, and the
		// money tiles that CANNOT be computed across currencies say so rather than
		// dividing a sum of EUR and USD minor units by a currency-less count.
		expect(items.length).toBeLessThanOrEqual(4);
		const aov = items.find((i) => String(i.label).startsWith("AOV"));
		expect(aov?.value).toBe("—");
		expect(String(aov?.description)).toMatch(/several currencies/);

		// DA-7: the wire gap (no per-currency order count) is disclosed to the
		// OPERATOR, inside the always-open "Revenue by day" group — not only in
		// the PR body — and ONLY when it actually applies (multi-currency).
		const revenueGroupText = groupBlocks(blocks, "reports:revenue")
			.filter((b) => b.type === "context")
			.map((b) => b.text);
		expect(revenueGroupText.some((t) => /no per-currency order count/.test(String(t)))).toBe(true);

		// Top products' currency-less wire can't be safely formatted across more
		// than one currency either — same "—" fallback as before, but now with
		// its own explanatory line inside the "Top products" group.
		const topTable = tableWithId(blocks, "reports:top-table");
		const topRows = (topTable?.rows ?? []) as Array<Record<string, unknown>>;
		expect(topRows.map((r) => r.revenue)).toEqual(["—"]);
		const topGroupText = groupBlocks(blocks, "reports:top")
			.filter((b) => b.type === "context")
			.map((b) => b.text);
		expect(topGroupText.some((t) => /more than one currency/.test(String(t)))).toBe(true);
	});

	test("single-currency reports carry NEITHER disclosure line (T-8a: a caveat that cannot apply is noise)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		expect(
			groupBlocks(blocks, "reports:revenue").some(
				(b) => b.type === "context" && /order count/.test(String(b.text)),
			),
		).toBe(false);
		expect(
			groupBlocks(blocks, "reports:top").some(
				(b) => b.type === "context" && /more than one currency/.test(String(b.text)),
			),
		).toBe(false);
	});

	test("the subtitle states the active period in absolute dates, and the From/To form prefills it", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", {
			type: "page_load",
			page: "/reports",
			...RANGE,
		});
		const blocks = blocksOf(outcome);
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
	});

	test("submitting the From/To form re-renders the page for that period — the id round-trips, never {blocks: []}", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		// The blank-console trap: an action id absent from REPORTS_ACTION_IDS
		// falls through the dispatcher to its `{blocks: []}` fallback. This id
		// fires on every period change, so the registration is load-bearing.
		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "reports:apply-range",
			values: { from: "2026-07-10", to: "2026-07-12" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.length).toBeGreaterThan(0);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// The rendered period changed with the submission…
		expect(contextTexts(blocks)[0]).toMatch(/^10 Jul – 12 Jul 2026 \(UTC\)/);
		expect(statItems(blocks).map((i) => i.label)).toEqual([
			"Revenue (USD) — 10 Jul – 12 Jul 2026",
			"Orders — 10 Jul – 12 Jul 2026",
			"AOV (USD) — 10 Jul – 12 Jul 2026",
			"Refunded (USD) — 10 Jul – 12 Jul 2026",
		]);
		// …and so did the window the SERVICE was asked about: the `to` bound
		// covers the whole last day, so an order placed on 12 Jul at 18:00 is not
		// silently dropped from the period the operator asked for.
		const revenueUrl = stub.requests
			.map((r) => r.url)
			.find((u) => u.startsWith("/reports/revenue"));
		const query = new URLSearchParams((revenueUrl ?? "").split("?")[1] ?? "");
		expect(query.get("from")).toBe("2026-07-10T00:00:00.000Z");
		expect(query.get("to")).toBe("2026-07-12T23:59:59.999Z");
	});

	test("a backwards range renders the page with a banner and the default period — never a 4xx", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "reports:apply-range",
			values: { from: "2026-07-31", to: "2026-07-01" },
		});
		const blocks = blocksOf(outcome);
		// G5: a non-2xx unmounts the whole block tree; an error is a banner INSIDE
		// a 200, with the page still rendered around it.
		expect(blocks.length).toBeGreaterThan(0);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "alert");
		expect(String(banner?.title)).toContain("last 30 days");
		expect(String(banner?.description)).toMatch(/From date falls after the To date/);
		// The substitution is never silent: the figures are labelled for the
		// period actually rendered.
		expect(statItems(blocks)[0]?.label).toBe("Revenue (USD) — last 30 days");
		expect(group(blocks, "reports:revenue")).toBeDefined();
	});

	test("the low-stock group states the threshold its rows were selected by", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// "Low stock (1)" never said low compared to WHAT, and the threshold lives
		// two screens away in Settings.
		expect(String(group(blocks, "reports:low")?.label)).toBe("Low stock (1) — at or below 5");
		// The revenue group drops the internal "(N buckets)" vocabulary.
		expect(String(group(blocks, "reports:revenue")?.label)).toBe("Revenue by day");
	});

	test("a failed settings read degrades the low-stock label instead of taking the screen down", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) =>
			req.url.startsWith("/settings")
				? { status: 500, body: { error: "boom" } }
				: reportsResponder(req),
		);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });
		// The threshold is a LABEL, not a figure: it is omitted, never guessed,
		// and the four reports still render.
		expect(String(group(blocks, "reports:low")?.label)).toBe("Low stock (1)");
		expect(findBlocks(blocks, "table")).toHaveLength(4);
	});

	test("the revenue series is continuous across a zero-revenue gap, and no chart block is emitted", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) => {
			if (req.url.startsWith("/reports/revenue")) {
				return {
					status: 200,
					body: {
						ok: true,
						// Two days of sales with a three-day hole between them — the wire
						// returns only the days that had revenue.
						buckets: [
							{ bucketStart: "2026-07-01T00:00:00.000Z", currency: "USD", revenueCents: 1000 },
							{ bucketStart: "2026-07-05T00:00:00.000Z", currency: "USD", revenueCents: 2000 },
						],
					},
				};
			}
			return reportsResponder(req);
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedAdminToken(sandbox, stub);

		const outcome = await sandbox.invokeRoute("admin", {
			type: "page_load",
			page: "/reports",
			from: "2026-07-01",
			to: "2026-07-05",
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		// DESIGNER §6: a month of steady sales and a month with a three-week hole
		// used to render identically. The zero days are the shape.
		const rows = (tableWithId(blocks, "reports:revenue-table")?.rows ?? []) as Array<
			Record<string, unknown>
		>;
		expect(rows.map((r) => r.bucketStart)).toEqual([
			"2026-07-01",
			"2026-07-02",
			"2026-07-03",
			"2026-07-04",
			"2026-07-05",
		]);
		expect(rows.map((r) => r.revenue)).toEqual(["$10.00", "$0.00", "$0.00", "$0.00", "$20.00"]);
		// A continuous table is the answer here, not a chart: the renderer strips
		// the formatter a money axis would need (§1.2).
		expect(findBlocks(blocks, "chart")).toHaveLength(0);
	});

	test("Reports page manifest declares only content:read + network:request, no storage/kv/db capability", () => {
		expect(OTTA_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request"]);
		expect(OTTA_PLUGIN_CAPABILITIES).not.toContain("network:request:unrestricted");
		for (const cap of OTTA_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("kv")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
	});
});
