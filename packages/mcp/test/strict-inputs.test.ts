/**
 * Every tool's input is STRICT: an unknown key — a typo such as `maxUse` for
 * `maxUses`, or `expectedAmountCent` — is refused with INVALID_INPUT, never
 * dropped. A dropped key turns a reasonable agent's typo into a write that
 * reports success (an unlimited coupon, a disabled compare-and-set guard).
 * `withMcp` also refuses a non-strict input at construction (with-mcp.test.ts);
 * this table pins the refusal for every tool through its real route.
 */
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import { afterAll, beforeAll, expect, test } from "vitest";
import { OTTA_MCP_TOOLS, ToolError, withMcp, type McpRouteEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

let harness: AdminHarness;
const plugin = withMcp(createOttaPlugin());

beforeAll(async () => {
	harness = await makeAdminHarness();
});
afterAll(async () => {
	expect(harness.egressAttempts()).toBe(0);
	await harness?.close();
});

test("the table is not empty (the loop below is not vacuous)", () => {
	expect(OTTA_MCP_TOOLS.length).toBeGreaterThan(40);
});

test.each(OTTA_MCP_TOOLS.map((tool) => [tool.name, tool] as const))(
	"%s refuses an unknown key with INVALID_INPUT",
	async (name, tool) => {
		const route = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
		if (route === undefined) throw new Error(`no route mcp/${name}`);
		const failure = await route
			.handler(
				{
					input: { zzUnknownKey: 1 },
					request: new Request("http://x"),
					user: { name: "Ada" },
				} as never,
				harness.ctx,
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(ToolError);
		expect((failure as ToolError).code).toBe("INVALID_INPUT");
		const issues = ((failure as ToolError).details as { issues: { message: string }[] }).issues;
		expect(issues.some((issue) => /unrecognized key|unknown key/i.test(issue.message))).toBe(true);
		// A secret tool's refusal names no key the caller sent.
		if (tool.sensitiveInput === true) {
			expect(JSON.stringify(failure)).not.toContain("zzUnknownKey");
			expect((failure as ToolError).message).not.toContain("zzUnknownKey");
		}
	},
);
