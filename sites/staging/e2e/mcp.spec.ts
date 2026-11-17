/**
 * `@urumi.ai/otta-mcp` through EmDash's REAL MCP endpoint (ADR-0046): the
 * staging site opts in with `otta({ mcp: true })`, and an agent's view of the
 * store is exactly what `/_emdash/api/mcp` serves to an API token.
 *
 * The test drives EmDash's own admin API, never the UI, the way an operator's
 * first session would:
 *  1. turn on Otta's MCP tools, which records the admin's consent to the tool
 *     list (`PUT /_emdash/api/admin/plugins/otta/mcp`);
 *  2. mint an API token with scope `mcp:tools:otta`, and one with only `admin`;
 *  3. speak MCP's Streamable HTTP transport (JSON-RPC 2.0, stateless) with each.
 *
 * Review Focus 5: a token without the plugin-tool scope is refused with
 * `INSUFFICIENT_SCOPE`, even one with `admin` (EmDash checks the plugin scope
 * before its `admin` shortcut).
 */
import { setupClaimHeaders } from "../../store/scripts/setup-claim-cookie.js";
import { adminHeaders } from "./admin-rules.js";
import { E2E_BASE_URL, expect, skipWithoutSite, test } from "./harness.js";

const MCP = `${E2E_BASE_URL}/_emdash/api/mcp`;
const PLUGIN_MCP = `${E2E_BASE_URL}/_emdash/api/admin/plugins/otta/mcp`;
const API_TOKENS = `${E2E_BASE_URL}/_emdash/api/admin/api-tokens`;

/** The JSON-RPC envelope an MCP response carries. */
interface RpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

/** A `tools/call` result: content, optional structured data, and a refusal's `_meta.code`. */
interface ToolResult {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: { code?: string };
}

interface ToolListing {
	tools: Array<{ name: string; annotations?: { destructiveHint?: boolean } }>;
}

/**
 * The Streamable HTTP transport answers a POST either as JSON or as an SSE
 * stream, whichever the server picks (EmDash's stateless server picks SSE). Both
 * carry the same JSON-RPC envelope; this reads it out of either.
 */
function parseRpc(contentType: string, body: string): RpcResponse {
	if (contentType.includes("text/event-stream")) {
		const data = body
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.filter((line) => line !== "");
		const last = data.at(-1);
		if (last === undefined) throw new Error(`MCP SSE response had no data line: ${body}`);
		return JSON.parse(last) as RpcResponse;
	}
	return JSON.parse(body) as RpcResponse;
}

let rpcId = 0;

async function rpc(token: string, method: string, params: unknown): Promise<RpcResponse> {
	const res = await fetch(MCP, {
		method: "POST",
		headers: {
			...setupClaimHeaders(E2E_BASE_URL),
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	const body = await res.text();
	expect(res.status, `MCP ${method} → HTTP ${res.status}: ${body.slice(0, 300)}`).toBe(200);
	const envelope = parseRpc(res.headers.get("content-type") ?? "", body);
	expect(envelope.error, `MCP ${method} JSON-RPC error`).toBeUndefined();
	return envelope;
}

async function initialize(token: string): Promise<void> {
	const init = await rpc(token, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "otta-e2e", version: "0.0.0" },
	});
	expect(init.result?.["serverInfo"]).toMatchObject({ name: "emdash" });
}

async function callTool(token: string, name: string, args: unknown): Promise<ToolResult> {
	const res = await rpc(token, "tools/call", { name, arguments: args });
	return res.result as ToolResult;
}

/** A successful tool result's data: the structured content, or the JSON text. */
function toolData(result: ToolResult): Record<string, unknown> {
	expect(result.isError, `tool refused: ${JSON.stringify(result).slice(0, 400)}`).not.toBe(true);
	if (result.structuredContent !== undefined) return result.structuredContent;
	const text = result.content?.find((c) => c.type === "text")?.text ?? "";
	return JSON.parse(text) as Record<string, unknown>;
}

async function createToken(
	headers: Record<string, string>,
	name: string,
	scopes: string[],
): Promise<{ id: string; token: string }> {
	const res = await fetch(API_TOKENS, {
		method: "POST",
		headers,
		body: JSON.stringify({ name, scopes }),
	});
	const body = await res.text();
	expect(res.status, `create token ${scopes.join(",")} → ${body.slice(0, 300)}`).toBe(201);
	const { data } = JSON.parse(body) as { data: { token: string; info: { id: string } } };
	expect(data.token).toMatch(/^ec_pat_/);
	return { id: data.info.id, token: data.token };
}

async function revokeToken(headers: Record<string, string>, id: string): Promise<void> {
	await fetch(`${API_TOKENS}/${id}`, { method: "DELETE", headers });
}

test.describe("otta-mcp through /_emdash/api/mcp", () => {
	test.slow();

	test("an admin enables the tools, and a scoped token runs them; an unscoped one is refused", async () => {
		await skipWithoutSite(test.info());
		const headers = await adminHeaders();

		// 1. Enable + consent (the admin switch's own API call).
		const enable = await fetch(PLUGIN_MCP, {
			method: "PUT",
			headers,
			body: JSON.stringify({ enabled: true }),
		});
		const enableBody = await enable.text();
		expect(enable.status, `enable Otta MCP tools → ${enableBody.slice(0, 300)}`).toBe(200);
		const enabled = JSON.parse(enableBody) as {
			data: { enabled: boolean; tools: Array<{ mcpName?: string; name: string }> };
		};
		expect(enabled.data.enabled).toBe(true);
		expect(enabled.data.tools.map((t) => t.name)).toContain("orders_refund");

		// 2. Tokens: the plugin-tool scope, and `admin` alone.
		const stamp = Date.now().toString(36);
		const scoped = await createToken(headers, `otta-e2e-mcp-${stamp}`, ["mcp:tools:otta"]);
		const unscoped = await createToken(headers, `otta-e2e-admin-${stamp}`, ["admin"]);
		try {
			await initialize(scoped.token);

			// 3. tools/list carries the Otta tools, destructive ones flagged.
			const listing = (await rpc(scoped.token, "tools/list", {})).result as unknown as ToolListing;
			const names = listing.tools.map((t) => t.name);
			expect(names).toContain("otta__orders_list");
			expect(names).toContain("otta__orders_refund");
			const refund = listing.tools.find((t) => t.name === "otta__orders_refund");
			expect(refund?.annotations?.destructiveHint).toBe(true);

			// 4. A read.
			const settings = toolData(await callTool(scoped.token, "otta__settings_get", {}));
			expect(settings).toHaveProperty("currency");

			// 5. A write and a destructive write, round trip.
			const code = `MCPE2E${stamp.toUpperCase()}`;
			const created = toolData(
				await callTool(scoped.token, "otta__coupons_create", {
					code,
					type: "percentage",
					rateBps: 1000,
				}),
			);
			expect(created["status"]).toBe("created");
			const couponId = (created["coupon"] as { id: string }).id;
			const deleted = toolData(await callTool(scoped.token, "otta__coupons_delete", { couponId }));
			expect(deleted).toEqual({ status: "deleted" });

			// 6. Review Focus 5: `admin` is not `mcp:tools:otta`.
			await initialize(unscoped.token);
			const refused = await callTool(unscoped.token, "otta__settings_get", {});
			expect(refused.isError).toBe(true);
			expect(refused["_meta"]?.code).toBe("INSUFFICIENT_SCOPE");
		} finally {
			await revokeToken(headers, scoped.id);
			await revokeToken(headers, unscoped.id);
		}
	});
});
