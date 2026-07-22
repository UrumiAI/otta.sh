import { describe, expect, test } from "vitest";
import type { Block, BlockResponse, PluginContext, SandboxedRouteContext } from "../src/types.js";
import {
	backButton,
	createListDetailHandler,
	customAction,
	decodeListCursor,
	decodePath,
	encodeListCursor,
	encodePath,
	failClosedResponse,
	leafLevel,
	listLevel,
	noticeBanner,
	readString,
	screenActions,
	type ListDetailInput,
	type Notice,
} from "../src/admin/scaffold/index.js";

// Characterization tests for the reusable admin list/detail SCAFFOLD's own
// control flow — pagination round-trip, drill-in dispatch, N-LEVEL (depth-3)
// back-navigation, and banner rendering. The orders console (2 levels) is the
// production regression net in `orders-page.sandbox.test.ts`; this drives a
// SYNTHETIC 3-level screen (countries → cities → landmark) so the N-level nav
// core is exercised beyond what a 2-level screen can reach. The engine is
// IO-free pure dispatch, so it runs in-process with a fake client + stub ctx
// (no sandbox needed: no ctx.http egress crosses this boundary).

// -- a fake, in-memory 3-level data source ------------------------------------

interface Country {
	id: string;
	name: string;
}
interface City {
	id: string;
	name: string;
}
interface Landmark {
	id: string;
	name: string;
}

const COUNTRIES: Country[] = [
	{ id: "c1", name: "Alpha" },
	{ id: "c2", name: "Beta" },
	{ id: "c3", name: "Gamma" },
];
const CITIES: Record<string, City[]> = {
	c1: [
		{ id: "m1", name: "One" },
		{ id: "m2", name: "Two" },
		{ id: "m3", name: "Three" },
	],
};
const LANDMARK: Landmark = { id: "m1", name: "Tower" };

/** A fake client whose "cursors" are transparent so a test can assert paging. */
class FakeGeoClient {
	pageOf<T extends { id: string }>(
		all: T[],
		limit: number,
		cursor: string | undefined,
	): { items: T[]; nextCursor: string | null } {
		const start = cursor === undefined ? 0 : Number(cursor);
		const items = all.slice(start, start + limit);
		const next = start + limit;
		return { items, nextCursor: next < all.length ? String(next) : null };
	}
	listCountries(limit: number, cursor?: string) {
		return this.pageOf(COUNTRIES, limit, cursor);
	}
	listCities(countryId: string, limit: number, cursor?: string) {
		return this.pageOf(CITIES[countryId] ?? [], limit, cursor);
	}
	getLandmark(id: string): Landmark | null {
		return id === LANDMARK.id ? LANDMARK : null;
	}
}

const geo = screenActions("geo");

/** Encode a full drill target into an option value so `parseOpen` recovers the
 *  whole path — the documented deep-drill pattern (the parent path rides in the
 *  option value, since the interaction is stateless). */
function targetOption(path: string[], label: string) {
	return { value: encodePath(path), label };
}

function buildGeoHandler(client: FakeGeoClient) {
	return createListDetailHandler({
		actions: geo,
		createClient: () => client,
		parseOpen(input) {
			const encoded = readString(input.values?.target);
			const targetPath = encoded === undefined ? null : decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [
			// level 0 — countries
			listLevel<FakeGeoClient, Record<string, never>, Country>({
				limit: 2,
				filterFromValues: () => ({}),
				fetchPage: (c, _path, _filter, opts) => {
					const page = c.listCountries(opts.limit, opts.cursor);
					return Promise.resolve(page);
				},
				render: ({ actions, items, nextToken }) => {
					const blocks: Block[] = [
						{ type: "header", text: "Countries" },
						{
							type: "table",
							columns: [{ key: "id", label: "id" }],
							rows: items.map((x) => ({ id: x.id })),
							page_action_id: actions.page,
							...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
						},
						{
							type: "form",
							fields: [
								{
									type: "select",
									action_id: "target",
									label: "Open country",
									options: items.map((x) => targetOption([x.id], x.name)),
								},
							],
							submit: { label: "Open", action_id: actions.open },
						},
					];
					return blocks;
				},
				onError: () =>
					failClosedResponse({ header: "Countries", title: "down", description: "down" }),
			}),
			// level 1 — cities of the country at path[0]
			listLevel<FakeGeoClient, Record<string, never>, City>({
				limit: 2,
				filterFromValues: () => ({}),
				fetchPage: (c, path, _filter, opts) => {
					const page = c.listCities(path[0] ?? "", opts.limit, opts.cursor);
					return Promise.resolve(page);
				},
				render: ({ actions, path, items, nextToken }) => {
					const blocks: Block[] = [
						{ type: "header", text: `Cities of ${path[0] ?? "?"}` },
						backButton(actions.back, "← Back to countries", path),
						{
							type: "table",
							columns: [{ key: "id", label: "id" }],
							rows: items.map((x) => ({ id: x.id })),
							page_action_id: actions.page,
							...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
						},
						{
							type: "form",
							fields: [
								{
									type: "select",
									action_id: "target",
									label: "Open city",
									options: items.map((x) => targetOption([...path, x.id], x.name)),
								},
							],
							submit: { label: "Open", action_id: actions.open },
						},
					];
					return blocks;
				},
				onError: () => failClosedResponse({ header: "Cities", title: "down", description: "down" }),
			}),
			// level 2 — a landmark leaf
			leafLevel<FakeGeoClient, Landmark>({
				load: (c, _path, id) => Promise.resolve(c.getLandmark(id)),
				render: ({ actions, path, detail, notice }) => {
					const blocks: Block[] = [
						{ type: "header", text: `Landmark ${detail.id}` },
						backButton(actions.back, "← Back to cities", path),
					];
					if (notice !== undefined) blocks.push(noticeBanner(notice));
					return blocks;
				},
				notFound: ({ actions, path, id }) => [
					{ type: "header", text: "Not found" },
					backButton(actions.back, "← Back", path),
					{ type: "banner", variant: "error", title: "Not found", description: id },
				],
				onError: () =>
					failClosedResponse({ header: "Landmark", title: "down", description: "down" }),
			}),
		],
		customActions: {
			[geo.custom("ping")]: customAction<FakeGeoClient>(({ input, showLeaf }) => {
				const path = decodePath(readString(asRecordValue(input.value, "path")) ?? "") ?? [];
				return showLeaf(path, {
					variant: "default",
					title: "Pinged",
					description: "side effect ran",
				});
			}),
		},
	});
}

function asRecordValue(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)[key]
		: undefined;
}

