import { afterEach, describe, expect, test } from "vitest";
import { decodeCarrier } from "../src/admin/scaffold/carrier.js";
import { decodePath, encodePath } from "../src/admin/scaffold/index.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	buttons,
	confirmOf,
	contextTexts,
	emptyActions,
	field,
	fieldEntries,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	openGroupIds,
	tableRows,
	valueOf,
	type LooseBlock,
	type LooseElement,
} from "./helpers/blocks.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Shipping console under the REAL workerd-on-Node sandbox (design
// spec §12.4 — the deepest of the seven admin screens). Zones and methods
// render as a per-row `accordion` list (L-9) when the fetched page is
// complete and small (<=25 rows); otherwise a `table` + a standalone
// `combobox` drill-in (L-7 fallback). Rates is EXEMPT (L-9a) and keeps its
// existing `fields`-based 0-or-1-row lookup. This suite drives all three
// levels, both L-9 branches (asserted at 25 and 26 rows), the zero-row
// `empty` state (E-2) with its force-open create action (B-6), and a
// depth-3 open fired from a row BUTTON (§12.7) — never a bare id.

interface ZoneRow {
	id: string;
	name: string;
	regions: unknown;
}
interface MethodRow {
	id: string;
	zoneId: string;
	name: string;
	type: string;
}
interface RateRow {
	methodId: string;
	currency: string;
	amountCents: number;
	minSubtotalCents: number | null;
}

interface ShippingState {
	zones: ZoneRow[];
	methods: MethodRow[];
	rates: RateRow[];
	/** Make every rate READ answer 500. The methods level's per-row price is a
	 *  SECONDARY read, so this must degrade the affected rows to "Price
	 *  unavailable" and never fail the level (nor claim "No rate set", which is
	 *  a fact this state cannot establish). */
	rateReadsFail?: boolean;
}

/** A small stateful stub standing in for the shipping-admin HTTP surface —
 *  zones/methods/rates are mutated by POST/PUT/DELETE and read back by GET,
 *  so create→list, edit→reload, and delete→idempotent-replay all exercise
 *  real state transitions (not canned fixtures). */
function makeShippingState(): ShippingState {
	const zones: ZoneRow[] = [
		{ id: "us", name: "United States", regions: ["US"] },
		{ id: "empty", name: "Empty zone", regions: null },
	];
	const methods: MethodRow[] = [
		{ id: "standard", zoneId: "us", name: "Standard", type: "flat_rate" },
		{ id: "bare", zoneId: "us", name: "No rates yet", type: "flat_rate" },
	];
	const rates: RateRow[] = [
		{ methodId: "standard", currency: "USD", amountCents: 499, minSubtotalCents: 3500 },
	];
	return { zones, methods, rates };
}

/** L-9's branch boundary is asserted at exactly 25 and 26 rows — an all-zones
 *  state with no methods/rates, so the branch decision is isolated to row
 *  count alone. */
function makeManyZonesState(count: number): ShippingState {
	const zones: ZoneRow[] = Array.from({ length: count }, (_, i) => ({
		id: `z${i}`,
		name: `Zone ${i}`,
		regions: null,
	}));
	return { zones, methods: [], rates: [] };
}

function makeManyMethodsState(count: number): ShippingState {
	const zones: ZoneRow[] = [{ id: "us", name: "United States", regions: null }];
	// Alternate type so the `Type` badge column genuinely chunks two values
	// apart (T-5/X-4) — a fixture where every row is the same value is not a
	// realistic method registry and trips the constant-badge-column check for
	// the wrong reason.
	const methods: MethodRow[] = Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		zoneId: "us",
		name: `Method ${i}`,
		type: i % 2 === 0 ? "flat_rate" : "free_shipping",
	}));
	return { zones, methods, rates: [] };
}

