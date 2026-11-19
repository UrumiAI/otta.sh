/**
 * The MCP audit log, over a real SQLite document store: every tool call leaves
 * one entry, written BEFORE the tool runs and finished after it; a sensitive
 * tool's values never reach it; a log that cannot be written refuses the call;
 * `audit_list` reads it back; and the one-year retention prunes it, 20 at a time.
 */
import { createOttaPlugin, MCP_AUDIT_COLLECTION, type PluginContext } from "@urumi.ai/otta-plugin";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { newAuditId } from "../src/audit.js";
import {
	AUDIT_INPUT_MAX_BYTES,
	defineTool,
	OTTA_MCP_TOOLS,
	REDACTED,
	ToolError,
	withMcp,
	type AuditEntry,
	type McpRouteEntry,
} from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

/** One collection of `ctx.storage`, as the host hands it over. */
type StorageCollection = NonNullable<PluginContext["storage"]>[string];

const DAY_MS = 86_400_000;
const ADA = { id: "user-ada", email: "ada@store.test", name: "Ada", role: 50 };
const META = { ip: "203.0.113.9", userAgent: "claude-code/2.0", referer: null, geo: null };
const SECRET = "sk_test_51AuditNeverStoresThisValue000000000000";

let ran = 0;
const spy = defineTool({
	name: "zz_spy",
	description: "Counts its runs.",
	input: z.object({}).strict(),
	async run() {
		ran += 1;
		return { status: "done" };
	},
});
const crash = defineTool({
	name: "zz_crash",
	description: "Throws something that is not a ToolError.",
	input: z.object({}).strict(),
	async run() {
		throw new Error("database exploded with secret detail");
	},
});

const plugin = withMcp(createOttaPlugin(), [...OTTA_MCP_TOOLS, spy, crash]);

let harness: AdminHarness;

