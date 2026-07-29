import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	createListDetailHandler,
	customAction,
	leafLevel,
	listLevel,
	screenActions,
	type ListDetailInput,
} from "../src/admin/scaffold/index.js";
import type { Block, BlockResponse, PluginContext } from "../src/types.js";

/**
 * THE LAST-RESORT CONTAINMENT NET, path by path.
 *
 * `createListDetailHandler` must never let an exception escape: a throw becomes a
 * non-2xx from the plugin route, and a non-2xx replaces the whole `BlockRenderer`
 * tree with a raw status panel — unmounting every accordion and tab, and telling an
 * operator nothing about whether their action applied.
 *
 * The inner catches (a list level's, a leaf level's, a custom action's) are covered
 * against the REAL workerd sandbox in `admin-scaffold-list-detail.sandbox.test.ts`.
 * This suite covers the paths NO inner try can reach, which the geo fixture cannot
 * express because its `createClient`/`parseOpen`/`filterFromValues` are infallible
 * and its `onError`s never throw: those five paths, plus the compound
 * custom-action-then-fallback double fault. Driven IN PROCESS — the subject is the
 * handler's own control flow, and there is no IO to sandbox (the "client" is a
 * literal).
 */

/** A `PluginContext` the handler only ever hands to `createClient`. */
const CTX = { http: { fetch: () => Promise.reject(new Error("no egress in this suite")) }, kv: {} };
function ctx(): PluginContext {
	return CTX as unknown as PluginContext;
}

function routeCtx(input: ListDetailInput) {
	return { input, request: { method: "POST", url: "http://127.0.0.1/admin", headers: {} } };
}

const OK_BLOCKS: Block[] = [{ type: "header", text: "Healthy" }];

/** A minimal healthy screen, with one member swapped for a throwing one. */
function screen(
	entity: string,
	overrides: {
		createClient?: () => unknown;
		parseOpen?: () => { targetPath: readonly string[] } | undefined;
		filterFromValues?: () => unknown;
		listOnError?: () => BlockResponse;
		leafLoad?: () => Promise<unknown>;
		leafOnError?: () => BlockResponse;
		custom?: () => Promise<BlockResponse>;
		listFetchPage?: () => Promise<{ items: unknown[]; nextCursor: string | null }>;
	} = {},
) {
	const actions = screenActions(entity);
	const handler = createListDetailHandler({
		actions,
		createClient: overrides.createClient ?? (() => ({})),
		parseOpen: overrides.parseOpen ?? (() => ({ targetPath: ["x1"] })),
		levels: [
			listLevel<unknown, unknown, unknown>({
				limit: 2,
				filterFromValues: overrides.filterFromValues ?? (() => ({})),
				fetchPage:
					overrides.listFetchPage ?? (() => Promise.resolve({ items: [], nextCursor: null })),
				render: () => OK_BLOCKS,
				onError:
					overrides.listOnError ?? (() => ({ blocks: [{ type: "header", text: "List down" }] })),
			}),
			leafLevel<unknown, unknown>({
				load: overrides.leafLoad ?? (() => Promise.resolve({ id: "x1" })),
				render: () => [{ type: "header", text: "Leaf" }],
				notFound: () => [{ type: "header", text: "Missing" }],
				onError:
					overrides.leafOnError ?? (() => ({ blocks: [{ type: "header", text: "Leaf down" }] })),
			}),
		],
		...(overrides.custom !== undefined
			? { customActions: { [actions.custom("boom")]: customAction(overrides.custom) } }
			: {}),
	});
	return { actions, handler };
}

async function run(
	handler: ReturnType<typeof screen>["handler"],
	input: ListDetailInput,
): Promise<BlockResponse> {
	// The assertion that matters: this await must RESOLVE. A rejection here is
	// exactly the non-2xx the containment exists to prevent.
	const res = await handler(routeCtx(input), ctx());
	expect(res).toBeDefined();
	return res as BlockResponse;
}

function headerText(res: BlockResponse): unknown {
	return (res.blocks as unknown as Array<Record<string, unknown>>).find((b) => b.type === "header")
		?.text;
}
function bannerOf(res: BlockResponse): Record<string, unknown> | undefined {
	return (res.blocks as unknown as Array<Record<string, unknown>>).find((b) => b.type === "banner");
}

/** The wrapper's own copy — asserted, so deleting the wrapper fails this suite. */
function expectLastResort(res: BlockResponse): void {
	expect(headerText(res)).toBe("Unavailable");
	expect(bannerOf(res)?.title).toBe("This screen could not be rendered");
	expect(res.toast).toEqual({ message: "Could not render this screen", type: "error" });
}

