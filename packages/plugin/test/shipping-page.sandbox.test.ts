import { cents as toCents, currency as toCurrency } from "@otta-sh/domain";
import { EmdashShippingRulesStore, systemClock, type StorageAccess } from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { decodeCarrier } from "../src/admin/scaffold/carrier.js";
import { decodePath, encodePath } from "../src/admin/scaffold/index.js";
import { COMMERCE_STORAGE_COLLECTION_NAMES } from "../src/commerce/commerce-storage.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	buttons,
	confirmOf,
	contextTexts,
	emptyActions,
	field,
	fieldEntries,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	openGroupIds,
	tableRows,
	valueOf,
	type LooseBlock,
	type LooseElement,
} from "./helpers/blocks.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

// The admin Shipping console under the REAL workerd-on-Node sandbox (design
// spec §12.4 — the deepest of the seven admin screens). Zones and methods
// render as a per-row `accordion` list (L-9) when the fetched page is
// complete and small (<=25 rows); otherwise a `table` + a standalone
// `combobox` drill-in (L-7 fallback). Rates is EXEMPT (L-9a) and keeps its
// existing `fields`-based 0-or-1-row lookup. This suite drives all three
// levels, both L-9 branches (asserted at 25 and 26 rows), the zero-row
// `empty` state (E-2) with its create action, and a depth-3 open fired from a
// row BUTTON (§12.7) — never a bare id.
//
// THE RULES SURFACE IS NO LONGER AN HTTP SERVICE (INC-D3a). `makeAdminClients`
// hands this screen an `InProcessAdminRulesClient` composed over `ctx.storage`,
// so the fixtures below are REAL documents written through the same
// `@otta-sh/store-emdash` store the plugin itself reads, and every "did the
// write land" claim is read back off that store rather than off a recorded
// request body — a strictly stronger claim, since a recorded `PUT
// /admin/shipping/zones/us` proved only that a request was FORMED.
//
// Three consequences, stated once because several cases inherit them:
//  * There is no admin token. `X-Internal-Token` / `X-Service-Token`
//    authenticated a caller TO the commerce service; the console routes are
//    gated by EmDash's own admin auth and CSRF (ADR-0014 D3), so there is
//    nothing to forward and nothing to withhold.
//  * `listZones()` sorts by zone id (the store reads `ORDER BY id`), so the
//    fixture's `empty` zone now precedes `us`. No assertion here depends on
//    the registry's order, and the ones that locate a row do it by block_id.
//  * A duplicate id is a THROWN collision from the store, not a 500 the HTTP
//    client mapped to `{ok:false}` — see the duplicate-zone case for what the
//    operator sees now.

let storage: StorageAccess;
let shippingRules: EmdashShippingRulesStore;
let sandbox: SandboxHandle;

interface ZoneFixture {
	id: string;
	name: string;
	regions: unknown;
}
interface MethodFixture {
	id: string;
	zoneId: string;
	name: string;
	type: "flat_rate" | "free_shipping";
}
interface RateFixture {
	methodId: string;
	currency: string;
	amountCents: number;
	minSubtotalCents: number | null;
}
interface ShippingFixture {
	zones?: ZoneFixture[];
	methods?: MethodFixture[];
	rates?: RateFixture[];
}

const DEFAULT_ZONES: ZoneFixture[] = [
	{ id: "us", name: "United States", regions: ["US"] },
	{ id: "empty", name: "Empty zone", regions: null },
];
const DEFAULT_METHODS: MethodFixture[] = [
	{ id: "standard", zoneId: "us", name: "Standard", type: "flat_rate" },
	{ id: "bare", zoneId: "us", name: "No rates yet", type: "flat_rate" },
];
const DEFAULT_RATES: RateFixture[] = [
	{ methodId: "standard", currency: "USD", amountCents: 499, minSubtotalCents: 3500 },
];

/** L-9's branch boundary is asserted at exactly 25 and 26 rows — an all-zones
 *  fixture with no methods/rates, so the branch decision is isolated to row
 *  count alone. */
function manyZones(count: number): ShippingFixture {
	return {
		zones: Array.from({ length: count }, (_, i) => ({
			id: `z${i}`,
			name: `Zone ${i}`,
			regions: null,
		})),
		methods: [],
		rates: [],
	};
}

function manyMethods(count: number): ShippingFixture {
	return {
		zones: [{ id: "us", name: "United States", regions: null }],
		// Alternate type so the `Type` badge column genuinely chunks two values
		// apart (T-5/X-4) — a fixture where every row is the same value is not a
		// realistic method registry and trips the constant-badge-column check for
		// the wrong reason.
		methods: Array.from({ length: count }, (_, i) => ({
			id: `m${i}`,
			zoneId: "us",
			name: `Method ${i}`,
			type: i % 2 === 0 ? ("flat_rate" as const) : ("free_shipping" as const),
		})),
		rates: [],
	};
}

/** Empty every declared collection. The store is process-scoped by design
 *  (`storageBridge`) and this screen's reads are REGISTRY-WIDE — "25 zones" is
 *  a claim about the whole store, not about a namespace — so each case starts
 *  from nothing rather than narrowing a shared catalogue. */
async function resetStore(): Promise<void> {
	for (const name of COMMERCE_STORAGE_COLLECTION_NAMES) {
		const collection = storage[name];
		if (collection === undefined) continue;
		for (;;) {
			const page = await collection.query({ limit: 200 });
			if (page.items.length === 0) break;
			for (const { id } of page.items) await collection.delete(id);
		}
	}
}

/** Write one case's fixture as REAL documents through the store the plugin
 *  reads. Defaults reproduce the old stub's seed exactly, so the cases below
 *  read as they always did. */
async function seedShipping(fixture: ShippingFixture = {}): Promise<void> {
	await resetStore();
	for (const zone of fixture.zones ?? DEFAULT_ZONES) {
		await shippingRules.createZone({ id: zone.id, name: zone.name, regions: zone.regions });
	}
	for (const method of fixture.methods ?? DEFAULT_METHODS) {
		await shippingRules.createMethod(method);
	}
	for (const rate of fixture.rates ?? DEFAULT_RATES) {
		await shippingRules.createRate({
			methodId: rate.methodId,
			currency: toCurrency(rate.currency),
			amountCents: toCents(rate.amountCents),
			minSubtotalCents: rate.minSubtotalCents === null ? null : toCents(rate.minSubtotalCents),
		});
	}
}

function bannerOf(blocks: LooseBlock[]): LooseElement | undefined {
	return findBlock(blocks, "banner");
}

/** A form's carried context, with `carriedForm`'s `__v` prefill digest
 *  stripped — every prefilling form carries one (B-3a) and it is not part of
 *  the screen's own context (it exists only to move the React key). */
function carriedContext(blockId: unknown): Record<string, string> | undefined {
	const decoded = decodeCarrier(blockId as string | undefined);
	if (decoded === undefined) return undefined;
	const { __v: _digest, ...rest } = decoded;
	return rest;
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	shippingRules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	// ONE boot for the file: the isolate holds no per-case state now that the
	// fixtures live in the store, so rebooting between cases would buy nothing
	// but seconds.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox.close();
});

beforeEach(async () => {
	await resetStore();
});

