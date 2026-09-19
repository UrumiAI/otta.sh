import { OTTA_PLUGIN_CAPABILITIES, SETTINGS_SCHEMA } from "@otta-sh/plugin";
import {
	collectionOf,
	SETTINGS_COLLECTION,
	SETTINGS_DOC_ID,
	SETTINGS_MUTATIONS_COLLECTION,
	type SettingsMutationDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterEach, describe, expect, test } from "vitest";
import { MISSING_STORAGE_MESSAGE } from "../src/commerce/in-process-commerce-stores.js";
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
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

// §4.1 report/settings skeleton, §12.6: the admin Settings Block Kit form
// under the REAL workerd-on-Node sandbox.
//
// INC-D3a (the commerce service is folded into the plugin, ADR-0014 D3):
// this file used to boot a stub HTTP commerce service and prove a "Service
// connection" group (two tokens, forwarded as headers on every GET/PUT
// /settings). Both the service and the group are GONE OUTRIGHT — there is no
// second deployable left to authenticate to (see `settings-form.ts`'s own
// module doc comment). What remains is THREE groups ("Store", "Checkout &
// holds", "Payments & email") and EIGHT save paths: `save-display` (kv),
// `save-operational` (the real in-process `EmdashSettingsStore`, over
// `makeAdminClients`), the FIVE real payment/email secrets (write-only kv),
// and `save-payment-settings` (three read-back plain settings, kv). SECURITY:
// no secret is ever rendered back into a block — still true, still pinned
// below.
//
// INC-15: each group's LABEL carries that group's current values, and all
// three render closed.
//
// A PROCESS-SHARED STORAGE CAVEAT, load-bearing for every test below that
// asserts an EXACT operational-settings value: `storage: true` binds
// `ctx.storage` to `storageBridge()`'s one memoized SQLite store per test
// PROCESS (see its own doc comment — "ONE STORE PER PROCESS, reused across
// boots"). `ctx.kv` resets with every fresh `loadPluginInSandbox()` boot, so
// display-name and secret state never leaks between tests in this file — but
// the operational-settings doc is a true singleton (`SETTINGS_DOC_ID =
// "store"`), so it DOES persist across tests unless a test resets it first.
// `resetOperationalSettings` below does that reset directly against the same
// bridge, the same way `collectionOf` is already used read-only elsewhere in
// this suite (`helpers/block-contract.ts`) to reach internal store constants.
let sandbox: SandboxHandle | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
});

/**
 * Make JUST the operational-settings read fail, leaving kv and every other
 * collection reachable — the input the "no admin token ⇒ the guarded GET
 * /settings 401s" fixture used to supply before there were any tokens.
 *
 * The bridge resolves `storage[name]` FRESH on every call (see
 * `sandbox/storage-bridge.ts`), so swapping one collection for a proxy that
 * throws on reads is enough to fail that one read and nothing else. It is a
 * fault injected at the seam the store itself uses, exactly as
 * `publish-atomicity.sandbox.test.ts` injects one, and the real collection is
 * put back in a `finally` so the process-shared store is never left broken for
 * the next test.
 */
async function withSettingsReadFailing<T>(body: () => Promise<T>): Promise<T> {
	const { storage } = await storageBridge();
	const real = storage[SETTINGS_COLLECTION];
	if (real === undefined) throw new Error("no settings collection to fault-inject");
	storage[SETTINGS_COLLECTION] = new Proxy(real, {
		get(_holder, property) {
			if (property === "get" || property === "getVersioned") {
				return () => {
					throw new Error("injected storage fault: settings unreadable");
				};
			}
			const value = Reflect.get(real, property) as unknown;
			if (typeof value !== "function") return value;
			return (value as (...args: unknown[]) => unknown).bind(real);
		},
	}) as StorageAccess[string];
	try {
		return await body();
	} finally {
		storage[SETTINGS_COLLECTION] = real;
	}
}

/** Every form's submit action_id the Settings screen renders on a FULL-screen
 *  render (S-5) — eight now, not the four this file used to pin before the
 *  fold-in deleted `save-token`/`save-service-token` and added five real
 *  payment/email secrets plus `save-payment-settings`. */
const ALL_SUBMIT_IDS = [
	"save-display",
	"save-operational",
	"save-stripe-secret-key",
	"save-stripe-webhook-secret",
	"save-email-api-key",
	"save-x402-facilitator-secret",
	"save-webhook-edge-token",
	"save-payment-settings",
];

