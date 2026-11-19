/**
 * The `mcp` opt-in on the Otta plugin descriptor (ADR-0046). Off by default, and
 * when it is off the descriptor is exactly today's. On, the entrypoint is the
 * same plugin wrapped by `@urumi.ai/otta-mcp`, and the add-on's audit log is
 * declared (its collection and its page); the id, capabilities and allowed hosts
 * stay the same. The rest of the descriptor is
 * pinned field by field in `sites/staging/test/site-config.test.ts`.
 */
import { OTTA_MCP_TOOLS } from "@urumi.ai/otta-mcp";
import {
	COMMERCE_STORAGE_COLLECTIONS,
	MCP_AUDIT_PAGE,
	MCP_AUDIT_STORAGE_COLLECTIONS,
} from "@urumi.ai/otta-plugin";
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

	test("true: the otta-mcp entry, plus the audit log's collection and page; nothing else differs", () => {
		const egress = { extraAllowedHosts: "x.example.com" };
		const plain = ottaPluginDescriptor({ egress });
		const withMcp = ottaPluginDescriptor({ egress, mcp: true });
		expect(withMcp.entrypoint).toBe(MCP_ENTRY);
		expect(withMcp).toEqual({
			...plain,
			entrypoint: MCP_ENTRY,
			storage: { ...COMMERCE_STORAGE_COLLECTIONS, ...MCP_AUDIT_STORAGE_COLLECTIONS },
			adminPages: [...(plain.adminPages ?? []), MCP_AUDIT_PAGE],
		});
		// The audit collection is new: it shadows no commerce collection.
		for (const name of Object.keys(MCP_AUDIT_STORAGE_COLLECTIONS)) {
			expect(Object.hasOwn(COMMERCE_STORAGE_COLLECTIONS, name), name).toBe(false);
		}
	});

	test("the otta-mcp entry is the Otta plugin's trusted entry, with the MCP tools added", async () => {
		type Entry = {
			hooks?: unknown;
			routes?: Record<string, unknown>;
			mcp?: { tools?: Record<string, unknown> };
		};
		const wrapped = (await import("@urumi.ai/otta-mcp/trusted")).default as Entry;
		const plain = (await import("@urumi.ai/otta-plugin/trusted")).default as Entry;
		// The same plugin: its hooks unchanged, every route of its own kept as it is
		// but `admin`, which also serves the Audit log page.
		expect(wrapped.hooks).toBe(plain.hooks);
		for (const [name, route] of Object.entries(plain.routes ?? {})) {
			if (name === "admin") continue;
			expect(wrapped.routes?.[name], name).toBe(route);
		}
		expect(wrapped.routes?.["admin"]).toBeDefined();
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
