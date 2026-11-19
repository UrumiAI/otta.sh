/**
 * The Audit log admin page, through the plugin's real `admin` route as `withMcp`
 * wraps it: its own interactions render the log (Block Kit only), with the
 * `audit_list` filters and a "Load more" that keeps them; every other admin
 * interaction reaches the plugin's own handler unchanged.
 */
import {
	createOttaPlugin,
	MCP_AUDIT_COLLECTION,
	MCP_AUDIT_PAGE,
	type Block,
	type BlockResponse,
	type RouteEntry,
} from "@urumi.ai/otta-plugin";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newAuditId } from "../src/audit.js";
import { AUDIT_PAGE_ACTIONS, withMcp, type AuditEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

const DAY_MS = 86_400_000;
const base = createOttaPlugin();
const plugin = withMcp(base);

let harness: AdminHarness;
beforeAll(async () => {
	harness = await makeAdminHarness();
}, 120_000);
beforeEach(async () => {
	await harness.reset();
});
afterAll(async () => {
	await harness?.close();
});

function handlerOf(entry: RouteEntry | undefined) {
	if (entry === undefined) throw new Error("no admin route");
	return typeof entry === "function" ? entry : entry.handler;
}

async function admin(input: unknown, routes = plugin.routes): Promise<BlockResponse> {
	return (await handlerOf(routes["admin"])(
		{ input, request: { method: "POST", url: "http://x", headers: {} }, user: { name: "Ada" } },
		harness.ctx,
	)) as BlockResponse;
}

async function seed(ageDays: number, fields: Partial<AuditEntry> = {}): Promise<AuditEntry> {
	const ms = Date.now() - ageDays * DAY_MS;
	const entry: AuditEntry = {
		id: newAuditId(ms),
		at: new Date(ms).toISOString(),
		actor: { id: "u1", email: "ada@store.test", name: "Ada", role: 50 },
		actorId: "u1",
		ip: null,
		userAgent: null,
		tool: "coupons_create",
		input: { code: "SAVE10" },
		status: "ok",
		...fields,
	};
	await harness.ctx.storage?.[MCP_AUDIT_COLLECTION]?.put(entry.id, entry);
	return entry;
}

function table(response: BlockResponse) {
	const found = response.blocks.find((b: Block) => b.type === "table");
	if (found === undefined || found.type !== "table") throw new Error("no table");
	return found;
}

describe("the Audit log page", () => {
	test("page_load renders the log, newest first: time, user email, tool, status/code, input", async () => {
		await seed(2, {
			tool: "coupons_get",
			status: "refused",
			code: "NOT_FOUND",
			input: { code: "X" },
		});
		await seed(1);
		const response = await admin({ type: "page_load", page: MCP_AUDIT_PAGE.path });
		expect(response.blocks[0]).toEqual({ type: "header", text: "Audit log" });
		const rows = table(response).rows;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			user: "ada@store.test",
			tool: "coupons_create",
			status: "ok",
			input: '{"code":"SAVE10"}',
		});
		expect(rows[0]?.["at"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
		expect(rows[1]).toMatchObject({ tool: "coupons_get", status: "refused: NOT_FOUND" });
		// Block Kit only: nothing here is a React page.
		expect(JSON.stringify(response)).not.toContain("adminEntry");
	});

	test("an empty log says so", async () => {
		const response = await admin({ type: "page_load", page: MCP_AUDIT_PAGE.path });
		expect(table(response).rows).toEqual([]);
		expect(table(response).empty_text).toMatch(/No MCP tool calls yet/);
	});

	test("the filter form filters, and Load more keeps the filters", async () => {
		for (let i = 0; i < 30; i += 1) await seed(40 - i, { tool: "orders_get" });
		await seed(1, { tool: "coupons_create" });
		const first = await admin({
			type: "form_submit",
			action_id: AUDIT_PAGE_ACTIONS.filter,
			page: MCP_AUDIT_PAGE.path,
			values: { tool: "orders_get", status: "ok", actorId: "", since: "", until: "" },
		});
		const page1 = table(first);
		expect(page1.rows).toHaveLength(25);
		expect(page1.rows.every((r) => r["tool"] === "orders_get")).toBe(true);
		expect(page1.next_cursor).toBeTypeOf("string");

		const more = await admin({
			type: "block_action",
			action_id: AUDIT_PAGE_ACTIONS.page,
			page: MCP_AUDIT_PAGE.path,
			value: { cursor: page1.next_cursor },
		});
		const page2 = table(more);
		expect(page2.rows).toHaveLength(5);
		expect(page2.rows.every((r) => r["tool"] === "orders_get")).toBe(true);
		expect(page2.next_cursor).toBeUndefined();
	});

	test("a date range by day, and a bound that is not a date, which says so", async () => {
		await seed(10);
		const inside = await seed(5);
		const day = inside.at.slice(0, 10);
		const response = await admin({
			type: "form_submit",
			action_id: AUDIT_PAGE_ACTIONS.filter,
			values: { since: day, until: day },
		});
		expect(table(response).rows).toHaveLength(1);

		const bad = await admin({
			type: "form_submit",
			action_id: AUDIT_PAGE_ACTIONS.filter,
			values: { since: "yesterday-ish" },
		});
		expect(bad.blocks.some((b) => b.type === "banner" && b.variant === "error")).toBe(true);
		expect(bad.blocks.some((b) => b.type === "table")).toBe(false);
	});

	test("a started entry reads as outcome unknown", async () => {
		await seed(1, { status: "started" });
		const rows = table(await admin({ type: "page_load", page: MCP_AUDIT_PAGE.path })).rows;
		expect(rows[0]?.["status"]).toBe("started (outcome unknown)");
	});
});

describe("every other admin interaction reaches the plugin's own handler", () => {
	test("an unknown page answers as the plugin does", async () => {
		const input = { type: "page_load", page: "/no-such-page" };
		expect(await admin(input)).toEqual(await admin(input, base.routes ?? {}));
	});

	test("an unrecognized interaction answers as the plugin does", async () => {
		const input = { type: "block_action", action_id: "nobody:owns-this" };
		expect(await admin(input)).toEqual(await admin(input, base.routes ?? {}));
	});

	test("without withMcp, the plugin has no Audit log page", async () => {
		const own = await admin({ type: "page_load", page: MCP_AUDIT_PAGE.path }, base.routes ?? {});
		expect(own.blocks[0]).toEqual({ type: "header", text: "Page not found" });
	});
});
