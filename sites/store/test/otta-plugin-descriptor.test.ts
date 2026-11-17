/**
 * The `mcp` opt-in on the Otta plugin descriptor (ADR-0046). Off by default, and
 * when it is off the descriptor is exactly today's. On, the one change is the
 * entrypoint: the same plugin, wrapped by `@urumi.ai/otta-mcp`, under the same
 * id, storage, capabilities and allowed hosts. The rest of the descriptor is
 * pinned field by field in `sites/staging/test/site-config.test.ts`.
 */
import { OTTA_MCP_TOOLS } from "@urumi.ai/otta-mcp";
import { describe, expect, test } from "vitest";
import { buildEmdashOptions } from "../src/emdash-options.js";
import { ottaPluginDescriptor } from "../src/otta-plugin-descriptor.js";

const PLUGIN_ENTRY = "@urumi.ai/otta-plugin/trusted";
const MCP_ENTRY = "@urumi.ai/otta-mcp/trusted";

describe("ottaPluginDescriptor's mcp option", () => {
	test("unset or false: the plugin's own trusted entry, and every field as before", () => {
		const today = ottaPluginDescriptor();
		expect(today.entrypoint).toBe(PLUGIN_ENTRY);
		expect(ottaPluginDescriptor({ mcp: false })).toEqual(today);
		expect(ottaPluginDescriptor({ egress: {}, mcp: false })).toEqual(
			ottaPluginDescriptor({ egress: {} }),
		);
	});

	test("true: only the entrypoint differs, and it names the otta-mcp trusted entry", () => {
		const egress = { extraAllowedHosts: "x.example.com" };
		const plain = ottaPluginDescriptor({ egress });
		const withMcp = ottaPluginDescriptor({ egress, mcp: true });
		expect(withMcp.entrypoint).toBe(MCP_ENTRY);
		expect(withMcp).toEqual({ ...plain, entrypoint: MCP_ENTRY });
	});

	test("the otta-mcp entry is the Otta plugin's trusted entry, with the MCP tools added", async () => {
		type Entry = {
			hooks?: unknown;
			routes?: Record<string, unknown>;
			mcp?: { tools?: Record<string, unknown> };
		};
		const wrapped = (await import("@urumi.ai/otta-mcp/trusted")).default as Entry;
		const plain = (await import("@urumi.ai/otta-plugin/trusted")).default as Entry;
		// The same plugin: its hooks unchanged, every route of its own kept as it is.
		expect(wrapped.hooks).toBe(plain.hooks);
		for (const [name, route] of Object.entries(plain.routes ?? {})) {
			expect(wrapped.routes?.[name], name).toBe(route);
		}
		// Plus one tool per table entry, each on its own private route.
		expect(Object.keys(wrapped.mcp?.tools ?? {}).toSorted()).toEqual(
			OTTA_MCP_TOOLS.map((tool) => tool.name).toSorted(),
		);
		expect(Object.keys(wrapped.routes ?? {})).toHaveLength(
			Object.keys(plain.routes ?? {}).length + OTTA_MCP_TOOLS.length,
		);
	});
});

describe("buildEmdashOptions threads mcp into the Otta descriptor", () => {
	test("default: the registered descriptor is today's", () => {
		expect(buildEmdashOptions({}).plugins[0]).toEqual(ottaPluginDescriptor({ egress: {} }));
		expect(buildEmdashOptions({}, undefined, { mcp: false }).plugins[0]).toEqual(
			ottaPluginDescriptor({ egress: {} }),
		);
	});

	test("mcp: true registers the otta-mcp entry, and changes nothing else", () => {
		const plain = buildEmdashOptions({});
		const opted = buildEmdashOptions({}, undefined, { mcp: true });
		expect(opted.plugins[0]).toEqual(ottaPluginDescriptor({ egress: {}, mcp: true }));
		expect(opted.plugins.slice(1)).toEqual(plain.plugins.slice(1));
		expect(opted.database).toEqual(plain.database);
		expect(opted.storage).toEqual(plain.storage);
	});
});
