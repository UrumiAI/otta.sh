import { afterEach, describe, expect, test } from "vitest";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Tax console under the REAL workerd-on-Node sandbox (admin-UX
// Increment 3, slice 2 — "tax admin drill-down"): tax classes (list/create)
// drilling into a class's tax rates (list/create/edit-with-CAS/delete). This
// is the first production screen where BOTH scaffold levels are LISTS (no
// leaf) — row mutations re-render the list via the scaffold's list-level
// notice surface. Renaming/deleting a CLASS is intentionally not offered
// (no service route / no domain port method — see `tax-page.ts`'s top
// comment); this suite proves what IS wired: the classes registry's
// list+create, and rates' full create/list/update-with-CAS/delete-idempotent.

interface TaxClassRow {
	id: string;
	name: string;
}
interface TaxRateRow {
	id: string;
	taxClassId: string;
	zoneId: string;
	rateBps: number;
	appliesToShipping: boolean;
}
interface ZoneRow {
	id: string;
	name: string;
	regions: unknown;
}

/** A small stateful stub standing in for the rules-admin HTTP surface —
 *  classes/rates/zones are mutated by POST/PUT/DELETE and read back by GET,
 *  so create→list, edit→reload, and delete→idempotent-replay all exercise
 *  real state transitions (not canned fixtures). */
function makeRulesState() {
	const zones: ZoneRow[] = [
		{ id: "us", name: "United States", regions: ["US"] },
		{ id: "eu", name: "Europe", regions: ["EU"] },
	];
	const classes: TaxClassRow[] = [{ id: "standard", name: "Standard" }];
	const rates: TaxRateRow[] = [
		{ id: "std-us", taxClassId: "standard", zoneId: "us", rateBps: 725, appliesToShipping: false },
		{ id: "std-eu", taxClassId: "standard", zoneId: "eu", rateBps: 2000, appliesToShipping: true },
	];
	return { zones, classes, rates };
}

function attachRulesStub(stub: StubCommerceServer, state: ReturnType<typeof makeRulesState>) {
	stub.respondWith("GET", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const [path, query = ""] = req.url.split("?");
		if (path === "/admin/tax/classes") {
			return { status: 200, body: { ok: true, classes: state.classes } };
		}
		if (path === "/admin/shipping/zones") {
			return { status: 200, body: { ok: true, zones: state.zones } };
		}
		if (path === "/admin/tax/rates") {
			const zoneId = new URLSearchParams(query).get("zoneId");
			if (zoneId === null) return { status: 400, body: { error: "zoneId query is required" } };
			return {
				status: 200,
				body: { ok: true, rates: state.rates.filter((r) => r.zoneId === zoneId) },
			};
		}
		return { status: 404, body: { error: "unknown" } };
	});

	stub.respondWith("POST", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		if (req.url === "/admin/tax/classes") {
			const body = req.body as { id: string; name: string };
			if (state.classes.some((c) => c.id === body.id)) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			const created = { id: body.id, name: body.name };
			state.classes.push(created);
			return { status: 201, body: { ok: true, taxClass: created } };
		}
		if (req.url === "/admin/tax/rates") {
			const body = req.body as TaxRateRow;
			if (state.rates.some((r) => r.id === body.id)) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			const created: TaxRateRow = { ...body, appliesToShipping: body.appliesToShipping ?? false };
			state.rates.push(created);
			return { status: 201, body: { ok: true, rate: created } };
		}
		return { status: 404, body: { error: "unknown" } };
	});

	stub.respondWith("PUT", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const m = /^\/admin\/tax\/rates\/(.+)$/.exec(req.url);
		if (m === null) return { status: 404, body: { error: "unknown" } };
		const rateId = decodeURIComponent(m[1] ?? "");
		const rate = state.rates.find((r) => r.id === rateId);
		if (rate === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
		const body = req.body as {
			rateBps: number;
			appliesToShipping: boolean;
			expectedRateBps: number;
		};
		if (rate.rateBps !== body.expectedRateBps) {
			return { status: 409, body: { ok: false, reason: "STALE", current: rate } };
		}
		rate.rateBps = body.rateBps;
		rate.appliesToShipping = body.appliesToShipping;
		return { status: 200, body: { ok: true, rate } };
	});

	stub.respondWith("DELETE", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const m = /^\/admin\/tax\/rates\/(.+)$/.exec(req.url);
		if (m === null) return { status: 404, body: { error: "unknown" } };
		const rateId = decodeURIComponent(m[1] ?? "");
		const idx = state.rates.findIndex((r) => r.id === rateId);
		if (idx === -1) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
		state.rates.splice(idx, 1);
		return { status: 200, body: { ok: true } };
	});
}

