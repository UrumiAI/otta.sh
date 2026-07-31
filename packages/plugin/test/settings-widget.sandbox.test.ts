import { SETTINGS_SCHEMA, OTTA_PLUGIN_CAPABILITIES } from "@otta-sh/plugin";
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
//
// INC-15: each group's LABEL now carries that group's current values, and all
// three render closed. "Token set" is a boolean FACT about a credential, not
// any part of it — the no-echo pins below cover the whole response, labels
// included.

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

/** Each group's `label` by `block_id` — INC-15's subject: the label states what
 *  the group holds, and the `block_id` is what must NOT move when it changes. */
function groupLabels(blocks: readonly LooseBlock[]): Map<string, string> {
	return new Map(findBlocks(blocks, "accordion").map((a) => [String(a.block_id), String(a.label)]));
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

		// INC-15 amends S-3 for this screen: NO group is default_open. The labels
		// carry the values, so there is nothing to rank — and X-18's mechanical
		// rule is "at most one", which zero satisfies.
		expect(openGroupIds(blocks)).toEqual([]);

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
		expect(OTTA_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request"]);
		for (const cap of OTTA_PLUGIN_CAPABILITIES) {
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

	// INC-09 (EVIDENCE §4.3 / DESIGNER §7 shot `18b`): the Admin token field's
	// `secret_input` reveal/copy chip computed to `opacity: 0` and, on hover,
	// overlapped its own label; revealed, a SET token became visually identical
	// to the unset field below it. Both tokens now render as a PLAIN, always-
	// empty `text_input` — the same shape whether a token is already stored or
	// not — and a blank submit still keeps whatever is currently stored.
	test("INC-09: Admin token and Service token render as plain text_input — no secret_input, no has_value, no masked variant", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// Seed BOTH tokens first — a set token must render IDENTICALLY to an
		// unset one under the plain variant (unlike the dropped masked variant,
		// whose placeholder / `has_value` used to depend on this).
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "qa-local-admin-token" },
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-service-token",
			values: { serviceToken: "qa-local-service-token" },
		});

		const loaded = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const blocks = blocksOf(loaded);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		const adminField = field(formFor(blocks, "save-token"), "internalToken");
		const serviceField = field(formFor(blocks, "save-service-token"), "serviceToken");

		// No masked variant on either field.
		expect(adminField?.type).toBe("text_input");
		expect(serviceField?.type).toBe("text_input");
		expect(adminField).not.toHaveProperty("has_value");
		expect(serviceField).not.toHaveProperty("has_value");
		// Never rendered back — plain empty input even though both tokens are SET.
		expect(adminField).not.toHaveProperty("initial_value");
		expect(serviceField).not.toHaveProperty("initial_value");
		// The two fields are now visually and behaviourally symmetric.
		expect(adminField?.placeholder).toBe("Enter new admin token (blank keeps current)");
		expect(serviceField?.placeholder).toBe("Enter new service token (blank keeps current)");

		// SECURITY PIN: the WHOLE rendered response — not just the two field
		// objects above — must never contain either raw token value. Per-field
		// property assertions can't catch a future echo through a banner or
		// context line; a whole-response string search can.
		const wholeResponse = JSON.stringify(blocks);
		expect(wholeResponse).not.toContain("qa-local-admin-token");
		expect(wholeResponse).not.toContain("qa-local-service-token");
	});

	test("INC-09 post-save clear: a successful token save remounts its form BLANK with a DIFFERENT block_id; the other field and blank submits are unaffected", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const before = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(before, { screen: "settings", level: "list" });
		const adminBlockIdBefore = formFor(before, "save-token")?.block_id;
		const serviceBlockIdBefore = formFor(before, "save-service-token")?.block_id;

		// With `has_value`/`initial_value` gone from both fields, the form's own
		// prefill digest is now CONSTANT — without the `gen`-carried fix below,
		// the carrier `block_id` (the renderer's React key) would never change on
		// a save, and a mount-only `text_input` would keep showing whatever the
		// operator had just typed, even after a "saved" re-render.
		const adminSaved = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-token",
				values: { internalToken: "qa-local-admin-token" },
			}),
		);
		const adminFieldAfter = field(formFor(adminSaved, "save-token"), "internalToken");
		const adminBlockIdAfterSave = formFor(adminSaved, "save-token")?.block_id;
		// The re-rendered field carries no value — still a plain, empty
		// text_input, nothing left lingering from what was typed.
		expect(adminFieldAfter).not.toHaveProperty("initial_value");
		// The KEY changed: a real host remounts the input on this response,
		// discarding whatever DOM value the operator had just typed.
		expect(adminBlockIdAfterSave).not.toBe(adminBlockIdBefore);
		// Saving the ADMIN token must not remount the untouched SERVICE field.
		expect(formFor(adminSaved, "save-service-token")?.block_id).toBe(serviceBlockIdBefore);

		// Same pin, the other direction — and saving the service token must not
		// re-remount the admin field a second time.
		const serviceSaved = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-service-token",
				values: { serviceToken: "qa-local-service-token" },
			}),
		);
		const serviceFieldAfter = field(formFor(serviceSaved, "save-service-token"), "serviceToken");
		expect(serviceFieldAfter).not.toHaveProperty("initial_value");
		expect(formFor(serviceSaved, "save-service-token")?.block_id).not.toBe(serviceBlockIdBefore);
		expect(formFor(serviceSaved, "save-token")?.block_id).toBe(adminBlockIdAfterSave);

		// blank-submit-keeps-current still holds UNCHANGED: a blank submit never
		// bumps the generation, so the block_id does not move further (there is
		// nothing to remount — the field was already blank).
		const blankSubmitted = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-token",
				values: { internalToken: "" },
			}),
		);
		expect(formFor(blankSubmitted, "save-token")?.block_id).toBe(adminBlockIdAfterSave);
	});

	test("INC-09: a blank submit on either token form keeps the currently stored token (unchanged behaviour)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 15, lowStockThreshold: 5 } },
		}));
		stub.respondWith("PUT", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes: 20, lowStockThreshold: 6 } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// Seed both tokens.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "qa-local-admin-token" },
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-service-token",
			values: { serviceToken: "qa-local-service-token" },
		});

		// Blank submits on BOTH — exactly what a real host sends for a plain,
		// always-empty field the operator left untouched.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "" },
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-service-token",
			values: { serviceToken: "" },
		});
		stub.requests.length = 0;

		// The privileged PUT forwards BOTH tokens as headers — if either blank
		// submit had clobbered its token, one of these would be missing/blank.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "20", lowStockThreshold: "6" },
			idempotencyKey: "k-inc09-blank-keeps-current",
		});
		const put = stub.requests.find((r) => r.method === "PUT");
		expect(put?.headers["x-internal-token"]).toBe("qa-local-admin-token");
		expect(put?.headers["x-service-token"]).toBe("qa-local-service-token");
	});

	// -- INC-15: the labels carry the values, so every group can start closed ----

	async function bootWithSettings(
		holdTtlMinutes: number,
		lowStockThreshold: number,
	): Promise<void> {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({
			status: 200,
			body: { ok: true, settings: { holdTtlMinutes, lowStockThreshold } },
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
	}

	test("INC-15: every group renders CLOSED and its label states its own values — nothing has to be opened to read this screen", async () => {
		await bootWithSettings(15, 5);
		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		const labels = groupLabels(blocks);
		expect([...labels.keys()]).toEqual([
			"settings:store",
			"settings:checkout",
			"settings:connection",
		]);
		expect(labels.get("settings:store")).toBe("Store — no display name");
		expect(labels.get("settings:checkout")).toBe("Checkout & holds — 15 min hold · low stock at 5");
		expect(labels.get("settings:connection")).toBe(
			"Service connection — token not set · service token not set",
		);
		// X-11: mechanically enforced by assertBlockContract too, pinned here as
		// the rule these three strings were composed against.
		for (const label of labels.values()) expect(label.length).toBeLessThanOrEqual(60);

		// All three closed — the render-time kind (§1.2), which is legal.
		expect(openGroupIds(blocks)).toEqual([]);
		expect(findBlocks(blocks, "accordion").every((a) => a.default_open === false)).toBe(true);
	});

	test("INC-15: a label states an unset or unreadable value as a FACT — never a blank tail, never a zero", async () => {
		// The secondary GET fails: there are no operational values to state, and
		// the label says so rather than implying `0 min hold · low stock at 0`.
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({ status: 503, body: { error: "unavailable" } }));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		const labels = groupLabels(blocks);
		expect(labels.get("settings:checkout")).toBe("Checkout & holds — not loaded");
		for (const label of labels.values()) {
			expect(label).not.toMatch(/—\s*$/);
			expect(label).not.toMatch(/\b0 min hold\b|low stock at 0\b/);
		}
	});

	test("INC-15: the labels track saves — a saved display name and a first-ever token save are stated on the SAME response that saved them", async () => {
		await bootWithSettings(15, 5);

		const named = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-display",
				values: { storeDisplayName: "Acme Goods" },
			}),
		);
		expect(groupLabels(named).get("settings:store")).toBe("Store — Acme Goods");

		// The trap this pins: the handler reads both tokens ONCE, at the top, so a
		// first-ever save would report the token it had just persisted as "not
		// set" unless the save updates what the re-render is computed from.
		const savedAdmin = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-token",
				values: { internalToken: "qa-local-admin-token" },
			}),
		);
		expect(groupLabels(savedAdmin).get("settings:connection")).toBe(
			"Service connection — token set · service token not set",
		);

		const savedService = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-service-token",
				values: { serviceToken: "qa-local-service-token" },
			}),
		);
		expect(groupLabels(savedService).get("settings:connection")).toBe(
			"Service connection — token set · service token set",
		);

		// …and a later page load agrees, so the label is reporting kv, not the
		// interaction it was submitted with.
		const reloaded = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		expect(groupLabels(reloaded).get("settings:connection")).toBe(
			"Service connection — token set · service token set",
		);

		// SECURITY PIN (the whole point of stating a BOOLEAN): "token set" is a
		// fact ABOUT the credential. No part of either token value appears in the
		// response that reports it as set — labels included.
		const wholeResponse = JSON.stringify(reloaded);
		expect(wholeResponse).not.toContain("qa-local-admin-token");
		expect(wholeResponse).not.toContain("qa-local-service-token");
	});

	test("INC-15: a label change NEVER changes a group's block_id — the labels move, the accordions do not remount (§1.2)", async () => {
		await bootWithSettings(15, 5);
		const before = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const after = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-display",
				values: { storeDisplayName: "Acme Goods" },
			}),
		);
		// The label DID change…
		expect(groupLabels(before).get("settings:store")).not.toBe(
			groupLabels(after).get("settings:store"),
		);
		// …and every group's identity did NOT. Forcing a group shut by changing
		// its block_id is the FORBIDDEN programmatic close (§1.2) — it would
		// discard whatever the operator had typed into the other two groups.
		expect([...groupLabels(after).keys()]).toEqual([...groupLabels(before).keys()]);
	});
});
