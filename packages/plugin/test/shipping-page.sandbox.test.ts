import { afterEach, describe, expect, test } from "vitest";
import { decodePath, encodePath } from "../src/admin/scaffold/index.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Shipping console under the REAL workerd-on-Node sandbox
// (admin-UX Increment 3, slice 3 — "shipping admin drill-down"): zones
// (list/create/edit-LWW/delete-forbid-if-methods) drilling into a zone's
// methods (list/create/edit-LWW/delete-forbid-if-rates) drilling into a
// method's currency-keyed rates (list/create/edit-with-CAS/delete). This is
// the FIRST production screen to reach depth 3 (the scaffold's own N-level
// nav core was proven first by the synthetic geo fixture,
// `admin-scaffold-list-detail.sandbox.test.ts`) — render/drill/back/CRUD are
// exercised at all three levels, including CAS-stale and both forbid-if-
// children conflicts.

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

/** A small stateful stub standing in for the shipping-admin HTTP surface —
 *  zones/methods/rates are mutated by POST/PUT/DELETE and read back by GET,
 *  so create→list, edit→reload, and delete→idempotent-replay all exercise
 *  real state transitions (not canned fixtures). */
function makeShippingState() {
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

function attachShippingStub(stub: StubCommerceServer, state: ReturnType<typeof makeShippingState>) {
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
function actionButtons(blocks: Blk[]): Array<Record<string, unknown>> {
	return blocks
		.filter((b) => b.type === "actions")
		.flatMap((b) => (b.elements as Array<Record<string, unknown>>) ?? []);
}
/** The open form's `target` select options — asserts they decode to a real
 *  {@link NavPath} rather than trusting a hand-encoded guess. */
function openTargetOptions(blocks: Blk[]): Array<{ value: string; label: string }> {
	const fields = formFields(blocks, "shipping:open");
	const targetField = fields.find((f) => f.action_id === "target");
	return (targetField?.options as Array<{ value: string; label: string }> | undefined) ?? [];
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

async function boot(state: ReturnType<typeof makeShippingState>, token = "admin-token-xyz") {
	stub = await startStubCommerceServer();
	attachShippingStub(stub, state);
	sandbox = await loadPluginInSandbox({
		allowedHosts: [stub.host],
		commerceServiceBaseUrl: stub.baseUrl,
	});
	if (token.length > 0) await seedToken(sandbox, stub, token);
}

describe("admin Shipping console — zones level (workerd sandbox)", () => {
	test("page_load /shipping renders the zones list and forwards the kv-sourced admin token", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(true);
		expect(tableRows(blocks).map((r) => r.id)).toEqual(["us", "empty"]);
		const listReq = stub!.requests.find((r) => r.url === "/admin/shipping/zones");
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
		// Regions render honestly: an array joins, null renders as "none" — never
		// a raw JSON dump for the common shapes.
		const rows = tableRows(blocks);
		expect(rows.find((r) => r.id === "us")?.regions).toBe("US");
		expect(rows.find((r) => r.id === "empty")?.regions).toBe("— (none)");
	});

	test("NO-TOKEN page_load /shipping fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		const state = makeShippingState();
		await boot(state, "");
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/shipping|401/);
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
		expect(tableRows(blocks).map((r) => r.id)).toEqual(["us", "empty", "eu"]);
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

	test("the zones list carries a per-row edit form ALWAYS pre-filled with both name and regions (full-replace safety)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const fields = formFields(blocksOf(outcome), "shipping:save-zone");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("zoneId")?.initial_value).toBe("us");
		expect(byId.get("name")?.initial_value).toBe("United States");
		expect(byId.get("regions")?.initial_value).toBe("US");
	});

	test("save-zone PUTs the full-replace edit and reloads with a 'saved' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-zone",
			values: { zoneId: "us", name: "USA", regions: "US, PR" },
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/shipping/zones/us");
		expect(put!.body).toEqual({ name: "USA", regions: ["US", "PR"] });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		expect(state.zones.find((z) => z.id === "us")?.name).toBe("USA");
	});

	test("deleting a zone that still has methods is a forbid-if-methods conflict, rendered honestly", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: { zoneId: "us" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/shipping methods/i);
		expect(state.zones.some((z) => z.id === "us")).toBe(true); // never deleted
	});

	test("deleting a zone with no methods DELETEs and reloads with a 'deleted' notice; a repeat delete is idempotent", async () => {
		const state = makeShippingState();
		await boot(state);
		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: { zoneId: "empty" },
		});
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/shipping/zones/empty");
		const firstBanner = bannerOf(blocksOf(first));
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(tableRows(blocksOf(first)).some((r) => r.id === "empty")).toBe(false);

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-zone",
			value: { zoneId: "empty" },
		});
		const secondBanner = bannerOf(blocksOf(second));
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});
});