function expectAllRealFormsPresent(blocks: readonly LooseBlock[]): void {
	for (const actionId of ALL_SUBMIT_IDS) {
		expect(formFor(blocks, actionId), `expected a form submitting "${actionId}"`).toBeDefined();
	}
}

/** Each group's `label` by `block_id` — INC-15's subject: the label states what
 *  the group holds, and the `block_id` is what must NOT move when it changes. */
function groupLabels(blocks: readonly LooseBlock[]): Map<string, string> {
	return new Map(findBlocks(blocks, "accordion").map((a) => [String(a.block_id), String(a.label)]));
}

function toastOf(outcome: unknown): { message?: string; type?: string } | undefined {
	if (!(typeof outcome === "object" && outcome !== null && "result" in outcome)) return undefined;
	const result = (outcome as { result: unknown }).result;
	if (!(typeof result === "object" && result !== null && "toast" in result)) return undefined;
	return (result as { toast?: { message?: string; type?: string } }).toast;
}

/** Force the operational-settings singleton back to "never written" (the
 *  domain defaults, 15/5 — `DEFAULT_OPERATIONAL_SETTINGS`) before a test that
 *  depends on an exact value. See the process-shared-storage caveat above. */
async function resetOperationalSettings(): Promise<StorageAccess> {
	const { storage } = await storageBridge();
	await collectionOf(storage, SETTINGS_COLLECTION).delete(SETTINGS_DOC_ID);
	return storage;
}

