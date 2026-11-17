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
 *
 * The error contract: an Otta-raised refusal (`coupons_get` of a code that is
 * not there) arrives as `isError` with `_meta.code: "NOT_FOUND"`, end to end.
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

/** Revoke a token, and fail loudly if the host did not: a revoke that silently
 *  failed would leave an admin-capable token live. */
async function revokeToken(headers: Record<string, string>, id: string): Promise<void> {
	const res = await fetch(`${API_TOKENS}/${id}`, { method: "DELETE", headers });
	const body = await res.text();
	expect(res.ok, `revoke token ${id} → HTTP ${res.status}: ${body.slice(0, 300)}`).toBe(true);
}

/** An Otta-raised refusal as the agent sees it: a tool error, its code in `_meta.code`. */
function expectRefusal(result: ToolResult, code: string): void {
	expect(result.isError, `expected ${code}, got ${JSON.stringify(result).slice(0, 400)}`).toBe(
		true,
	);
	expect(result["_meta"]?.code).toBe(code);
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
		let unscoped: { id: string; token: string } | undefined;
		let couponId: string | undefined;
		let couponDeleted = false;
		const cleanupFailures: string[] = [];
		try {
			unscoped = await createToken(headers, `otta-e2e-admin-${stamp}`, ["admin"]);
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
			couponId = (created["coupon"] as { id: string }).id;
			expect(toolData(await callTool(scoped.token, "otta__coupons_get", { code }))).toMatchObject({
				id: couponId,
				code,
			});
			const deleted = toolData(await callTool(scoped.token, "otta__coupons_delete", { couponId }));
			expect(deleted).toEqual({ status: "deleted" });
			couponDeleted = true;

			// 6. An OTTA-raised refusal through the real endpoint: the tool throws a
			// ToolError, EmDash's route layer must recognise it (`isPluginRouteError`)
			// and the MCP server must unwrap it as `isError` with `_meta.code`. The
			// canary for that contract on the next EmDash bump. The re-read is also
			// the proof the delete happened, not just what it answered.
			expectRefusal(await callTool(scoped.token, "otta__coupons_get", { code }), "NOT_FOUND");
			expectRefusal(
				await callTool(scoped.token, "otta__coupons_delete", { couponId }),
				"NOT_FOUND",
			);
			expectRefusal(
				await callTool(scoped.token, "otta__coupons_get", { code: `NOPE-${stamp}` }),
				"NOT_FOUND",
			);

			// 7. Review Focus 5: `admin` is not `mcp:tools:otta`.
			await initialize(unscoped.token);
			const refused = await callTool(unscoped.token, "otta__settings_get", {});
			expectRefusal(refused, "INSUFFICIENT_SCOPE");

			// 8. No token at all: refused before MCP.
			const anonymous = await fetch(MCP, {
				method: "POST",
				headers: {
					...setupClaimHeaders(E2E_BASE_URL),
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
			});
			expect(anonymous.status).toBe(401);
		} finally {
			// Cleanup runs whatever failed above, every step even if one throws:
			// the coupon first (it needs the scoped token), then both tokens.
			const cleanup: Array<() => Promise<void>> = [];
			if (couponId !== undefined && !couponDeleted) {
				const id = couponId;
				cleanup.push(async () => {
					await callTool(scoped.token, "otta__coupons_delete", { couponId: id });
				});
			}
			cleanup.push(() => revokeToken(headers, scoped.id));
			if (unscoped !== undefined) {
				const id = unscoped.id;
				cleanup.push(() => revokeToken(headers, id));
			}
			for (const step of cleanup) {
				try {
					await step();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`[otta-e2e] mcp cleanup failed: ${message}`);
					cleanupFailures.push(message);
				}
			}
		}
		// Reached only when the body passed: a failed cleanup (a token left live)
		// then fails the test too. Had the body failed, its error stands and the
		// cleanup failures are logged above.
		expect(cleanupFailures).toEqual([]);
	});
});
