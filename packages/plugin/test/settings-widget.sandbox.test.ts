import { SETTINGS_SCHEMA, URUMI_PLUGIN_CAPABILITIES } from "@otta-sh/plugin";
import { afterEach, describe, expect, test } from "vitest";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	contextTexts,
	field,
	findBlocks,
	formFor,
	openGroupIds,
	type LooseBlock,
} from "./helpers/blocks.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// §4.1 report/settings skeleton, §12.6: the admin Settings Block Kit form
// under the REAL workerd-on-Node sandbox. ONE page, THREE named accordion
// groups ("Store", "Checkout & holds", "Service connection"), FOUR save
// paths: kv (display name, no ctx.http on ITS OWN write — but S-5/S-5a means
// every save re-renders the WHOLE screen from a fresh read) and service
// (operational + both tokens, over ctx.http). SECURITY: no secret is ever
// rendered back into a block.

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

/** Every form's submit action_id this screen renders, in the FULL-screen
 *  render (S-5) — the four forms the two live bugs used to drop. */
const ALL_SUBMIT_IDS = ["save-display", "save-operational", "save-token", "save-service-token"];

function expectAllFourFormsPresent(blocks: readonly LooseBlock[]): void {
	for (const actionId of ALL_SUBMIT_IDS) {
		expect(formFor(blocks, actionId), `expected a form submitting "${actionId}"`).toBeDefined();
	}
}