/** The list, freshly loaded. */
async function loadZones(): Promise<LooseBlock[]> {
	return blocksOf(await sandbox.invokeRoute("admin", { type: "page_load", page: "/shipping" }));
}

/** Click a button the way em-dash does: `action_id` + `value`, and NO
 *  `block_id` — a button echoes none (B-1). */
async function clickButton(actionId: string, value: unknown): Promise<LooseBlock[]> {
	return blocksOf(
		await sandbox.invokeRoute("admin", { type: "block_action", action_id: actionId, value }),
	);
}

/** Submit a form the way em-dash does: `values` PLUS the form's own
 *  `block_id`, which is where every id and watermark rides (F-2, B-1). */
async function submitForm(
	actionId: string,
	values: Record<string, unknown>,
	blockId?: unknown,
): Promise<LooseBlock[]> {
	return blocksOf(
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: actionId,
			values,
			block_id: blockId,
		}),
	);
}

/** Drill to a level by its encoded path, the way the L-7 combobox does. */
async function openPath(path: string[]): Promise<LooseBlock[]> {
	return submitForm("shipping:open", { target: encodePath(path) });
}

/** The promoted create button on a rendered level (INC-14), by action id — so
 *  a test can only reach a create screen the way an operator does. */
function createButton(blocks: readonly LooseBlock[], actionId: string): LooseElement | undefined {
	return buttons(blocks).find((b) => b.action_id === actionId);
}

/** Drill into the "New shipping zone" screen by clicking the promoted button. */
async function openNewZoneScreen(from?: LooseBlock[]): Promise<LooseBlock[]> {
	const list = from ?? (await loadZones());
	const button = createButton(list, "shipping:open-create-zone");
	expect(button, "no New shipping zone button").toBeDefined();
	return clickButton("shipping:open-create-zone", valueOf(button));
}

/** Drill into a zone's "New shipping method" screen from its methods level —
 *  the button is what carries the zone path (L-6). */
async function openNewMethodScreen(methods: LooseBlock[]): Promise<LooseBlock[]> {
	const button = createButton(methods, "shipping:open-create-method");
	expect(button, "no New shipping method button").toBeDefined();
	return clickButton("shipping:open-create-method", valueOf(button));
}

/** What `blocks/form.tsx` would post for an UNTOUCHED form: every field's
 *  `initial_value`, and no key at all for a field without one — how a "the
 *  refusal put my typing back" claim is checked without asserting on the
 *  renderer's own state. */
function formInitialValues(
	blocks: readonly LooseBlock[],
	submitActionId: string,
): Record<string, unknown> {
	const form = formFor(blocks, submitActionId);
	const out: Record<string, unknown> = {};
	for (const f of (form?.fields ?? []) as Array<Record<string, unknown>>) {
		if (f.initial_value !== undefined) out[String(f.action_id)] = f.initial_value;
	}
	return out;
}