beforeAll(async () => {
	harness = await makeAdminHarness();
}, 120_000);
beforeEach(async () => {
	ran = 0;
	await harness.reset();
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(async () => {
	expect(harness.egressAttempts()).toBe(0);
	await harness?.close();
});

function log(ctx: PluginContext = harness.ctx): StorageCollection {
	const collection = ctx.storage?.[MCP_AUDIT_COLLECTION];
	if (collection === undefined) throw new Error("no audit collection");
	return collection;
}

/** Every entry, oldest first. */
async function entries(): Promise<AuditEntry[]> {
	const page = await log().query({ orderBy: { at: "asc" }, limit: 100 });
	return page.items.map((item) => item.data as AuditEntry);
}

async function only(): Promise<AuditEntry> {
	const all = await entries();
	expect(all).toHaveLength(1);
	return all[0] as AuditEntry;
}

function route(name: string): McpRouteEntry {
	const entry = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
	if (entry === undefined) throw new Error(`no route mcp/${name}`);
	return entry;
}

interface CallOptions {
	user?: unknown;
	ctx?: PluginContext;
}

async function call(name: string, input: unknown, options: CallOptions = {}): Promise<any> {
	const user = "user" in options ? options.user : ADA;
	return route(name).handler(
		{
			input,
			request: new Request("http://x"),
			requestMeta: META,
			...(user === undefined ? {} : { user }),
		} as never,
		options.ctx ?? harness.ctx,
	);
}

async function refusal(
	name: string,
	input: unknown,
	options: CallOptions = {},
): Promise<ToolError> {
	const error = await call(name, input, options).then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error, `${name} did not refuse`).toBeInstanceOf(ToolError);
	return error as ToolError;
}

/** The harness's context, with the audit collection's `put` replaced. */
function withAuditPut(put: StorageCollection["put"]): PluginContext {
	const real = log();
	const collection: StorageCollection = {
		...real,
		get: (id) => real.get(id),
		delete: (id) => real.delete(id),
		query: (options) => real.query(options),
		count: (where) => real.count(where),
		updateIf: (id, args) => real.updateIf(id, args),
		getVersioned: (id) => real.getVersioned(id),
		compareAndSet: (id, revision, data) => real.compareAndSet(id, revision, data),
		compareAndDelete: (id, revision) => real.compareAndDelete(id, revision),
		put,
	};
	return {
		...harness.ctx,
		storage: { ...harness.ctx.storage, [MCP_AUDIT_COLLECTION]: collection },
	};
}

/** An entry written straight to the log, `ageDays` old. */
async function seedEntry(ageDays: number, fields: Partial<AuditEntry> = {}): Promise<AuditEntry> {
	const ms = Date.now() - ageDays * DAY_MS;
	const entry: AuditEntry = {
		id: newAuditId(ms),
		at: new Date(ms).toISOString(),
		actor: null,
		actorId: null,
		ip: null,
		userAgent: null,
		tool: "settings_get",
		input: {},
		status: "ok",
		finishedAt: new Date(ms).toISOString(),
		...fields,
	};
	await log().put(entry.id, entry);
	return entry;
}

/** Every field path of a schema, nested objects included. */
function leaves(schema: unknown, path: string, out: string[]): void {
	const def = (schema as { def?: Record<string, unknown> } | undefined)?.def;
	if (def === undefined) return;
	if (def["type"] === "object") {
		for (const [key, field] of Object.entries(def["shape"] as Record<string, unknown>)) {
			const at = path === "" ? key : `${path}.${key}`;
			out.push(at);
			leaves(field, at, out);
		}
		return;
	}
	for (const child of [def["innerType"], def["element"], def["in"], def["out"]]) {
		if (child !== undefined) leaves(child, path, out);
	}
	for (const option of (def["options"] as unknown[] | undefined) ?? []) leaves(option, path, out);
}

describe("(a) every call leaves one entry, with how it ended", () => {
	test("a read: ok, with the verified actor, IP and user agent", async () => {
		const settings = await call("settings_get", {});
		expect(settings).toHaveProperty("currency");
		const entry = await only();
		expect(entry).toMatchObject({
			tool: "settings_get",
			input: {},
			status: "ok",
			actor: ADA,
			actorId: ADA.id,
			ip: META.ip,
			userAgent: META.userAgent,
		});
		expect(entry.code).toBeUndefined();
		expect(Date.parse(entry.at)).not.toBeNaN();
		expect(Date.parse(entry.finishedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(entry.at));
	});

	test("a write: ok, its input whole, and what it touched", async () => {
		const input = { code: "AUDIT10", type: "percentage", rateBps: 1000 };
		const created = await call("coupons_create", input);
		expect(created.status).toBe("created");
		const entry = await only();
		expect(entry.status).toBe("ok");
		expect(entry.input).toEqual(input);
		expect(entry.affected).toEqual({ code: "AUDIT10", couponId: created.coupon.id });
	});

	test("a refusal: refused, with its code", async () => {
		expect((await refusal("coupons_get", { code: "NOPE" })).code).toBe("NOT_FOUND");
		const entry = await only();
		expect(entry).toMatchObject({ tool: "coupons_get", status: "refused", code: "NOT_FOUND" });
		expect(entry.affected).toEqual({ code: "NOPE" });
	});

	test("a needs_confirmation answer", async () => {
		const answer = await call("shipping_zone_create", { name: "Home", regions: "US" });
		expect(answer.status).toBe("needs_confirmation");
		const entry = await only();
		expect(entry).toMatchObject({ tool: "shipping_zone_create", status: "needs_confirmation" });
		expect(entry.code).toBeUndefined();
	});

	test("an unknown throw: error, INTERNAL_ERROR, the throw passed on unchanged", async () => {
		const error = await call("zz_crash", {}).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ToolError);
		const entry = await only();
		expect(entry).toMatchObject({ tool: "zz_crash", status: "error", code: "INTERNAL_ERROR" });
		expect(JSON.stringify(entry)).not.toContain("exploded");
	});
});

describe("(b) a sensitive tool's values never reach the log", () => {
	test("payments_set_secret records its keys, every value [redacted]", async () => {
		const warn = vi.spyOn(console, "warn");
		await call("payments_set_secret", { field: "webhookEdgeToken", value: SECRET }).catch(
			() => undefined,
		);
		const entry = await only();
		expect(entry.input).toEqual({ field: REDACTED, value: REDACTED });
		expect(entry.affected).toBeUndefined();
		expect(JSON.stringify(entry)).not.toContain(SECRET);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
	});

	test("an unknown key on a sensitive tool is counted, never named", async () => {
		await refusal("payments_set_secret", {
			field: "webhookEdgeToken",
			value: SECRET,
			[SECRET]: SECRET,
		});
		const entry = await only();
		expect(entry).toMatchObject({ status: "refused", code: "INVALID_INPUT" });
		expect(entry.input).toEqual({
			field: REDACTED,
			value: REDACTED,
			"[unrecognized keys]": 1,
		});
		expect(JSON.stringify(entry)).not.toContain(SECRET);
	});

	test("no tool that is not sensitiveInput takes a secret-like field (so none needs redacting)", () => {
		const SECRET_LIKE = /secret|password|passwd|token|api_?key|credential|private|bearer/i;
		const flagged = OTTA_MCP_TOOLS.filter((tool) => tool.sensitiveInput !== true).flatMap(
			(tool) => {
				const paths: string[] = [];
				leaves(tool.input, "", paths);
				return paths.filter((p) => SECRET_LIKE.test(p)).map((p) => `${tool.name}.${p}`);
			},
		);
		expect(flagged).toEqual([]);
	});
});

describe("(c) a log that cannot be written refuses the call, and nothing runs", () => {
	test("AUDIT_UNAVAILABLE (503), the handler not run", async () => {
		const ctx = withAuditPut(() => Promise.reject(new Error("disk full")));
		const error = await refusal("zz_spy", {}, { ctx });
		expect(error.code).toBe("AUDIT_UNAVAILABLE");
		expect(error.status).toBe(503);
		expect(ran).toBe(0);
		expect(await entries()).toEqual([]);
	});

	test("a write is not made: the coupon is not there on a re-read", async () => {
		const ctx = withAuditPut(() => Promise.reject(new Error("disk full")));
		const error = await refusal(
			"coupons_create",
			{ code: "UNLOGGED", type: "percentage", rateBps: 500 },
			{ ctx },
		);
		expect(error.code).toBe("AUDIT_UNAVAILABLE");
		expect(JSON.stringify(error)).not.toContain("UNLOGGED");
		expect((await refusal("coupons_get", { code: "UNLOGGED" })).code).toBe("NOT_FOUND");
	});

	test("an undeclared collection is the same refusal", async () => {
		const storage = { ...harness.ctx.storage };
		delete storage[MCP_AUDIT_COLLECTION];
		const error = await refusal("zz_spy", {}, { ctx: { ...harness.ctx, storage } });
		expect(error.code).toBe("AUDIT_UNAVAILABLE");
		expect(ran).toBe(0);
	});
});

describe("(d) a final update that fails changes nothing about the call", () => {
	test("the result is the tool's own; the entry stays started; the warning names only the id", async () => {
		const real = log();
		let puts = 0;
		const ctx = withAuditPut((id, data) => {
			puts += 1;
			return puts === 1 ? real.put(id, data) : Promise.reject(new Error("gone"));
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const created = await call(
			"coupons_create",
			{ code: "HALFLOG", type: "percentage", rateBps: 700 },
			{ ctx },
		);
		expect(created).toMatchObject({ status: "created", coupon: { code: "HALFLOG" } });
		const entry = await only();
		expect(entry.status).toBe("started");
		expect(entry.finishedAt).toBeUndefined();
		const warned = warn.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(warned).toContain(entry.id);
		expect(warned).not.toContain("HALFLOG");
	});

	test("a refusal still reaches the caller with its code", async () => {
		const real = log();
		let puts = 0;
		const ctx = withAuditPut((id, data) => {
			puts += 1;
			return puts === 1 ? real.put(id, data) : Promise.reject(new Error("gone"));
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect((await refusal("coupons_get", { code: "NOPE" }, { ctx })).code).toBe("NOT_FOUND");
		expect((await only()).status).toBe("started");
	});
});

describe("(e) the actor is EmDash's, never the input's", () => {
	test("a lookalike field is refused as strict input, and the refusal is logged under ctx.user", async () => {
		const error = await refusal("settings_get", {
			actor: { id: "mallory", email: "m@evil.test" },
			actorId: "mallory",
		});
		expect(error.code).toBe("INVALID_INPUT");
		const entry = await only();
		expect(entry).toMatchObject({
			status: "refused",
			code: "INVALID_INPUT",
			actor: ADA,
			actorId: ADA.id,
		});
	});

	test("no user: logged with actor null, and not refused for it", async () => {
		const settings = await call("settings_get", {}, { user: undefined });
		expect(settings).toHaveProperty("currency");
		expect(await only()).toMatchObject({ status: "ok", actor: null, actorId: null });
	});
});

describe("(f) audit_list", () => {
	test("newest first, and its own call is logged too", async () => {
		const older = await seedEntry(3);
		const newer = await seedEntry(1);
		const page = await call("audit_list", {});
		const ids = page.entries.map((e: AuditEntry) => e.id);
		expect(ids.slice(1)).toEqual([newer.id, older.id]);
		expect(page.entries[0]).toMatchObject({ tool: "audit_list", status: "started" });
		expect(page.nextCursor).toBeUndefined();
	});

	test("filters by tool, status, actor and time, combined", async () => {
		await seedEntry(5, { tool: "orders_refund", status: "ok", actorId: "a" });
		const match = await seedEntry(4, { tool: "orders_refund", status: "refused", actorId: "a" });
		await seedEntry(3, { tool: "orders_refund", status: "refused", actorId: "b" });
		await seedEntry(2, { tool: "coupons_create", status: "refused", actorId: "a" });
		const byAll = await call("audit_list", {
			tool: "orders_refund",
			status: "refused",
			actorId: "a",
		});
		expect(byAll.entries.map((e: AuditEntry) => e.id)).toEqual([match.id]);

		const since = new Date(Date.now() - 4.5 * DAY_MS).toISOString();
		const until = new Date(Date.now() - 2.5 * DAY_MS).toISOString();
		const window = await call("audit_list", { tool: "orders_refund", since, until });
		expect(window.entries.map((e: AuditEntry) => e.tool)).toEqual([
			"orders_refund",
			"orders_refund",
		]);
		expect(window.entries.every((e: AuditEntry) => e.at >= since && e.at < until)).toBe(true);
	});

	test("cursor paging walks every entry once, and a cursor is bound to its filters", async () => {
		const seeded: AuditEntry[] = [];
		for (let i = 0; i < 7; i += 1) seeded.push(await seedEntry(10 - i, { tool: "orders_get" }));
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await call("audit_list", {
				tool: "orders_get",
				limit: 3,
				...(cursor === undefined ? {} : { cursor }),
			});
			seen.push(...page.entries.map((e: AuditEntry) => e.id));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor !== undefined && pages < 10);
		expect(pages).toBe(3);
		expect(seen).toEqual(seeded.map((e) => e.id).toReversed());

		const first = await call("audit_list", { tool: "orders_get", limit: 3 });
		expect(
			(await refusal("audit_list", { tool: "orders_list", cursor: first.nextCursor })).code,
		).toBe("INVALID_CURSOR");
		expect((await refusal("audit_list", { cursor: "not-a-cursor" })).code).toBe("INVALID_CURSOR");
	});

	test("a since that is not an instant, and a limit out of range, are refused", async () => {
		expect((await refusal("audit_list", { since: "last tuesday" })).code).toBe("INVALID_INPUT");
		expect((await refusal("audit_list", { limit: 101 })).code).toBe("INVALID_INPUT");
		expect((await refusal("audit_list", { limit: 0 })).code).toBe("INVALID_INPUT");
	});

	test("is read-only, and there is no tool to edit or delete an entry", () => {
		const tool = OTTA_MCP_TOOLS.find((t) => t.name === "audit_list");
		expect(tool?.destructive ?? false).toBe(false);
		expect(OTTA_MCP_TOOLS.filter((t) => t.name.startsWith("audit_")).map((t) => t.name)).toEqual([
			"audit_list",
		]);
	});
});

describe("(g) one-year retention, pruned at most 20 per call", () => {
	test("366 days old is pruned, 364 is kept, and one call prunes at most 20", async () => {
		const expired: AuditEntry[] = [];
		for (let i = 0; i < 25; i += 1) expired.push(await seedEntry(366 + i));
		const kept = await seedEntry(364);
		const cutoff = () => new Date(Date.now() - 365 * DAY_MS).toISOString();

		await call("settings_get", {});
		expect(await log().count({ at: { lt: cutoff() } })).toBe(5);
		// The oldest go first.
		for (const entry of expired.slice(5)) expect(await log().get(entry.id)).toBeNull();

		await call("settings_get", {});
		expect(await log().count({ at: { lt: cutoff() } })).toBe(0);
		expect(await log().get(kept.id)).not.toBeNull();
		expect(await log().count()).toBe(3);
	});

	test("a prune that fails is a warning, never a failed call", async () => {
		await seedEntry(400);
		const real = log();
		const failingDelete: PluginContext = {
			...harness.ctx,
			storage: {
				...harness.ctx.storage,
				[MCP_AUDIT_COLLECTION]: {
					...real,
					put: (id, data) => real.put(id, data),
					get: (id) => real.get(id),
					query: (options) => real.query(options),
					delete: () => Promise.reject(new Error("locked")),
				} as StorageCollection,
			},
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await call("settings_get", {}, { ctx: failingDelete })).toHaveProperty("currency");
		expect(warn).toHaveBeenCalled();
	});
});

describe("(h) the input is capped at 8 KB", () => {
	test("over the cap: a truncated marker, the original byte length and a preview", async () => {
		const body = "é".repeat(5000); // 10,000 UTF-8 bytes
		await refusal("orders_add_note", { orderId: "o-1", body });
		const entry = await only();
		const whole = JSON.stringify({ orderId: "o-1", body });
		expect(entry.input).toMatchObject({
			truncated: true,
			bytes: new TextEncoder().encode(whole).length,
		});
		const preview = (entry.input as { preview: string }).preview;
		expect(whole.startsWith(preview)).toBe(true);
		expect(preview.length).toBeLessThan(AUDIT_INPUT_MAX_BYTES);
	});

	test("at the cap: kept whole", async () => {
		const prefix = JSON.stringify({ orderId: "o-1", body: "" }).length;
		const input = { orderId: "o-1", body: "a".repeat(AUDIT_INPUT_MAX_BYTES - prefix) };
		expect(new TextEncoder().encode(JSON.stringify(input)).length).toBe(AUDIT_INPUT_MAX_BYTES);
		await call("orders_add_note", input).catch(() => undefined);
		expect((await only()).input).toEqual(input);
	});
});
