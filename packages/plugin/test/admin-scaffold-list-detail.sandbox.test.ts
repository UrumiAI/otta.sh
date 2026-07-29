import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	backButton,
	decodeCarrier,
	decodeListCursor,
	decodePath,
	encodeCarrier,
	encodeListCursor,
	encodePath,
	failClosedResponse,
	filterPathField,
	noticeBanner,
	screenActions,
	type Notice,
} from "../src/admin/scaffold/index.js";
import type { BlockResponse } from "../src/types.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Characterization tests for the reusable admin list/detail SCAFFOLD's own
// behaviors — pagination round-trip, drill-in dispatch, N-LEVEL (depth-3)
// back-navigation, deep apply-filter path-carry, and banner rendering — run
// under the REAL workerd-on-Node sandbox (CLAUDE.md verification policy),
// exactly like the production screens' suites. The screen under test is the
// SYNTHETIC 3-level geo fixture (`src/admin/scaffold/testing/geo-screen.ts`:
// countries → cities → landmark, in-memory fake client, booted through the
// production `createSandboxWorker` bridge via `testing/geo-entry.ts`) because
// the production Orders screen only reaches depth 2 — the N-level nav core
// needs depth 3 to be exercised. `orders-page.sandbox.test.ts` remains the
// production-screen regression net.

let sandbox: SandboxHandle;
beforeAll(async () => {
	sandbox = await loadPluginInSandbox({
		// The geo fixture's fake client performs NO egress; hosts/base-url are
		// inert placeholders the bridge still requires.
		allowedHosts: ["127.0.0.1"],
		commerceServiceBaseUrl: "http://127.0.0.1:1",
		entry: "admin/scaffold/testing/geo-entry.ts",
	});
}, 60_000);
afterAll(async () => {
	await sandbox?.close();
});

async function invoke(input: unknown): Promise<BlockResponse> {
	const outcome = await sandbox.invokeRoute("admin", input);
	expect("result" in outcome, `sandbox error: ${JSON.stringify(outcome)}`).toBe(true);
	return (outcome as { result: BlockResponse }).result;
}

interface Blk extends Record<string, unknown> {
	type: string;
}
function blocksOf(res: BlockResponse): Blk[] {
	return res.blocks as unknown as Blk[];
}
function headerText(res: BlockResponse): unknown {
	return blocksOf(res).find((b) => b.type === "header")?.text;
}
function firstTable(res: BlockResponse): Blk | undefined {
	return blocksOf(res).find((b) => b.type === "table");
}
function formWithSubmit(res: BlockResponse, actionId: string): Blk | undefined {
	return blocksOf(res).find(
		(b) => b.type === "form" && (b.submit as { action_id?: string })?.action_id === actionId,
	);
}
/** Pull the encoded drill path out of a rendered view's back button. */
function extractBackPath(res: BlockResponse): string[] {
	for (const b of blocksOf(res)) {
		if (b.type !== "actions") continue;
		const el = (b.elements as Array<Record<string, unknown>>)[0];
		if (el?.action_id === "geo:back" && el.value !== undefined) {
			const encoded = (el.value as Record<string, string>)["__path"];
			const decoded = encoded !== undefined ? decodePath(encoded) : null;
			return decoded === null ? [] : [...decoded];
		}
	}
	return [];
}

