/**
 * `withMcp` turns the tool table into the two halves EmDash needs: a private
 * JSON POST route per tool, and the matching `mcp.tools` entry. EmDash drops a
 * tool SILENTLY when its route fails the registration checks
 * (`getPluginMcpTools` in `emdash-runtime.ts`: non-public, not `raw`,
 * `isJsonPostRouteContract`, a `permission` that is a real EmDash permission), so
 * these cases assert against EmDash's own predicates, not a restatement of them.
 */
import { Permissions } from "@emdash-cms/auth";
import { isJsonPostRouteContract } from "@emdash-cms/plugin-types";
import {
	createOttaPlugin,
	OTTA_PLUGIN_ID,
	OTTA_PLUGIN_VERSION,
	type PluginContext,
	type SandboxedPlugin,
} from "@urumi.ai/otta-plugin";
import { adaptSandboxEntry } from "emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
	defineTool,
	MCP_ROUTE_PREFIX,
	OTTA_MCP_TOOLS,
	ToolError,
	toolFailure,
	withMcp,
	type McpRouteEntry,
} from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

const echo = defineTool({
	name: "x",
	description: "Echo the input back, with who called.",
	input: z.object({ n: z.number().int() }).strict(),
	destructive: true,
	async run({ input, operator, clients }) {
		return { n: input.n, operator, hasOrders: typeof clients.orders.getOrder === "function" };
	},
});

const failing = defineTool({
	name: "y",
	description: "Always fails with a stable code.",
	input: z.object({}).strict(),
	async run() {
		toolFailure("NOT_FOUND", "No such thing.", { id: "abc" });
	},
});

function mcpRoute(plugin: SandboxedPlugin, name: string): McpRouteEntry {
	const route = plugin.routes?.[`${MCP_ROUTE_PREFIX}${name}`];
	if (route === undefined || typeof route === "function") {
		throw new Error(`no MCP route for ${name}`);
	}
	return route as McpRouteEntry;
}

function routeCtx(input: unknown, user?: { name?: string | null; email?: string | null }) {
	return {
		input,
		request: {
			method: "POST",
			url: "https://store.test/_emdash/api/plugins/otta/mcp/x",
			headers: {},
		},
		...(user !== undefined ? { user } : {}),
	};
}

describe("withMcp — the route and tool table", () => {
	const base = createOttaPlugin();

	test("keeps every original route key and does not mutate the plugin", () => {
		const routesBefore = { ...base.routes };
		const keysBefore = Object.keys(base.routes ?? {});
		const wrapped = withMcp(base, [echo]);

		expect(wrapped).not.toBe(base);
		// Every route kept as it is, but `admin`, which is wrapped to serve the
		// Audit log page too (audit-page.test.ts pins that it delegates the rest).
		for (const key of keysBefore.filter((k) => k !== "admin")) {
			expect(wrapped.routes[key]).toBe(routesBefore[key]);
		}
		expect(Object.keys(wrapped.routes)).toEqual([...keysBefore, "mcp/x"]);
		const admin = wrapped.routes["admin"] as { handler: unknown; public?: boolean };
		expect(admin.handler).not.toBe((routesBefore["admin"] as { handler: unknown }).handler);
		expect(admin.public).toBe(false);
		expect(Object.keys(base.routes ?? {})).toEqual(keysBefore);
		expect(base.routes).toEqual(routesBefore);
		expect("mcp" in base).toBe(false);
		expect(wrapped.hooks).toBe(base.hooks);
	});

	test("every added route is private, admin-only, JSON POST — EmDash's own checks pass", () => {
		const wrapped = withMcp(base, [echo, failing]);
		for (const name of ["x", "y"]) {
			const route = mcpRoute(wrapped, name);
			expect(route.public).toBe(false);
			expect(route.permission).toBe("plugins:manage");
			expect(Object.hasOwn(Permissions, route.permission)).toBe(true);
			expect(route.methods).toEqual(["POST"]);
			expect(route.request).toEqual({ body: "json" });
			expect(isJsonPostRouteContract(route)).toBe(true);
		}
	});

	test("mcp.tools carries description, route, input and destructive", () => {
		const wrapped = withMcp(base, [echo, failing]);
		expect(wrapped.mcp.tools.x).toEqual({
			description: echo.description,
			route: "mcp/x",
			input: echo.input,
			destructive: true,
		});
		expect(wrapped.mcp.tools.y?.route).toBe("mcp/y");
		expect(wrapped.mcp.tools.y?.destructive).toBe(false);
	});

	test("EmDash's adapter keeps every tool and its route contract (none dropped)", () => {
		const wrapped = withMcp(base, [echo, failing]);
		const resolved = adaptSandboxEntry(wrapped as never, {
			id: OTTA_PLUGIN_ID,
			version: OTTA_PLUGIN_VERSION,
			entrypoint: "@urumi.ai/otta-mcp/trusted",
			format: "standard",
		});
		expect(Object.keys(resolved.mcp?.tools ?? {}).toSorted()).toEqual(["x", "y"]);
		for (const tool of Object.values(resolved.mcp?.tools ?? {})) {
			const route = resolved.routes[tool.route];
			expect(route).toBeDefined();
			if (route === undefined) continue;
			expect(route.public).toBe(false);
			expect(route.permission).toBe("plugins:manage");
			expect(isJsonPostRouteContract(route)).toBe(true);
		}
	});

	test("a tool name colliding with an existing route throws", () => {
		const taken: SandboxedPlugin = {
			routes: { "mcp/x": { handler: async () => ({}) } },
		};
		expect(() => withMcp(taken, [echo])).toThrow(/mcp\/x/);
	});

	test("two tools with one name throw", () => {
		expect(() => withMcp(base, [echo, { ...echo }])).toThrow(/x/);
	});

	test("a name that is not snake_case throws", () => {
		expect(() => withMcp(base, [{ ...echo, name: "Orders-List" }])).toThrow(/Orders-List/);
	});

	test("a tool whose input is not a strict object throws, naming the tool", () => {
		expect(() => withMcp(base, [{ ...echo, input: z.object({ n: z.number() }) }])).toThrow(
			/"x".*strict/,
		);
		expect(() =>
			withMcp(base, [{ ...echo, input: z.object({ n: z.number() }).passthrough() }]),
		).toThrow(/"x".*strict/);
		expect(() => withMcp(base, [{ ...echo, input: z.string() as never }])).toThrow(
			/"x".*strict object/,
		);
	});

	test("a NESTED object that is not strict throws too, naming its path", () => {
		const nested = (inner: z.ZodTypeAny) => ({
			...echo,
			input: z.object({ n: z.number(), m: inner }).strict(),
		});
		expect(() => withMcp(base, [nested(z.object({ a: z.number() }).optional())])).toThrow(
			/"x".*\bm\b/,
		);
		expect(() => withMcp(base, [nested(z.array(z.object({ a: z.number() })))])).toThrow(/"x"/);
		expect(() =>
			withMcp(base, [
				nested(
					z.discriminatedUnion("k", [
						z.object({ k: z.literal("a") }).strict(),
						z.object({ k: z.literal("b") }),
					]),
				),
			]),
		).toThrow(/"x"/);
		expect(() =>
			withMcp(base, [nested(z.object({ a: z.number() }).strict().nullable().default(null))]),
		).not.toThrow();
	});

	test("the default table is OTTA_MCP_TOOLS", () => {
		const wrapped = withMcp(base);
		expect(Object.keys(wrapped.mcp.tools)).toEqual(OTTA_MCP_TOOLS.map((t) => t.name));
	});
});