function attachShippingStub(stub: StubCommerceServer, state: ShippingState) {
	stub.respondWith("GET", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const [path, query = ""] = req.url.split("?");
		if (path === "/admin/shipping/zones") {
			return { status: 200, body: { ok: true, zones: state.zones } };
		}
		const methodsMatch = /^\/admin\/shipping\/zones\/([^/]+)\/methods$/.exec(path ?? "");
		if (methodsMatch !== null) {
			const zoneId = decodeURIComponent(methodsMatch[1] ?? "");
			return {
				status: 200,
				body: { ok: true, methods: state.methods.filter((m) => m.zoneId === zoneId) },
			};
		}
		const rateMatch = /^\/admin\/shipping\/methods\/([^/]+)\/rates$/.exec(path ?? "");
		if (rateMatch !== null) {
			if (state.rateReadsFail === true) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			const methodId = decodeURIComponent(rateMatch[1] ?? "");
			const currency = new URLSearchParams(query).get("currency");
			if (currency === null) return { status: 400, body: { error: "currency query is required" } };
			const rate = state.rates.find((r) => r.methodId === methodId && r.currency === currency);
			if (rate === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			return { status: 200, body: { ok: true, rate } };
		}
		return { status: 404, body: { error: "unknown" } };
	});

	stub.respondWith("POST", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		if (req.url === "/admin/shipping/zones") {
			const body = req.body as { id: string; name: string; regions?: unknown };
			if (state.zones.some((z) => z.id === body.id)) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			const created: ZoneRow = { id: body.id, name: body.name, regions: body.regions ?? null };
			state.zones.push(created);
			return { status: 201, body: { ok: true, zone: created } };
		}
		const methodsMatch = /^\/admin\/shipping\/zones\/([^/]+)\/methods$/.exec(req.url);
		if (methodsMatch !== null) {
			const zoneId = decodeURIComponent(methodsMatch[1] ?? "");
			const body = req.body as { id: string; name: string; type: string };
			if (state.methods.some((m) => m.id === body.id)) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			const created: MethodRow = { id: body.id, zoneId, name: body.name, type: body.type };
			state.methods.push(created);
			return { status: 201, body: { ok: true, method: created } };
		}
		const rateMatch = /^\/admin\/shipping\/methods\/([^/]+)\/rates$/.exec(req.url);
		if (rateMatch !== null) {
			const methodId = decodeURIComponent(rateMatch[1] ?? "");
			const body = req.body as {
				currency: string;
				amountCents: number;
				minSubtotalCents?: number | null;
			};
			if (state.rates.some((r) => r.methodId === methodId && r.currency === body.currency)) {
				return { status: 500, body: { ok: false, error: "internal_error" } };
			}
			const created: RateRow = {
				methodId,
				currency: body.currency,
				amountCents: body.amountCents,
				minSubtotalCents: body.minSubtotalCents ?? null,
			};
			state.rates.push(created);
			return { status: 201, body: { ok: true, rate: created } };
		}
		return { status: 404, body: { error: "unknown" } };
	});

	stub.respondWith("PUT", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const zoneMatch = /^\/admin\/shipping\/zones\/([^/]+)$/.exec(req.url);
		if (zoneMatch !== null) {
			const zoneId = decodeURIComponent(zoneMatch[1] ?? "");
			const zone = state.zones.find((z) => z.id === zoneId);
			if (zone === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			const body = req.body as { name: string; regions: unknown };
			zone.name = body.name;
			zone.regions = body.regions;
			return { status: 200, body: { ok: true, zone } };
		}
		const methodMatch = /^\/admin\/shipping\/methods\/([^/]+)$/.exec(req.url);
		if (methodMatch !== null) {
			const methodId = decodeURIComponent(methodMatch[1] ?? "");
			const method = state.methods.find((m) => m.id === methodId);
			if (method === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			const body = req.body as { name: string; type: string };
			method.name = body.name;
			method.type = body.type;
			return { status: 200, body: { ok: true, method } };
		}
		const rateMatch = /^\/admin\/shipping\/methods\/([^/]+)\/rates\/([^/]+)$/.exec(req.url);
		if (rateMatch !== null) {
			const methodId = decodeURIComponent(rateMatch[1] ?? "");
			const currency = decodeURIComponent(rateMatch[2] ?? "");
			const rate = state.rates.find((r) => r.methodId === methodId && r.currency === currency);
			if (rate === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			const body = req.body as {
				amountCents: number;
				minSubtotalCents: number | null;
				expectedAmountCents: number;
			};
			if (rate.amountCents !== body.expectedAmountCents) {
				return { status: 409, body: { ok: false, reason: "STALE", current: rate } };
			}
			rate.amountCents = body.amountCents;
			rate.minSubtotalCents = body.minSubtotalCents;
			return { status: 200, body: { ok: true, rate } };
		}
		return { status: 404, body: { error: "unknown" } };
	});

	stub.respondWith("DELETE", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const zoneMatch = /^\/admin\/shipping\/zones\/([^/]+)$/.exec(req.url);
		if (zoneMatch !== null) {
			const zoneId = decodeURIComponent(zoneMatch[1] ?? "");
			const idx = state.zones.findIndex((z) => z.id === zoneId);
			if (idx === -1) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			if (state.methods.some((m) => m.zoneId === zoneId)) {
				return { status: 409, body: { ok: false, reason: "IN_USE_BY_METHODS" } };
			}
			state.zones.splice(idx, 1);
			return { status: 200, body: { ok: true } };
		}
		const methodMatch = /^\/admin\/shipping\/methods\/([^/]+)$/.exec(req.url);
		if (methodMatch !== null) {
			const methodId = decodeURIComponent(methodMatch[1] ?? "");
			const idx = state.methods.findIndex((m) => m.id === methodId);
			if (idx === -1) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			if (state.rates.some((r) => r.methodId === methodId)) {
				return { status: 409, body: { ok: false, reason: "IN_USE_BY_RATES" } };
			}
			state.methods.splice(idx, 1);
			return { status: 200, body: { ok: true } };
		}
		const rateMatch = /^\/admin\/shipping\/methods\/([^/]+)\/rates\/([^/]+)$/.exec(req.url);
		if (rateMatch !== null) {
			const methodId = decodeURIComponent(rateMatch[1] ?? "");
			const currency = decodeURIComponent(rateMatch[2] ?? "");
			const idx = state.rates.findIndex((r) => r.methodId === methodId && r.currency === currency);
			if (idx === -1) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
			state.rates.splice(idx, 1);
			return { status: 200, body: { ok: true } };
		}
		return { status: 404, body: { error: "unknown" } };
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

function bannerOf(blocks: LooseBlock[]): LooseElement | undefined {
	return findBlock(blocks, "banner");
}

/** A form's carried context, with `carriedForm`'s `__v` prefill digest
 *  stripped — every prefilling form carries one (B-3a) and it is not part of
 *  the screen's own context (it exists only to move the React key). */
function carriedContext(blockId: unknown): Record<string, string> | undefined {
	const decoded = decodeCarrier(blockId as string | undefined);
	if (decoded === undefined) return undefined;
	const { __v: _digest, ...rest } = decoded;
	return rest;
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

async function boot(state: ShippingState, token = "admin-token-xyz") {
	stub = await startStubCommerceServer();
	attachShippingStub(stub, state);
	sandbox = await loadPluginInSandbox({
		allowedHosts: [stub.host],
		commerceServiceBaseUrl: stub.baseUrl,
	});
	if (token.length > 0) await seedToken(sandbox, stub, token);
}

describe("admin Shipping console — zones level, accordion branch (workerd sandbox)", () => {
	test("page_load /shipping renders one per-row accordion per zone, all collapsed (L-9)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(true);
		expect(findBlocks(blocks, "divider")).toHaveLength(0); // R-4/X-6

		const usGroup = group(blocks, "ship:zone:us");
		expect(usGroup?.label).toBe("us — United States");
		const emptyGroup = group(blocks, "ship:zone:empty");
		expect(emptyGroup?.label).toBe("empty — Empty zone");
		// L-9: every per-row accordion (and the create accordion) is collapsed —
		// a registry level renders with ZERO open groups.
		expect(openGroupIds(blocks)).toHaveLength(0);

		const listReq = stub!.requests.find((r) => r.url === "/admin/shipping/zones");
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("a zone's regions render honestly in the row's edit form (array joins, null renders blank)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		const usForm = formFor(groupBlocks(blocks, "ship:zone:us"), "shipping:save-zone");
		expect(field(usForm, "regions")?.initial_value).toBe("US");
		const emptyForm = formFor(groupBlocks(blocks, "ship:zone:empty"), "shipping:save-zone");
		expect(field(emptyForm, "regions")?.initial_value).toBe("");
	});

	test("NO-TOKEN page_load /shipping fails closed with E-7's normative copy (no raw HTTP status/URL, no single-cause claim)", async () => {
		const state = makeShippingState();
		await boot(state, "");
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/shipping|401/);
		// X-42: not a single-cause claim — names the two checks AND the console-bug possibility.
		expect(String(banner?.description)).toContain("admin token in Settings");
		expect(String(banner?.description)).toContain("fault in the console itself");
		expect(String(banner?.description).length).toBeLessThanOrEqual(240);
	});

	test("the row edit form's block_id carries the zoneId invisibly — no visible carrier field, no id in the field label", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		const usForm = formFor(groupBlocks(blocks, "ship:zone:us"), "shipping:save-zone");
		expect(fieldIds(usForm)).toEqual(["name", "regions"]); // no "zoneId" field (F-2, F-3)
		expect(String(field(usForm, "name")?.label)).toBe("Name"); // no id in the label (M-7)
		const carried = decodeCarrier(usForm?.block_id as string | undefined);
		expect(carried?.zoneId).toBe("us");
	});

	test("save-zone PUTs the full-replace edit (reading the carried zoneId, not a visible field) and reloads with a 'saved' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const usForm = formFor(groupBlocks(blocksOf(opened), "ship:zone:us"), "shipping:save-zone");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-zone",
			block_id: usForm?.block_id,
			values: { name: "USA", regions: "US, PR" },
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/shipping/zones/us");
		expect(put!.body).toEqual({ name: "USA", regions: ["US", "PR"] });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		expect(state.zones.find((z) => z.id === "us")?.name).toBe("USA");
	});

	test("the row's 'View methods' button carries the FULL target path in value.target, never a bare id (§12.7)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		const rowButtons = buttons(groupBlocks(blocks, "ship:zone:us"));
		const view = rowButtons.find((b) => b.action_id === "shipping:open");
		expect(view?.label).toBe("View methods");
		const target = valueOf(view).target;
		expect(decodePath(String(target))).toEqual(["us"]);
	});

	test("opening a zone via the row BUTTON drills to its methods (button carries no block_id — only value)", async () => {
		const state = makeShippingState();
		await boot(state);
		const zones = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const view = buttons(groupBlocks(blocksOf(zones), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:open",
		);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:open",
			value: valueOf(view),
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
	});

	test("deleting a zone is unconditional (DA-2) — a forbid-if-methods conflict is reported by the post-attempt banner", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const del = buttons(groupBlocks(blocksOf(outcome), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:delete-zone",
		);
		expect(del?.label).toBe("Delete zone"); // no id in the button label (M-7)
		expect(del?.style).toBe("danger");
		expect(confirmOf(del).style).toBe("danger");
		const result = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: valueOf(del),
		});
		const banner = bannerOf(blocksOf(result));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/shipping methods/i);
		expect(state.zones.some((z) => z.id === "us")).toBe(true); // never deleted
	});

	test("deleting a zone with no methods DELETEs and reloads with a 'deleted' notice; a repeat delete is idempotent", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const del = buttons(groupBlocks(blocksOf(outcome), "ship:zone:empty")).find(
			(b) => b.action_id === "shipping:delete-zone",
		);
		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: valueOf(del),
		});
		const delReq = stub!.requests.find((r) => r.method === "DELETE");
		expect(delReq?.url).toBe("/admin/shipping/zones/empty");
		const firstBanner = bannerOf(blocksOf(first));
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(group(blocksOf(first), "ship:zone:empty")).toBeUndefined();

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: valueOf(del),
		});
		const secondBanner = bannerOf(blocksOf(second));
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("create-zone with blank fields is caught at the plugin boundary — no POST sent", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-zone",
			values: { id: "", name: "", regions: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("create-zone POSTs {id,name,regions} parsed to a string array, then re-lists with a success notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-zone",
			values: { id: "eu", name: "Europe", regions: " EU , FR " },
		});
		const post = stub!.requests.find(
			(r) => r.method === "POST" && r.url === "/admin/shipping/zones",
		);
		expect(post).toBeDefined();
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(post!.body).toEqual({ id: "eu", name: "Europe", regions: ["EU", "FR"] });

		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		expect(group(blocks, "ship:zone:eu")).toBeDefined();
	});

	test("a blank regions input creates a zone with regions=null (an explicit 'none', not a garbled string)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-zone",
			values: { id: "anywhere", name: "Anywhere", regions: "" },
		});
		const post = stub!.requests.find(
			(r) => r.method === "POST" && r.url === "/admin/shipping/zones",
		);
		expect(post!.body).toEqual({ id: "anywhere", name: "Anywhere", regions: null });
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("default");
	});

	test("creating a zone with a duplicate id fails with a GENERIC error notice (no raw status)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-zone",
			values: { id: "us", name: "United States again", regions: "" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		expect(state.zones.filter((z) => z.id === "us")).toHaveLength(1);
	});

	test("the 'New zone' create group is closed by default and carries an F-8 line about regions, not the page context", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		const newZone = group(blocks, "ship:new-zone");
		expect(newZone).toBeDefined();
		expect(newZone?.default_open).not.toBe(true);
		const bodyContexts = findBlocks(groupBlocks(blocks, "ship:new-zone"), "context").map((c) =>
			String(c.text),
		);
		expect(bodyContexts.some((t) => /auto-match/i.test(t))).toBe(true);
		// The page-level context stays terse (≤140) and says nothing about regions.
		const pageContext = String(findBlocks(blocks, "context")[0]?.text);
		expect(pageContext.length).toBeLessThanOrEqual(140);
		expect(pageContext).not.toMatch(/auto-match/i);
	});
});

