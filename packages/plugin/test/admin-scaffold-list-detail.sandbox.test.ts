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
	rowCountLine,
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
/** The encoded drill path the engine injected into a rendered form as a visible
 *  field, or undefined when it stood down (the form carried it invisibly). */
function pathFieldOf(form: Blk | undefined): string | undefined {
	const fields = (form?.fields ?? []) as Array<{ action_id?: string; initial_value?: string }>;
	return fields.find((f) => f.action_id === "__path")?.initial_value;
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

describe("rowCountLine: the count states the SET when the service reports one (INC-23)", () => {
	const noun = { one: "order", other: "orders" };

	test("a reported total overrides the page count AND drops the page-scoped suffix, on any page", () => {
		// 2 rows on screen, mid-scan (not the first page, more behind it) — the
		// one shape that could never claim a whole-set count before.
		expect(rowCountLine(2, noun, { complete: false, total: 17 })).toBe("17 orders");
		expect(rowCountLine(1, noun, { complete: false, total: 1 })).toBe("1 order");
	});

	test("without a total the page-scoped rule is untouched", () => {
		expect(rowCountLine(2, noun, { complete: false })).toBe("2 orders on this page");
		expect(rowCountLine(3, noun, { complete: true })).toBe("3 orders");
	});

	test("a total of zero renders NO count, exactly as a zero page does", () => {
		// The zero state says it in words; a count line repeating it is the
		// "unknown rendered as 0" failure in a costume.
		expect(rowCountLine(0, noun, { complete: true, total: 0 })).toBeUndefined();
	});

	test("a total that UNDERSTATES the rows on screen is refused, falling back to the page", () => {
		// Two statements under one predicate can straddle a concurrent insert, so
		// a total below the rendered row count is possible — and it is the one
		// direction that would contradict what the operator can see and count.
		expect(rowCountLine(5, noun, { complete: false, total: 2 })).toBe("5 orders on this page");
	});

	test("a non-integer or negative total is refused rather than formatted", () => {
		expect(rowCountLine(2, noun, { complete: false, total: 4.5 })).toBe("2 orders on this page");
		expect(rowCountLine(2, noun, { complete: false, total: -1 })).toBe("2 orders on this page");
		expect(rowCountLine(2, noun, { complete: false, total: Number.NaN })).toBe(
			"2 orders on this page",
		);
	});

	test("a total is SUPPRESSED on a zero page — the zero state owns that render", () => {
		// Paging off the end of a list that changed underneath. "17 orders" sitting
		// above "Nothing on this page" is the screen contradicting itself in two
		// adjacent blocks, so the count stands down and the zero state speaks alone.
		expect(rowCountLine(0, noun, { complete: false, total: 17 })).toBeUndefined();
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
 * CONTAINMENT. A throw escaping the route handler becomes a non-2xx, and a non-2xx
 * replaces the whole `BlockRenderer` tree with a raw status panel — unmounting
 * every accordion and tab and telling the operator NOTHING about whether their
 * action applied. Block-building code throws by design here (a rejected carrier
 * namespace, a filter form over its field budget, a prefilled form with no
 * digest), so every path that runs screen code has to fail closed to a banner
 * instead. These probe each path with a fixture that throws deliberately.
 */
describe("scaffold containment: no throw escapes the handler — workerd sandbox", () => {
	test("a leaf `render` that throws fails closed to the level's onError banner", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "m-throw"]) },
		});
		// `m-throw` RESOLVES (so `render` is reached) and its render throws. Before
		// containment this escaped: `renderLeaf`'s try wrapped only `load`.
		expect(headerText(res)).toBe("Landmark"); // the leaf's fail-closed header
		const banner = blocksOf(res).find((b) => b.type === "banner");
		expect(banner?.variant).toBe("error");
		expect(banner?.title).toBe("down");
	});

	test("a leaf `notFound` that throws fails closed to the level's onError banner", async () => {
		const res = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1", "nope-throw"]) },
		});
		expect(headerText(res)).toBe("Landmark");
		expect(blocksOf(res).find((b) => b.type === "banner")?.variant).toBe("error");
	});

	test("a custom action that throws keeps a working screen AND says the outcome is unknown", async () => {
		const res = await invoke({ type: "block_action", action_id: "geo:boom", value: {} });
		// A custom action is the one place a side effect may ALREADY have applied, so
		// this must not read as a plain failure — nor as a silent success.
		const banner = blocksOf(res).find((b) => b.type === "banner");
		expect(banner?.variant).toBe("error");
		expect(banner?.title).toBe("Action outcome unknown");
		expect(String(banner?.description)).toMatch(/may already have been applied/);
		expect(res.toast?.type).toBe("error");
		// ...and the operator still has a usable screen, not a raw status panel.
		expect(headerText(res)).toBe("Countries");
		expect(firstTable(res)).toBeDefined();
	});

	test("every rendered response is a well-formed BlockResponse (never an error escape)", async () => {
		// The sandbox harness surfaces a thrown route as `{error}` rather than
		// `{result}`, so `invoke`'s own assertion is what proves nothing escaped —
		// but assert the envelope explicitly too, for every probe at once.
		for (const input of [
			{
				type: "form_submit",
				action_id: "geo:open",
				values: { target: encodePath(["c1", "m-throw"]) },
			},
			{
				type: "form_submit",
				action_id: "geo:open",
				values: { target: encodePath(["c1", "nope-throw"]) },
			},
			{ type: "block_action", action_id: "geo:boom", value: {} },
		]) {
			const res = await invoke(input);
			expect(Array.isArray(res.blocks)).toBe(true);
			expect(res.blocks.length).toBeGreaterThan(0);
		}
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
			block_id: encodeCarrier("geo:tag-form", {
				__path: encodePath(["c1", "m1"]),
				label: "high-water",
			}),
			values: {},
		});
		// BOTH the target level and the payload came out of `block_id`: no visible
		// field carried either.
		expect(headerText(res)).toBe("Landmark m1");
		const banner = blocksOf(res).find((b) => b.type === "banner");
		expect(banner?.title).toBe("Tagged");
		// The fixture echoes its carried value AND the keys it can see. `__path` (which
		// it carried, and which the engine used to find this leaf) and `__v` are
		// STRIPPED, so a screen iterating `carried` sees only its own fields.
		expect(banner?.description).toBe("high-water (label)");
	});

	test("a custom action with a malformed/absent carrier fails closed, never throws", async () => {
		for (const blockId of [undefined, "not-a-carrier", "geo:tabs", "ns:x:u1.garbage", 42]) {
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
			block_id: encodeCarrier("geo:city-filter", { __path: encodePath(["c1"]) }),
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
			block_id: encodeCarrier("geo:city-filter", { __path: encodePath([]) }),
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
		// Two TOP-LEVEL filter forms at this level: the plain one (engine-injected
		// visible carrier — asserted above) and the carrier-bearing one, which must
		// render with NO visible path field at all. (Three more are nested inside the
		// accordion / columns / tab containers, asserted below.)
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

	test("the injection reaches a filter form nested in a `columns` column and in a `tab` panel (two deep)", async () => {
		// The traversal exists so the guarantee cannot be silently broken by nesting;
		// `accordion` alone proving it would leave two thirds of it unverified.
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const columns = blocksOf(cities).find((b) => b.type === "columns");
		const inColumn = ((columns?.columns as Blk[][] | undefined)?.[0] ?? []).find(
			(b) => b.type === "form",
		);
		expect(pathFieldOf(inColumn)).toBe(encodePath(["c1"]));

		// tab → accordion → form: nested two containers deep.
		const tab = blocksOf(cities).find((b) => b.type === "tab");
		const panelBlocks = ((tab?.panels as Array<{ blocks?: Blk[] }> | undefined)?.[0]?.blocks ??
			[]) as Blk[];
		const innerAccordion = panelBlocks.find((b) => b.type === "accordion");
		const inTab = ((innerAccordion?.blocks ?? []) as Blk[]).find((b) => b.type === "form");
		expect(pathFieldOf(inTab)).toBe(encodePath(["c1"]));

		// A spacer block in the other column is untouched.
		const spacer = ((columns?.columns as Blk[][] | undefined)?.[1] ?? [])[0];
		expect(spacer).toEqual({ type: "context", text: "spacer" });
	});

	test("the stand-down requires the EXACT current path — a stale carried path gets the injection anyway", async () => {
		// A hand-written carrier that captured the wrong path must not suppress the
		// guarantee: the engine injects its own (correct) path, which wins by
		// precedence, instead of silently filtering another level.
		const cities = await invoke({
			type: "form_submit",
			action_id: "geo:open",
			values: { target: encodePath(["c1"]) },
		});
		const forms = blocksOf(cities).filter(
			(b) =>
				b.type === "form" && (b.submit as { action_id?: string })?.action_id === "geo:apply-filter",
		);
		// The correctly-carried form is the one that renders WITHOUT the field.
		const correct = forms.find((f) => typeof f.block_id === "string");
		expect(pathFieldOf(correct)).toBeUndefined();

		// Now simulate the copy-paste mistake directly against the engine: a submit
		// whose carrier names a DIFFERENT level. The visible field is absent, so the
		// carrier is all there is — and it is honoured (it is the only source), which
		// is exactly why the RENDER-time stand-down must be exact: had the engine
		// skipped injecting for the wrong path, the operator's submit would have gone
		// to that wrong level with no way to correct it.
		const wrong = await invoke({
			type: "form_submit",
			action_id: "geo:apply-filter",
			block_id: encodeCarrier("geo:city-filter", { __path: encodePath(["c2"]) }),
			values: { q: "T" },
		});
		expect(headerText(wrong)).toBe("Cities of c2");
		// c2 has no cities, so the mistake is visible rather than silently plausible.
		expect(firstTable(wrong)?.rows).toEqual([]);
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
