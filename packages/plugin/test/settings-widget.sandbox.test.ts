import { SETTINGS_SCHEMA, URUMI_PLUGIN_CAPABILITIES } from "@urumi/plugin";
import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Phase 7 §6 Step 7: the admin Settings Block Kit form under the REAL
// workerd-on-Node sandbox. ONE form, TWO save paths: kv (display name, no
// ctx.http) and service (operational, PUT /settings over ctx.http). SECURITY:
// no secret is read from or written to ctx.kv.

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

function blocksOf(
	outcome: { result: unknown } | { error: string },
): Array<Record<string, unknown>> {
	if (!("result" in outcome))
		throw new Error(`expected a result, got error: ${JSON.stringify(outcome)}`);
	return (outcome.result as { blocks: Array<Record<string, unknown>> }).blocks;
}

describe("Settings admin form (workerd sandbox)", () => {
	test("storeDisplayName saves via ctx.kv without calling ctx.http, and persists across invocations", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const saved = await sandbox.invokeRoute("admin/settings", {
			action_id: "save-display",
			values: { storeDisplayName: "Acme Goods" },
		});
		// No ctx.http was used for the kv-backed save.
		expect(stub.requests).toHaveLength(0);
		const savedBlocks = blocksOf(saved);
		expect(
			savedBlocks.some((b) => typeof b.text === "string" && b.text.includes("Acme Goods")),
		).toBe(true);

		// It persisted in kv: a page load reflects it as the form's initial value
		// (this load DOES call GET /settings for the operational fields).
		const loaded = await sandbox.invokeRoute("admin/settings", { action_id: "load" });
		const form = blocksOf(loaded).find(
			(b) => b.type === "form" && Array.isArray(b.fields) && (b.fields as unknown[]).length === 1,
		);
		expect(form).toBeDefined();
		const fields = (form?.fields ?? []) as Array<Record<string, unknown>>;
		const nameField = fields[0];
		expect(nameField?.action_id).toBe("storeDisplayName");
		expect(nameField?.initial_value).toBe("Acme Goods");
	});

	test("holdTtlMinutes and lowStockThreshold save via PUT /settings over ctx.http with the admin token + Idempotency-Key", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("PUT", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 45, lowStockThreshold: 20 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin/settings", {
			action_id: "save-operational",
			values: { holdTtlMinutes: 45, lowStockThreshold: 20 },
			idempotencyKey: "k-op-1",
			adminToken: "admin-token-xyz",
		});

		expect(stub.requests).toHaveLength(1);
		const req = stub.requests[0];
		expect(req?.method).toBe("PUT");
		expect(req?.url).toBe("/settings");
		expect(req?.body).toEqual({ holdTtlMinutes: 45, lowStockThreshold: 20 });
		expect(req?.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(req?.headers["idempotency-key"]).toBe("k-op-1");
		// The form re-renders with the saved values + a success toast.
		expect((outcome as { result: { toast: { type: string } } }).result.toast.type).toBe("success");
	});

	test("a service-side validation error (400) surfaces inline on the form, not swallowed", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("PUT", () => ({
			status: 400,
			body: {
				ok: false,
				error: "validation_error",
				message: "holdTtlMinutes must be a positive integer",
			},
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin/settings", {
			action_id: "save-operational",
			values: { holdTtlMinutes: 0 },
			idempotencyKey: "k-bad",
			adminToken: "admin-token-xyz",
		});
		// Not a thrown {error} — a rendered inline error banner carrying the
		// service's actual message.
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.text)).toContain("holdTtlMinutes must be a positive integer");
	});

	test("SECURITY: the settings form manifest declares only content:read + network:request (no storage/kv/db), and the schema has no secret field", () => {
		expect(URUMI_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request"]);
		for (const cap of URUMI_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
		// The kv-backed field is display-only; the two operational fields are
		// service-DB. NONE is a secret (no secret tier, no secret-shaped field).
		expect(SETTINGS_SCHEMA.storeDisplayName.tier).toBe("kv");
		expect(SETTINGS_SCHEMA.holdTtlMinutes.tier).toBe("service");
		expect(SETTINGS_SCHEMA.lowStockThreshold.tier).toBe("service");
		for (const field of Object.values(SETTINGS_SCHEMA)) {
			expect(["string", "number", "boolean"]).toContain(field.type);
			expect(field.type).not.toBe("secret");
			expect(field.label.toLowerCase()).not.toMatch(/secret|password|api key|token/);
		}
	});
});
