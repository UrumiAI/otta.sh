import { afterEach, describe, expect, test } from "vitest";
import { decodeCarrier } from "../src/admin/scaffold/carrier.js";
import { encodePath } from "../src/admin/scaffold/nav.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	buttons,
	contextTexts,
	field,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	openGroupIds,
	type LooseBlock,
} from "./helpers/blocks.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Tax console under the REAL workerd-on-Node sandbox (design spec
// §12.3, the density-overhaul layout): tax classes (list/create/rename-LWW/
// delete-forbid-if-in-use) drilling into a class's tax rates (list/create/
// edit-with-CAS/delete), which — only past L-9's 25-row bound — drills once
// more into a single rate's own detail. Per-row content lives inside a
// collapsed accordion (L-9); a level falls back to a table + `combobox`
// drill-in only when the fetched page is complete AND has more than 25 rows.

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

function bannerOf(blocks: readonly LooseBlock[]) {
	return findBlock(blocks, "banner") as
		| { variant?: string; title?: string; description?: string }
		| undefined;
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

/** Close whatever's currently running and boot a fresh sandbox against a new
 *  state — for a single test that exercises several distinct fixtures in a
 *  row (kept in its own function so the reset assignments don't chain into
 *  TypeScript narrowing oddities inside the calling test body). */
async function reboot(state: ReturnType<typeof makeRulesState>) {
	await sandbox?.close();
	await stub?.close();
	sandbox = undefined;
	stub = undefined;
	await boot(state);
}

/** Render the classes list. */
async function loadClasses(): Promise<LooseBlock[]> {
	return blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/tax" }));
}

/** Open a class's rates the way the per-row "View rates" button does — a
 *  `block_action` carrying the FULL target path in `value.target` (§12.7). */
async function openClass(classId: string): Promise<LooseBlock[]> {
	return blocksOf(
		await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:open",
			value: { target: encodePath([classId]) },
		}),
	);
}

/** Submit a form the way em-dash does: `values` PLUS the `block_id` the form
 *  carried, which is where every id and watermark now rides (F-2, B-1).
 *  Driving it any other way exercises a wire shape the renderer never sends. */
async function submitForm(
	blocks: readonly LooseBlock[],
	submitActionId: string,
	values: Record<string, unknown>,
): Promise<LooseBlock[]> {
	const form = formFor(blocks, submitActionId);
	expect(form, `no form submitting ${submitActionId}`).toBeDefined();
	return blocksOf(
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: submitActionId,
			values,
			block_id: form!.block_id,
		}),
	);
}

/** Click a button the way em-dash does: `action_id` + `value`, and NO
 *  `block_id` — a button echoes none (B-1). */
async function clickButton(actionId: string, value: unknown): Promise<LooseBlock[]> {
	return blocksOf(
		await sandbox!.invokeRoute("admin", { type: "block_action", action_id: actionId, value }),
	);
}

