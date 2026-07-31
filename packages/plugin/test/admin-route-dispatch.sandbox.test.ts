import { plugin } from "@otta-sh/plugin";
import { afterEach, describe, expect, test } from "vitest";
import { blocksOf, field, findBlocks, formFor } from "./helpers/blocks.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// This change: em-dash's admin shell renders EVERY plugin admin page by
// `POST /plugins/{id}/admin` and resolves the route by the literal key
// "admin", dispatching on the BlockInteraction's `type` + `page`/`action_id`.
// Otta previously registered `admin/reports`/`admin/settings` (which never
// dispatch) → Reports/Settings 404'd. Proven here under the REAL
// workerd-on-Node sandbox.

/** A GET responder for both the guarded /reports/* reads (200 only WITH the
 *  admin token, else 401 — mirroring the service's guard) and the unguarded
 *  GET /settings. */
function makeGetResponder() {
	return (req: {
		url: string;
		headers: Record<string, string | string[] | undefined>;
	}): { status: number; body: unknown } => {
		if (req.url.startsWith("/settings")) {
			return {
				status: 200,
				body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
			};
		}
		if (req.url.startsWith("/reports/")) {
			// Guarded: without X-Internal-Token the service answers 401.
			if (req.headers["x-internal-token"] === undefined) {
				return { status: 401, body: { ok: false, error: "unauthorized" } };
			}
			if (req.url.startsWith("/reports/revenue")) {
				return {
					status: 200,
					body: {
						ok: true,
						buckets: [
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
						products: [
							{ productId: "p1", titleSnapshot: "Widget", qtySold: 2, revenueCents: 4000 },
						],
					},
				};
			}
			if (req.url.startsWith("/reports/low-stock")) {
				return { status: 200, body: { ok: true, rows: [{ sku: "SKU-A", onHand: 0 }] } };
			}
		}
		return { status: 404, body: { error: "unknown" } };
	};
}

async function seedToken(sandbox: SandboxHandle, stub: StubCommerceServer, token: string) {
	await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-token",
		values: { internalToken: token },
	});
	stub.requests.length = 0;
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

describe("admin route dispatch (workerd sandbox)", () => {
	test("the plugin registers the single `admin` route and NOT the old per-page keys", () => {
		const keys = Object.keys(plugin.routes ?? {});
		expect(keys).toContain("admin");
		expect(keys).not.toContain("admin/reports");
		expect(keys).not.toContain("admin/settings");
	});

	test("page_load /reports renders the Reports blocks and forwards the kv-sourced admin token", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedToken(sandbox, stub, "admin-token-xyz");

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		expect(blocks.length).toBeGreaterThan(0);
		// §12.5: the four report groups are accordions, resolved by `block_id`
		// (never by label — D-6 makes labels carry live figures).
		const groupIds = findBlocks(blocks, "accordion").map((a) => a.block_id);
		expect(groupIds).toEqual(
			expect.arrayContaining(["reports:revenue", "reports:statuses", "reports:top", "reports:low"]),
		);
		expect(findBlocks(blocks, "table")).toHaveLength(4);
		// All four guarded reads carried the token from write-only kv.
		expect(stub.requests.length).toBe(4);
		for (const req of stub.requests) {
			expect(req.headers["x-internal-token"]).toBe("admin-token-xyz");
		}
	});

	test("page_load /settings renders the Settings form (display + operational + secret token)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const blocks = blocksOf(outcome);
		expect(blocks.length).toBeGreaterThan(0);
		// §12.6: the three groups are accordions now — resolve each field by its
		// form's SUBMIT action_id (stable), not by a top-level flat scan.
		expect(field(formFor(blocks, "save-display"), "storeDisplayName")).toBeDefined();
		expect(field(formFor(blocks, "save-operational"), "holdTtlMinutes")).toBeDefined();
		expect(field(formFor(blocks, "save-operational"), "lowStockThreshold")).toBeDefined();
		// The token field renders write-only: it exists, is a plain text_input
		// (INC-09 dropped the masked secret_input variant), and carries NO
		// initial_value (the stored token is never echoed).
		const secret = field(formFor(blocks, "save-token"), "internalToken");
		expect(secret?.type).toBe("text_input");
		expect(secret).not.toHaveProperty("initial_value");
	});

	test("NO-TOKEN page_load /reports (kv empty) fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// No seedToken → the guarded reads answer 401.
		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		const text = `${String(banner?.title ?? "")} ${String(banner?.description ?? "")}`;
		expect(text).not.toMatch(/HTTP \d|\/reports\/|401/);
	});

	test("the old per-page keys no longer resolve (404 unknown route)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin/reports", {
			type: "page_load",
			page: "/reports",
		});
		expect("error" in outcome).toBe(true);
		if (!("error" in outcome)) return;
		expect(outcome.error).toContain("unknown route");
	});

	test("save-token round-trip: a non-empty submit persists the token; a blank submit does NOT clobber it", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// 1. Non-empty submit persists the token; a subsequent reports read forwards it.
		await seedToken(sandbox, stub, "tok-1");
		await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		expect(stub.requests.length).toBe(4);
		for (const req of stub.requests) {
			expect(req.headers["x-internal-token"]).toBe("tok-1");
		}
		stub.requests.length = 0;

		// 2. A blank submit must NOT clobber the stored token (write-only hygiene).
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "" },
		});
		stub.requests.length = 0;
		await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		expect(stub.requests.length).toBe(4);
		for (const req of stub.requests) {
			expect(req.headers["x-internal-token"]).toBe("tok-1");
		}
	});
});