describe("scaffold nav primitives (pure serialization — no handler invoked)", () => {
	test("path + list-cursor round-trip (with and without a drill path)", () => {
		expect(decodePath(encodePath(["a", "b"]))).toEqual(["a", "b"]);
		const rooted = encodeListCursor({ c: "svc-1", f: { q: "x" } });
		expect(decodeListCursor(rooted)).toEqual({ c: "svc-1", f: { q: "x" } });
		const deep = encodeListCursor({ c: "svc-2", f: {}, p: ["c1"] });
		expect(decodeListCursor(deep)).toEqual({ c: "svc-2", f: {}, p: ["c1"] });
		expect(decodeListCursor("not-a-token")).toBeNull();
	});

	test("backButton carries the path only at depth ≥ 1 (value-less at the root)", () => {
		const rootBack = backButton("x:back", "Back");
		const el0 = rootBack.elements[0];
		expect(el0 !== undefined && "value" in el0 ? el0.value : "none").toBe("none");
		const deepBack = backButton("x:back", "Back", ["c1", "m1"]);
		const el = deepBack.elements[0];
		const carried = el !== undefined && "value" in el ? (el.value as Record<string, string>) : {};
		expect(decodePath(carried["__path"] ?? "")).toEqual(["c1", "m1"]);
	});

	test("filterPathField encodes the drill path as a single-option select on the reserved key", () => {
		const field = filterPathField(["z1", "mm2"]);
		expect(field.action_id).toBe("__path");
		expect(field.options).toHaveLength(1);
		expect(decodePath(field.initial_value ?? "")).toEqual(["z1", "mm2"]);
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

	test("claiming an already-registered entity namespace throws (silent dispatch-collision guard)", () => {
		screenActions("dup-entity-check");
		expect(() => screenActions("dup-entity-check")).toThrowError(/already claimed/);
	});
});

describe("scaffold list/detail dispatch — N-level, workerd sandbox", () => {
	test("page-load default renders the root list with a keyset next_cursor", async () => {
		const res = await invoke({ type: "page_load", page: "/geo" });
		expect(headerText(res)).toBe("Countries");
		const table = firstTable(res);
		expect(((table?.rows ?? []) as unknown[]).length).toBe(2); // limit 2
		expect(table?.page_action_id).toBe("geo:page");
		expect(typeof table?.next_cursor).toBe("string");
	});

	test("pagination round-trip: the wrapped next_cursor re-lists the SAME level's page 2", async () => {
		const page1 = await invoke({ type: "page_load" });
		const token = firstTable(page1)?.next_cursor as string;
		// The wrapped token embeds the SERVICE cursor "2" (fake offset) + no path.
		expect(decodeListCursor(token)?.c).toBe("2");
		const page2 = await invoke({
			type: "block_action",
			action_id: "geo:page",
			value: { cursor: token },
		});
		expect(headerText(page2)).toBe("Countries");
		expect(firstTable(page2)?.rows).toEqual([{ id: "c3" }]); // the remainder
		expect(firstTable(page2)?.next_cursor).toBeUndefined(); // last page
	});

	test("a garbage page cursor defensively falls back to the root list", async () => {
		const res = await invoke({
			type: "block_action",
			action_id: "geo:page",
			value: { cursor: "garbage" },
		});
		expect(headerText(res)).toBe("Countries");
	});

	test("drill-in dispatch: open [c1] renders the cities LIST; open [c1,m1] renders the landmark LEAF", async () => {
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		expect(headerText(cities)).toBe("Cities of c1");
		expect(((firstTable(cities)?.rows ?? []) as unknown[]).length).toBe(2);

		const landmark = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "m1"]) },
		});
		expect(headerText(landmark)).toBe("Landmark m1");
	});

	test("keyset paging at a DEEP list level carries the drill path through the cursor", async () => {
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const token = firstTable(cities)?.next_cursor as string;
		expect(decodeListCursor(token)?.p).toEqual(["c1"]); // path survived
		const page2 = await invoke({
			type: "block_action",
			action_id: "geo:page",
			value: { cursor: token },
		});
		expect(headerText(page2)).toBe("Cities of c1"); // still the c1 cities level
		expect(firstTable(page2)?.rows).toEqual([{ id: "m3" }]);
	});

	test("deep apply-filter: the engine AUTO-INJECTS the path carrier, and the submit re-filters the CURRENT level (not the root)", async () => {
		// The geo cities filter form deliberately renders WITHOUT a path field —
		// the engine must inject it (review round 2, item 1).
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const filterForm = formWithSubmit(cities, "geo:apply-filter");
		expect(filterForm).toBeDefined();
		const fields = (filterForm?.fields ?? []) as Array<{
			action_id?: string;
			initial_value?: string;
		}>;
		const carrier = fields.find((f) => f.action_id === "__path");
		expect(carrier).toBeDefined(); // injected, not screen-authored
		expect(decodePath(carrier?.initial_value ?? "")).toEqual(["c1"]);

		// Submit the filter form the way em-dash would: all field values,
		// including the carried path.
		const filtered = await invoke({
			type: "form_submit",
			action_id: "geo:apply-filter",
			values: { q: "T", __path: carrier?.initial_value },
		});
		expect(headerText(filtered)).toBe("Cities of c1"); // stayed on the deep level
		expect(firstTable(filtered)?.rows).toEqual([{ id: "m2" }, { id: "m3" }]); // Two, Three
		// The re-rendered form re-populates the filter AND still carries the path.
		const reForm = formWithSubmit(filtered, "geo:apply-filter");
		const reFields = (reForm?.fields ?? []) as Array<{
			action_id?: string;
			initial_value?: string;
		}>;
		expect(reFields.find((f) => f.action_id === "q")?.initial_value).toBe("T");
		expect(decodePath(reFields.find((f) => f.action_id === "__path")?.initial_value ?? "")).toEqual(
			["c1"],
		);
	});

	test("the ROOT filter form gets NO injected path carrier (payloads byte-identical to a plain form)", async () => {
		const res = await invoke({ type: "page_load" });
		const filterForm = formWithSubmit(res, "geo:apply-filter");
		expect(filterForm).toBeDefined();
		const fields = (filterForm?.fields ?? []) as Array<{ action_id?: string }>;
		expect(fields.some((f) => f.action_id === "__path")).toBe(false);
	});

	test("apply-filter with NO path defensively re-filters the root list", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:apply-filter",
			values: {},
		});
		expect(headerText(res)).toBe("Countries");
	});

	test("N-level back-navigation: leaf → cities → countries, one pop per click", async () => {
		const leaf = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "m1"]) },
		});
		const leafBackPath = extractBackPath(leaf);
		expect(leafBackPath).toEqual(["c1", "m1"]);
		// Back from the leaf → the cities list of c1 (popped one level).
		const cities = await invoke({
			type: "block_action",
			action_id: "geo:back",
			value: { __path: encodePath(leafBackPath) },
		});
		expect(headerText(cities)).toBe("Cities of c1");
		const cityBackPath = extractBackPath(cities);
		expect(cityBackPath).toEqual(["c1"]);
		// Back again → the root countries list.
		const countries = await invoke({
			type: "block_action",
			action_id: "geo:back",
			value: { __path: encodePath(cityBackPath) },
		});
		expect(headerText(countries)).toBe("Countries");
	});

	test("banner rendering: a custom action re-renders the leaf with a non-error notice", async () => {
		const res = await invoke({
			type: "block_action",
			action_id: "geo:ping",
			value: { path: encodePath(["c1", "m1"]) },
		});
		expect(headerText(res)).toBe("Landmark m1");
		const banner = blocksOf(res).find((b) => b.type === "banner");
		expect(banner?.variant).toBe("default");
		expect(banner?.title).toBe("Pinged");
	});

	test("a missing leaf record renders the notFound blocks (not a fail-closed banner)", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "nope"]) },
		});
		expect(headerText(res)).toBe("Not found");
	});
});