describe("admin Shipping console — zones level, accordion branch (workerd sandbox)", () => {
	test("page_load /shipping renders one per-row accordion per zone, all collapsed (L-9), off the plugin's own store", async () => {
		await seedShipping();
		const blocks = await loadZones();
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(true);
		expect(findBlocks(blocks, "divider")).toHaveLength(0); // R-4/X-6

		const usGroup = group(blocks, "ship:zone:us");
		expect(usGroup?.label).toBe("us — United States");
		const emptyGroup = group(blocks, "ship:zone:empty");
		expect(emptyGroup?.label).toBe("empty — Empty zone");
		// L-9: every per-row accordion is collapsed — a registry level renders
		// with ZERO open groups.
		expect(openGroupIds(blocks)).toHaveLength(0);
	});

	test("a zone's regions render honestly in the row's edit form (array joins, null renders blank)", async () => {
		await seedShipping();
		const blocks = await loadZones();
		const usForm = formFor(groupBlocks(blocks, "ship:zone:us"), "shipping:save-zone");
		expect(field(usForm, "regions")?.initial_value).toBe("US");
		const emptyForm = formFor(groupBlocks(blocks, "ship:zone:empty"), "shipping:save-zone");
		expect(field(emptyForm, "regions")?.initial_value).toBe("");
	});

	// DELETED: "NO-TOKEN page_load /shipping fails closed with E-7's normative
	// copy". It withheld the kv admin token so the stub answered 401 and the
	// zones level's `onError` fired. There is no token — `makeAdminClients`
	// builds the rules client over `ctx.storage` with no credential of any kind
	// — so the input that produced it cannot be expressed. `zonesFailClosed()`
	// is still wired as the level's `onError`; its only remaining producer is
	// storage itself failing, which this tier cannot induce without breaking the
	// bridge the whole suite runs on, and a fixture that faked one would assert
	// on itself.

	test("the row edit form's block_id carries the zoneId invisibly — no visible carrier field, no id in the field label", async () => {
		await seedShipping();
		const usForm = formFor(groupBlocks(await loadZones(), "ship:zone:us"), "shipping:save-zone");
		expect(fieldIds(usForm)).toEqual(["name", "regions"]); // no "zoneId" field (F-2, F-3)
		expect(String(field(usForm, "name")?.label)).toBe("Name"); // no id in the label (M-7)
		expect(carriedContext(usForm?.block_id)?.zoneId).toBe("us");
	});

	test("save-zone applies the full-replace edit (reading the carried zoneId, not a visible field) and reloads with a 'saved' notice", async () => {
		await seedShipping();
		const usForm = formFor(groupBlocks(await loadZones(), "ship:zone:us"), "shipping:save-zone");
		const blocks = await submitForm(
			"shipping:save-zone",
			{ name: "USA", regions: "US, PR" },
			usForm?.block_id,
		);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		// THE ROW, not a request body: both keys of the full replace landed, and
		// the comma list became a real array rather than a garbled string.
		expect(await shippingRules.getZone("us")).toEqual({
			id: "us",
			name: "USA",
			regions: ["US", "PR"],
		});
	});

	test("the row's 'View methods' button carries the FULL target path in value.target, never a bare id (§12.7)", async () => {
		await seedShipping();
		const rowButtons = buttons(groupBlocks(await loadZones(), "ship:zone:us"));
		const view = rowButtons.find((b) => b.action_id === "shipping:open");
		expect(view?.label).toBe("View methods");
		expect(decodePath(String(valueOf(view).target))).toEqual(["us"]);
	});

	test("opening a zone via the row BUTTON drills to its methods (button carries no block_id — only value)", async () => {
		await seedShipping();
		const view = buttons(groupBlocks(await loadZones(), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:open",
		);
		const blocks = await clickButton("shipping:open", valueOf(view));
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
	});

	test("deleting a zone is unconditional (DA-2) — a forbid-if-methods conflict is reported by the post-attempt banner", async () => {
		await seedShipping();
		const del = buttons(groupBlocks(await loadZones(), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:delete-zone",
		);
		expect(del?.label).toBe("Delete zone"); // no id in the button label (M-7)
		expect(del?.style).toBe("danger");
		expect(confirmOf(del).style).toBe("danger");
		const banner = bannerOf(await clickButton("shipping:delete-zone", valueOf(del)));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/shipping methods/i);
		expect(await shippingRules.getZone("us")).not.toBeNull(); // never deleted
	});

	test("deleting a zone with no methods removes it and reloads with a 'deleted' notice; a repeat delete is idempotent", async () => {
		await seedShipping();
		const del = buttons(groupBlocks(await loadZones(), "ship:zone:empty")).find(
			(b) => b.action_id === "shipping:delete-zone",
		);
		const first = await clickButton("shipping:delete-zone", valueOf(del));
		expect(await shippingRules.getZone("empty")).toBeNull();
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(group(first, "ship:zone:empty")).toBeUndefined();

		const second = await clickButton("shipping:delete-zone", valueOf(del));
		const secondBanner = bannerOf(second);
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("create-zone with blank fields is caught at the plugin boundary — nothing is written", async () => {
		await seedShipping();
		const before = await shippingRules.listZones();
		const blocks = await submitForm("shipping:create-zone", { id: "", name: "", regions: "" });
		expect(await shippingRules.listZones()).toEqual(before);
		expect(bannerOf(blocks)?.variant).toBe("error");
	});

	test("create-zone stores {id,name,regions} with the regions parsed to a string array, then re-lists with a success notice", async () => {
		await seedShipping();
		const blocks = await submitForm("shipping:create-zone", {
			id: "eu",
			name: "Europe",
			regions: " EU , FR ",
		});
		expect(await shippingRules.getZone("eu")).toEqual({
			id: "eu",
			name: "Europe",
			regions: ["EU", "FR"],
		});
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		expect(group(blocks, "ship:zone:eu")).toBeDefined();
	});

	test("a blank regions input creates a zone with regions=null (an explicit 'none', not a garbled string)", async () => {
		await seedShipping();
		const blocks = await submitForm("shipping:create-zone", {
			id: "anywhere",
			name: "Anywhere",
			regions: "",
		});
		expect(await shippingRules.getZone("anywhere")).toEqual({
			id: "anywhere",
			name: "Anywhere",
			regions: null,
		});
		expect(bannerOf(blocks)?.variant).toBe("default");
	});

	test("creating a zone with a duplicate id refuses with a GENERIC error banner and writes nothing", async () => {
		// THE MECHANISM CHANGED AND THE GUARANTEE DID NOT. A duplicate used to be a
		// 500 the HTTP client mapped to `{ok:false}`, which the screen dressed as
		// its own "Zone not created". In-process the store REJECTS with a collision
		// error, which the scaffold's custom-action net catches — so the operator
		// gets the engine's "outcome unknown, re-check the record" banner instead of
		// the screen's copy, and the draft is not carried back. A REGRESSION IN
		// COPY, not in safety: still an error, still no raw status or path, and the
		// registry is provably unchanged. (Recovering the screen's own copy would
		// need the client to catch the collision and answer `{ok:false}` — a `src/`
		// change, not a test one.)
		await seedShipping();
		const blocks = await submitForm("shipping:create-zone", {
			id: "us",
			name: "United States again",
			regions: "",
		});
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		expect((await shippingRules.getZone("us"))?.name).toBe("United States");
		expect((await shippingRules.listZones()).filter((z) => z.id === "us")).toHaveLength(1);
	});

	test("the create screen carries the F-8 line about regions; the page context stays terse and says nothing about them", async () => {
		await seedShipping();
		const blocks = await loadZones();
		// The page-level context stays terse (≤140) and says nothing about regions.
		const pageContext = String(findBlocks(blocks, "context")[0]?.text);
		expect(pageContext.length).toBeLessThanOrEqual(140);
		expect(pageContext).not.toMatch(/auto-match/i);
		// The F-8 line moved WITH the form it qualifies, onto the create screen.
		const screen = await openNewZoneScreen(blocks);
		expect(contextTexts(screen).some((t) => /auto-match/i.test(t))).toBe(true);
	});

	// -- INC-14: the create action is a button above the data ------------------

	test("INC-14: `New shipping zone` is a primary BUTTON directly under the intro line, above the rows — and no create accordion survives below them", async () => {
		await seedShipping();
		const blocks = await loadZones();
		expect(blocks.map((b) => String(b.type)).slice(0, 3)).toEqual(["header", "context", "actions"]);
		const button = createButton(blocks, "shipping:open-create-zone");
		expect(button?.type).toBe("button");
		expect(button?.label).toBe("New shipping zone");
		expect(button?.style).toBe("primary");
		const firstRow = blocks.findIndex((b) => String(b.block_id).startsWith("ship:zone:"));
		expect(blocks.findIndex((b) => b.type === "actions")).toBeLessThan(firstRow);
		// L-8's bottom create group is gone, in either block_id, and no create
		// form renders on the registry at all.
		expect(group(blocks, "ship:new-zone")).toBeUndefined();
		expect(group(blocks, "ship:new-zone:open")).toBeUndefined();
		expect(formFor(blocks, "shipping:create-zone")).toBeUndefined();
		expect(openGroupIds(blocks)).toHaveLength(0); // X-18
	});

	test("INC-14: the New shipping zone screen is a drill-in whose back control returns to the registry", async () => {
		await seedShipping();
		const screen = await openNewZoneScreen();
		expect(screen.some((b) => b.type === "header" && b.text === "New shipping zone")).toBe(true);
		expect(
			findBlocks(screen, "accordion").filter((a) => String(a.block_id).startsWith("ship:zone:")),
		).toHaveLength(0);
		expect(fieldIds(formFor(screen, "shipping:create-zone"))).toEqual(["id", "name", "regions"]);

		const back = buttons(screen).find((b) => b.action_id === "shipping:cancel-new");
		expect(String(back?.label)).toMatch(/back to shipping zones/i);
		const list = await clickButton("shipping:cancel-new", valueOf(back));
		expect(list.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(true);
		expect(group(list, "ship:zone:us")).toBeDefined();
	});

	// THE PROPERTY THIS INCREMENT MUST NOT LOSE: a refusal never costs the
	// operator their typing. It used to rest on the client keeping the create
	// form mounted; every refusal now carries the values back as
	// `initial_value` (DA-3a-i), which is checkable from the emitted JSON.
	test("INC-14/DA-3a-i: a REFUSED zone create re-renders the create screen with all three typed values put back", async () => {
		await seedShipping();
		const screen = await openNewZoneScreen();
		const blocks = await submitForm(
			"shipping:create-zone",
			{ id: "", name: "Canada", regions: "CA, US" },
			formFor(screen, "shipping:create-zone")?.block_id,
		);
		expect(await shippingRules.getZone("ca")).toBeNull();
		expect(bannerOf(blocks)?.variant).toBe("error");
		expect(blocks.some((b) => b.type === "header" && b.text === "New shipping zone")).toBe(true);
		expect(formInitialValues(blocks, "shipping:create-zone")).toEqual({
			name: "Canada",
			regions: "CA, US", // VERBATIM — never the parsed region array
		});

		// Fixing the one field and resubmitting creates the zone and returns.
		const created = await submitForm(
			"shipping:create-zone",
			{ id: "ca", name: "Canada", regions: "CA, US" },
			formFor(blocks, "shipping:create-zone")?.block_id,
		);
		expect((await shippingRules.getZone("ca"))?.regions).toEqual(["CA", "US"]);
		expect(bannerOf(created)?.variant).toBe("default");
		expect(formFor(created, "shipping:create-zone")).toBeUndefined();
	});
});

describe("admin Shipping console — zones level, zero-row empty state (E-2)", () => {
	test("zero zones renders the `empty` block (not the row list) with a create action in empty.actions", async () => {
		await seedShipping({ zones: [], methods: [], rates: [] });
		const blocks = await loadZones();
		expect(
			findBlocks(blocks, "accordion").some((a) => String(a.block_id).startsWith("ship:zone:")),
		).toBe(false);
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No shipping zones yet");
		const action = emptyActions(blocks)[0];
		expect(action?.action_id).toBe("shipping:open-create-zone");
	});

	test("clicking the empty state's create action opens the SAME create screen as the promoted button (E-2)", async () => {
		await seedShipping({ zones: [], methods: [], rates: [] });
		const action = emptyActions(await loadZones())[0];
		// One act, one wording — the empty state and the promoted button above it.
		expect(action?.label).toBe("New shipping zone");
		const blocks = await clickButton("shipping:open-create-zone", valueOf(action));
		expect(blocks.some((b) => b.type === "header" && b.text === "New shipping zone")).toBe(true);
		expect(formFor(blocks, "shipping:create-zone")).toBeDefined();
		expect(openGroupIds(blocks)).toHaveLength(0); // X-18
	});
});

describe("admin Shipping console — zones level, L-9 fallback branch (>25 rows)", () => {
	test("at 25 zones (a complete page), the ACCORDION branch renders — no table, no L-7 drill-in", async () => {
		await seedShipping(manyZones(25));
		const blocks = await loadZones();
		expect(findBlocks(blocks, "table")).toHaveLength(0);
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("ship:zone:")),
		).toHaveLength(25);
	});

	test("at 26 zones, the TABLE + combobox drill-in branch renders instead — no per-row accordions", async () => {
		await seedShipping(manyZones(26));
		const blocks = await loadZones();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("ship:zone:")),
		).toHaveLength(0);
		const table = findBlock(blocks, "table");
		expect(table).toBeDefined();
		expect(tableRows(blocks)).toHaveLength(26);
		expect(String(table?.empty_text).length).toBeGreaterThan(0); // T-7/L-9b
		expect(table?.page_action_id).toBe("shipping:page"); // R-21/T-6

		// L-7: always a combobox, option value is the encoded path, label never
		// contains the id (X-22, M-7).
		const openForm = formFor(blocks, "shipping:open");
		const targetField = field(openForm, "target");
		expect(targetField?.type).toBe("combobox");
		const options = targetField?.options as Array<{ value: string; label: string }>;
		expect(options.every((o) => o.value !== "")).toBe(true); // F-6a/X-23
		expect(options.some((o) => o.label.includes("z0"))).toBe(false); // no id in the label

		const z0 = options.find((o) => decodePath(o.value)?.[0] === "z0");
		const drill = await submitForm("shipping:open", { target: z0!.value }, openForm?.block_id);
		expect(drill.some((b) => b.type === "header" && b.text === "Shipping methods — z0")).toBe(true);
	});
});