describe("admin Shipping console — zones level, zero-row empty state (E-2/B-6)", () => {
	test("zero zones renders the `empty` block (not the row list) with a create action in empty.actions", async () => {
		const state = { zones: [] as ZoneRow[], methods: [] as MethodRow[], rates: [] as RateRow[] };
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		expect(
			findBlocks(blocks, "accordion").some((a) => String(a.block_id).startsWith("ship:zone:")),
		).toBe(false);
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No shipping zones yet");
		const action = emptyActions(blocks)[0];
		expect(action?.action_id).toBe("shipping:open-create-zone");
	});

	test("clicking the empty state's create action re-renders with the 'New zone' group FORCED OPEN (B-6: changed block_id AND default_open:true)", async () => {
		const state = { zones: [] as ZoneRow[], methods: [] as MethodRow[], rates: [] as RateRow[] };
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const action = emptyActions(blocksOf(opened))[0];
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:open-create-zone",
			value: valueOf(action),
		});
		const blocks = blocksOf(outcome);
		// X-18: at most one default_open:true in the emitted response.
		expect(openGroupIds(blocks)).toEqual(["ship:new-zone:open"]);
		expect(group(blocks, "ship:new-zone:open")?.label).toBe("New zone");
	});
});

describe("admin Shipping console — zones level, L-9 fallback branch (>25 rows)", () => {
	test("at 25 zones (a complete page), the ACCORDION branch renders — no table, no L-7 drill-in", async () => {
		const state = makeManyZonesState(25);
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		expect(findBlocks(blocks, "table")).toHaveLength(0);
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("ship:zone:")),
		).toHaveLength(25);
	});

	test("at 26 zones, the TABLE + combobox drill-in branch renders instead — no per-row accordions", async () => {
		const state = makeManyZonesState(26);
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("ship:zone:")),
		).toHaveLength(0);
		const table = findBlock(blocks, "table");
		expect(table).toBeDefined();
		expect(tableRows(blocks)).toHaveLength(26);
		expect(String(table?.empty_text).length).toBeGreaterThan(0); // T-7/L-9b
		expect(table?.page_action_id).toBe("shipping:page"); // R-21/T-6

		// L-7: always a combobox, option value is the encoded path, label never
		// contains the id (X-22, M-7).
		const openForm = formFor(blocks, "shipping:open");
		const targetField = field(openForm, "target");
		expect(targetField?.type).toBe("combobox");
		const options = targetField?.options as Array<{ value: string; label: string }>;
		expect(options.every((o) => o.value !== "")).toBe(true); // F-6a/X-23
		expect(options.some((o) => o.label.includes("z0"))).toBe(false); // no id in the label

		const z0 = options.find((o) => decodePath(o.value)?.[0] === "z0");
		const drill = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			block_id: openForm?.block_id,
			values: { target: z0!.value },
		});
		expect(
			blocksOf(drill).some((b) => b.type === "header" && b.text === "Shipping methods — z0"),
		).toBe(true);
	});
});