/**
 * The `block_id` CARRIER half (admin-UX density increment 2): context that must
 * survive a stateless submit rides in the form's `block_id` — which em-dash
 * echoes back (`blocks/form.tsx:57`, `blocks/table.tsx:55,64`) — instead of in a
 * single-option `select` whose label leaks a raw internal field name. The drill
 * path and the carrier are DIFFERENT concerns: every `__path` route below keeps
 * working (the suite above is unchanged), and the carrier is an ADDITIONAL,
 * lower-precedence source for it.
 */
describe("scaffold carrier: hidden context in `block_id` — workerd sandbox", () => {
	test("a custom action reads the context its form carried in `block_id`", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:tag",
			block_id: encodeCarrier({ __path: encodePath(["c1", "m1"]), label: "high-water" }),
			values: {},
		});
		// BOTH the target level and the payload came out of `block_id`: no visible
		// field carried either.
		expect(headerText(res)).toBe("Landmark m1");
		const banner = blocksOf(res).find((b) => b.type === "banner");
		expect(banner?.title).toBe("Tagged");
		expect(banner?.description).toBe("high-water");
	});

	test("a custom action with a malformed/absent carrier fails closed, never throws", async () => {
		for (const blockId of [undefined, "not-a-carrier", "u1.garbage", 42]) {
			const res = await invoke({
				type: "form_submit",
				action_id: "geo:tag",
				block_id: blockId,
				values: {},
			});
			// No carried context ⇒ no path ⇒ the root list, and a "none" label.
			expect(headerText(res)).toBe("Countries");
		}
	});

	test("deep apply-filter works with the path carried INVISIBLY in `block_id`", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:apply-filter",
			block_id: encodeCarrier({ __path: encodePath(["c1"]) }),
			values: { q: "T" },
		});
		expect(headerText(res)).toBe("Cities of c1"); // stayed on the deep level
		expect(firstTable(res)?.rows).toEqual([{ id: "m2" }, { id: "m3" }]); // Two, Three
	});

	test("a visible `values.__path` still WINS over the carrier (precedence is explicit)", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:apply-filter",
			// The carrier points at the root; the visible field points at c1.
			block_id: encodeCarrier({ __path: encodePath([]) }),
			values: { q: "T", __path: encodePath(["c1"]) },
		});
		expect(headerText(res)).toBe("Cities of c1");
	});

	test("the engine SKIPS injecting the visible path field when the form already carries it in `block_id`", async () => {
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const forms = blocksOf(cities).filter(
			(b) =>
				b.type === "form" && (b.submit as { action_id?: string })?.action_id === "geo:apply-filter",
		);
		// Two filter forms at this level: the plain one (engine-injected visible
		// carrier — asserted above) and the carrier-bearing one, which must render
		// with NO visible path field at all.
		expect(forms).toHaveLength(2);
		const carried = forms.find((f) => typeof f.block_id === "string");
		expect(carried).toBeDefined();
		expect(decodeCarrier(carried?.block_id)?.["__path"]).toBe(encodePath(["c1"]));
		const fields = (carried?.fields ?? []) as Array<{ action_id?: string }>;
		expect(fields.some((f) => f.action_id === "__path")).toBe(false);
	});

	test("the path-carry injection reaches a filter form COLLAPSED inside an accordion", async () => {
		// Collapsing a deep filter form (the density fix) must not cost it the drill
		// path: the engine's guarantee looks inside layout containers.
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const accordion = blocksOf(cities).find((b) => b.type === "accordion");
		expect(accordion?.label).toBe("Filters");
		const nested = ((accordion?.blocks ?? []) as Blk[]).find((b) => b.type === "form");
		const fields = (nested?.fields ?? []) as Array<{ action_id?: string; initial_value?: string }>;
		const injected = fields.find((f) => f.action_id === "__path");
		expect(injected).toBeDefined();
		expect(decodePath(injected?.initial_value ?? "")).toEqual(["c1"]);
		// And submitting it re-filters the DEEP level, not the root.
		const filtered = await invoke({
			type: "form_submit",
			action_id: "geo:apply-filter",
			values: { q: "T", __path: injected?.initial_value },
		});
		expect(headerText(filtered)).toBe("Cities of c1");
	});

	test("a sortable-header click (page action, `{sort}` and NO cursor) stays on the carried level", async () => {
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const table = firstTable(cities);
		expect(decodeCarrier(table?.block_id)?.["__path"]).toBe(encodePath(["c1"]));
		const sorted = await invoke({
			type: "block_action",
			action_id: "geo:page",
			block_id: table?.block_id,
			// Exactly what em-dash's table sends on a sortable header click.
			value: { sort: { key: "id", dir: "asc" } },
		});
		expect(headerText(sorted)).toBe("Cities of c1");
	});
});