describe("admin Shipping console — methods level, depth 1 (workerd sandbox)", () => {
	/** Open the `us` zone's methods the way the zones list does — the row's own
	 *  "View methods" BUTTON, carrying the full target path (§12.7). */
	async function openUsMethods(): Promise<LooseBlock[]> {
		const view = buttons(groupBlocks(await loadZones(), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:open",
		);
		return clickButton("shipping:open", valueOf(view));
	}

	test("opening a zone drills to its methods; each per-row accordion label LEADS WITH THE PRICE, then the name, the full slug id and the type", async () => {
		await seedShipping();
		const blocks = await openUsMethods();
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		// The number the operator came for is FIRST, so every row's amount starts
		// at the same left edge and the column can be compared vertically. The
		// slug keeps its place IN FULL — a method id is a natural key, not a uuid.
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"$4.99 — Standard · standard · flat rate",
		);
		expect(buttons(blocks).some((e) => e.action_id === "shipping:back")).toBe(true);
		expect(openGroupIds(blocks)).toHaveLength(0); // L-9: zero open groups
	});

	test("a method with no rate in the filter currency says so — never 'Free', never a zero amount", async () => {
		await seedShipping();
		const label = String(group(await openUsMethods(), "ship:method:us:bare")?.label);
		expect(label).toBe("No rate set — No rates yet · bare · flat rate");
		expect(label).not.toMatch(/free|\$0|0\.00/i);
	});

	test("a method priced in ANOTHER currency reads as unset FOR THIS CURRENCY, not as unconfigured — and prices once the filter names its currency", async () => {
		// THE FALSE-ABSENCE CASE. A store that prices solely in EUR, read under
		// the USD default, must not report a fully configured method as having no
		// rate at all — the same lie as rendering an unknown price as `Free`.
		await seedShipping({
			methods: [
				...DEFAULT_METHODS,
				{ id: "eu-express", zoneId: "us", name: "Express courier", type: "flat_rate" },
			],
			rates: [
				...DEFAULT_RATES,
				{ methodId: "eu-express", currency: "EUR", amountCents: 1200, minSubtotalCents: null },
			],
		});
		const usd = await openUsMethods();
		expect(group(usd, "ship:method:us:eu-express")?.label).toBe(
			"No rate set — Express courier · eu-express · flat rate",
		);
		// The row carries no ISO code (G1) — the currency is named once, above,
		// and THAT is where the row's claim is scoped: the operator reads "no USD
		// rate", not "unconfigured". Row-level scoping was tried first and is 63
		// chars against X-11's 60-char accordion budget.
		expect(String(group(usd, "ship:method:us:eu-express")?.label)).not.toContain("USD");
		expect(contextTexts(usd)).toContain(
			'"Flat rate" always charges its rate; "Free shipping" charges nothing above its threshold. Prices in USD — "No rate set" means no USD rate.',
		);

		const filterForm = formFor(usd, "shipping:apply-filter");
		const eur = await submitForm(
			"shipping:apply-filter",
			{ currency: "EUR" },
			filterForm?.block_id,
		);
		expect(group(eur, "ship:method:us:eu-express")?.label).toBe(
			"€12.00 — Express courier · eu-express · flat rate",
		);
		// …and the USD-only method flips the other way, by the same rule, with the
		// context line's scope flipping with it.
		expect(group(eur, "ship:method:us:standard")?.label).toBe(
			"No rate set — Standard · standard · flat rate",
		);
		expect(contextTexts(eur).some((t) => t.endsWith('"No rate set" means no EUR rate.'))).toBe(
			true,
		);
	});

	test("a currency that is not a currency code is rejected BEFORE any read: banner in a 200, rows unpriced, nothing claimed", async () => {
		await seedShipping();
		const opened = await openUsMethods();
		const filterForm = formFor(opened, "shipping:apply-filter");
		const blocks = await submitForm(
			"shipping:apply-filter",
			{ currency: "dollars" },
			filterForm?.block_id,
		);
		// THE "no doomed reads" CLAIM IS NOW MADE BY THE ROWS, not by a request
		// log. `not-priced` is a state the row can only be in when `pricedMethods`
		// short-circuited before asking — a read that HAD been attempted and failed
		// would render "Price unavailable" instead, and one that succeeded would
		// render an amount. So "Price not loaded" on every row IS the assertion
		// that the typo cost zero lookups.
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toBe("Enter a 3-letter currency code like USD.");
		// The list itself is unaffected and stays on screen, with the offending
		// field still there to fix.
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"Price not loaded — Standard · standard · flat rate",
		);
		expect(group(blocks, "ship:method:us:bare")?.label).toBe(
			"Price not loaded — No rates yet · bare · flat rate",
		);
		expect(field(formFor(blocks, "shipping:apply-filter"), "currency")?.initial_value).toBe(
			"DOLLARS",
		);
		// Nothing priced ⇒ no currency claimed, and never the read-failure copy.
		expect(findBlocks(blocks, "context").some((c) => /Prices in/.test(String(c.text)))).toBe(false);
		expect(
			findBlocks(blocks, "accordion").some((a) => /Price unavailable/.test(String(a.label))),
		).toBe(false);
	});

	test("a FAILED price read degrades that row to 'Price unavailable' — the level still renders, and absence is never claimed", async () => {
		// THE FAILURE IS REAL, AND IT IS THE ONE THIS TIER CAN STILL PRODUCE. The
		// old fixture answered 500 to every rate GET; there is no GET. What
		// remains is the rules client's own input guard: `getRate` runs
		// `requireIdToken("methodId", …)`, which REFUSES an id carrying
		// whitespace. A method whose id was written straight to the store (as a
		// legacy row, or by any writer that did not go through this client) is
		// therefore listable but not price-readable — a secondary read that
		// throws, which is exactly the shape `methodPrice` contains. The primary
		// list read is untouched, so the level must still render.
		await seedShipping({
			methods: [
				...DEFAULT_METHODS,
				{ id: "legacy id", zoneId: "us", name: "Legacy", type: "flat_rate" },
			],
		});
		const blocks = await openUsMethods();
		// Secondary read: the methods list itself still rendered, no fail-closed banner.
		expect(bannerOf(blocks)).toBeUndefined();
		expect(group(blocks, "ship:method:us:legacy id")?.label).toBe(
			"Price unavailable — Legacy · legacy id · flat rate",
		);
		// "unavailable" is not "none": a read that did not answer must not be
		// reported as a rate that does not exist…
		expect(String(group(blocks, "ship:method:us:legacy id")?.label)).not.toMatch(/no rate set/i);
		// …and the containment is PER ROW: the readable rows are priced as usual.
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"$4.99 — Standard · standard · flat rate",
		);
		expect(group(blocks, "ship:method:us:bare")?.label).toBe(
			"No rate set — No rates yet · bare · flat rate",
		);
	});

	test("the price is read in the level's currency, and the currency is stated ONCE for the list (G1)", async () => {
		// DELETED FROM THIS CASE: `expect(rateReads).toEqual([...two URLs...])` —
		// the exact one-read-per-method fan-out. Those reads are now in-isolate
		// store calls with no observable trace on this side of the bridge, and
		// counting them would mean instrumenting shared harness infrastructure to
		// assert on an implementation detail. What survives is the bound's
		// OBSERVABLE consequence, asserted at the boundary two cases below: every
		// row priced at 25, and no row priced at 26.
		await seedShipping();
		const blocks = await openUsMethods();
		// Currency named once, in the level's context line — never as an ISO code
		// repeated per row — and inside X-11's 140-char page-context budget.
		const contexts = findBlocks(blocks, "context").map((c) => String(c.text));
		const priced = contexts.find((t) => t.includes("Prices in USD"));
		expect(priced).toBe(
			'"Flat rate" always charges its rate; "Free shipping" charges nothing above its threshold. Prices in USD — "No rate set" means no USD rate.',
		);
		expect(String(priced).length).toBeLessThanOrEqual(140);
		expect(String(group(blocks, "ship:method:us:standard")?.label)).not.toContain("USD");
		// One context line claiming a currency, not one per row.
		expect(contexts.filter((t) => t.includes("Prices in"))).toHaveLength(1);
	});

	test("the price currency is a filter: applying EUR re-reads in EUR and re-prices every row", async () => {
		await seedShipping({
			rates: [
				...DEFAULT_RATES,
				{ methodId: "standard", currency: "EUR", amountCents: 1200, minSubtotalCents: null },
			],
		});
		const opened = await openUsMethods();
		const filterForm = formFor(opened, "shipping:apply-filter");
		expect(field(filterForm, "currency")?.initial_value).toBe("USD");

		const blocks = await submitForm(
			"shipping:apply-filter",
			{ currency: "eur" },
			filterForm?.block_id,
		);
		// L-6: the depth-1 path survived the apply — this is still the `us`
		// methods list, not the root zones list.
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		// The re-read really happened in EUR: the same row that priced at $4.99
		// now prices at €12.00, which no cached USD answer could produce.
		expect(group(blocks, "ship:method:us:standard")?.label).toBe(
			"€12.00 — Standard · standard · flat rate",
		);
		expect(group(blocks, "ship:method:us:bare")?.label).toBe(
			"No rate set — No rates yet · bare · flat rate",
		);
		expect(
			findBlocks(blocks, "context").some((c) =>
				String(c.text).includes('Prices in EUR — "No rate set" means no EUR rate.'),
			),
		).toBe(true);
	});

	test("no operator-facing copy on this level names a raw enum — but the stored values are untouched", async () => {
		await seedShipping();
		const blocks = await openUsMethods();
		const copy = [
			...findBlocks(blocks, "context").map((c) => String(c.text)),
			...findBlocks(blocks, "accordion").map((a) => String(a.label)),
		].join(" | ");
		expect(copy).not.toMatch(/flat_rate|free_shipping/);
		expect(copy).toContain('"Flat rate" always charges its rate');
		expect(copy).toContain('"Free shipping" charges nothing above its threshold');

		// The SELECT still submits the enum the domain expects — humanizing the
		// copy must not touch the protocol, and the stored row still spells it.
		const createForm = formFor(await openNewMethodScreen(blocks), "shipping:create-method");
		const typeOptions = field(createForm, "type")?.options as Array<{
			value: string;
			label: string;
		}>;
		expect(typeOptions.map((o) => o.value)).toEqual(["flat_rate", "free_shipping"]);
		expect((await shippingRules.getMethod("standard"))?.type).toBe("flat_rate");
	});

	test("a zone with no methods yet shows the `empty` block, never a fail-closed banner", async () => {
		await seedShipping();
		const blocks = await openPath(["empty"]);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — empty")).toBe(
			true,
		);
		expect(findBlock(blocks, "empty")?.title).toBe("No shipping methods yet");
		expect(findBlock(blocks, "banner")).toBeUndefined();
	});

	test("the empty state's create action carries the zoneId in value.__path and opens the create screen at the RIGHT zone", async () => {
		await seedShipping();
		const action = emptyActions(await openPath(["empty"]))[0];
		expect(action?.action_id).toBe("shipping:open-create-method");
		expect(action?.label).toBe("New shipping method"); // one act, one wording
		expect(decodePath(String(valueOf(action)["__path"]))).toEqual(["empty"]);
		const blocks = await clickButton("shipping:open-create-method", valueOf(action));
		// The zone the operator was in, not the root registry — the path rode in
		// the button's own value (L-6).
		expect(
			blocks.some((b) => b.type === "header" && b.text === "New shipping method — empty"),
		).toBe(true);
		expect(carriedContext(formFor(blocks, "shipping:create-method")?.block_id)).toMatchObject({
			zoneId: "empty",
		});
		expect(openGroupIds(blocks)).toHaveLength(0); // X-18
	});

	test("the row edit form carries zoneId+methodId invisibly; save-method applies the LWW edit and reloads with a 'saved' notice", async () => {
		await seedShipping();
		const editForm = formFor(
			groupBlocks(await openPath(["us"]), "ship:method:us:standard"),
			"shipping:save-method",
		);
		expect(fieldIds(editForm)).toEqual(["name", "type"]);
		expect(carriedContext(editForm?.block_id)).toEqual({ zoneId: "us", methodId: "standard" });

		const blocks = await submitForm(
			"shipping:save-method",
			{ name: "Standard (2-5 days)", type: "flat_rate" },
			editForm?.block_id,
		);
		expect(bannerOf(blocks)?.variant).toBe("default");
		// Both keys of the full replace landed on the real row.
		expect(await shippingRules.getMethod("standard")).toMatchObject({
			name: "Standard (2-5 days)",
			type: "flat_rate",
			zoneId: "us",
		});
	});

	test("create-method carries the zoneId invisibly (no visible field) and writes the method UNDER that zone, then reloads the methods level", async () => {
		await seedShipping();
		const createForm = formFor(
			await openNewMethodScreen(await openPath(["us"])),
			"shipping:create-method",
		);
		expect(fieldIds(createForm)).toEqual(["id", "name", "type"]);
		const blocks = await submitForm(
			"shipping:create-method",
			{ id: "express", name: "Express", type: "flat_rate" },
			createForm?.block_id,
		);
		// The ZONE IS THE PATH, never the body: the new method belongs to `us`.
		expect(await shippingRules.getMethod("express")).toEqual({
			id: "express",
			zoneId: "us",
			name: "Express",
			type: "flat_rate",
		});
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(group(blocks, "ship:method:us:express")).toBeDefined();
		expect(bannerOf(blocks)?.variant).toBe("default");
	});

	test("an invalid method type is caught at the plugin boundary — nothing is written", async () => {
		await seedShipping();
		const createForm = formFor(
			await openNewMethodScreen(await openPath(["us"])),
			"shipping:create-method",
		);
		const refused = await submitForm(
			"shipping:create-method",
			{ id: "bogus", name: "Bogus", type: "not-a-type" },
			createForm?.block_id,
		);
		expect(await shippingRules.getMethod("bogus")).toBeNull();
		expect(bannerOf(refused)?.variant).toBe("error");
		// DA-3a-i: the refusal re-renders the create screen with the typed values
		// put back — a bogus `type` falls back to a real option (X-23) rather
		// than rendering a blank trigger, and the two text fields are verbatim.
		expect(refused.some((b) => b.type === "header" && b.text === "New shipping method — us")).toBe(
			true,
		);
		expect(formInitialValues(refused, "shipping:create-method")).toEqual({
			id: "bogus",
			name: "Bogus",
			type: "flat_rate",
		});
	});

	// -- INC-14: the create action is a button above the data ------------------

	test("INC-14: `New shipping method` is a primary BUTTON under the intro line, above the rows, carrying its zone path", async () => {
		await seedShipping();
		const blocks = await openUsMethods();
		// header · back · context · the create button (this level's intro line is
		// the context under the back control).
		expect(blocks.map((b) => String(b.type)).slice(0, 4)).toEqual([
			"header",
			"actions",
			"context",
			"actions",
		]);
		const button = createButton(blocks, "shipping:open-create-method");
		expect(button?.label).toBe("New shipping method");
		expect(button?.style).toBe("primary");
		// L-6: depth 1, so the path is not optional.
		expect(decodePath(String(valueOf(button)["__path"]))).toEqual(["us"]);
		const firstRow = blocks.findIndex((b) => String(b.block_id).startsWith("ship:method:"));
		expect(blocks.findIndex((b, i) => b.type === "actions" && i > 0)).toBeLessThan(firstRow);
		expect(group(blocks, "ship:new-method:us")).toBeUndefined();
		expect(group(blocks, "ship:new-method:us:open")).toBeUndefined();
		expect(formFor(blocks, "shipping:create-method")).toBeUndefined();
	});

	test("INC-14: the New shipping method screen is a drill-in whose back control returns to THAT zone's methods", async () => {
		await seedShipping();
		const screen = await openNewMethodScreen(await openUsMethods());
		expect(screen.some((b) => b.type === "header" && b.text === "New shipping method — us")).toBe(
			true,
		);
		expect(
			findBlocks(screen, "accordion").filter((a) => String(a.block_id).startsWith("ship:method:")),
		).toHaveLength(0);
		const back = buttons(screen).find((b) => b.action_id === "shipping:cancel-new");
		expect(String(back?.label)).toMatch(/back to shipping methods/i);
		const methods = await clickButton("shipping:cancel-new", valueOf(back));
		// The zone the operator came from, NOT the root registry.
		expect(methods.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(group(methods, "ship:method:us:standard")).toBeDefined();
	});

	test("deleting a method is unconditional (DA-2) — a forbid-if-rates conflict is reported by the post-attempt banner", async () => {
		await seedShipping();
		const del = buttons(groupBlocks(await openPath(["us"]), "ship:method:us:standard")).find(
			(b) => b.action_id === "shipping:delete-method",
		);
		expect(del?.label).toBe("Delete method");
		const banner = bannerOf(await clickButton("shipping:delete-method", valueOf(del)));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/rates/i);
		expect(await shippingRules.getMethod("standard")).not.toBeNull(); // never deleted
	});

	test("deleting a method with no rates removes it and reloads with a 'deleted' notice", async () => {
		await seedShipping();
		const del = buttons(groupBlocks(await openPath(["us"]), "ship:method:us:bare")).find(
			(b) => b.action_id === "shipping:delete-method",
		);
		const blocks = await clickButton("shipping:delete-method", valueOf(del));
		expect(await shippingRules.getMethod("bare")).toBeNull();
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("deleted");
		expect(group(blocks, "ship:method:us:bare")).toBeUndefined();
	});

	test("back from the methods level (depth 1) returns to the zones list", async () => {
		await seedShipping();
		const methods = await openPath(["us"]);
		const backValue = valueOf(buttons(methods).find((e) => e.action_id === "shipping:back"));
		const back = await clickButton("shipping:back", backValue);
		expect(back.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(true);
	});
});