async function seedToken(sandbox: SandboxHandle, stub: StubCommerceServer, token: string) {
	await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-token",
		values: { internalToken: token },
	});
	stub.requests.length = 0;
}

interface Blk extends Record<string, unknown> {
	type: string;
}
function blocksOf(outcome: unknown): Blk[] {
	if (!(typeof outcome === "object" && outcome !== null && "result" in outcome)) return [];
	const result = (outcome as { result: { blocks?: Blk[] } }).result;
	return result.blocks ?? [];
}
function tableRows(blocks: Blk[]): Array<Record<string, unknown>> {
	const table = blocks.find((b) => b.type === "table");
	return (table?.rows ?? []) as Array<Record<string, unknown>>;
}
function bannerOf(blocks: Blk[]) {
	return blocks.find((b) => b.type === "banner") as
		| { variant?: string; title?: string; description?: string }
		| undefined;
}
function formFields(blocks: Blk[], submitActionId: string): Array<Record<string, unknown>> {
	const form = blocks.find(
		(b) => b.type === "form" && (b.submit as { action_id?: string })?.action_id === submitActionId,
	);
	return (form?.fields ?? []) as Array<Record<string, unknown>>;
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

async function boot(state: ReturnType<typeof makeRulesState>, token = "admin-token-xyz") {
	stub = await startStubCommerceServer();
	attachRulesStub(stub, state);
	sandbox = await loadPluginInSandbox({
		allowedHosts: [stub.host],
		commerceServiceBaseUrl: stub.baseUrl,
	});
	if (token.length > 0) await seedToken(sandbox, stub, token);
}

describe("admin Tax console — classes level (workerd sandbox)", () => {
	test("page_load /tax renders the classes list and forwards the kv-sourced admin token", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/tax" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
		expect(tableRows(blocks)).toEqual([{ id: "standard", name: "Standard" }]);
		const listReq = stub!.requests.find((r) => r.url === "/admin/tax/classes");
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("NO-TOKEN page_load /tax fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		const state = makeRulesState();
		await boot(state, "");
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/tax" });
		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/tax|401/);
	});

	test("create-class with blank fields is caught at the plugin boundary — no POST sent", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:create-class",
			values: { id: "", name: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("create-class POSTs {id,name} with the admin token, then re-lists with a success notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:create-class",
			values: { id: "reduced", name: "Reduced rate" },
		});
		const post = stub!.requests.find((r) => r.method === "POST" && r.url === "/admin/tax/classes");
		expect(post).toBeDefined();
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(post!.body).toEqual({ id: "reduced", name: "Reduced rate" });

		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		// The re-rendered (root) list reflects the new class — a fresh GET, not a
		// locally-patched echo.
		expect(tableRows(blocks)).toEqual([
			{ id: "standard", name: "Standard" },
			{ id: "reduced", name: "Reduced rate" },
		]);
	});

	test("creating a class with a duplicate id fails with a GENERIC error notice (no raw status)", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:create-class",
			values: { id: "standard", name: "Standard again" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		// Never applied — the list still shows exactly one "standard".
		expect(state.classes.filter((c) => c.id === "standard")).toHaveLength(1);
	});

	test("the classes screen offers NO rename/delete affordance (capability doesn't exist end-to-end)", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/tax" });
		const blocks = blocksOf(outcome);
		const allActionIds = new Set<string>();
		for (const b of blocks) {
			if (b.type === "form")
				allActionIds.add((b.submit as { action_id?: string })?.action_id ?? "");
			if (b.type === "actions") {
				for (const el of (b.elements as Array<Record<string, unknown>>) ?? []) {
					if (typeof el.action_id === "string") allActionIds.add(el.action_id);
				}
			}
		}
		expect(allActionIds.has("tax:rename-class")).toBe(false);
		expect(allActionIds.has("tax:delete-class")).toBe(false);
	});
});

