import { afterEach, describe, expect, test } from "vitest";
import {
	blocksOf,
	buttons,
	findBlock,
	findBlocks,
	formFor,
	tableRows,
	type LooseBlock,
	type LooseElement,
} from "./helpers/blocks.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Tax console under the REAL workerd-on-Node sandbox (admin-UX
// Increment 3, slice 2 — "tax admin drill-down"; class rename/delete added
// in the Increment 3 closeout slice): tax classes (list/create/rename-LWW/
// delete-forbid-if-in-use) drilling into a class's tax rates (list/create/
// edit-with-CAS/delete). This is the first production screen where BOTH
// scaffold levels are LISTS (no leaf) — row mutations re-render the list via
// the scaffold's list-level notice surface.

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
	// Simulates LIVE product references per tax-class id — the DELETE stub
	// checks this map (mirroring the service's product-guard, checked BEFORE
	// the rate guard) to exercise the honest in_use_by_products count.
	const productRefCounts: Record<string, number> = {};
	return { zones, classes, rates, productRefCounts };
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
		const classMatch = /^\/admin\/tax\/classes\/(.+)$/.exec(req.url);
		if (classMatch !== null) {
			const classId = decodeURIComponent(classMatch[1] ?? "");
			const cls = state.classes.find((c) => c.id === classId);
			if (cls === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			const body = req.body as { name: string };
			cls.name = body.name;
			return { status: 200, body: { ok: true, taxClass: cls } };
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
		const classMatch = /^\/admin\/tax\/classes\/(.+)$/.exec(req.url);
		if (classMatch !== null) {
			const classId = decodeURIComponent(classMatch[1] ?? "");
			const idx = state.classes.findIndex((c) => c.id === classId);
			if (idx === -1) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			// Product guard checked first (mirrors `deleteTaxClass`'s ordering).
			const productCount = state.productRefCounts[classId] ?? 0;
			if (productCount > 0) {
				return {
					status: 409,
					body: { ok: false, reason: "IN_USE_BY_PRODUCTS", count: productCount },
				};
			}
			const rateCount = state.rates.filter((r) => r.taxClassId === classId).length;
			if (rateCount > 0) {
				return { status: 409, body: { ok: false, reason: "IN_USE_BY_RATES", count: rateCount } };
			}
			state.classes.splice(idx, 1);
			return { status: 200, body: { ok: true } };
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

// `blocksOf`/`tableRows` come from the shared recursive helpers (spec §15 V-1):
// `BlockRenderer` recurses into `columns`/`tab`/`accordion` children (R-25), and a
// flat `blocks.find(...)` silently returns nothing the moment this screen's content
// moves into a container — passing while asserting nothing. `bannerOf`/`formFields`
// are this suite's own thin wrappers over the shared `findBlock`/`formFor`, kept
// local because no shared `bannerOf` exists yet (only `findBlocks`/`panel`/`group`
// are the three every suite needs).
function bannerOf(blocks: readonly LooseBlock[]) {
	return findBlock(blocks, "banner") as
		| { variant?: string; title?: string; description?: string }
		| undefined;
}
function formFields(blocks: readonly LooseBlock[], submitActionId: string): LooseElement[] {
	const form = formFor(blocks, submitActionId);
	return Array.isArray(form?.fields) ? (form.fields as LooseElement[]) : [];
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

	test("the classes screen offers a rename form and a delete button per row", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/tax" });
		const blocks = blocksOf(outcome);
		const allActionIds = new Set<string>();
		for (const form of findBlocks(blocks, "form")) {
			allActionIds.add((form.submit as { action_id?: string } | undefined)?.action_id ?? "");
		}
		for (const el of buttons(blocks)) {
			if (typeof el.action_id === "string") allActionIds.add(el.action_id);
		}
		expect(allActionIds.has("tax:save-class")).toBe(true);
		expect(allActionIds.has("tax:delete-class")).toBe(true);
	});

	test("save-class PUTs the rename and reloads the classes list with a 'saved' notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:save-class",
			values: { classId: "standard", name: "Standard rate" },
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put?.url).toBe("/admin/tax/classes/standard");
		expect(put?.body).toEqual({ name: "Standard rate" });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		// Reloaded from a real GET, not a locally-patched echo.
		expect(tableRows(blocksOf(outcome))).toEqual([{ id: "standard", name: "Standard rate" }]);
		expect(state.classes[0]?.name).toBe("Standard rate");
	});

	test("save-class with a blank name is caught at the plugin boundary — no PUT sent", async () => {
		const state = makeRulesState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:save-class",
			values: { classId: "standard", name: "" },
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("delete-class DELETEs and reloads with a 'deleted' notice; a repeat delete is idempotent, never an error", async () => {
		const state = makeRulesState();
		state.classes.push({ id: "zero", name: "Zero-rated" });
		await boot(state);
		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:delete-class",
			value: { classId: "zero" },
		});
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/tax/classes/zero");
		const firstBanner = bannerOf(blocksOf(first));
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(tableRows(blocksOf(first)).some((r) => r.id === "zero")).toBe(false);

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:delete-class",
			value: { classId: "zero" },
		});
		const secondBanner = bannerOf(blocksOf(second));
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("delete-class refused while a RATE references it renders the HONEST count, never a bare refusal", async () => {
		const state = makeRulesState();
		await boot(state); // "standard" has 2 seeded rates (std-us, std-eu)
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:delete-class",
			value: { classId: "standard" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toContain("2 tax rates");
		// Nothing was applied — the class survives.
		expect(state.classes.some((c) => c.id === "standard")).toBe(true);
	});

	test("delete-class refused while a PRODUCT references it renders the HONEST count", async () => {
		const state = makeRulesState();
		state.classes.push({ id: "reduced", name: "Reduced" });
		state.productRefCounts.reduced = 3;
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:delete-class",
			value: { classId: "reduced" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toContain("3 products");
		expect(state.classes.some((c) => c.id === "reduced")).toBe(true);
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
		expect(buttons(blocks).some((e) => e.action_id === "tax:back")).toBe(true);

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
		const table = findBlock(blocks, "table");
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
		const backButtonValue = buttons(blocksOf(rates)).find((e) => e.action_id === "tax:back")
			?.value as Record<string, string> | undefined;
		expect(backButtonValue).toBeDefined();
		const back = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:back",
			value: backButtonValue,
		});
		expect(blocksOf(back).some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
	});
});