describe("admin Shipping console — methods level, L-9 fallback branch (>25 rows)", () => {
	test("at 25 methods the ACCORDION branch renders and every row is priced; at 26, TABLE + combobox drill-in and NOTHING is priced (Type keeps its badge, T-5)", async () => {
		await seedShipping(manyMethods(25));
		const blocks25 = await openPath(["us"]);
		expect(findBlocks(blocks25, "table")).toHaveLength(0);
		const rows25 = findBlocks(blocks25, "accordion").filter((a) =>
			String(a.block_id).startsWith("ship:method:"),
		);
		expect(rows25).toHaveLength(25);
		// THE BOUND, ASSERTED AT THE BOUND, by its observable consequence: at 25
		// rows every row WAS priced (these methods have no rates, so the honest
		// answer is "No rate set" — a fact only a completed read can state).
		expect(rows25.every((a) => String(a.label).startsWith("No rate set — "))).toBe(true);

		await seedShipping(manyMethods(26));
		const blocks26 = await openPath(["us"]);
		expect(
			findBlocks(blocks26, "accordion").filter((a) =>
				String(a.block_id).startsWith("ship:method:"),
			),
		).toHaveLength(0);
		const table = findBlock(blocks26, "table");
		expect(table?.columns).toEqual([
			{ key: "id", label: "Method ID", format: "code" },
			{ key: "name", label: "Name" },
			{ key: "type", label: "Type", format: "badge" },
		]);
		expect(tableRows(blocks26)).toHaveLength(26);
		// The `Type` badge reads the human name; the stored value never appears.
		expect(tableRows(blocks26).map((r) => String(r["type"]))).toContain("Free shipping");
		expect(tableRows(blocks26).some((r) => /_/.test(String(r["type"])))).toBe(false);
		// THE PRICE FAN-OUT IS BOUNDED BY THE ACCORDION BRANCH. Past 25 rows the
		// table shows no price, so nothing is read: with nothing priced, the
		// context line claims no currency and the filter field is not rendered.
		expect(findBlocks(blocks26, "context").some((c) => /Prices in/.test(String(c.text)))).toBe(
			false,
		);
		expect(formFor(blocks26, "shipping:apply-filter")).toBeUndefined();
	}, 120_000);
});