describe("admin Shipping console — methods level, depth 1 (workerd sandbox)", () => {
	/** Open the `us` zone's methods the way the zones list does — the row's own
	 *  "View methods" BUTTON, carrying the full target path (§12.7). */
	async function openUsMethods(): Promise<LooseBlock[]> {
		const zones = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const view = buttons(groupBlocks(blocksOf(zones), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:open",
		);
		return blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "shipping:open",
				value: valueOf(view),
			}),
		);
	}

	test("opening a zone drills to its methods; each per-row accordion label LEADS WITH THE PRICE, then the name, the full slug id and the type", async () => {
		const state = makeShippingState();
		await boot(state);
		const blocks = await openUsMethods();
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		// The number the operator came for is FIRST, so every row's amount starts
		// at the same left edge and the column can be compared vertically. The
		// slug keeps its place IN FULL — a method id is a natural key, not a uuid.
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"$4.99 — Standard · standard · flat rate",
		);
		expect(buttons(blocks).some((e) => e.action_id === "shipping:back")).toBe(true);
		expect(openGroupIds(blocks)).toHaveLength(0); // L-9: zero open groups
	});

	test("a method with no rate in the filter currency says so — never 'Free', never a zero amount", async () => {
		const state = makeShippingState();
		await boot(state);
		const label = String(group(await openUsMethods(), "ship:method:us:bare")?.label);
		expect(label).toBe("No rate set — No rates yet · bare · flat rate");
		expect(label).not.toMatch(/free|\$0|0\.00/i);
	});

	test("a method priced in ANOTHER currency reads as unset FOR THIS CURRENCY, not as unconfigured — and prices once the filter names its currency", async () => {
		// THE FALSE-ABSENCE CASE. A store that prices solely in EUR, read under
		// the USD default, must not report a fully configured method as having no
		// rate at all — the same lie as rendering an unknown price as `Free`.
		const state = makeShippingState();
		state.methods.push({
			id: "eu-express",
			zoneId: "us",
			name: "Express courier",
			type: "flat_rate",
		});
		state.rates.push({
			methodId: "eu-express",
			currency: "EUR",
			amountCents: 1200,
			minSubtotalCents: null,
		});
		await boot(state);
		const usd = await openUsMethods();
		expect(group(usd, "ship:method:us:eu-express")?.label).toBe(
			"No rate set — Express courier · eu-express · flat rate",
		);
		// The row carries no ISO code (G1) — the currency is named once, above,
		// and THAT is where the row's claim is scoped: the operator reads "no USD
		// rate", not "unconfigured". Row-level scoping was tried first and is 63
		// chars against X-11's 60-char accordion budget.
		expect(String(group(usd, "ship:method:us:eu-express")?.label)).not.toContain("USD");
		expect(contextTexts(usd)).toContain(
			'"Flat rate" always charges its rate; "Free shipping" charges nothing above its threshold. Prices in USD — "No rate set" means no USD rate.',
		);

		const filterForm = formFor(usd, "shipping:apply-filter");
		const eur = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "shipping:apply-filter",
				block_id: filterForm?.block_id,
				values: { currency: "EUR" },
			}),
		);
		expect(group(eur, "ship:method:us:eu-express")?.label).toBe(
			"€12.00 — Express courier · eu-express · flat rate",
		);
		// …and the USD-only method flips the other way, by the same rule, with the
		// context line's scope flipping with it.
		expect(group(eur, "ship:method:us:standard")?.label).toBe(
			"No rate set — Standard · standard · flat rate",
		);
		expect(contextTexts(eur).some((t) => t.endsWith('"No rate set" means no EUR rate.'))).toBe(
			true,
		);
	});

	test("a currency that is not a currency code is rejected BEFORE any read: banner in a 200, rows unpriced, nothing claimed", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await openUsMethods();
		const filterForm = formFor(opened, "shipping:apply-filter");
		stub!.requests.length = 0;

		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "shipping:apply-filter",
				block_id: filterForm?.block_id,
				values: { currency: "dollars" },
			}),
		);
		// Not one doomed read — a typo must not cost 25 requests that all fail
		// and then paint the list "Price unavailable", blaming the service.
		expect(stub!.requests.filter((r) => /\/rates\?/.test(r.url))).toHaveLength(0);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toBe("Enter a 3-letter currency code like USD.");
		// The list itself is unaffected and stays on screen, with the offending
		// field still there to fix.
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"Price not loaded — Standard · standard · flat rate",
		);
		expect(field(formFor(blocks, "shipping:apply-filter"), "currency")?.initial_value).toBe(
			"DOLLARS",
		);
		// Nothing priced ⇒ no currency claimed, and never the read-failure copy.
		expect(findBlocks(blocks, "context").some((c) => /Prices in/.test(String(c.text)))).toBe(false);
		expect(
			findBlocks(blocks, "accordion").some((a) => /Price unavailable/.test(String(a.label))),
		).toBe(false);
	});

	test("a FAILED price read degrades that row to 'Price unavailable' — the level still renders, and absence is never claimed", async () => {
		const state = makeShippingState();
		state.rateReadsFail = true;
		await boot(state);
		const blocks = await openUsMethods();
		// Secondary read: the methods list itself still rendered, no fail-closed banner.
		expect(bannerOf(blocks)).toBeUndefined();
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"Price unavailable — Standard · standard · flat rate",
		);
		// "unavailable" is not "none": a read that did not answer must not be
		// reported as a rate that does not exist.
		expect(String(group(blocks, "ship:method:us:bare")?.label)).not.toMatch(/no rate set/i);
	});

	test("the price costs exactly ONE rate read per method, in the level's currency, and the currency is stated ONCE for the list (G1)", async () => {
		const state = makeShippingState();
		await boot(state);
		stub!.requests.length = 0;
		const blocks = await openUsMethods();
		const rateReads = stub!.requests.filter((r) => /\/rates\?/.test(r.url)).map((r) => r.url);
		expect(rateReads.toSorted()).toEqual([
			"/admin/shipping/methods/bare/rates?currency=USD",
			"/admin/shipping/methods/standard/rates?currency=USD",
		]);
		// Currency named once, in the level's context line — never as an ISO code
		// repeated per row — and inside X-11's 140-char page-context budget.
		const contexts = findBlocks(blocks, "context").map((c) => String(c.text));
		const priced = contexts.find((t) => t.includes("Prices in USD"));
		expect(priced).toBe(
			'"Flat rate" always charges its rate; "Free shipping" charges nothing above its threshold. Prices in USD — "No rate set" means no USD rate.',
		);
		expect(String(priced).length).toBeLessThanOrEqual(140);
		expect(String(group(blocks, "ship:method:us:standard")?.label)).not.toContain("USD");
	});

	test("the price currency is a filter: applying EUR re-reads in EUR and re-prices every row", async () => {
		const state = makeShippingState();
		state.rates.push({
			methodId: "standard",
			currency: "EUR",
			amountCents: 1200,
			minSubtotalCents: null,
		});
		await boot(state);
		const opened = await openUsMethods();
		const filterForm = formFor(opened, "shipping:apply-filter");
		expect(field(filterForm, "currency")?.initial_value).toBe("USD");
		stub!.requests.length = 0;

		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "shipping:apply-filter",
				block_id: filterForm?.block_id,
				values: { currency: "eur" },
			}),
		);
		// L-6: the depth-1 path survived the apply — this is still the `us`
		// methods list, not the root zones list.
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		const eurReads = stub!.requests.filter((r) => /\/rates\?/.test(r.url));
		expect(eurReads.length).toBeGreaterThan(0);
		expect(eurReads.every((r) => r.url.endsWith("currency=EUR"))).toBe(true);
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"€12.00 — Standard · standard · flat rate",
		);
		expect(group(blocks, "ship:method:us:bare")?.label).toBe(
			"No rate set — No rates yet · bare · flat rate",
		);
		expect(
			findBlocks(blocks, "context").some((c) =>
				String(c.text).includes('Prices in EUR — "No rate set" means no EUR rate.'),
			),
		).toBe(true);
	});

	test("no operator-facing copy on this level names a raw enum — but the wire values are untouched", async () => {
		const state = makeShippingState();
		await boot(state);
		const blocks = await openUsMethods();
		const copy = [
			...findBlocks(blocks, "context").map((c) => String(c.text)),
			...findBlocks(blocks, "accordion").map((a) => String(a.label)),
		].join(" | ");
		expect(copy).not.toMatch(/flat_rate|free_shipping/);
		expect(copy).toContain('"Flat rate" always charges its rate');
		expect(copy).toContain('"Free shipping" charges nothing above its threshold');

		// The SELECT still submits the enum the service expects — humanizing the
		// copy must not touch the protocol.
		const createForm = formFor(groupBlocks(blocks, "ship:new-method:us"), "shipping:create-method");
		const typeOptions = field(createForm, "type")?.options as Array<{
			value: string;
			label: string;
		}>;
		expect(typeOptions.map((o) => o.value)).toEqual(["flat_rate", "free_shipping"]);
	});

	test("a zone with no methods yet shows the `empty` block, never a fail-closed banner", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["empty"]) },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — empty")).toBe(
			true,
		);
		expect(findBlock(blocks, "empty")?.title).toBe("No shipping methods yet");
		expect(findBlock(blocks, "banner")).toBeUndefined();
	});

	test("the empty state's create action carries the zoneId in value.__path and force-opens 'New method' at the RIGHT zone", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["empty"]) },
		});
		const action = emptyActions(blocksOf(opened))[0];
		expect(action?.action_id).toBe("shipping:open-create-method");
		expect(decodePath(String(valueOf(action)["__path"]))).toEqual(["empty"]);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:open-create-method",
			value: valueOf(action),
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — empty")).toBe(
			true,
		);
		expect(openGroupIds(blocks)).toEqual(["ship:new-method:empty:open"]);
	});

	test("the row edit form carries zoneId+methodId invisibly; save-method PUTs the LWW edit and reloads with a 'saved' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const editForm = formFor(
			groupBlocks(blocksOf(opened), "ship:method:us:standard"),
			"shipping:save-method",
		);
		expect(fieldIds(editForm)).toEqual(["name", "type"]);
		const carried = carriedContext(editForm?.block_id);
		expect(carried).toEqual({ zoneId: "us", methodId: "standard" });

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-method",
			block_id: editForm?.block_id,
			values: { name: "Standard (2-5 days)", type: "flat_rate" },
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/shipping/methods/standard");
		expect(put!.body).toEqual({ name: "Standard (2-5 days)", type: "flat_rate" });
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("default");
		expect(state.methods.find((m) => m.id === "standard")?.name).toBe("Standard (2-5 days)");
	});

	test("create-method carries the zoneId invisibly (no visible field) and POSTs under the zone, then reloads the methods level", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const createForm = formFor(
			groupBlocks(blocksOf(opened), "ship:new-method:us"),
			"shipping:create-method",
		);
		expect(fieldIds(createForm)).toEqual(["id", "name", "type"]);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-method",
			block_id: createForm?.block_id,
			values: { id: "express", name: "Express", type: "flat_rate" },
		});
		const post = stub!.requests.find(
			(r) => r.method === "POST" && r.url === "/admin/shipping/zones/us/methods",
		);
		expect(post!.body).toEqual({ id: "express", name: "Express", type: "flat_rate" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(group(blocks, "ship:method:us:express")).toBeDefined();
		expect(bannerOf(blocks)?.variant).toBe("default");
	});

	test("an invalid method type is caught at the plugin boundary — no POST sent", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const createForm = formFor(
			groupBlocks(blocksOf(opened), "ship:new-method:us"),
			"shipping:create-method",
		);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-method",
			block_id: createForm?.block_id,
			values: { id: "bogus", name: "Bogus", type: "not-a-type" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("deleting a method is unconditional (DA-2) — a forbid-if-rates conflict is reported by the post-attempt banner", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const del = buttons(groupBlocks(blocksOf(opened), "ship:method:us:standard")).find(
			(b) => b.action_id === "shipping:delete-method",
		);
		expect(del?.label).toBe("Delete method");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-method",
			value: valueOf(del),
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/rates/i);
		expect(state.methods.some((m) => m.id === "standard")).toBe(true); // never deleted
	});

	test("deleting a method with no rates DELETEs and reloads with a 'deleted' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const del = buttons(groupBlocks(blocksOf(opened), "ship:method:us:bare")).find(
			(b) => b.action_id === "shipping:delete-method",
		);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-method",
			value: valueOf(del),
		});
		const delReq = stub!.requests.find((r) => r.method === "DELETE");
		expect(delReq?.url).toBe("/admin/shipping/methods/bare");
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("deleted");
		expect(group(blocksOf(outcome), "ship:method:us:bare")).toBeUndefined();
	});

	test("back from the methods level (depth 1) returns to the zones list", async () => {
		const state = makeShippingState();
		await boot(state);
		const methods = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const backButtonValue = valueOf(
			buttons(blocksOf(methods)).find((e) => e.action_id === "shipping:back"),
		);
		const back = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:back",
			value: backButtonValue,
		});
		expect(blocksOf(back).some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(
			true,
		);
	});
});

