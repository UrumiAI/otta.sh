/**
 * `otta({ mcp })` end to end through the real `astro:config:setup` hook
 * (ADR-0046): the option reaches the descriptor EmDash registers, and the Vite
 * settings, and nothing else moves.
 *
 * `emdash/astro` is replaced by a recorder. `emdash()` keeps its options in a
 * closure, so the registered descriptor is otherwise unreachable from a test
 * (see site-config.test.ts); the recorder is the only stand-in here, and the
 * hook, the guards and the descriptor builder all run for real.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginDescriptor } from "emdash";
import { afterEach, describe, expect, test, vi } from "vitest";

const recorded = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("emdash/astro", () => ({
	default: (options: unknown) => {
		recorded.options.push(options);
		return { name: "emdash", hooks: {} };
	},
}));

const { default: otta } = await import("../src/integration.js");

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	recorded.options.length = 0;
});

/** A project root the whole setup hook accepts: every peer at the version this
 *  package resolves (otta-mcp included), a wrangler config, the seed, the live
 *  config and an empty public/. */
function site(): string {
	const root = mkdtempSync(path.join(tmpdir(), "otta-mcp-site-"));
	dirs.push(root);
	const { peerDependencies } = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as {
		peerDependencies: Record<string, string>;
	};
	for (const name of Object.keys(peerDependencies)) {
		const manifest = path.join(PKG, "node_modules", ...name.split("/"), "package.json");
		const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
		const dir = path.join(root, "node_modules", ...name.split("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
	}
	writeFileSync(path.join(root, "wrangler.jsonc"), "{}");
	mkdirSync(path.join(root, "seed"));
	writeFileSync(path.join(root, "seed", "seed.json"), "{}");
	mkdirSync(path.join(root, "src"));
	writeFileSync(
		path.join(root, "src", "live.config.ts"),
		"export const collections = ottaLiveCollections(defineLiveCollection);",
	);
	mkdirSync(path.join(root, "public"));
	return root;
}

interface Setup {
	descriptor: PluginDescriptor | undefined;
	noExternal: unknown[];
}

function runSetup(mcp: boolean | undefined): Setup {
	const root = site();
	const updates: Record<string, unknown>[] = [];
	const setup = otta({ template: 1, env: {}, ...(mcp === undefined ? {} : { mcp }) }).hooks[
		"astro:config:setup"
	] as (o: unknown) => void;
	setup({
		config: { root: pathToFileURL(`${root}/`), publicDir: pathToFileURL(`${root}/public/`) },
		updateConfig: (update: Record<string, unknown>) => updates.push(update),
		injectRoute: () => {},
		addMiddleware: () => {},
	});
	const options = recorded.options.at(-1) as { plugins?: PluginDescriptor[] } | undefined;
	const vite = updates.find((u) => u["vite"] !== undefined)?.["vite"] as {
		ssr?: { noExternal?: unknown[] };
	};
	return { descriptor: options?.plugins?.[0], noExternal: vite.ssr?.noExternal ?? [] };
}

describe("otta({ mcp }) through the setup hook", () => {
	test("unset: the Otta plugin's own entry, and otta-mcp is not bundled", () => {
		const { descriptor, noExternal } = runSetup(undefined);
		expect(descriptor?.entrypoint).toBe("@urumi.ai/otta-plugin/trusted");
		expect(noExternal).not.toContain("@urumi.ai/otta-mcp");
	});

	test("false is the same build as unset", () => {
		const unset = runSetup(undefined);
		const off = runSetup(false);
		expect(off).toEqual(unset);
	});

	test("true: the otta-mcp entry is registered and bundled with the plugin; nothing else moves", () => {
		const unset = runSetup(undefined);
		const on = runSetup(true);
		// The entry, and the audit log's collection and page (pinned in
		// otta-plugin-descriptor.test.ts).
		expect(on.descriptor).toEqual({
			...unset.descriptor,
			entrypoint: "@urumi.ai/otta-mcp/trusted",
			storage: on.descriptor?.storage,
			adminPages: on.descriptor?.adminPages,
		});
		expect(Object.keys(on.descriptor?.storage ?? {})).toEqual([
			...Object.keys(unset.descriptor?.storage ?? {}),
			"mcp_audit",
		]);
		expect(on.descriptor?.adminPages?.map((p) => p.path)).toEqual([
			...(unset.descriptor?.adminPages ?? []).map((p) => p.path),
			"/mcp-audit",
		]);
		// Bundled for the plugin's own reason: it imports @urumi.ai/otta-plugin, and
		// an externalized copy would load a second plugin without the build defines.
		expect(on.noExternal).toEqual([...unset.noExternal, "@urumi.ai/otta-mcp"]);
	});
});