describe("withMcp — the route handler", () => {
	let harness: AdminHarness;
	let ctx: PluginContext;

	beforeAll(async () => {
		harness = await makeAdminHarness();
		ctx = harness.ctx;
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("valid input runs the tool with the admin clients and the signed-in operator", async () => {
		const route = mcpRoute(withMcp(createOttaPlugin(), [echo]), "x");
		const out = await route.handler(
			routeCtx({ n: 7 }, { name: "  Ada  ", email: "a@x.test" }),
			ctx,
		);
		expect(out).toEqual({ n: 7, operator: "Ada", hasOrders: true });
	});

	test("the operator falls back to the email, and is undefined with nobody named", async () => {
		const route = mcpRoute(withMcp(createOttaPlugin(), [echo]), "x");
		expect(await route.handler(routeCtx({ n: 1 }, { name: null, email: "a@x.test" }), ctx)).toEqual(
			{ n: 1, operator: "a@x.test", hasOrders: true },
		);
		expect(await route.handler(routeCtx({ n: 1 }), ctx)).toEqual({
			n: 1,
			operator: undefined,
			hasOrders: true,
		});
	});

	test("invalid input fails with code INVALID_INPUT and runs nothing", async () => {
		let ran = false;
		const spy = defineTool({ ...echo, run: async () => ((ran = true), {}) });
		const route = mcpRoute(withMcp(createOttaPlugin(), [spy]), "x");
		const failure = await route.handler(routeCtx({ n: "seven" }), ctx).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ToolError);
		expect((failure as ToolError).code).toBe("INVALID_INPUT");
		expect((failure as ToolError).details).toMatchObject({ issues: [{ path: "n" }] });
		expect(ran).toBe(false);
	});

	test("a ToolError reaches EmDash as a failed route with its code kept", async () => {
		const route = mcpRoute(withMcp(createOttaPlugin(), [failing]), "y");
		const failure = await route.handler(routeCtx({}), ctx).then(
			() => undefined,
			(error: unknown) => error,
		);
		// EmDash's `isPluginRouteError` (plugins/route-error.ts) matches ON SHAPE —
		// an Error named "PluginRouteError" with a string `code` and numeric
		// `status` — and turns it into `{ success: false, error: { code, message,
		// details } }`, which the MCP server's `unwrap` returns as a tool error with
		// `_meta.code`. Anything else becomes INTERNAL_ERROR, losing the code.
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({
			name: "PluginRouteError",
			code: "NOT_FOUND",
			message: "No such thing.",
			status: 404,
			details: { id: "abc" },
		});
	});
});