describe("admin Shipping console — methods level, depth 1 (workerd sandbox)", () => {
	test("opening a zone drills to its methods, decoding the open form's OWN encoded target", async () => {
		const state = makeShippingState();
		await boot(state);
		const zones = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const options = openTargetOptions(blocksOf(zones));
		const usOption = options.find((o) => decodePath(o.value)?.[0] === "us");
		expect(usOption).toBeDefined();
		expect(decodePath(usOption!.value)).toEqual(["us"]);

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: usOption!.value },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(
			tableRows(blocks)
				.map((r) => r.id)
				.toSorted(),
		).toEqual(["bare", "standard"]);
		expect(actionButtons(blocks).some((e) => e.action_id === "shipping:back")).toBe(true);
	});

	test("a zone with no methods yet shows an honest empty state, never a fail-closed banner", async () => {
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
		expect(tableRows(blocks).length).toBe(0);
	});

	test("create-method carries the zoneId hidden carrier and POSTs under the zone, then reloads the methods level", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-method",
			values: { zoneId: "us", id: "express", name: "Express", type: "flat_rate" },
		});
		const post = stub!.requests.find(
			(r) => r.method === "POST" && r.url === "/admin/shipping/zones/us/methods",
		);
		expect(post!.body).toEqual({ id: "express", name: "Express", type: "flat_rate" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(
			tableRows(blocks)
				.map((r) => r.id)
				.toSorted(),
		).toEqual(["bare", "express", "standard"]);
		expect(bannerOf(blocks)?.variant).toBe("default");
	});

	test("an invalid method type is caught at the plugin boundary — no POST sent", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-method",
			values: { zoneId: "us", id: "bogus", name: "Bogus", type: "not-a-type" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("save-method PUTs the LWW edit and reloads with a 'saved' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-method",
			values: {
				zoneId: "us",
				methodId: "standard",
				name: "Standard (2-5 days)",
				type: "flat_rate",
			},
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/shipping/methods/standard");
		expect(put!.body).toEqual({ name: "Standard (2-5 days)", type: "flat_rate" });
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("default");
		expect(state.methods.find((m) => m.id === "standard")?.name).toBe("Standard (2-5 days)");
	});

	test("deleting a method that still has rates is a forbid-if-rates conflict, rendered honestly", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-method",
			value: { zoneId: "us", methodId: "standard" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/rates/i);
		expect(state.methods.some((m) => m.id === "standard")).toBe(true); // never deleted
	});

	test("deleting a method with no rates DELETEs and reloads with a 'deleted' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-method",
			value: { zoneId: "us", methodId: "bare" },
		});
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/shipping/methods/bare");
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("deleted");
		expect(tableRows(blocksOf(outcome)).some((r) => r.id === "bare")).toBe(false);
	});

	test("back from the methods level (depth 1) returns to the zones list", async () => {
		const state = makeShippingState();
		await boot(state);
		const methods = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us"]) },
		});
		const backButtonValue = actionButtons(blocksOf(methods)).find(
			(e) => e.action_id === "shipping:back",
		)?.value as Record<string, string> | undefined;
		expect(backButtonValue).toBeDefined();
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