describe("admin Tax console — classes level (workerd sandbox)", () => {
	test("page_load /tax renders the classes list as per-row accordions, forwarding the kv-sourced admin token", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await loadClasses();
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
		const row = group(blocks, "tax:class:standard");
		expect(row?.label).toBe("standard — Standard");
		expect(row?.default_open).toBe(false);
		expect(findBlock(blocks, "table")).toBeUndefined(); // L-9 accordion branch at 1 row
		const listReq = stub!.requests.find((r) => r.url === "/admin/tax/classes");
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("NO-TOKEN page_load /tax fails closed with the E-7 normative banner (no raw HTTP status/URL)", async () => {
		const state = makeRulesState();
		await boot(state, "");
		const blocks = await loadClasses();
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toBe("Tax classes are unavailable");
		expect(String(banner?.description)).toContain("fault in the console itself");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/tax|401/);
	});

	test("create-class with blank fields is caught at the plugin boundary — no POST sent", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await loadClasses();
		const after = await submitForm(blocks, "tax:create-class", { id: "", name: "" });
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(after)?.variant).toBe("error");
	});

	test("create-class POSTs {id,name} with the admin token, then re-lists with a success notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await loadClasses();
		const after = await submitForm(blocks, "tax:create-class", {
			id: "reduced",
			name: "Reduced rate",
		});
		const post = stub!.requests.find((r) => r.method === "POST" && r.url === "/admin/tax/classes");
		expect(post).toBeDefined();
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(post!.body).toEqual({ id: "reduced", name: "Reduced rate" });

		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		// The re-rendered (root) list reflects the new class — a fresh GET, not a
		// locally-patched echo.
		expect(group(after, "tax:class:standard")).toBeDefined();
		expect(group(after, "tax:class:reduced")?.label).toBe("reduced — Reduced rate");
	});

	test("creating a class with a duplicate id fails with a GENERIC error notice (no raw status)", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await loadClasses();
		const after = await submitForm(blocks, "tax:create-class", {
			id: "standard",
			name: "Standard again",
		});
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		// Never applied — the list still shows exactly one "standard".
		expect(state.classes.filter((c) => c.id === "standard")).toHaveLength(1);
	});

	test("a class row offers a rename form, a View-rates drill-in, and a delete button — the id rides in the carrier, never a visible field (F-2/X-1)", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await loadClasses();
		const row = group(blocks, "tax:class:standard")!;
		const renameForm = formFor([row], "tax:save-class")!;
		expect(fieldIds(renameForm)).toEqual(["name"]);
		expect(decodeCarrier(renameForm.block_id as string)).toMatchObject({ classId: "standard" });

		const rowButtons = buttons([row]);
		const viewRates = rowButtons.find((b) => b.action_id === "tax:open");
		expect((viewRates?.value as { target?: string } | undefined)?.target).toBe(
			encodePath(["standard"]),
		);
		const del = rowButtons.find((b) => b.action_id === "tax:delete-class");
		expect(del?.style).toBe("danger");
		expect(del?.confirm).toBeDefined();
		expect((del?.value as { classId?: string } | undefined)?.classId).toBe("standard");
	});

	test("a class group orders its controls common-path-first and destructive-last, with a spacer between the edit and the delete", async () => {
		const state = makeRulesState();
		await boot(state);
		const body = groupBlocks(await loadClasses(), "tax:class:standard");
		// ORDER IS THE ONLY AFFORDANCE AVAILABLE. A `form` renders `flex flex-col`
		// in the pinned renderer, so nothing here can sit in a horizontal row with
		// the primary on the end; which control comes FIRST is the whole signal.
		expect(body.map((b) => String(b.type))).toEqual(["actions", "form", "context", "actions"]);
		expect(buttons([body[0]!])[0]?.action_id).toBe("tax:open"); // View rates leads
		expect((body[1]?.submit as { action_id?: unknown } | undefined)?.action_id).toBe(
			"tax:save-class",
		);
		// Block Kit has no spacer block and `divider` is off this console's
		// vocabulary, so the separation is a context line that also earns its
		// height — it states the refusal BEFORE the click, where the confirm
		// dialog's copy only appears after.
		expect(String(body[2]?.text)).toMatch(/blocked while any product or tax rate/i);
		const last = buttons([body[3]!])[0];
		expect(last?.action_id).toBe("tax:delete-class"); // destructive LAST
		expect(last?.style).toBe("danger");
	});

	test("save-class PUTs the rename (reading the id from the carrier) and reloads the classes list with a 'saved' notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const row = group(await loadClasses(), "tax:class:standard")!;
		const after = await submitForm([row], "tax:save-class", { name: "Standard rate" });
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put?.url).toBe("/admin/tax/classes/standard");
		expect(put?.body).toEqual({ name: "Standard rate" });
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		// Reloaded from a real GET, not a locally-patched echo.
		expect(group(after, "tax:class:standard")?.label).toBe("standard — Standard rate");
		expect(state.classes[0]?.name).toBe("Standard rate");
	});

	test("save-class with a blank name is caught at the plugin boundary — no PUT sent", async () => {
		const state = makeRulesState();
		await boot(state);
		const row = group(await loadClasses(), "tax:class:standard")!;
		const after = await submitForm([row], "tax:save-class", { name: "" });
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(bannerOf(after)?.variant).toBe("error");
	});

	test("delete-class DELETEs and reloads with a 'deleted' notice; a repeat delete is idempotent, never an error", async () => {
		const state = makeRulesState();
		state.classes.push({ id: "zero", name: "Zero-rated" });
		await boot(state);
		const first = await clickButton("tax:delete-class", { classId: "zero" });
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/tax/classes/zero");
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(group(first, "tax:class:zero")).toBeUndefined();

		const second = await clickButton("tax:delete-class", { classId: "zero" });
		const secondBanner = bannerOf(second);
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("delete-class refused while a RATE references it renders the HONEST count, never a bare refusal", async () => {
		const state = makeRulesState();
		await boot(state); // "standard" has 2 seeded rates (std-us, std-eu)
		const outcome = await clickButton("tax:delete-class", { classId: "standard" });
		const banner = bannerOf(outcome);
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
		const outcome = await clickButton("tax:delete-class", { classId: "reduced" });
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toContain("3 products");
		expect(state.classes.some((c) => c.id === "reduced")).toBe(true);
	});

	test("zero classes shows the empty illustration with a create action, forced open by ACTION_SHOW_NEW_CLASS (E-2/B-6), and X-18 holds", async () => {
		const state = makeRulesState();
		state.classes = [];
		await boot(state);
		const blocks = await loadClasses();
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No tax classes yet");
		const createBtn = (empty?.actions as Array<Record<string, unknown>> | undefined)?.[0];
		expect(createBtn?.action_id).toBe("tax:show-new-class");
		expect(findBlock(blocks, "table")).toBeUndefined();
		expect(group(blocks, "tax:new-class")?.default_open).toBe(false);

		const after = await clickButton("tax:show-new-class", createBtn?.value);
		const forced = group(after, "tax:new-class:opened");
		expect(forced?.default_open).toBe(true);
		expect(openGroupIds(after)).toEqual(["tax:new-class:opened"]); // X-18: at most one
	});

	test("25 classes still render the per-row accordion branch (L-9)", async () => {
		const state = makeRulesState();
		state.classes = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` }));
		await boot(state);
		const blocks = await loadClasses();
		expect(findBlock(blocks, "table")).toBeUndefined();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:class:"))
				.length,
		).toBe(25);
	});

	test("26 classes fall back to the table + combobox drill-in branch (L-9)", async () => {
		const state = makeRulesState();
		state.classes = Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` }));
		await boot(state);
		const blocks = await loadClasses();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:class:"))
				.length,
		).toBe(0);
		const table = findBlock(blocks, "table");
		expect(table).toBeDefined();
		expect((table!.rows as unknown[]).length).toBe(26);
		const openForm = formFor(blocks, "tax:open");
		expect(openForm).toBeDefined();
		const picker = field(openForm, "target");
		expect(picker?.type).toBe("combobox"); // R-17a/R-17b: never a select
	});

	test("opening a class from the fallback combobox drill-in opens its rates list (L-7, full path)", async () => {
		const state = makeRulesState();
		state.classes = Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` }));
		await boot(state);
		const blocks = await loadClasses();
		const openForm = formFor(blocks, "tax:open")!;
		const picker = field(openForm, "target")!;
		const options = picker.options as Array<{ value: string; label: string }>;
		expect(options[0]).toEqual({ value: "none", label: "Choose a tax class…" });
		const target = options.find((o) => o.label === "Class 5")!.value;
		const after = await submitForm(blocks, "tax:open", { target });
		expect(after.some((b) => b.type === "header" && b.text === "Tax rates — c5")).toBe(true);
	});
});

describe("admin Tax console — rates level (workerd sandbox)", () => {
	test("opening a class renders its rates as per-row accordions, fanned out across every zone by default (D-6 labels)", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await openClass("standard");
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		expect(buttons(blocks).some((e) => e.action_id === "tax:back")).toBe(true);
		expect(findBlock(blocks, "table")).toBeUndefined(); // L-9 accordion branch at 2 rows

		// Fanned out: a zones read, then one rates read per zone.
		expect(stub!.requests.some((r) => r.url === "/admin/shipping/zones")).toBe(true);
		expect(stub!.requests.some((r) => r.url === "/admin/tax/rates?zoneId=us")).toBe(true);
		expect(stub!.requests.some((r) => r.url === "/admin/tax/rates?zoneId=eu")).toBe(true);

		// THE RATE LEADS THE LABEL. It used to trail a slug of varying length, so
		// no two rows started their number at the same x and 7.25 / 20.00 could
		// not be compared down the column — the one comparison this level exists
		// for. The slug keeps its place IN FULL (a natural key, not a uuid).
		expect(group(blocks, "tax:rate:std-us")?.label).toBe(
			"7.25% — United States · std-us · goods only",
		);
		expect(group(blocks, "tax:rate:std-eu")?.label).toBe(
			"20.00% — Europe · std-eu · also shipping",
		);
	});

	test("a rate label's leading token is a PERCENT, not money — no currency symbol or code anywhere in it", async () => {
		const state = makeRulesState();
		await boot(state);
		const labels = findBlocks(await openClass("standard"), "accordion")
			.filter((a) => String(a.block_id).startsWith("tax:rate:"))
			.map((a) => String(a.label));
		expect(labels).toHaveLength(2);
		for (const label of labels) {
			expect(label).toMatch(/^\d+\.\d{2}% — /);
			expect(label).not.toMatch(/[$€£¥]|USD|EUR/);
		}
	});

	test("the Zone filter is a non-blank select seeded from the zones read this level already performs (D-6, F-6a)", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await openClass("standard");
		const filterForm = formFor(blocks, "tax:apply-filter")!;
		const zoneField = field(filterForm, "zoneId")!;
		expect(zoneField.type).toBe("select");
		expect(zoneField.initial_value).toBe("any");
		const options = zoneField.options as Array<{ value: string; label: string }>;
		expect(options.map((o) => o.value)).toEqual(["any", "us", "eu"]);
		expect(options.every((o) => o.value !== "")).toBe(true); // F-6a: no "" option
	});

	test("filtering by a zone scopes the rates read to ONE (plus the always-on zones read) and excludes other zones", async () => {
		const state = makeRulesState();
		await boot(state);
		const opened = await openClass("standard");
		stub!.requests.length = 0;
		const filtered = await submitForm(opened, "tax:apply-filter", { zoneId: "us" });
		expect(stub!.requests.some((r) => r.url === "/admin/shipping/zones")).toBe(true);
		expect(stub!.requests.filter((r) => r.url.startsWith("/admin/tax/rates"))).toHaveLength(1);
		expect(stub!.requests.find((r) => r.url.startsWith("/admin/tax/rates"))?.url).toBe(
			"/admin/tax/rates?zoneId=us",
		);
		expect(group(filtered, "tax:rate:std-us")).toBeDefined();
		expect(group(filtered, "tax:rate:std-eu")).toBeUndefined();

		const section = findBlock(filtered, "section");
		expect(section?.text).toBe("zone: us");
		expect((section?.accessory as { label?: string } | undefined)?.label).toBe("Clear filters");
	});

	test("clearing the filter re-lists every zone's rates for the class (L-6)", async () => {
		const state = makeRulesState();
		await boot(state);
		const opened = await openClass("standard");
		const filtered = await submitForm(opened, "tax:apply-filter", { zoneId: "us" });
		const section = findBlock(filtered, "section")!;
		const clearValue = (section.accessory as { value?: unknown } | undefined)?.value;
		const cleared = await clickButton("tax:apply-filter", clearValue);
		expect(group(cleared, "tax:rate:std-us")).toBeDefined();
		expect(group(cleared, "tax:rate:std-eu")).toBeDefined();
		expect(findBlock(cleared, "section")).toBeUndefined();
	});

	test("a class with no rates yet (unfiltered) shows the empty illustration, forced open by ACTION_SHOW_NEW_RATE (E-2/B-6)", async () => {
		const state = makeRulesState();
		state.classes.push({ id: "zero", name: "Zero-rated" });
		await boot(state);
		const blocks = await openClass("zero");
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — zero")).toBe(true);
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No tax rates yet");
		const createBtn = (empty?.actions as Array<Record<string, unknown>> | undefined)?.[0];
		expect(createBtn?.action_id).toBe("tax:show-new-rate");
		expect(createBtn?.value).toMatchObject({ __path: encodePath(["zero"]) });

		const after = await clickButton("tax:show-new-rate", createBtn?.value);
		const forced = group(after, "tax:new-rate:zero:opened");
		expect(forced?.default_open).toBe(true);
		expect(openGroupIds(after)).toEqual(["tax:new-rate:zero:opened"]);
	});

	test('filtering to a zone with no rates for this class shows a plain context line, never the empty illustration (E-1/E-2 "never for a filtered-to-zero list")', async () => {
		const state = makeRulesState();
		state.zones.push({ id: "jp", name: "Japan", regions: ["JP"] });
		await boot(state);
		const opened = await openClass("standard");
		const filtered = await submitForm(opened, "tax:apply-filter", { zoneId: "jp" });
		expect(findBlock(filtered, "empty")).toBeUndefined();
		expect(contextTexts(filtered).some((t) => /no tax rates for zone "jp"/i.test(t))).toBe(true);
	});

	test("create-rate POSTs the percent parsed to EXACT integer bps (real boolean toggle), then reloads the class's rates with a success notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const opened = await openClass("standard");
		const after = await submitForm(opened, "tax:create-rate", {
			id: "std-us-b",
			zoneId: "us",
			ratePercent: "20",
			appliesToShipping: true,
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
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		expect(after.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		expect(group(after, "tax:rate:std-us-b")).toBeDefined();
	});

	test("a malformed rate percent is caught at the plugin boundary — no POST is sent", async () => {
		const state = makeRulesState();
		await boot(state);
		const opened = await openClass("standard");
		const after = await submitForm(opened, "tax:create-rate", {
			id: "bad",
			zoneId: "us",
			ratePercent: "7.255",
			appliesToShipping: false,
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(after)?.variant).toBe("error");
	});

	test("a rate row carries a per-row edit form (CAS) prefilled from the loaded rate — ids and watermark in the carrier, never a visible field (F-2/X-1)", async () => {
		const state = makeRulesState();
		await boot(state);
		const blocks = await openClass("standard");
		const row = group(blocks, "tax:rate:std-us")!;
		const form = formFor([row], "tax:save-rate")!;
		expect(fieldIds(form)).toEqual(["ratePercent", "appliesToShipping"]);
		expect(decodeCarrier(form.block_id as string)).toMatchObject({
			classId: "standard",
			rateId: "std-us",
			expectedRateBps: "725",
		});
		expect(field(form, "ratePercent")?.type).toBe("text_input"); // never number_input
		expect(field(form, "ratePercent")?.initial_value).toBe("7.25");
		expect(field(form, "appliesToShipping")?.type).toBe("toggle");
		expect(field(form, "appliesToShipping")?.initial_value).toBe(false); // F-6b/X-24: REQUIRED
	});

	test("save-rate PUTs the CAS edit (reading ids from the carrier) and reloads with a 'saved' notice", async () => {
		const state = makeRulesState();
		await boot(state);
		const row = group(await openClass("standard"), "tax:rate:std-us")!;
		const after = await submitForm([row], "tax:save-rate", {
			ratePercent: "8.25",
			appliesToShipping: true,
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put).toBeDefined();
		expect(put!.url).toBe("/admin/tax/rates/std-us");
		expect(put!.body).toEqual({ rateBps: 825, appliesToShipping: true, expectedRateBps: 725 });
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		expect(state.rates.find((r) => r.id === "std-us")?.rateBps).toBe(825);
	});

	test("a concurrent-edit conflict (409 STALE) is caught via the carrier's own watermark — reloads the fresh rate with a re-apply warning, never a clobber", async () => {
		const state = makeRulesState();
		await boot(state);
		const opened = await openClass("standard");
		const row = group(opened, "tax:rate:std-us")!;
		const form = formFor([row], "tax:save-rate")!;
		// Simulate the record having moved since THIS render loaded it (the
		// carrier this form carries still says 725) — someone else's edit lands
		// in between, exactly the race the watermark exists to catch (DA-2a).
		state.rates.find((r) => r.id === "std-us")!.rateBps = 900;
		const after = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:save-rate",
			values: { ratePercent: "9.00", appliesToShipping: false },
			block_id: form.block_id,
		});
		const blocks = blocksOf(after);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/changed since you loaded it|reload/i);
		// The submitted edit was NOT applied — the concurrent 900 stands.
		expect(state.rates.find((r) => r.id === "std-us")?.rateBps).toBe(900);
		// The re-render shows the FRESH (server) value, from a real reload GET —
		// never the stale 725 the carrier was minted against, and never a blind
		// clobber to 900 either.
		expect(group(blocks, "tax:rate:std-us")?.label).toBe(
			"9.00% — United States · std-us · goods only",
		);
	});

	test("delete-rate DELETEs and reloads with a 'deleted' notice; a repeat delete is an idempotent 'already deleted' notice, never an error", async () => {
		const state = makeRulesState();
		await boot(state);
		const first = await clickButton("tax:delete-rate", { classId: "standard", rateId: "std-us" });
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/tax/rates/std-us");
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(group(first, "tax:rate:std-us")).toBeUndefined();

		const second = await clickButton("tax:delete-rate", { classId: "standard", rateId: "std-us" });
		const secondBanner = bannerOf(second);
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("back from the rates level returns to the tax classes list", async () => {
		const state = makeRulesState();
		await boot(state);
		const rates = await openClass("standard");
		const backButtonValue = buttons(rates).find((e) => e.action_id === "tax:back")?.value as
			| Record<string, string>
			| undefined;
		expect(backButtonValue).toBeDefined();
		const back = await clickButton("tax:back", backButtonValue);
		expect(back.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
	});

	test("25 rates for a class still render the per-row accordion branch (L-9)", async () => {
		const state = makeRulesState();
		state.rates = Array.from({ length: 25 }, (_, i) => ({
			id: `r${i}`,
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 100 + i,
			appliesToShipping: false,
		}));
		await boot(state);
		const blocks = await openClass("standard");
		expect(findBlock(blocks, "table")).toBeUndefined();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:rate:"))
				.length,
		).toBe(25);
	});

	test("26 rates for a class fall back to the table + combobox drill-in branch (L-9), and Applies-to-shipping is plain text, never a badge (T-5/X-4)", async () => {
		const state = makeRulesState();
		state.rates = Array.from({ length: 26 }, (_, i) => ({
			id: `r${i}`,
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 100 + i,
			appliesToShipping: i % 2 === 0,
		}));
		await boot(state);
		const blocks = await openClass("standard");
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:rate:"))
				.length,
		).toBe(0);
		const table = findBlock(blocks, "table")!;
		expect(table).toBeDefined();
		expect((table.rows as unknown[]).length).toBe(26);
		const columns = table.columns as Array<{ key: string; format?: string }>;
		const appliesCol = columns.find((c) => c.key === "appliesToShipping");
		expect(appliesCol?.format).not.toBe("badge");
		const openForm = formFor(blocks, "tax:open")!;
		expect(field(openForm, "target")?.type).toBe("combobox");
	});

	test("opening a rate from the fallback combobox drill-in reaches its own detail leaf (§12.7 full path, depth 2)", async () => {
		const state = makeRulesState();
		state.rates = Array.from({ length: 26 }, (_, i) => ({
			id: `r${i}`,
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 100 + i,
			appliesToShipping: false,
		}));
		await boot(state);
		const blocks = await openClass("standard");
		const openForm = formFor(blocks, "tax:open")!;
		const picker = field(openForm, "target")!;
		const options = picker.options as Array<{ value: string; label: string }>;
		expect(options[0]).toEqual({ value: "none", label: "Choose a tax rate…" });
		// The picker options lead with the rate too — it is what the operator is
		// choosing between — and still never carry the id (M-7/X-22).
		expect(options.slice(1).every((o) => /^\d+\.\d{2}% · /.test(o.label))).toBe(true);
		expect(options.some((o) => o.label.includes("r5"))).toBe(false);
		const target = options.find((o) => o.label.endsWith("United States"))!.value;
		const after = await submitForm(blocks, "tax:open", { target });
		expect(
			after.some((b) => b.type === "header" && String(b.text).startsWith("Tax rate — r")),
		).toBe(true);
		const form = formFor(after, "tax:save-rate")!;
		expect(decodeCarrier(form.block_id as string)).toMatchObject({ classId: "standard" });
	});

	test("a rate's own detail leaf edits and deletes exactly like the accordion body, and its back button returns to the rates list", async () => {
		const state = makeRulesState();
		state.rates = Array.from({ length: 26 }, (_, i) => ({
			id: `r${i}`,
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 100 + i,
			appliesToShipping: false,
		}));
		await boot(state);
		const detail = await submitForm(await openClass("standard"), "tax:open", {
			target: encodePath(["standard", "r5"]),
		});
		expect(detail.some((b) => b.type === "header" && b.text === "Tax rate — r5")).toBe(true);
		const backValue = buttons(detail).find((e) => e.action_id === "tax:back")?.value;
		expect(backValue).toBeDefined();

		const saved = await submitForm(detail, "tax:save-rate", {
			ratePercent: "9.00",
			appliesToShipping: true,
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put?.url).toBe("/admin/tax/rates/r5");
		expect(bannerOf(saved)?.variant).toBe("default");

		const deleted = await clickButton("tax:delete-rate", { classId: "standard", rateId: "r5" });
		expect(stub!.requests.find((r) => r.method === "DELETE")?.url).toBe("/admin/tax/rates/r5");
		expect(bannerOf(deleted)?.variant).toBe("default");

		const back = await clickButton("tax:back", backValue);
		expect(back.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
	});

	test("a rate detail leaf for an id that no longer resolves renders notFound, never a blank page", async () => {
		const state = makeRulesState();
		await boot(state);
		// Driven as a bare block_action (matching a button/combobox click) rather
		// than through the accordion branch's row list, which offers no direct
		// per-rate "open" control of its own — the leaf is reachable at any row
		// count via a fully-encoded target path.
		const after = await clickButton("tax:open", { target: encodePath(["standard", "nope"]) });
		expect(after.some((b) => b.type === "header" && b.text === "Tax rate not found")).toBe(true);
		expect(bannerOf(after)?.variant).toBe("error");
	});
});

describe("admin Tax console — assertBlockContract (§15 V-3)", () => {
	// Every H-marked §13 row this helper enforces, on every distinct render
	// shape this screen produces: both L-9 branches (accordion at ≤25 rows,
	// table+combobox past it) on both list levels, both levels' zero-row empty
	// states, a filtered rates render, and the rate-detail leaf. `level: "list"`
	// throughout, including for the rate-detail leaf — Tax has no TABBED detail
	// screen (§4: "every level is a list"), and this leaf carries no `tab`/D-2
	// panel set of its own; it is a single-record page, not a §4-shaped detail
	// screen, so `checkX16`'s D-2 comparison (which has no entry for "tax" and
	// deliberately refuses `level:"detail"` for a screen absent from it) does
	// not apply. See the PR body's disclosure section.
	test("assertBlockContract holds on every rendered shape this screen produces", async () => {
		const small = makeRulesState();
		await boot(small);
		assertBlockContract(await loadClasses(), { screen: "tax", level: "list" });
		assertBlockContract(await openClass("standard"), { screen: "tax", level: "list" });
		const filtered = await submitForm(await openClass("standard"), "tax:apply-filter", {
			zoneId: "us",
		});
		assertBlockContract(filtered, { screen: "tax", level: "list" });
		assertBlockContract(
			await clickButton("tax:open", { target: encodePath(["standard", "std-us"]) }),
			{ screen: "tax", level: "list" },
		);

		const zero = makeRulesState();
		zero.classes = [];
		await reboot(zero);
		assertBlockContract(await loadClasses(), { screen: "tax", level: "list" });

		const zeroRates = makeRulesState();
		zeroRates.classes.push({ id: "zero", name: "Zero-rated" });
		await reboot(zeroRates);
		assertBlockContract(await openClass("zero"), { screen: "tax", level: "list" });

		const big = makeRulesState();
		big.classes = Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` }));
		big.rates = Array.from({ length: 26 }, (_, i) => ({
			id: `r${i}`,
			taxClassId: "c0",
			zoneId: "us",
			rateBps: 100 + i,
			appliesToShipping: i % 2 === 0,
		}));
		await reboot(big);
		assertBlockContract(await loadClasses(), { screen: "tax", level: "list" });
		assertBlockContract(await openClass("c0"), { screen: "tax", level: "list" });
	});
});