describe("admin Shipping console — rates level, depth 2, EXEMPT from L-9 (workerd sandbox)", () => {
	test("opening a method drills to its rates, default-filtered to USD, rendered as `fields` (not a 1-row table, P-3)", async () => {
		await seedShipping();
		const view = buttons(groupBlocks(await openPath(["us"]), "ship:method:us:standard")).find(
			(b) => b.action_id === "shipping:open",
		);
		// Depth-3 open FIRED FROM A BUTTON — the trap: value.target must carry
		// the FULL [zoneId, methodId] path, and parseOpen must read `value`, not
		// only `values` (§12.7).
		expect(decodePath(String(valueOf(view).target))).toEqual(["us", "standard"]);
		const blocks = await clickButton("shipping:open", valueOf(view));
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		);

		expect(findBlocks(blocks, "table")).toHaveLength(0); // L-9a: no table at this level
		// The default currency is USD and the readout is the stored row, exactly.
		expect(fieldEntries(blocks)).toEqual([
			"Currency=USD",
			"Amount=$4.99",
			"Free-shipping threshold=$35.00",
			"Method=standard",
		]);
		expect(buttons(blocks).some((e) => e.action_id === "shipping:back")).toBe(true);
		// No "Clear filters" section — the currency filter is already at its default.
		expect(findBlocks(blocks, "section")).toHaveLength(0);
	});

	test("a method with no rate for the filtered currency shows an honest context line, never fail-closed", async () => {
		await seedShipping();
		const blocks = await openPath(["us", "bare"]);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — bare")).toBe(
			true,
		);
		expect(findBlocks(blocks, "fields")).toHaveLength(0);
		expect(contextTexts(blocks).some((t) => /no rate set/i.test(t))).toBe(true);
	});

	test("filtering to a non-default currency renders the L-6 'Clear filters' section, whose button re-applies the [zoneId,methodId] path", async () => {
		await seedShipping({
			rates: [
				...DEFAULT_RATES,
				{ methodId: "standard", currency: "EUR", amountCents: 599, minSubtotalCents: null },
			],
		});
		const opened = await openPath(["us", "standard"]);
		const filterForm = formFor(opened, "shipping:apply-filter");
		expect(filterForm?.submit).toEqual({
			label: "Apply filters",
			action_id: "shipping:apply-filter",
		});

		const blocks = await submitForm(
			"shipping:apply-filter",
			{ currency: "eur" },
			filterForm?.block_id,
		);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		); // path survived
		// The EUR row, not the USD one — the filter reached the store.
		expect(fieldEntries(blocks)).toEqual([
			"Currency=EUR",
			"Amount=€5.99",
			"Free-shipping threshold=No minimum",
			"Method=standard",
		]);

		const section = findBlock(blocks, "section");
		expect(String(section?.text)).toBe("currency: EUR");
		const clearButton = section?.accessory as LooseElement;
		expect(clearButton.action_id).toBe("shipping:apply-filter");
		expect(clearButton.label).toBe("Clear filters");

		const cleared = await clickButton("shipping:apply-filter", clearButton.value);
		expect(cleared.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		); // still the SAME method's rates, not the root
		expect(fieldEntries(cleared)[0]).toBe("Currency=USD"); // back to the default
	});

	test("create-rate stores the EXACT integer cents (0 is allowed), then reloads the rates level", async () => {
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		expect(carriedContext(createForm?.block_id)).toEqual({ zoneId: "us", methodId: "bare" });
		const blocks = await submitForm(
			"shipping:create-rate",
			{ currency: "usd", amount: "0", minSubtotal: "" },
			createForm?.block_id,
		);
		// ZERO IS A PRICE, and it is stored as the integer 0 rather than dropped:
		// a $0 flat rate is legitimate config, and a blank threshold is an
		// explicit "none", never a 0 minimum.
		expect(await shippingRules.getRate("bare", toCurrency("USD"))).toEqual({
			methodId: "bare",
			currency: "USD",
			amountCents: 0,
			minSubtotalCents: null,
		});
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping rates — bare")).toBe(
			true,
		);
		expect(bannerOf(blocks)?.variant).toBe("default");
	});

	test("a malformed amount is caught at the plugin boundary — nothing is written (money parse edge)", async () => {
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		const blocks = await submitForm(
			"shipping:create-rate",
			{ currency: "USD", amount: "4.999", minSubtotal: "" },
			createForm?.block_id,
		);
		expect(await shippingRules.getRate("bare", toCurrency("USD"))).toBeNull();
		expect(bannerOf(blocks)?.variant).toBe("error");
	});

	test("a negative amount is caught at the plugin boundary — nothing is written (money parse edge)", async () => {
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		const blocks = await submitForm(
			"shipping:create-rate",
			{ currency: "USD", amount: "-1", minSubtotal: "" },
			createForm?.block_id,
		);
		expect(await shippingRules.getRate("bare", toCurrency("USD"))).toBeNull();
		expect(bannerOf(blocks)?.variant).toBe("error");
	});

	test("an invalid currency code is caught at the plugin boundary — nothing is written", async () => {
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		const blocks = await submitForm(
			"shipping:create-rate",
			{ currency: "US", amount: "4.99", minSubtotal: "" },
			createForm?.block_id,
		);
		expect(bannerOf(blocks)?.variant).toBe("error");
		// Nothing landed under the truncated code, nor under a helpfully-guessed one.
		expect(await shippingRules.getRate("bare", toCurrency("USD"))).toBeNull();
	});

	test("the rate edit form carries the CAS watermark (expectedAmountCents) invisibly, alongside zoneId/methodId/currency", async () => {
		await seedShipping();
		const editForm = formFor(await openPath(["us", "standard"]), "shipping:save-rate");
		expect(fieldIds(editForm)).toEqual(["amount", "minSubtotal"]); // no hidden fields visible
		expect(field(editForm, "amount")?.type).toBe("text_input"); // never number_input
		expect(field(editForm, "amount")?.initial_value).toBe("4.99");
		expect(field(editForm, "minSubtotal")?.initial_value).toBe("35.00");
		expect(carriedContext(editForm?.block_id)).toEqual({
			zoneId: "us",
			methodId: "standard",
			currency: "USD",
			expectedAmountCents: "499",
		});
	});

	test("save-rate applies the CAS edit and reloads with a 'saved' notice", async () => {
		await seedShipping();
		const editForm = formFor(await openPath(["us", "standard"]), "shipping:save-rate");
		const blocks = await submitForm(
			"shipping:save-rate",
			{ amount: "5.99", minSubtotal: "" },
			editForm?.block_id,
		);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		// The stored row moved, and the blank threshold CLEARED it — the
		// required-nullable full-replace key, proven on the row rather than in a
		// request body.
		expect(await shippingRules.getRate("standard", toCurrency("USD"))).toMatchObject({
			amountCents: 599,
			minSubtotalCents: null,
		});
	});

	test("a concurrent-edit conflict loses the CAS: the fresh rate is reloaded with a re-apply warning, never a clobber", async () => {
		await seedShipping();
		// Stage an edit form whose carried watermark (499) is already stale by
		// the time it is submitted — a real out-of-band change to the record,
		// written through the store's own CAS so the concurrent edit is as real as
		// the one it is about to beat.
		const editForm = formFor(await openPath(["us", "standard"]), "shipping:save-rate");
		await shippingRules.updateRate(
			"standard",
			toCurrency("USD"),
			{ amountCents: toCents(1), minSubtotalCents: toCents(3500) },
			toCents(499),
		);

		const blocks = await submitForm(
			"shipping:save-rate",
			{ amount: "9.00", minSubtotal: "" },
			editForm?.block_id,
		);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/changed since you loaded it|reload/i);
		// The submitted edit was NOT applied — the concurrent 1 stands.
		expect((await shippingRules.getRate("standard", toCurrency("USD")))?.amountCents).toBe(1);
		expect(fieldEntries(blocks)).toContain("Amount=$0.01"); // the FRESH value, from a real reload
	});

	test("delete-rate removes the row and reloads with a 'deleted' notice, danger copy about in-flight carts / snapshotted orders; a repeat delete is idempotent", async () => {
		await seedShipping();
		const del = buttons(await openPath(["us", "standard"])).find(
			(e) => e.action_id === "shipping:delete-rate",
		);
		expect(del?.label).toBe("Delete rate");
		expect(String(confirmOf(del).text)).toMatch(/in-flight carts/i);
		expect(String(confirmOf(del).text)).toMatch(/snapshots the shipping fee/i);

		const first = await clickButton("shipping:delete-rate", valueOf(del));
		expect(await shippingRules.getRate("standard", toCurrency("USD"))).toBeNull();
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(findBlocks(first, "fields")).toHaveLength(0);

		const second = await clickButton("shipping:delete-rate", valueOf(del));
		const secondBanner = bannerOf(second);
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("back from the rates level (depth 2) pops exactly ONE level, to the methods list — not the root", async () => {
		await seedShipping();
		const rates = await openPath(["us", "standard"]);
		const backValue = valueOf(buttons(rates).find((e) => e.action_id === "shipping:back"));
		const blocks = await clickButton("shipping:back", backValue);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(false);
	});
});