describe("admin Shipping console — rates level, depth 2 (workerd sandbox)", () => {
	test("opening a method drills to its rates, default-filtered to USD", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		);
		const getReq = stub!.requests.find((r) =>
			r.url.startsWith("/admin/shipping/methods/standard/rates"),
		);
		expect(getReq?.url).toBe("/admin/shipping/methods/standard/rates?currency=USD");
		const rows = tableRows(blocks);
		expect(rows).toEqual([{ currency: "USD", amount: "$4.99", minSubtotal: "$35.00" }]);
		expect(actionButtons(blocks).some((e) => e.action_id === "shipping:back")).toBe(true);
	});

	test("a method with no rate for the filtered currency shows an honest empty state, never fail-closed", async () => {
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
		expect(tableRows(blocks).length).toBe(0);
		const table = blocks.find((b) => b.type === "table");
		expect(String((table as { empty_text?: string } | undefined)?.empty_text)).toMatch(/no rate/i);
	});

	test("PATH INTEGRITY at depth 2: apply-filter auto-carries the [zoneId, methodId] path (no hand-carry needed)", async () => {
		const state = makeShippingState();
		state.rates.push({
			methodId: "standard",
			currency: "EUR",
			amountCents: 599,
			minSubtotalCents: null,
		});
		await boot(state);
		const rates = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		// The scaffold AUTO-INJECTS the drill-path carrier into the filter form
		// (`withFilterPathCarry`) — extract it exactly as em-dash would resubmit
		// it, rather than hand-encoding the path.
		const filterFields = formFields(blocksOf(rates), "shipping:apply-filter");
		const pathField = filterFields.find((f) => f.action_id === "__path");
		expect(pathField).toBeDefined();
		expect(decodePath(String(pathField!.initial_value))).toEqual(["us", "standard"]);
		stub!.requests.length = 0;

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:apply-filter",
			values: { currency: "eur", __path: pathField?.initial_value },
		});
		expect(stub!.requests).toHaveLength(1);
		expect(stub!.requests[0]?.url).toBe("/admin/shipping/methods/standard/rates?currency=EUR");
		const blocks = blocksOf(outcome);
		// Still on the SAME method's rates level (path survived), not the root.
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		);
		expect(tableRows(blocks)).toEqual([
			{ currency: "EUR", amount: "€5.99", minSubtotal: "No minimum" },
		]);
	});

	test("create-rate POSTs the EXACT integer cents (0 is allowed), then reloads the rates level", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			values: {
				zoneId: "us",
				methodId: "bare",
				currency: "usd",
				amount: "0",
				minSubtotal: "",
			},
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
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			values: { zoneId: "us", methodId: "bare", currency: "USD", amount: "4.999", minSubtotal: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("a negative amount is caught at the plugin boundary — no POST is sent (money parse edge)", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			values: { zoneId: "us", methodId: "bare", currency: "USD", amount: "-1", minSubtotal: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("an invalid currency code is caught at the plugin boundary — no POST is sent", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:create-rate",
			values: { zoneId: "us", methodId: "bare", currency: "US", amount: "4.99", minSubtotal: "" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
	});

	test("the rates list carries a per-row edit form (CAS) prefilled from the loaded rate", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: encodePath(["us", "standard"]) },
		});
		const fields = formFields(blocksOf(outcome), "shipping:save-rate");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("currency")?.initial_value).toBe("USD");
		expect(byId.get("expectedAmountCents")?.initial_value).toBe("499");
		expect(byId.get("amount")?.type).toBe("text_input"); // never number_input
		expect(byId.get("amount")?.initial_value).toBe("4.99");
		expect(byId.get("minSubtotal")?.initial_value).toBe("35.00");
	});

	test("save-rate PUTs the CAS edit and reloads with a 'saved' notice", async () => {
		const state = makeShippingState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-rate",
			values: {
				zoneId: "us",
				methodId: "standard",
				currency: "USD",
				expectedAmountCents: "499",
				amount: "5.99",
				minSubtotal: "",
			},
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
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:save-rate",
			values: {
				zoneId: "us",
				methodId: "standard",
				currency: "USD",
				expectedAmountCents: "1", // stale — the real current value is 499
				amount: "9.00",
				minSubtotal: "",
			},
		});
		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/changed since you loaded it|reload/i);
		expect(state.rates.find((r) => r.currency === "USD")?.amountCents).toBe(499); // untouched
		const usdRow = tableRows(blocks).find((r) => r.currency === "USD");
		expect(usdRow?.amount).toBe("$4.99"); // the FRESH value, from a real reload GET
	});

	test("delete-rate DELETEs and reloads with a 'deleted' notice, with danger copy about in-flight carts / snapshotted orders; a repeat delete is idempotent", async () => {
		const state = makeShippingState();
		await boot(state);
		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-rate",
			value: { zoneId: "us", methodId: "standard", currency: "USD" },
		});
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/shipping/methods/standard/rates/USD");
		const firstBanner = bannerOf(blocksOf(first));
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(tableRows(blocksOf(first)).some((r) => r.currency === "USD")).toBe(false);

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "shipping:delete-rate",
			value: { zoneId: "us", methodId: "standard", currency: "USD" },
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
		const backButtonValue = actionButtons(blocksOf(rates)).find(
			(e) => e.action_id === "shipping:back",
		)?.value as Record<string, string> | undefined;
		expect(backButtonValue).toBeDefined();
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

	test("FULL DEEP-DRILL round trip: zones → methods → rates → back → back returns to zones", async () => {
		const state = makeShippingState();
		await boot(state);
		const zones = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/shipping" });
		const zoneOption = openTargetOptions(blocksOf(zones)).find(
			(o) => decodePath(o.value)?.[0] === "us",
		);
		const methods = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: zoneOption!.value },
		});
		expect(
			blocksOf(methods).some((b) => b.type === "header" && b.text === "Shipping methods — us"),
		).toBe(true);
		const methodOption = openTargetOptions(blocksOf(methods)).find(
			(o) => decodePath(o.value)?.[1] === "standard",
		);
		const rates = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "shipping:open",
			values: { target: methodOption!.value },
		});
		expect(
			blocksOf(rates).some((b) => b.type === "header" && b.text === "Shipping rates — standard"),
		).toBe(true);

		const backToMethodsValue = actionButtons(blocksOf(rates)).find(
			(e) => e.action_id === "shipping:back",
		)?.value as Record<string, string> | undefined;
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

		const backToZonesValue = actionButtons(blocksOf(backToMethods)).find(
			(e) => e.action_id === "shipping:back",
		)?.value as Record<string, string> | undefined;
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