describe("admin Shipping console — methods level, L-9 fallback branch (>25 rows)", () => {
	test("at 25 methods the ACCORDION branch renders; at 26, TABLE + combobox drill-in (Type keeps its badge, T-5)", async () => {
		const at25 = makeManyMethodsState(25);
		await boot(at25);
		stub!.requests.length = 0;
		const level25 = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const blocks25 = blocksOf(level25);
		expect(findBlocks(blocks25, "table")).toHaveLength(0);
		expect(
			findBlocks(blocks25, "accordion").filter((a) =>
				String(a.block_id).startsWith("ship:method:"),
			),
		).toHaveLength(25);
		// THE CAP, ASSERTED AT THE CAP. 25 rows priced ⇒ exactly 25 rate reads,
		// one per row and no more — this is the number the whole bound exists to
		// hold, and asserting the branch alone would not catch a fan-out that
		// grew to two reads a row.
		expect(stub!.requests.filter((r) => /\/rates\?/.test(r.url))).toHaveLength(25);
		await sandbox!.close();
		await stub!.close();

		const at26 = makeManyMethodsState(26);
		await boot(at26);
		stub!.requests.length = 0;
		const level26 = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const blocks26 = blocksOf(level26);
		expect(
			findBlocks(blocks26, "accordion").filter((a) =>
				String(a.block_id).startsWith("ship:method:"),
			),
		).toHaveLength(0);
		const table = findBlock(blocks26, "table");
		expect(table?.columns).toEqual([
			{ key: "id", label: "Method ID", format: "code" },
			{ key: "name", label: "Name" },
			{ key: "type", label: "Type", format: "badge" },
		]);
		expect(tableRows(blocks26)).toHaveLength(26);
		// The `Type` badge reads the human name; the wire value never appears.
		expect(tableRows(blocks26).map((r) => String(r["type"]))).toContain("Free shipping");
		expect(tableRows(blocks26).some((r) => /_/.test(String(r["type"])))).toBe(false);
		// THE PRICE FAN-OUT IS BOUNDED BY THE ACCORDION BRANCH. Past 25 rows the
		// table shows no price, so it must cost NO rate reads — never 26, never
		// the level's `limit: 200`.
		expect(stub!.requests.filter((r) => /\/rates\?/.test(r.url))).toHaveLength(0);
		// …and with nothing priced, the context line claims no currency.
		expect(findBlocks(blocks26, "context").some((c) => /Prices in/.test(String(c.text)))).toBe(
			false,
		);
		expect(formFor(blocks26, "shipping:apply-filter")).toBeUndefined();
	});
});