describe("admin Tax console — rates level (workerd sandbox)", () => {
	test("opening a class renders its rates FANNED OUT across every zone by default (no explicit zoneId filter)", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:open",
			values: { classId: "standard" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		// A back button exists (no dead-end).
		const actions = blocks.filter((b) => b.type === "actions");
		const allButtons = actions.flatMap((a) => (a.elements as Array<Record<string, unknown>>) ?? []);
		expect(allButtons.some((e) => e.action_id === "tax:back")).toBe(true);

		// Fanned out: a zones read, then one rates read per zone.
		expect(stub!.requests.some((r) => r.url === "/admin/shipping/zones")).toBe(true);
		expect(stub!.requests.some((r) => r.url === "/admin/tax/rates?zoneId=us")).toBe(true);
		expect(stub!.requests.some((r) => r.url === "/admin/tax/rates?zoneId=eu")).toBe(true);

		// Both seeded rates for "standard" show up, rate rendered as a percent.
		const rows = tableRows(blocks);
		expect(rows.map((r) => r.id).toSorted()).toEqual(["std-eu", "std-us"]);
		const usRow = rows.find((r) => r.id === "std-us");
		expect(usRow?.rate).toBe("7.25%");
		expect(usRow?.zone).toBe("United States"); // zone NAME resolved via the fan-out
		expect(usRow?.appliesToShipping).toBe("no");
		const euRow = rows.find((r) => r.id === "std-eu");
		expect(euRow?.rate).toBe("20.00%");
		expect(euRow?.appliesToShipping).toBe("yes");
	});

	test("filtering by a zone ID scopes to ONE read (no fan-out) and excludes other zones' rates", async () => {
		const state = makeRulesState();
		await boot(state);
		const rates = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:open",
			values: { classId: "standard" },
		});
		// The scaffold AUTO-INJECTS the drill-path carrier into the filter form
		// (`withFilterPathCarry`) — extract it exactly as em-dash would resubmit it,
		// rather than hand-encoding the path.
		const filterFields = formFields(blocksOf(rates), "tax:apply-filter");
		const pathField = filterFields.find((f) => f.action_id === "__path");
		expect(pathField).toBeDefined();
		stub!.requests.length = 0;

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:apply-filter",
			values: { zoneId: "us", __path: pathField?.initial_value },
		});
		expect(stub!.requests.some((r) => r.url === "/admin/shipping/zones")).toBe(false);
		expect(stub!.requests.filter((r) => r.url.startsWith("/admin/tax/rates"))).toHaveLength(1);
		expect(stub!.requests[0]?.url).toBe("/admin/tax/rates?zoneId=us");

		const rows = tableRows(blocksOf(outcome));
		expect(rows.map((r) => r.id)).toEqual(["std-us"]);
	});

	test("a class with no rates yet shows an honest empty state, never a fail-closed banner", async () => {
		const state = makeRulesState();
		state.classes.push({ id: "zero", name: "Zero-rated" });
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:open",
			values: { classId: "zero" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — zero")).toBe(true);
		const table = blocks.find((b) => b.type === "table");
		expect(tableRows(blocks).length).toBe(0);
		expect(String(table?.empty_text)).toMatch(/no tax rates/i);
	});

	test("create-rate POSTs the percent parsed to EXACT integer bps, then reloads the class's rates with a success notice", async () => {
		const state = makeRulesState();
		await boot(state);
		// Zone "us" already exists in the fan-out's zone list, so the reloaded
		// (unfiltered) rates level picks the new rate straight up.
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:create-rate",
			values: {
				classId: "standard",
				id: "std-us-b",
				zoneId: "us",
				ratePercent: "20",
				appliesToShipping: "true",
			},
		});
		const post = stub!.requests.find((r) => r.method === "POST" && r.url === "/admin/tax/rates");
		expect(post).toBeDefined();
		expect(post!.body).toEqual({
			id: "std-us-b",
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 2000, // "20" → 2000 bps, EXACT integer math, no float
			appliesToShipping: true,
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		// Re-rendered the RATES level (path=[classId]), not the root classes list —
		// and the reload (a real fresh GET, not a locally-patched echo) shows it.
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		expect(
			tableRows(blocks)
				.map((r) => r.id)
				.toSorted(),
		).toEqual(["std-eu", "std-us", "std-us-b"]);
	});

	test("a malformed rate percent is caught at the plugin boundary — no POST is sent", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:create-rate",
			values: {
				classId: "standard",
				id: "bad",
				zoneId: "us",
				ratePercent: "7.255",
				appliesToShipping: "false",
			},
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("the rates list carries a per-row edit form (CAS) prefilled from the loaded rate", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:open",
			values: { classId: "standard" },
		});
		const fields = formFields(blocksOf(outcome), "tax:save-rate");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("rateId")?.initial_value).toBe("std-us");
		expect(byId.get("expectedRateBps")?.initial_value).toBe("725");
		expect(byId.get("ratePercent")?.type).toBe("text_input"); // never number_input
		expect(byId.get("ratePercent")?.initial_value).toBe("7.25");
	});

	test("save-rate PUTs the CAS edit and reloads with a 'saved' notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:save-rate",
			values: {
				classId: "standard",
				rateId: "std-us",
				expectedRateBps: "725",
				ratePercent: "8.25",
				appliesToShipping: "true",
			},
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put).toBeDefined();
		expect(put!.url).toBe("/admin/tax/rates/std-us");
		expect(put!.body).toEqual({ rateBps: 825, appliesToShipping: true, expectedRateBps: 725 });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		expect(state.rates.find((r) => r.id === "std-us")?.rateBps).toBe(825);
	});

	test("a concurrent-edit conflict (409 STALE) reloads the fresh rate with a re-apply warning, never a clobber", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:save-rate",
			values: {
				classId: "standard",
				rateId: "std-us",
				expectedRateBps: "1", // stale — the real current value is 725
				ratePercent: "9.00",
				appliesToShipping: "false",
			},
		});
		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/changed since you loaded it|reload/i);
		// Nothing was applied server-side.
		expect(state.rates.find((r) => r.id === "std-us")?.rateBps).toBe(725);
		// The re-render shows the FRESH (unedited) value, from a real reload GET.
		const usRow = tableRows(blocks).find((r) => r.id === "std-us");
		expect(usRow?.rate).toBe("7.25%");
	});

	test("delete-rate DELETEs and reloads with a 'deleted' notice; a repeat delete is an idempotent 'already deleted' notice, never an error", async () => {
		const state = makeRulesState();
		await boot(state);
		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:delete-rate",
			value: { classId: "standard", rateId: "std-us" },
		});
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/tax/rates/std-us");
		const firstBanner = bannerOf(blocksOf(first));
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(tableRows(blocksOf(first)).some((r) => r.id === "std-us")).toBe(false);

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:delete-rate",
			value: { classId: "standard", rateId: "std-us" },
		});
		const secondBanner = bannerOf(blocksOf(second));
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("back from the rates level returns to the tax classes list", async () => {
		const state = makeRulesState();
		await boot(state);
		const rates = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:open",
			values: { classId: "standard" },
		});
		const backButtonValue = (() => {
			for (const b of blocksOf(rates)) {
				if (b.type !== "actions") continue;
				const el = (b.elements as Array<Record<string, unknown>>).find(
					(e) => e.action_id === "tax:back",
				);
				if (el !== undefined) return el.value as Record<string, string>;
			}
			return undefined;
		})();
		expect(backButtonValue).toBeDefined();
		const back = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:back",
			value: backButtonValue,
		});
		expect(blocksOf(back).some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
	});
});
