import { URUMI_PLUGIN_CAPABILITIES } from "@otta-sh/plugin";
import { afterEach, describe, expect, test } from "vitest";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	findBlocks,
	group,
	groupBlocks,
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
	return { status: 404, body: { error: "unknown" } };
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

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "reports", level: "list" });

		const revenueTable = tableWithId(blocks, "reports:revenue-table");
		const columns = (revenueTable?.columns ?? []) as Array<Record<string, unknown>>;
		expect(columns.map((c) => c.label)).not.toContain("Currency");
		const rows = (revenueTable?.rows ?? []) as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.revenue)).toEqual(["$30.00", "$55.00"]);
		// Bucket periods are date-only (M-6) — no millisecond timestamp.
		expect(rows.map((r) => r.bucketStart)).toEqual(["2026-07-10", "2026-07-11"]);

		// The `stats` block carries pre-formatted money too, with NO "integer
		// minor units" description (M-1 — that description was the bug).
		const stats = findBlocks(blocks, "stats")[0] as { items?: Array<Record<string, unknown>> };
		expect(stats.items).toEqual([{ label: "Revenue (USD)", value: "$85.00" }]);
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
		const stats = findBlocks(blocks, "stats")[0] as { items?: Array<Record<string, unknown>> };
		expect(stats.items).toEqual([
			{ label: "Revenue (EUR)", value: "€10.00" },
			{ label: "Revenue (USD)", value: "$900.00" },
		]);

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

	test("Reports page manifest declares only content:read + network:request, no storage/kv/db capability", () => {
		expect(URUMI_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request"]);
		expect(URUMI_PLUGIN_CAPABILITIES).not.toContain("network:request:unrestricted");
		for (const cap of URUMI_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("kv")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
	});
});