describe("Settings admin form (workerd sandbox)", () => {
	test("saving the display name re-renders the FULL screen — all four forms survive (Bug A)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const saved = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-display",
			values: { storeDisplayName: "Acme Goods" },
		});
		const blocks = blocksOf(saved);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		// BUG FIX: this branch used to return `[header, section]` — two blocks —
		// so the other three forms vanished and the operator had to navigate
		// away to recover (the host's page_load effect never re-fires on its
		// own). All four forms must be present on the SAME response the save
		// returned, not merely on a subsequent page load.
		expectAllFourFormsPresent(blocks);
		const nameField = field(formFor(blocks, "save-display"), "storeDisplayName");
		expect(nameField?.initial_value).toBe("Acme Goods");

		// S-5a: this save path used to be documented as provably ctx.http-free,
		// and a test asserted `stub.requests` was empty. That invariant is
		// retired DELIBERATELY (there is no operational-settings value already
		// in scope to re-render the other groups from without a live read) — so
		// this now asserts the OPPOSITE: a fresh GET /settings backs the
		// re-render.
		expect(stub.requests.some((r) => r.method === "GET" && r.url === "/settings")).toBe(true);

		// S-3: "Store" is the one open group, always.
		expect(openGroupIds(blocks)).toEqual(["settings:store"]);

		// It persisted in kv: a later page load reflects it as the form's
		// initial value too.
		const loaded = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const loadedBlocks = blocksOf(loaded);
		const loadedNameField = field(formFor(loadedBlocks, "save-display"), "storeDisplayName");
		expect(loadedNameField?.initial_value).toBe("Acme Goods");
	});

	test("an out-of-range display name re-renders the FULL screen with an error notice, not a dead end (Bug A, invalid branch)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-display",
			values: { storeDisplayName: "x".repeat(201) },
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		// BUG FIX: this branch used to return `[header, banner]` — no field at
		// all to correct the name. The field must still be right there.
		expectAllFourFormsPresent(blocks);
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(`${String(banner?.title)} ${String(banner?.description)}`).toMatch(/1–200 characters/);
	});

	test("holdTtlMinutes and lowStockThreshold save via PUT /settings over ctx.http with the admin token + Idempotency-Key", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("PUT", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 45, lowStockThreshold: 20 } },
		}));
		// GET /settings is needed by the save-token re-render (fails closed
		// otherwise, but still seeds the token) — provide it so the seed is clean.
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// Seed the admin token into write-only kv via the Settings secret field,
		// then clear the recorded requests so the PUT assertions are isolated.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "admin-token-xyz" },
		});
		stub.requests.length = 0;

		// F-6: holdTtlMinutes/lowStockThreshold are `text_input` (not
		// `number_input`), so the REAL wire shape is a digit-only string.
		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "45", lowStockThreshold: "20" },
			idempotencyKey: "k-op-1",
		});

		expect(stub.requests).toHaveLength(1);
		const req = stub.requests[0];
		expect(req?.method).toBe("PUT");
		expect(req?.url).toBe("/settings");
		expect(req?.body).toEqual({ holdTtlMinutes: 45, lowStockThreshold: 20 });
		// The token was forwarded from write-only kv (not the interaction body).
		expect(req?.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(req?.headers["idempotency-key"]).toBe("k-op-1");
		// The form re-renders with the saved values + a success toast, and every
		// other form on the screen is still present (S-5).
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		expectAllFourFormsPresent(blocks);
		expect((outcome as { result: { toast: { type: string } } }).result.toast.type).toBe("success");
	});

	test("F-6: holdTtlMinutes/lowStockThreshold are text_input, digit-parsed — a non-digit submission is OMITTED from the PUT, not sent as NaN/zero", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("PUT", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 20 } },
		}));
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// Confirm the element type migrated (F-6): not number_input.
		const loaded = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const opForm = formFor(blocksOf(loaded), "save-operational");
		expect(field(opForm, "holdTtlMinutes")?.type).toBe("text_input");
		expect(field(opForm, "lowStockThreshold")?.type).toBe("text_input");

		// "abc" fails /^\d+$/ — omitted from the patch rather than coerced to
		// NaN or 0; "20" is valid and passes through.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "abc", lowStockThreshold: "20" },
			idempotencyKey: "k-digits",
		});
		const req = stub.requests.find((r) => r.method === "PUT");
		expect(req?.body).toEqual({ lowStockThreshold: 20 });
	});

	test("a service-side validation error (400) surfaces inline and never zeroes an un-edited field", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("PUT", () => ({
			status: 400,
			body: {
				ok: false,
				error: "validation_error",
				message: "holdTtlMinutes must be a positive integer",
			},
		}));
		// The error re-render reads current stored settings (J6) so the un-edited
		// field keeps its stored value instead of collapsing to 0.
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "0" }, // only holdTtlMinutes edited (invalid)
			idempotencyKey: "k-bad",
		});
		// Not a thrown {error} — a rendered inline error banner carrying the
		// service's actual message.
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.description)).toContain("holdTtlMinutes must be a positive integer");

		// J6: the operational form re-renders the ATTEMPTED holdTtlMinutes (0) but
		// the un-edited lowStockThreshold keeps its STORED value (5), not 0.
		// Both are `text_input` (F-6), so the rendered `initial_value` is a
		// digit-only STRING, not a number.
		const opForm = formFor(blocks, "save-operational");
		expect(field(opForm, "holdTtlMinutes")?.initial_value).toBe("0");
		expect(field(opForm, "lowStockThreshold")?.initial_value).toBe("5");
		// Every other form on the screen survived too (S-5).
		expectAllFourFormsPresent(blocks);
	});

	test("a non-validation save failure (e.g. 401) surfaces a GENERIC banner with no raw HTTP status/URL", async () => {
		stub = await startStubCommerceServer();
		// Auth failure (no admin token seeded) — NOT a designed 400 validation.
		stub.respondWith("PUT", () => ({
			status: 401,
			body: { ok: false, error: "unauthorized" },
		}));
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "45", lowStockThreshold: "20" },
			idempotencyKey: "k-401",
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		// Part 5: the auth/5xx/non-JSON fallback must not echo a raw status or URL.
		const text = `${String(banner?.title)} ${String(banner?.description)}`;
		expect(text).not.toMatch(/HTTP \d|\/settings|401/);
	});

	test("the page-load GET /settings carries the admin token (the read is guarded too, ADR-0010)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) =>
			req.headers["x-internal-token"] === "admin-token-xyz"
				? {
						status: 200,
						body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
					}
				: { status: 401, body: { ok: false, error: "unauthorized" } },
		);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "admin-token-xyz" },
		});
		stub.requests.length = 0;

		const loaded = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });

		const get = stub.requests.find((r) => r.method === "GET");
		expect(get?.url).toBe("/settings");
		// Sourced from write-only kv, exactly like the PUT above — before ADR-0010
		// the client was constructed with the SERVICE token only, so this header
		// was absent and the guarded read would 401.
		expect(get?.headers["x-internal-token"]).toBe("admin-token-xyz");
		// It got through: the operational fields rendered, not a degraded context.
		const blocks = blocksOf(loaded);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		expect(formFor(blocks, "save-operational")).toBeDefined();
	});

	test("with NO admin token the guarded GET /settings degrades to a context line (E-1 secondary read), never a top-level banner — and both token forms still render", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({ status: 401, body: { ok: false, error: "unauthorized" } }));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		// Director ruling / E-1: `GET /settings` is a SECONDARY read (it feeds
		// only "Checkout & holds"); its failure degrades to a `context` line
		// inside that one group, never a screen-wide fail-closed banner — the
		// §12.6 listing implied the latter, which is the N-1 defect this fixes.
		expect(findBlocks(blocks, "banner")).toHaveLength(0);
		expect(
			contextTexts(blocks).some((t) => /Operational settings could not be loaded/.test(t)),
		).toBe(true);

		// No bootstrap lockout: both token forms — and the display-name form —
		// are still on the page, so an admin with no token provisioned can still
		// provision one.
		expect(formFor(blocks, "save-display")).toBeDefined();
		expect(formFor(blocks, "save-token")).toBeDefined();
		expect(formFor(blocks, "save-service-token")).toBeDefined();
		// The operational form itself is absent (there is nothing to prefill it
		// with) — the context line replaces it, not sits beside a zeroed form.
		expect(formFor(blocks, "save-operational")).toBeUndefined();
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
		for (const schemaField of Object.values(SETTINGS_SCHEMA)) {
			expect(["string", "number", "boolean"]).toContain(schemaField.type);
			expect(schemaField.type).not.toBe("secret");
			expect(schemaField.label.toLowerCase()).not.toMatch(/secret|password|api key|token/);
		}
	});
});