let logged: unknown[][];
beforeEach(() => {
	logged = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		logged.push(args);
	});
});

describe("containment: paths only the last-resort wrapper can catch", () => {
	test("`createClient` throwing (a token read failing) fails closed instead of 500ing", async () => {
		const { handler } = screen("contain-create-client", {
			createClient: () => {
				throw new Error("kv read blew up");
			},
		});
		expectLastResort(await run(handler, { type: "page_load" }));
	});

	test("`parseOpen` throwing fails closed", async () => {
		const { actions, handler } = screen("contain-parse-open", {
			parseOpen: () => {
				throw new Error("bad open payload");
			},
		});
		expectLastResort(await run(handler, { type: "form_submit", action_id: actions.open }));
	});

	test("`filterFromValues` throwing fails closed", async () => {
		// Runs OUTSIDE `renderList`'s try — the apply-filter branch calls it to build
		// the filter it then passes in.
		const { actions, handler } = screen("contain-filter-values", {
			filterFromValues: () => {
				throw new Error("unparseable filter");
			},
		});
		expectLastResort(
			await run(handler, { type: "form_submit", action_id: actions.applyFilter, values: {} }),
		);
	});

	test("a list level's own `onError` throwing fails closed (the fail-closed path failing)", async () => {
		const { handler } = screen("contain-list-onerror", {
			listFetchPage: () => Promise.reject(new Error("service unreachable")),
			listOnError: () => {
				throw new Error("onError itself blew up");
			},
		});
		expectLastResort(await run(handler, { type: "page_load" }));
	});

	test("a leaf level's own `onError` throwing fails closed", async () => {
		const { actions, handler } = screen("contain-leaf-onerror", {
			leafLoad: () => Promise.reject(new Error("service unreachable")),
			leafOnError: () => {
				throw new Error("onError itself blew up");
			},
		});
		expectLastResort(await run(handler, { type: "form_submit", action_id: actions.open }));
	});

	test("every contained failure is LOGGED, so a screen bug is not disguised as an outage", async () => {
		// The operator's banner cannot distinguish a screen bug from an unreachable
		// service; the log is the only place the cause survives.
		const { handler } = screen("contain-logging", {
			createClient: () => {
				throw new Error("kv read blew up");
			},
		});
		await run(handler, { type: "page_load" });
		expect(logged).toHaveLength(1);
		expect(String(logged[0]?.[0])).toContain("[urumi] admin list/detail dispatch failed:");
		expect(String((logged[0]?.[1] as Error | undefined)?.message)).toBe("kv read blew up");
	});
});

describe("containment: the compound double fault keeps the outcome-unknown warning", () => {
	test("a custom action AND its fallback render both throwing still warns that a mutation may have applied", async () => {
		// The money-path worst case: the side effect committed, rebuilding the detail
		// threw, and rebuilding the ROOT LIST threw too. The generic last-resort copy
		// would drop the one thing the operator must know.
		const { actions, handler } = screen("contain-double-fault", {
			listFetchPage: () => Promise.reject(new Error("service unreachable")),
			listOnError: () => {
				throw new Error("onError blew up too");
			},
			custom: () => {
				throw new Error("refund re-render blew up");
			},
		});
		const res = await run(handler, {
			type: "block_action",
			action_id: actions.custom("boom"),
			value: {},
		});
		expect(bannerOf(res)?.title).toBe("Action outcome unknown");
		expect(String(bannerOf(res)?.description)).toMatch(/may already have been applied/);
		expect(res.toast?.type).toBe("error");
		// The generic wrapper did NOT answer this one.
		expect(headerText(res)).not.toBe("Unavailable");
		// Both failures reached the log, distinctly.
		const messages = logged.map((entry) => String(entry[0]));
		expect(messages.some((m) => m.includes("custom action"))).toBe(true);
		expect(messages.some((m) => m.includes("fallback render failed"))).toBe(true);
	});

	test("a custom action throwing with a HEALTHY list keeps the working screen underneath", async () => {
		const { actions, handler } = screen("contain-single-fault", {
			custom: () => {
				throw new Error("refund re-render blew up");
			},
		});
		const res = await run(handler, {
			type: "block_action",
			action_id: actions.custom("boom"),
			value: {},
		});
		expect(bannerOf(res)?.title).toBe("Action outcome unknown");
		expect(headerText(res)).toBe("Healthy"); // the root list rendered beneath it
	});
});