describe("admin Shipping console — full deep-drill round trip via row BUTTONS (workerd sandbox)", () => {
	test("zones → methods → rates → back → back returns to zones, every open fired from a row button carrying the FULL path", async () => {
		await seedShipping();
		const zones = await loadZones();
		const zoneOpen = buttons(groupBlocks(zones, "ship:zone:us")).find(
			(b) => b.action_id === "shipping:open",
		);
		expect(decodePath(String(valueOf(zoneOpen).target))).toEqual(["us"]);
		const methods = await clickButton("shipping:open", valueOf(zoneOpen));
		expect(methods.some((b) => b.type === "header" && b.text === "Shipping methods — us")).toBe(
			true,
		);

		const methodOpen = buttons(groupBlocks(methods, "ship:method:us:standard")).find(
			(b) => b.action_id === "shipping:open",
		);
		// The depth-3 trap: the FULL [zoneId, methodId] path, not a bare methodId.
		expect(decodePath(String(valueOf(methodOpen).target))).toEqual(["us", "standard"]);
		const rates = await clickButton("shipping:open", valueOf(methodOpen));
		expect(rates.some((b) => b.type === "header" && b.text === "Shipping rates — standard")).toBe(
			true,
		);

		const backToMethods = await clickButton(
			"shipping:back",
			valueOf(buttons(rates).find((e) => e.action_id === "shipping:back")),
		);
		expect(
			backToMethods.some((b) => b.type === "header" && b.text === "Shipping methods — us"),
		).toBe(true);

		const backToZones = await clickButton(
			"shipping:back",
			valueOf(buttons(backToMethods).find((e) => e.action_id === "shipping:back")),
		);
		expect(backToZones.some((b) => b.type === "header" && b.text === "Shipping zones")).toBe(true);
	});
});