describe("Settings admin form (workerd sandbox)", () => {
	test("saving the display name re-renders the FULL screen — every real form survives (Bug A)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const saved = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-display",
			values: { storeDisplayName: "Acme Goods" },
		});
		const blocks = blocksOf(saved);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		// BUG FIX (still the point): this branch used to return `[header,
		// section]` — two blocks — so the other forms vanished and the operator
		// had to navigate away to recover. Every form must be present on the SAME
		// response the save returned, not merely on a subsequent page load.
		expectAllRealFormsPresent(blocks);
		const nameField = field(formFor(blocks, "save-display"), "storeDisplayName");
		expect(nameField?.initial_value).toBe("Acme Goods");

		// INC-D3a retires the old "S-5a: this save is provably ctx.http-free, and
		// the operational re-render came from a fresh GET /settings" pin — there
		// is no request left to observe. What proves the re-render is real is
		// this instead: the operational values that same response renders match
		// what `client.getSettings()` (a real in-process read) actually holds.
		expect(field(formFor(blocks, "save-operational"), "holdTtlMinutes")?.initial_value).toBe("15");

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
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-display",
			values: { storeDisplayName: "x".repeat(201) },
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		// BUG FIX: this branch used to return `[header, banner]` — no field at
		// all to correct the name. The field must still be right there.
		expectAllRealFormsPresent(blocks);
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(`${String(banner?.title)} ${String(banner?.description)}`).toMatch(/1–200 characters/);
	});

	test("holdTtlMinutes and lowStockThreshold save through the real in-process settings store, with a success toast", async () => {
		await resetOperationalSettings();
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		// F-6: holdTtlMinutes/lowStockThreshold are `text_input` (not
		// `number_input`), so the REAL wire shape is a digit-only string.
		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "45", lowStockThreshold: "20" },
			idempotencyKey: "k-op-save-1",
		});

		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		expectAllRealFormsPresent(blocks);
		expect(toastOf(outcome)).toEqual({ message: "Settings saved", type: "success" });
		expect(field(formFor(blocks, "save-operational"), "holdTtlMinutes")?.initial_value).toBe("45");
		expect(groupLabels(blocks).get("settings:checkout")).toBe(
			"Checkout & holds — 45 min hold · low stock at 20",
		);

		// It really persisted through the store, not just this response: a fresh
		// page load agrees.
		const loaded = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		expect(field(formFor(loaded, "save-operational"), "lowStockThreshold")?.initial_value).toBe(
			"20",
		);
	});

	test("F-6: holdTtlMinutes/lowStockThreshold are text_input, digit-parsed — a non-digit submission is OMITTED from the patch, not saved as NaN/zero", async () => {
		await resetOperationalSettings();
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		// Confirm the element type: not number_input.
		const loaded = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const opForm = formFor(blocksOf(loaded), "save-operational");
		expect(field(opForm, "holdTtlMinutes")?.type).toBe("text_input");
		expect(field(opForm, "lowStockThreshold")?.type).toBe("text_input");

		// "abc" fails /^\d+$/ — omitted from the patch rather than coerced to
		// NaN or 0, so the field it would have touched keeps its EXISTING
		// (default) value; "20" is valid and passes through.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "abc", lowStockThreshold: "20" },
			idempotencyKey: "k-digits-only",
		});
		const after = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const opFormAfter = formFor(after, "save-operational");
		expect(field(opFormAfter, "holdTtlMinutes")?.initial_value).toBe("15");
		expect(field(opFormAfter, "lowStockThreshold")?.initial_value).toBe("20");
	});

	test("a real domain validation error surfaces inline and never zeroes an un-edited field", async () => {
		await resetOperationalSettings();
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		// MAX_HOLD_TTL_MINUTES is 10_080 (one week) — 99999 is a genuine
		// InvalidSettingsError from `@otta-sh/domain`'s `updateSettings`, not a
		// stubbed 400. Only holdTtlMinutes is edited.
		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "99999" },
			idempotencyKey: "k-validation-bad",
		});
		// Not a thrown {error} — a rendered inline error banner carrying the
		// domain's own message.
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.description)).toContain("holdTtlMinutes must be <= 10080, got 99999");

		// J6: the operational form re-renders the ATTEMPTED holdTtlMinutes
		// (99999) but the un-edited lowStockThreshold keeps its STORED value (the
		// default, 5), not 0. Both are `text_input` (F-6), so `initial_value` is
		// a digit-only STRING, not a number.
		const opForm = formFor(blocks, "save-operational");
		expect(field(opForm, "holdTtlMinutes")?.initial_value).toBe("99999");
		expect(field(opForm, "lowStockThreshold")?.initial_value).toBe("5");
		// Every other form on the screen survived too (S-5).
		expectAllRealFormsPresent(blocks);
	});

	// INC-D3a deletes two old cases outright rather than adapting them:
	//
	//  - "a non-validation save failure (e.g. 401) surfaces a GENERIC banner"
	//    tested the in-process client's `reason: "unavailable"` fallback — the
	//    ONE failure class that has no black-box trigger left. Every real
	//    failure this suite can actually provoke against a real store is either
	//    a domain `InvalidSettingsError` (the case above) or a lost
	//    compare-and-set (`"superseded"`, below); "unavailable" exists in
	//    `in-process-reporting-settings-client.ts` for a genuine storage-layer
	//    fault (a corrupted collection, an IO exception) this integration
	//    suite has no honest way to induce against a real SQLite-backed store
	//    without mocking the storage layer, which defeats the point of a
	//    sandbox suite proving REAL persistence.
	//
	//  - "the page-load GET /settings carries the admin token" tested a header
	//    forwarded from write-only kv onto an HTTP request that no longer
	//    exists — there is no analogous concept to preserve.

	test("a lost compare-and-set (another writer decided this idempotency key first) surfaces as SUPERSEDED, not a generic failure, and leaks no transport/storage vocabulary", async () => {
		// `EmdashSettingsStore.update` (`packages/store-emdash/src/emdash-settings-store.ts`)
		// holds a claim on the idempotency key (create-if-absent) and, if the
		// claim already existed with a DIFFERENT decided revision than the real
		// current one, throws `SettingsMutationSupersededError` — deterministically,
		// with no timing/concurrency needed. Fabricating that claim directly
		// against the same store `storage: true` will bind to reproduces exactly
		// the condition a genuine race would leave behind.
		const storage = await resetOperationalSettings();
		const key = "k-superseded-fabricated-1";
		const mutations = collectionOf<SettingsMutationDoc>(storage, SETTINGS_MUTATIONS_COLLECTION);
		const seeded = await mutations.compareAndSet(key, null, {
			patch: { holdTtlMinutes: 30 },
			decidedRevision: "some-other-writer-already-decided-this",
			createdAt: new Date().toISOString(),
			result: null,
			appliedRevision: null,
			appliedAt: null,
			supersededAt: null,
		});
		if (!seeded.applied) {
			throw new Error("fixture setup itself lost a compare-and-set — flaky test infra");
		}

		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-operational",
			values: { holdTtlMinutes: "45", lowStockThreshold: "20" },
			idempotencyKey: key,
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.title)).toBe("Settings changed by someone else");
		expect(String(banner?.description)).toMatch(/Nothing was saved\.$/);
		// `updateSettings()` deliberately carries no `status` for this reason —
		// "a fabricated 409 would be indistinguishable from a real one" — and the
		// banner must not leak the compare-and-set vocabulary that produced it.
		const text = `${String(banner?.title)} ${String(banner?.description)}`;
		expect(text).not.toMatch(/HTTP \d|compareAndSet|claim|revision|409/i);
		expect(toastOf(outcome)).toEqual({
			message: "Settings changed by someone else",
			type: "error",
		});

		// J6: the FORM keeps the attempted values so the operator can retry…
		expect(field(formFor(blocks, "save-operational"), "holdTtlMinutes")?.initial_value).toBe("45");
		// …but the LABEL states what is actually stored — nothing, since the
		// superseded write never touched the real settings doc.
		expect(groupLabels(blocks).get("settings:checkout")).toBe(
			"Checkout & holds — 15 min hold · low stock at 5",
		);
	});

	test("NO-STORAGE page_load /settings (ctx.storage undeclared) crashes to the transport boundary — unlike Reports' internally-caught banner", async () => {
		// `settings-form.ts` calls `makeAdminClients(ctx)` — which THROWS
		// `MISSING_STORAGE_MESSAGE` synchronously when `ctx.storage` is absent —
		// OUTSIDE any try/catch of its own, and `admin-route.ts`'s settings
		// branches (both `page_load` and the action_id dispatch) wrap NEITHER
		// call in a try/catch either. `reports-page.ts` constructs its OWN
		// clients inside a try/catch precisely so the identical throw renders a
		// graceful fail-closed banner instead (see
		// `admin-route-dispatch.sandbox.test.ts`'s matching Reports case). This
		// throw therefore propagates all the way to `sandbox-entry.ts`'s one
		// outer dispatch catch and surfaces as a transport-level `{error}`, not
		// a rendered screen — a real, current asymmetry between the two
		// screens, not something this test's job is to paper over.
		sandbox = await loadPluginInSandbox({ allowedHosts: [] });

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		expect(outcome).toEqual({ error: MISSING_STORAGE_MESSAGE });
	});

	// RESTORED from "with NO admin token the guarded GET /settings degrades to a
	// context line (E-1 secondary read), never a top-level banner". The TOKEN is
	// gone, and so is the "both token forms still render" half of that case — but
	// the property it existed for is not the token, it is E-1: a FAILED read of
	// the operational settings degrades inside its own group and never fails the
	// screen closed. `renderPage`'s catch and `checkoutGroup`'s context branch are
	// both still live in `settings-form.ts`, so the case is restated against the
	// input that still exists — a storage fault on the settings collection alone.
	test("a FAILED operational-settings read degrades to a context line inside its own group (E-1 secondary read), never a top-level banner — and every other form still renders", async () => {
		const handle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		sandbox = handle;
		const blocks = await withSettingsReadFailing(async () =>
			blocksOf(await handle.invokeRoute("admin", { type: "page_load", page: "/settings" })),
		);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		// E-1 / director ruling: `getSettings()` feeds ONLY "Checkout & holds", so
		// its failure is a SECONDARY read failure — a `context` line inside that
		// one group, never a screen-wide fail-closed banner. (An earlier draft
		// rendered the banner, which §12.6's listing implied; that is the N-1
		// defect E-1 fixed, and this is what keeps it fixed.)
		expect(findBlocks(blocks, "banner")).toHaveLength(0);
		expect(
			contextTexts(blocks).some((text) => /Operational settings could not be loaded/.test(text)),
		).toBe(true);
		// INC-15: the closed group's LABEL says so as a FACT too, rather than
		// inventing a zero that would read as a stored value.
		expect(groupLabels(blocks).get("settings:checkout")).toBe("Checkout & holds — not loaded");

		// NO LOCKOUT: everything that needs no settings read is still on the page,
		// so an operator can still work the screen while that one read is down.
		expect(formFor(blocks, "save-display")).toBeDefined();
		expect(formFor(blocks, "save-stripe-secret-key")).toBeDefined();
		expect(formFor(blocks, "save-payment-settings")).toBeDefined();
		// The operational form itself is absent — there is nothing to prefill it
		// with, so the context line REPLACES it rather than sitting beside a
		// zeroed one.
		expect(formFor(blocks, "save-operational")).toBeUndefined();
	});

	test("SECURITY: the settings form manifest declares only content:read + network:request (no storage/kv/db), and the schema has no secret field", () => {
		expect(OTTA_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request"]);
		for (const cap of OTTA_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
		// The kv-backed field is display-only; the two operational fields are
		// service-tier. NONE is a secret (no secret tier, no secret-shaped
		// field) — the five real secrets are provisioning UI, not schema.
		expect(SETTINGS_SCHEMA.storeDisplayName.tier).toBe("kv");
		expect(SETTINGS_SCHEMA.holdTtlMinutes.tier).toBe("service");
		expect(SETTINGS_SCHEMA.lowStockThreshold.tier).toBe("service");
		for (const schemaField of Object.values(SETTINGS_SCHEMA)) {
			expect(["string", "number", "boolean"]).toContain(schemaField.type);
			expect(schemaField.type).not.toBe("secret");
			expect(schemaField.label.toLowerCase()).not.toMatch(/secret|password|api key|token/);
		}
	});

	// INC-D3a deletes the old "INC-09: Admin token and Service token render as
	// plain text_input" case outright — both fields are gone. The identical
	// claim (plain, always-empty `text_input`, no `secret_input`, no
	// `has_value`) is proven below against the five REAL secrets that remain,
	// which is the concept this case was actually protecting.

	/**
	 * INC-C3 — the payment/email secrets the folded-in commerce layer needs,
	 * held in WRITE-ONLY plugin kv, plus the Settings provisioning surface for
	 * them. Under the REAL workerd sandbox, not just the unit handler
	 * (`payment-secrets.test.ts` covers the handler-level field-by-field
	 * detail): the whole point of this pin is that nothing in the SERIALIZED
	 * response that crosses the host boundary carries a credential, and the
	 * sandbox is where that boundary actually exists.
	 */
	test("INC-C3: every payment/email secret is write-only — set, then never rendered back anywhere", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const SECRETS = [
			["save-stripe-secret-key", "stripeSecretKey", "qa-sk-live-NEVER-RENDER"],
			["save-stripe-webhook-secret", "stripeWebhookSecret", "qa-whsec-NEVER-RENDER"],
			["save-email-api-key", "emailApiKey", "qa-email-key-NEVER-RENDER"],
			["save-x402-facilitator-secret", "x402FacilitatorSecret", "qa-x402-NEVER-RENDER"],
			["save-webhook-edge-token", "webhookEdgeToken", "qa-wh-token-NEVER-RENDER"],
		] as const;

		// Each SAVE's own response must already be clean — the receipt is the
		// first place a naive implementation echoes what was just submitted.
		for (const [actionId, fieldId, value] of SECRETS) {
			const saved = await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: actionId,
				values: { [fieldId]: value },
			});
			expect(JSON.stringify(saved)).not.toContain(value);
		}

		// And the subsequent page load, with all five now SET, renders none of
		// them: no initial_value, no has_value, no masked variant, nothing in a
		// label, context line, notice or toast.
		const loaded = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const blocks = blocksOf(loaded);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		for (const [actionId, fieldId, value] of SECRETS) {
			const rendered = field(formFor(blocks, actionId), fieldId);
			expect(rendered?.type).toBe("text_input");
			expect(rendered).not.toHaveProperty("initial_value");
			expect(rendered).not.toHaveProperty("has_value");
			expect(JSON.stringify(loaded)).not.toContain(value);
		}

		// The group's label states WHICH credentials are missing — with all five
		// set, it says so without naming any of them.
		expect(groupLabels(blocks).get("settings:payments")).toBe("Payments & email — configured");
	});

	/**
	 * INC-C5 — the NON-SECRET in-process settings (`emailFrom`, `x402PayTo`,
	 * `x402Accepts`). These are READ BACK, unlike the secrets in the same
	 * group — that difference is the tier, and it is deliberate: an operator
	 * must be able to see which wallet they are being paid at.
	 */
	test("INC-C5: the non-secret in-process settings can be SET and are READ BACK (secrets are not)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		// A fresh install: the form is there, and empty.
		const fresh = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const freshForm = formFor(fresh, "save-payment-settings");
		expect(freshForm, "expected a form submitting save-payment-settings").toBeDefined();
		expect(field(freshForm, "x402PayTo")?.["initial_value"]).toBe("");

		const PAY_TO = "0x00000000000000000000000000000000000000a1";
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: {
				emailFrom: "orders@shop.example",
				x402PayTo: PAY_TO,
				x402Accepts: "eip155:8453, eip155:1",
			},
		});

		const loaded = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(loaded, { screen: "settings", level: "list" });
		const form = formFor(loaded, "save-payment-settings");
		expect(field(form, "emailFrom")?.["initial_value"]).toBe("orders@shop.example");
		expect(field(form, "x402PayTo")?.["initial_value"]).toBe(PAY_TO);
		expect(field(form, "x402Accepts")?.["initial_value"]).toBe("eip155:8453, eip155:1");
	});

	test("INC-C5: a PARTIAL submit leaves untouched settings alone — absent is not empty", async () => {
		// The save path only writes fields PRESENT as strings in the submit —
		// an absent field is skipped entirely, never coerced to `""` and
		// written unconditionally, because ONE submit that happens to omit
		// `x402PayTo` (a partial dispatch, a field the operator never focused)
		// must not silently blank the destination wallet.
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const PAY_TO = "0x00000000000000000000000000000000000000a1";
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { emailFrom: "orders@shop.example", x402PayTo: PAY_TO, x402Accepts: "eip155:8453" },
		});

		// A submit carrying ONLY the from-address.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { emailFrom: "hello@shop.example" },
		});

		const after = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const form = formFor(after, "save-payment-settings");
		expect(field(form, "emailFrom")?.["initial_value"]).toBe("hello@shop.example");
		// The two the submit never mentioned are UNCHANGED, not blanked.
		expect(field(form, "x402PayTo")?.["initial_value"]).toBe(PAY_TO);
		expect(field(form, "x402Accepts")?.["initial_value"]).toBe("eip155:8453");

		// A PRESENT empty string is still an instruction, and still honoured:
		// this is the operator clearing the box, which must remain possible.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { emailFrom: "hello@shop.example", x402PayTo: "", x402Accepts: "" },
		});
		const cleared = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		expect(field(formFor(cleared, "save-payment-settings"), "x402PayTo")?.["initial_value"]).toBe(
			"",
		);
	});

	test("INC-C5: a payTo that is not a wallet address is REFUSED and nothing is saved", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const refused = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-payment-settings",
			values: { emailFrom: "orders@shop.example", x402PayTo: "my-wallet", x402Accepts: "" },
		});
		const blocks = blocksOf(refused);
		// The whole screen comes back (S-5a: never a terminal receipt with no form).
		expectAllRealFormsPresent(blocks);
		expect(JSON.stringify(refused)).toContain("not a wallet address");

		// ATOMIC: the valid sibling field was not saved either, so the operator
		// is never left guessing which half of their submit landed.
		const after = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const form = formFor(after, "save-payment-settings");
		expect(field(form, "emailFrom")?.["initial_value"]).toBe("");
		expect(field(form, "x402PayTo")?.["initial_value"]).toBe("");
	});

	test("INC-09: a successful secret save remounts its own form BLANK with a DIFFERENT block_id, and does not remount an unrelated secret's form", async () => {
		// The old two-token version of this case is deleted along with the
		// tokens; the underlying mechanism (`secretForm` carries a `gen` in its
		// namespace context specifically to force a remount, since the field's
		// own prefill digest is constant — always blank) is unchanged and still
		// applies to all five real secrets. Two of them stand in for the pair.
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const before = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(before, { screen: "settings", level: "list" });
		const stripeKeyBlockIdBefore = formFor(before, "save-stripe-secret-key")?.block_id;
		const webhookBlockIdBefore = formFor(before, "save-stripe-webhook-secret")?.block_id;

		const stripeKeySaved = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-stripe-secret-key",
				values: { stripeSecretKey: "qa-local-stripe-key" },
			}),
		);
		const stripeKeyFieldAfter = field(
			formFor(stripeKeySaved, "save-stripe-secret-key"),
			"stripeSecretKey",
		);
		const stripeKeyBlockIdAfterSave = formFor(stripeKeySaved, "save-stripe-secret-key")?.block_id;
		// The re-rendered field carries no value — still a plain, empty
		// text_input, nothing left lingering from what was typed.
		expect(stripeKeyFieldAfter).not.toHaveProperty("initial_value");
		// The KEY changed: a real host remounts the input on this response,
		// discarding whatever DOM value the operator had just typed.
		expect(stripeKeyBlockIdAfterSave).not.toBe(stripeKeyBlockIdBefore);
		// Saving the STRIPE KEY must not remount the untouched WEBHOOK field.
		expect(formFor(stripeKeySaved, "save-stripe-webhook-secret")?.block_id).toBe(
			webhookBlockIdBefore,
		);

		// blank-submit-keeps-current still holds UNCHANGED: a blank submit never
		// bumps the generation, so the block_id does not move further (there is
		// nothing to remount — the field was already blank).
		const blankSubmitted = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-stripe-secret-key",
				values: { stripeSecretKey: "" },
			}),
		);
		expect(formFor(blankSubmitted, "save-stripe-secret-key")?.block_id).toBe(
			stripeKeyBlockIdAfterSave,
		);
	});

	test("INC-09: a blank secret submit gets an honest 'nothing entered' receipt, and a save-then-blank sequence keeps the stored secret (blank never clobbers it)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const blank = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-stripe-secret-key",
			values: { stripeSecretKey: "" },
		});
		const blocks = blocksOf(blank);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const banner = findBlocks(blocks, "banner")[0];
		expect(String(banner?.title)).toBe("Nothing entered — stripe secret key unchanged");
		expect(String(banner?.title)).not.toMatch(/saved/i);
		expect(toastOf(blank)).toEqual({ message: "Stripe secret key unchanged", type: "info" });
		// Nothing was ever set, so the group label still lists it as missing.
		expect(groupLabels(blocks).get("settings:payments")).toContain("stripe key");

		// Save it for real, then submit blank — the earlier save must survive.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-stripe-secret-key",
			values: { stripeSecretKey: "qa-local-stripe-key" },
		});
		const afterBlank = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-stripe-secret-key",
			values: { stripeSecretKey: "" },
		});
		const afterBlankBlocks = blocksOf(afterBlank);
		expect(String(findBlocks(afterBlankBlocks, "banner")[0]?.title)).toBe(
			"Nothing entered — stripe secret key unchanged",
		);
		// The label now says "configured" for stripe key's slot (no longer
		// listed as missing) — the earlier save held.
		expect(groupLabels(afterBlankBlocks).get("settings:payments")).not.toContain("stripe key");
		expect(JSON.stringify(afterBlankBlocks)).not.toContain("qa-local-stripe-key");
	});

	// -- INC-15: the labels carry the values, so every group can start closed ----

	test("INC-15: every group renders CLOSED and its label states its own values — nothing has to be opened to read this screen", async () => {
		await resetOperationalSettings();
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		const labels = groupLabels(blocks);
		// THREE groups, not the old four: INC-D3a deletes "Service connection"
		// outright.
		expect([...labels.keys()]).toEqual([
			"settings:store",
			"settings:checkout",
			"settings:payments",
		]);
		expect(labels.get("settings:store")).toBe("Store — no display name");
		expect(labels.get("settings:checkout")).toBe("Checkout & holds — 15 min hold · low stock at 5");
		expect(labels.get("settings:payments")).toBe(
			// Exactly 60 characters — the X-11 budget, with nothing elided.
			"Payments & email — no stripe key, webhook, email, x402, edge",
		);
		for (const label of labels.values()) expect(label.length).toBeLessThanOrEqual(60);

		// All three closed — the render-time kind (§1.2), which is legal.
		expect(openGroupIds(blocks)).toEqual([]);
		expect(findBlocks(blocks, "accordion").every((a) => a.default_open === false)).toBe(true);
	});

	// The old "a label states an unset or unreadable value as a FACT" case used a
	// stubbed GET 503 to force `checkoutGroupLabel`'s "not loaded" branch. There
	// is no stub any more, but the branch is reachable all the same: the E-1 case
	// above injects a storage fault on the settings collection alone
	// (`withSettingsReadFailing`) and asserts that label together with the context
	// line it belongs to, which is where the two facts are one render anyway.
	// UNREACHABLE: `client.getSettings()` returning a VALUE the label cannot read
	// — `EmdashSettingsStore.get()` defaults an absent document rather than
	// erroring, so "unset" and "default" are the same state by construction.

	test("INC-15: the labels track saves — a saved display name and a first-ever secret save are stated on the SAME response that saved them", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const named = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-display",
				values: { storeDisplayName: "Acme Goods" },
			}),
		);
		expect(groupLabels(named).get("settings:store")).toBe("Store — Acme Goods");

		// The trap this pins: the handler must not have read secret state ONCE,
		// at the top, in a way that would report a first-ever save as still
		// missing unless the save updates what the re-render is computed from.
		const savedKey = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-stripe-secret-key",
				values: { stripeSecretKey: "qa-local-stripe-key" },
			}),
		);
		// THE WHOLE LABEL, EXACTLY — a substring check ("no longer mentions the
		// stripe key, still mentions the webhook") passes just as happily on a
		// label that dropped the wrong entry, reordered the remaining four, or
		// lost the "no " prefix that makes the list read as MISSING rather than
		// as present.
		expect(groupLabels(savedKey).get("settings:payments")).toBe(
			"Payments & email — no webhook, email, x402, edge",
		);

		// …and a later page load agrees, so the label is reporting kv, not the
		// interaction it was submitted with. Stated as the same literal, not as
		// equality with the line above: two identically-wrong labels would satisfy
		// a comparison of one against the other.
		const reloaded = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		expect(groupLabels(reloaded).get("settings:payments")).toBe(
			"Payments & email — no webhook, email, x402, edge",
		);

		// SECURITY PIN: no part of the secret value appears in any of these
		// responses — labels included, and the SAVE response included (the
		// save handler is the only one with the plaintext in scope at render
		// time, and the plain unmasked field is what put that plaintext one
		// submit away from the response body).
		for (const response of [savedKey, reloaded, named]) {
			expect(JSON.stringify(response)).not.toContain("qa-local-stripe-key");
		}
	});

	test("INC-15: the groups are still ALL closed on a response whose secret form remounted — a churned form block_id does not open its group", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		const saved = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-stripe-secret-key",
				values: { stripeSecretKey: "qa-local-stripe-key" },
			}),
		);
		assertBlockContract(saved, { screen: "settings", level: "list" });
		// INC-09's post-save clear changes the FORM's carrier block_id inside the
		// group; the GROUP's own block_id and default_open must not follow it.
		expect(openGroupIds(saved)).toEqual([]);
		expect([...groupLabels(saved).keys()]).toEqual([
			"settings:store",
			"settings:checkout",
			"settings:payments",
		]);
	});

	test("INC-15: a REJECTED save leaves the LABEL on the stored values while the FORM keeps the attempted ones (J6)", async () => {
		await resetOperationalSettings();
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const rejected = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-operational",
				values: { holdTtlMinutes: "99999", lowStockThreshold: "5" },
				idempotencyKey: "k-inc15-rejected",
			}),
		);
		assertBlockContract(rejected, { screen: "settings", level: "list" });

		// The LABEL is the one thing on this screen that reads as persisted
		// state: 99999 was refused, so a collapsed group claiming "99999 min
		// hold" would be reporting a value the store does not hold.
		expect(groupLabels(rejected).get("settings:checkout")).toBe(
			"Checkout & holds — 15 min hold · low stock at 5",
		);
		// The FORM still carries the attempted value, so it can be corrected (J6).
		expect(field(formFor(rejected, "save-operational"), "holdTtlMinutes")?.initial_value).toBe(
			"99999",
		);
		expect(findBlocks(rejected, "banner").some((b) => b.variant === "error")).toBe(true);
	});

	test("INC-15: the one operator-supplied value on this screen cannot blow the label budget — a 200-char display name truncates, inside 60 (X-11)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		// `save-display` trims, so the fixture must not end in whitespace — the
		// label assertion below is about truncation, not about trimming.
		const longName = "Sea Salt & Cedar Supply Company of the Pacific Northwest"
			.repeat(4)
			.slice(0, 200)
			.trimEnd();
		const blocks = blocksOf(
			await sandbox.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-display",
				values: { storeDisplayName: longName },
			}),
		);
		assertBlockContract(blocks, { screen: "settings", level: "list" });

		const label = String(groupLabels(blocks).get("settings:store"));
		expect(label.length).toBe(60);
		expect(label.startsWith("Store — Sea Salt & Cedar Supply")).toBe(true);
		expect(label.endsWith("…")).toBe(true);
		// The form still prefills the WHOLE name — only the label is shortened.
		expect(field(formFor(blocks, "save-display"), "storeDisplayName")?.initial_value).toBe(
			longName,
		);
	});

	test("INC-15: a label change NEVER changes a group's block_id — the labels move, the accordions do not remount (§1.2)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
		const before = blocksOf(
			await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" }),
		);
		const after = blocksOf(
			await sandbox.invokeRoute("admin", {
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