describe("admin Shipping console — rates level, depth 2, EXEMPT from L-9 (workerd sandbox)", () => {
	test("opening a method drills to its rates, default-filtered to USD, rendered as `fields` (not a 1-row table, P-3)", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const view = buttons(groupBlocks(blocksOf(opened), "ship:method:us:standard")).find(
			(b) => b.action_id === "shipping:open",
		);
		// Depth-3 open FIRED FROM A BUTTON — the trap: value.target must carry
		// the FULL [zoneId, methodId] path, and parseOpen must read `value`, not
		// only `values` (§12.7).
		expect(decodePath(String(valueOf(view).target))).toEqual(["us", "standard"]);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:open",
			value: valueOf(view),
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		);
		const getReq = stub!.requests.find((r) =>
			r.url.startsWith("/admin/shipping/methods/standard/rates"),
		);
		expect(getReq?.url).toBe("/admin/shipping/methods/standard/rates?currency=USD");

		expect(findBlocks(blocks, "table")).toHaveLength(0); // L-9a: no table at this level
		expect(fieldEntries(blocks)).toEqual([
			"Currency=USD",
			"Amount=$4.99",
			"Free-shipping threshold=$35.00",
			"Method=standard",
		]);
		expect(buttons(blocks).some((e) => e.action_id === "shipping:back")).toBe(true);
		// No "Clear filters" section — the currency filter is already at its default.
		expect(findBlocks(blocks, "section")).toHaveLength(0);
	});

	test("a method with no rate for the filtered currency shows an honest context line, never fail-closed", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "bare"]) },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — bare")).toBe(
			true,
		);
		expect(findBlocks(blocks, "fields")).toHaveLength(0);
		const contexts = findBlocks(blocks, "context").map((c) => String(c.text));
		expect(contexts.some((t) => /no rate set/i.test(t))).toBe(true);
	});

	test("filtering to a non-default currency renders the L-6 'Clear filters' section, whose button re-applies the [zoneId,methodId] path", async () => {
		const state = makeShippingState();
		state.rates.push({
			methodId: "standard",
			currency: "EUR",
			amountCents: 599,
			minSubtotalCents: null,
		});
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const filterForm = formFor(blocksOf(opened), "shipping:apply-filter");
		expect(filterForm?.submit).toEqual({
			label: "Apply filters",
			action_id: "shipping:apply-filter",
		});
		stub!.requests.length = 0;

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:apply-filter",
			block_id: filterForm?.block_id,
			values: { currency: "eur" },
		});
		expect(stub!.requests).toHaveLength(1);
		expect(stub!.requests[0]?.url).toBe("/admin/shipping/methods/standard/rates?currency=EUR");
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		); // path survived
		expect(fieldEntries(blocks)).toEqual([
			"Currency=EUR",
			"Amount=€5.99",
			"Free-shipping threshold=No minimum",
			"Method=standard",
		]);

		const section = findBlock(blocks, "section");
		expect(String(section?.text)).toBe("currency: EUR");
		const clearButton = section?.accessory as LooseElement;
		expect(clearButton.action_id).toBe("shipping:apply-filter");
		expect(clearButton.label).toBe("Clear filters");

		const cleared = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:apply-filter",
			value: clearButton.value,
		});
		const clearedBlocks = blocksOf(cleared);
		expect(
			clearedBlocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard"),
		).toBe(true); // still the SAME method's rates, not the root
		expect(fieldEntries(clearedBlocks)[0]).toBe("Currency=USD"); // back to the default
	});

	test("create-rate POSTs the EXACT integer cents (0 is allowed), then reloads the rates level", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "bare"]) },
		});
		const createForm = formFor(blocksOf(opened), "shipping:create-rate");
		const carried = carriedContext(createForm?.block_id);
		expect(carried).toEqual({ zoneId: "us", methodId: "bare" });
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			block_id: createForm?.block_id,
			values: { currency: "usd", amount: "0", minSubtotal: "" },
		});
		const post = stub!.requests.find(
			(r) => r.method === "POST" && r.url === "/admin/shipping/methods/bare/rates",
		);
		expect(post!.body).toEqual({ currency: "USD", amountCents: 0, minSubtotalCents: null });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — bare")).toBe(
			true,
		);
		expect(bannerOf(blocks)?.variant).toBe("default");
	});

	test("a malformed amount is caught at the plugin boundary — no POST is sent (money parse edge)", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "bare"]) },
		});
		const createForm = formFor(blocksOf(opened), "shipping:create-rate");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			block_id: createForm?.block_id,
			values: { currency: "USD", amount: "4.999", minSubtotal: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("a negative amount is caught at the plugin boundary — no POST is sent (money parse edge)", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "bare"]) },
		});
		const createForm = formFor(blocksOf(opened), "shipping:create-rate");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			block_id: createForm?.block_id,
			values: { currency: "USD", amount: "-1", minSubtotal: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("an invalid currency code is caught at the plugin boundary — no POST is sent", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "bare"]) },
		});
		const createForm = formFor(blocksOf(opened), "shipping:create-rate");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			block_id: createForm?.block_id,
			values: { currency: "US", amount: "4.99", minSubtotal: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("the rate edit form carries the CAS watermark (expectedAmountCents) invisibly, alongside zoneId/methodId/currency", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const blocks = blocksOf(outcome);
		const editForm = formFor(blocks, "shipping:save-rate");
		expect(fieldIds(editForm)).toEqual(["amount", "minSubtotal"]); // no hidden fields visible
		expect(field(editForm, "amount")?.type).toBe("text_input"); // never number_input
		expect(field(editForm, "amount")?.initial_value).toBe("4.99");
		expect(field(editForm, "minSubtotal")?.initial_value).toBe("35.00");
		const carried = carriedContext(editForm?.block_id);
		expect(carried).toEqual({
			zoneId: "us",
			methodId: "standard",
			currency: "USD",
			expectedAmountCents: "499",
		});
	});

	test("save-rate PUTs the CAS edit and reloads with a 'saved' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const editForm = formFor(blocksOf(opened), "shipping:save-rate");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-rate",
			block_id: editForm?.block_id,
			values: { amount: "5.99", minSubtotal: "" },
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/shipping/methods/standard/rates/USD");
		expect(put!.body).toEqual({
			amountCents: 599,
			minSubtotalCents: null,
			expectedAmountCents: 499,
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		expect(state.rates.find((r) => r.currency === "USD")?.amountCents).toBe(599);
		expect(state.rates.find((r) => r.currency === "USD")?.minSubtotalCents).toBeNull();
	});

	test("a concurrent-edit conflict (409 STALE) reloads the fresh rate with a re-apply warning, never a clobber", async () => {
		const state = makeShippingState();
		await boot(state);
		// Stage an edit form whose carried watermark (499) is already stale by
		// the time it is submitted — a real out-of-band change to the record.
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const editForm = formFor(blocksOf(opened), "shipping:save-rate");
		state.rates.find((r) => r.currency === "USD")!.amountCents = 1;

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-rate",
			block_id: editForm?.block_id,
			values: { amount: "9.00", minSubtotal: "" },
		});
		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/changed since you loaded it|reload/i);
		expect(state.rates.find((r) => r.currency === "USD")?.amountCents).toBe(1); // untouched by this save
		expect(fieldEntries(blocks)).toContain("Amount=$0.01"); // the FRESH value, from a real reload GET
	});

	test("delete-rate DELETEs and reloads with a 'deleted' notice, danger copy about in-flight carts / snapshotted orders; a repeat delete is idempotent", async () => {
		const state = makeShippingState();
		await boot(state);
		const opened = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const del = buttons(blocksOf(opened)).find((e) => e.action_id === "shipping:delete-rate");
		expect(del?.label).toBe("Delete rate");
		expect(String(confirmOf(del).text)).toMatch(/in-flight carts/i);
		expect(String(confirmOf(del).text)).toMatch(/snapshots the shipping fee/i);

		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-rate",
			value: valueOf(del),
		});
		const delReq = stub!.requests.find((r) => r.method === "DELETE");
		expect(delReq?.url).toBe("/admin/shipping/methods/standard/rates/USD");
		const firstBanner = bannerOf(blocksOf(first));
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(findBlocks(blocksOf(first), "fields")).toHaveLength(0);

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-rate",
			value: valueOf(del),
		});
		const secondBanner = bannerOf(blocksOf(second));
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("back from the rates level (depth 2) pops exactly ONE level, to the methods list — not the root", async () => {
		const state = makeShippingState();
		await boot(state);
		const rates = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const backButtonValue = valueOf(
			buttons(blocksOf(rates)).find((e) => e.action_id === "shipping:back"),
		);
		const back = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:back",
			value: backButtonValue,
		});
		const blocks = blocksOf(back);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(false);
	});
});