async function invoke(
	handler: ReturnType<typeof buildGeoHandler>,
	input: ListDetailInput,
): Promise<BlockResponse> {
	const routeCtx = { input, request: { method: "POST", url: "/admin", headers: {} } };
	const out = await handler(
		routeCtx as SandboxedRouteContext<ListDetailInput>,
		{} as PluginContext,
	);
	return out as BlockResponse;
}

function headerText(res: BlockResponse): string | undefined {
	const h = res.blocks.find((b) => b.type === "header");
	return h !== undefined && h.type === "header" ? h.text : undefined;
}

function firstTable(res: BlockResponse) {
	const t = res.blocks.find((b) => b.type === "table");
	return t !== undefined && t.type === "table" ? t : undefined;
}

// -- the nav primitives (pure) ------------------------------------------------

describe("scaffold nav primitives", () => {
	test("path + list-cursor round-trip (with and without a drill path)", () => {
		expect(decodePath(encodePath(["a", "b"]))).toEqual(["a", "b"]);
		const rooted = encodeListCursor({ c: "svc-1", f: { q: "x" } });
		expect(decodeListCursor(rooted)).toEqual({ c: "svc-1", f: { q: "x" } });
		const deep = encodeListCursor({ c: "svc-2", f: {}, p: ["c1"] });
		expect(decodeListCursor(deep)).toEqual({ c: "svc-2", f: {}, p: ["c1"] });
		expect(decodeListCursor("not-a-token")).toBeNull();
	});

	test("backButton carries the path only at depth ≥ 1 (value-less at the root)", () => {
		const rootBack = backButton("geo:back", "Back");
		const el0 = rootBack.elements[0];
		expect(el0 !== undefined && "value" in el0 ? el0.value : "none").toBe("none");
		const deepBack = backButton("geo:back", "Back", ["c1", "m1"]);
		const el = deepBack.elements[0];
		const carried = el !== undefined && "value" in el ? (el.value as Record<string, string>) : {};
		expect(decodePath(carried["__path"] ?? "")).toEqual(["c1", "m1"]);
	});
});

// -- the dispatch engine ------------------------------------------------------

