import { URUMI_PLUGIN_CAPABILITIES } from "@urumi/plugin";
import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Phase 7 §6 Step 6: the admin Reports Block Kit page, proven under the REAL
// workerd-on-Node sandbox (not trusted in-process). Data reaches the page ONLY
// via ctx.http → the stub standing in for @urumi/service. em-dash renders the
// page by the single `admin` route with a `{type:"page_load", page:"/reports"}`
// BlockInteraction — NO token in the interaction; the admin token is sourced
// from write-only ctx.kv (seeded here via the Settings `save-token` action).

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
	test("Reports page renders revenue, orders-by-status, top-products, and low-stock sections via ctx.http only", async () => {
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
		expect("result" in outcome).toBe(true);
		if (!("result" in outcome)) return;
		const blocks = (outcome.result as { blocks: Array<Record<string, unknown>> }).blocks;
		const sections = blocks.filter((b) => b.type === "section").map((b) => b.text);
		expect(sections).toEqual(
			expect.arrayContaining([
				"Revenue by day",
				"Orders by status",
				"Top products (by revenue)",
				"Low stock",
			]),
		);
		// Each report's data made it into a table.
		const tables = blocks.filter((b) => b.type === "table");
		expect(tables).toHaveLength(4);
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

	test("Reports page fails closed with an error block when ctx.http rejects, never throws", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", reportsResponder);
		// Allowlist EXCLUDES the stub → ctx.http.fetch throws before egress.
		sandbox = await loadPluginInSandbox({
			allowedHosts: ["definitely-not-the-stub.example"],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		// Fails CLOSED: a rendered error block, NOT a thrown {error} envelope.
		expect("result" in outcome).toBe(true);
		if (!("result" in outcome)) return;
		const blocks = (outcome.result as { blocks: Array<Record<string, unknown>> }).blocks;
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
		// The generic message never leaks a raw HTTP status/URL (Part 5).
		expect(String(banner?.text)).not.toMatch(/HTTP \d|\/reports\//);
		// The allowlist blocked egress: no request ever reached the stub.
		expect(stub.requests).toHaveLength(0);
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