describe("admin Shipping console — full deep-drill round trip via row BUTTONS (workerd sandbox)", () => {
	test("zones → methods → rates → back → back returns to zones, every open fired from a row button carrying the FULL path", async () => {
		const state = makeShippingState();
		await boot(state);
		const zones = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const zoneOpen = buttons(groupBlocks(blocksOf(zones), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:open",
		);
		expect(decodePath(String(valueOf(zoneOpen).target))).toEqual(["us"]);
		const methods = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:open",
			value: valueOf(zoneOpen),
		});
		expect(
			blocksOf(methods).some((b) => b.type === "header" && b.text === "Shipping methods — us"),
		).toBe(true);

		const methodOpen = buttons(groupBlocks(blocksOf(methods), "ship:method:us:standard")).find(
			(b) => b.action_id === "shipping:open",
		);
		// The depth-3 trap: the FULL [zoneId, methodId] path, not a bare methodId.
		expect(decodePath(String(valueOf(methodOpen).target))).toEqual(["us", "standard"]);
		const rates = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:open",
			value: valueOf(methodOpen),
		});
		expect(
			blocksOf(rates).some((b) => b.type === "header" && b.text === "Shipping rates — standard"),
		).toBe(true);

		const backToMethodsValue = valueOf(
			buttons(blocksOf(rates)).find((e) => e.action_id === "shipping:back"),
		);
		const backToMethods = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:back",
			value: backToMethodsValue,
		});
		expect(
			blocksOf(backToMethods).some(
				(b) => b.type === "header" && b.text === "Shipping methods — us",
			),
		).toBe(true);

		const backToZonesValue = valueOf(
			buttons(blocksOf(backToMethods)).find((e) => e.action_id === "shipping:back"),
		);
		const backToZones = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:back",
			value: backToZonesValue,
		});
		expect(
			blocksOf(backToZones).some((b) => b.type === "header" && b.text === "Shipping zones"),
		).toBe(true);
	});
});