describe("scaffold list/detail dispatch (N-level)", () => {
	test("page-load default renders the root list with a keyset next_cursor", async () => {
		const res = await invoke(buildGeoHandler(new FakeGeoClient()), { type: "page_load" });
		expect(headerText(res)).toBe("Countries");
		const table = firstTable(res);
		expect((table?.rows ?? []).length).toBe(2); // limit 2
		expect(table?.page_action_id).toBe("geo:page");
		expect(typeof table?.next_cursor).toBe("string");
	});

	test("pagination round-trip: the wrapped next_cursor re-lists the SAME level's page 2", async () => {
		const handler = buildGeoHandler(new FakeGeoClient());
		const page1 = await invoke(handler, { type: "page_load" });
		const token = firstTable(page1)?.next_cursor;
		// The wrapped token embeds the SERVICE cursor "2" (offset) + an empty path.
		expect(decodeListCursor(token ?? "")?.c).toBe("2");
		const page2 = await invoke(handler, {
			type: "block_action",
			action_id: "geo:page",
			value: { cursor: token },
		});
		expect(headerText(page2)).toBe("Countries");
		expect(firstTable(page2)?.rows).toEqual([{ id: "c3" }]); // the remainder
		expect(firstTable(page2)?.next_cursor).toBeUndefined(); // last page
	});

	test("a garbage page cursor defensively falls back to the root list", async () => {
		const res = await invoke(buildGeoHandler(new FakeGeoClient()), {
			type: "block_action",
			action_id: "geo:page",
			value: { cursor: "garbage" },
		});
		expect(headerText(res)).toBe("Countries");
	});

	test("drill-in dispatch: open [c1] renders the cities LIST; open [c1,m1] renders the landmark LEAF", async () => {
		const handler = buildGeoHandler(new FakeGeoClient());
		const cities = await invoke(handler, {
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		expect(headerText(cities)).toBe("Cities of c1");
		expect((firstTable(cities)?.rows ?? []).length).toBe(2);

		const landmark = await invoke(handler, {
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "m1"]) },
		});
		expect(headerText(landmark)).toBe("Landmark m1");
	});

	test("keyset paging at a DEEP list level carries the drill path through the cursor", async () => {
		const handler = buildGeoHandler(new FakeGeoClient());
		const cities = await invoke(handler, {
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const token = firstTable(cities)?.next_cursor;
		expect(decodeListCursor(token ?? "")?.p).toEqual(["c1"]); // path survived
		const page2 = await invoke(handler, {
			type: "block_action",
			action_id: "geo:page",
			value: { cursor: token },
		});
		expect(headerText(page2)).toBe("Cities of c1"); // still the c1 cities level
		expect(firstTable(page2)?.rows).toEqual([{ id: "m3" }]);
	});

	test("N-level back-navigation: leaf → cities → countries, one pop per click", async () => {
		const handler = buildGeoHandler(new FakeGeoClient());
		// Enter the leaf at [c1, m1].
		const leaf = await invoke(handler, {
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "m1"]) },
		});
		const leafBackPath = extractBackPath(leaf);
		expect(leafBackPath).toEqual(["c1", "m1"]);
		// Back from the leaf → the cities list of c1 (popped one level).
		const cities = await invoke(handler, {
			type: "block_action",
			action_id: "geo:back",
			value: { __path: encodePath(leafBackPath) },
		});
		expect(headerText(cities)).toBe("Cities of c1");
		const cityBackPath = extractBackPath(cities);
		expect(cityBackPath).toEqual(["c1"]);
		// Back again → the root countries list.
		const countries = await invoke(handler, {
			type: "block_action",
			action_id: "geo:back",
			value: { __path: encodePath(cityBackPath) },
		});
		expect(headerText(countries)).toBe("Countries");
	});

	test("banner rendering: a custom action re-renders the leaf with a non-error notice", async () => {
		const res = await invoke(buildGeoHandler(new FakeGeoClient()), {
			type: "block_action",
			action_id: "geo:ping",
			value: { path: encodePath(["c1", "m1"]) },
		});
		expect(headerText(res)).toBe("Landmark m1");
		const banner = res.blocks.find((b) => b.type === "banner");
		expect(banner !== undefined && banner.type === "banner" ? banner.variant : undefined).toBe(
			"default",
		);
		expect(banner !== undefined && banner.type === "banner" ? banner.title : undefined).toBe(
			"Pinged",
		);
	});

	test("a missing leaf record renders the notFound blocks (not a fail-closed banner)", async () => {
		const res = await invoke(buildGeoHandler(new FakeGeoClient()), {
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "nope"]) },
		});
		expect(headerText(res)).toBe("Not found");
	});

	test("noticeBanner + failClosedResponse emit em-dash's authoritative banner shape", () => {
		const notice: Notice = { variant: "error", title: "T", description: "D" };
		expect(noticeBanner(notice)).toEqual({
			type: "banner",
			variant: "error",
			title: "T",
			description: "D",
		});
		const fc = failClosedResponse({ header: "H", title: "T", description: "D", toast: "oops" });
		expect(fc.blocks[0]).toEqual({ type: "header", text: "H" });
		expect(fc.blocks[1]).toEqual({
			type: "banner",
			variant: "error",
			title: "T",
			description: "D",
		});
		expect(fc.toast).toEqual({ message: "oops", type: "error" });
	});
});

/** Pull the encoded drill path out of a rendered view's back button. */
function extractBackPath(res: BlockResponse): string[] {
	for (const b of res.blocks) {
		if (b.type !== "actions") continue;
		const el = b.elements[0];
		if (el !== undefined && "action_id" in el && el.action_id === "geo:back" && "value" in el) {
			const v = el.value as Record<string, string> | undefined;
			const encoded = v?.["__path"];
			const decoded = encoded !== undefined ? decodePath(encoded) : null;
			return decoded === null ? [] : [...decoded];
		}
	}
	return [];
}