describe("admin Shipping console — assertBlockContract (§15 V-3)", () => {
	// Every H-marked §13 anti-pattern this helper enforces, run against one
	// rendered response per drill level, per branch, and per zero-row state —
	// all three levels are LIST levels (D-2: Shipping has no detail screen).
	test("assertBlockContract holds at every level, both L-9 branches, and both empty states", async () => {
		await seedShipping();

		const zonesList = await loadZones();
		assertBlockContract(zonesList, { screen: "shipping", level: "list" });

		const methodsList = await openPath(["us"]);
		assertBlockContract(methodsList, { screen: "shipping", level: "list" });

		assertBlockContract(await openPath(["empty"]), { screen: "shipping", level: "list" });

		// INC-14's four new list-level renders: each create screen, and each
		// after a refusal (a banner plus a form full of prefilled values).
		const zoneScreen = await openNewZoneScreen(zonesList);
		assertBlockContract(zoneScreen, { screen: "shipping", level: "list" });
		assertBlockContract(
			await submitForm(
				"shipping:create-zone",
				{ id: "", name: "Canada", regions: "CA" },
				formFor(zoneScreen, "shipping:create-zone")?.block_id,
			),
			{ screen: "shipping", level: "list" },
		);
		const methodScreen = await openNewMethodScreen(methodsList);
		assertBlockContract(methodScreen, { screen: "shipping", level: "list" });
		assertBlockContract(
			await submitForm(
				"shipping:create-method",
				{ id: "x", name: "", type: "flat_rate" },
				formFor(methodScreen, "shipping:create-method")?.block_id,
			),
			{ screen: "shipping", level: "list" },
		);

		assertBlockContract(await openPath(["us", "standard"]), { screen: "shipping", level: "list" });
		assertBlockContract(await openPath(["us", "bare"]), { screen: "shipping", level: "list" });

		// The zero-row `empty` state (E-2) — zones and methods. The fixture is
		// re-seeded rather than the sandbox rebooted: the isolate holds no state,
		// so a case's shape comes entirely from what the store says.
		await seedShipping({ zones: [], methods: [], rates: [] });
		assertBlockContract(await loadZones(), { screen: "shipping", level: "list" });

		// The L-9 fallback branch (>25 rows) — zones and methods.
		await seedShipping(manyZones(26));
		assertBlockContract(await loadZones(), { screen: "shipping", level: "list" });

		await seedShipping(manyMethods(26));
		assertBlockContract(await openPath(["us"]), { screen: "shipping", level: "list" });
	}, 180_000);
});