describe("admin Shipping console — assertBlockContract (§15 V-3)", () => {
	// Every H-marked §13 anti-pattern this helper enforces, run against one
	// rendered response per drill level, per branch, and per zero-row state —
	// all three levels are LIST levels (D-2: Shipping has no detail screen).
	test("assertBlockContract holds at every level, both L-9 branches, and both empty states", async () => {
		const state = makeShippingState();
		await boot(state);

		const zonesList = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		assertBlockContract(blocksOf(zonesList), { screen: "shipping", level: "list" });

		const methodsList = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		assertBlockContract(blocksOf(methodsList), { screen: "shipping", level: "list" });

		const emptyMethodsList = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["empty"]) },
		});
		assertBlockContract(blocksOf(emptyMethodsList), { screen: "shipping", level: "list" });

		const ratesWithRow = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		assertBlockContract(blocksOf(ratesWithRow), { screen: "shipping", level: "list" });

		const ratesNoRow = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "bare"]) },
		});
		assertBlockContract(blocksOf(ratesNoRow), { screen: "shipping", level: "list" });

		await sandbox!.close();
		await stub!.close();

		// The zero-row `empty` state (E-2) — zones and methods.
		const zeroState = {
			zones: [] as ZoneRow[],
			methods: [] as MethodRow[],
			rates: [] as RateRow[],
		};
		await boot(zeroState);
		const emptyZones = await sandbox!.invokeRoute("admin", {
			type: "page_load",
			page: "/shipping",
		});
		assertBlockContract(blocksOf(emptyZones), { screen: "shipping", level: "list" });

		await sandbox!.close();
		await stub!.close();

		// The L-9 fallback branch (>25 rows) — zones and methods.
		const manyZones = makeManyZonesState(26);
		await boot(manyZones);
		const zonesFallback = await sandbox!.invokeRoute("admin", {
			type: "page_load",
			page: "/shipping",
		});
		assertBlockContract(blocksOf(zonesFallback), { screen: "shipping", level: "list" });

		await sandbox!.close();
		await stub!.close();

		const manyMethods = makeManyMethodsState(26);
		await boot(manyMethods);
		const methodsFallback = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		assertBlockContract(blocksOf(methodsFallback), { screen: "shipping", level: "list" });
	});
});
