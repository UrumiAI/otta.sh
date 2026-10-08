import { cents as toCents, currency as toCurrency, idempotencyKey } from "@otta-sh/domain";
import {
	EmdashSettingsStore,
	EmdashShippingRulesStore,
	systemClock,
	type StorageAccess,
} from "@otta-sh/store-emdash";
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

	test("create-zone stores {id,name,regions} with the regions parsed to UPPERCASE ISO codes, then re-lists with a success notice", async () => {
		await seedShipping();
		const blocks = await submitForm("shipping:create-zone", {
			id: "eu",
			name: "Europe",
			regions: " FR , de ",
		});
		expect(await shippingRules.getZone("eu")).toEqual({
			id: "eu",
			name: "Europe",
			regions: ["FR", "DE"],
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

	test("creating a zone with a duplicate id says the ID is taken — never 'outcome unknown' — and keeps the typing", async () => {
		// The store refuses a duplicate id before writing anything, and the client
		// answers that as the create's `{ok:false, status: 409}` arm — so the
		// screen's own copy renders, on the create screen, with the draft back.
		await seedShipping();
		const blocks = await submitForm("shipping:create-zone", {
			id: "us",
			name: "United States again",
			regions: "",
		});
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toBe("Zone not created");
		expect(String(banner?.description)).toMatch(/a zone with the ID "us" already exists/i);
		expect(String(banner?.description)).not.toMatch(/HTTP \d|409|500|outcome unknown/i);
		expect(formInitialValues(blocks, "shipping:create-zone")).toMatchObject({
			id: "us",
			name: "United States again",
		});
		expect((await shippingRules.getZone("us"))?.name).toBe("United States");
		expect((await shippingRules.listZones()).filter((z) => z.id === "us")).toHaveLength(1);
	});

	test("a zone ID with a space is refused ON the create screen, in words, with the typing kept — nothing is written", async () => {
		await seedShipping();
		const blocks = await submitForm("shipping:create-zone", {
			id: "QA JP!",
			name: "Japan",
			regions: "JP",
		});
		const banner = bannerOf(blocks);
		expect(String(banner?.title)).toBe("Zone not created");
		expect(String(banner?.description)).toMatch(/can't contain spaces/i);
		expect(String(banner?.description)).not.toMatch(/outcome unknown|ASCII/i);
		expect(formInitialValues(blocks, "shipping:create-zone")).toEqual({
			id: "QA JP!",
			name: "Japan",
			regions: "JP",
		});
		expect(await shippingRules.getZone("QA JP!")).toBeNull();
	});

	test("the create screen carries the F-8 line about regions — ISO codes, exact, most specific wins (ADR-0021); the page context stays terse", async () => {
		await seedShipping();
		const blocks = await loadZones();
		// The page-level context stays terse (≤140) and says nothing about regions.
		const pageContext = String(findBlocks(blocks, "context")[0]?.text);
		expect(pageContext.length).toBeLessThanOrEqual(140);
		expect(pageContext).not.toMatch(/ISO/);
		// The F-8 line moved WITH the form it qualifies, onto the create screen,
		// and it now says what checkout actually does with the codes.
		const screen = await openNewZoneScreen(blocks);
		const line = contextTexts(screen).find((t) => /ISO/.test(t)) ?? "";
		expect(line).toMatch(/US-CA/);
		expect(line).toMatch(/most specific/i);
		expect(line).toMatch(/exact/i);
		expect(contextTexts(screen).some((t) => /auto-match/i.test(t))).toBe(false);
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
			{ id: "", name: "Canada", regions: "CA, MX" },
			formFor(screen, "shipping:create-zone")?.block_id,
		);
		expect(await shippingRules.getZone("ca")).toBeNull();
		expect(bannerOf(blocks)?.variant).toBe("error");
		expect(blocks.some((b) => b.type === "header" && b.text === "New shipping zone")).toBe(true);
		expect(formInitialValues(blocks, "shipping:create-zone")).toEqual({
			name: "Canada",
			regions: "CA, MX", // VERBATIM — never the parsed region array
		});

		// Fixing the one field and resubmitting creates the zone and returns.
		const created = await submitForm(
			"shipping:create-zone",
			{ id: "ca", name: "Canada", regions: "CA, MX" },
			formFor(blocks, "shipping:create-zone")?.block_id,
		);
		expect((await shippingRules.getZone("ca"))?.regions).toEqual(["CA", "MX"]);
		expect(bannerOf(created)?.variant).toBe("default");
		expect(formFor(created, "shipping:create-zone")).toBeUndefined();
	});
});

describe("admin Shipping console — the first zone turns on address matching (ADR-0021 §4)", () => {
	// QA: creating ONE zone (Japan) silently made checkout refuse every other
	// country ("We don't ship to this address"). ADR-0021 decided that — a store
	// with zones refuses addresses no zone lists — but nothing on the screen said
	// so, before or after.
	test("whenever zones exist, the landing states which destinations checkout ships to and that every other address is refused", async () => {
		await seedShipping({
			zones: [
				{ id: "jp", name: "Japan", regions: ["JP"] },
				{ id: "west", name: "US West", regions: ["US-CA", "US-OR"] },
			],
			methods: [],
			rates: [],
		});
		const blocks = await loadZones();
		const coverage = findBlocks(blocks, "banner").find((b) => b.block_id === "ship:coverage");
		expect(coverage, "a coverage banner").toBeDefined();
		expect(coverage?.variant).toBe("alert");
		expect(String(coverage?.title)).toMatch(/only ships to addresses your zones list/i);
		expect(String(coverage?.description)).toMatch(/We don't ship to this address/);
		expect(String(coverage?.description)).toContain("JP, US-CA, US-OR");
		expect(String(coverage?.description).length).toBeLessThanOrEqual(240);
	});

	test("with no zones there is nothing to warn about on the landing", async () => {
		await seedShipping({ zones: [], methods: [], rates: [] });
		const blocks = await loadZones();
		expect(findBlocks(blocks, "banner").some((b) => b.block_id === "ship:coverage")).toBe(false);
	});

	test("the FIRST zone's create screen warns and requires an acknowledgement; without it nothing is written and the typing is kept", async () => {
		await seedShipping({ zones: [], methods: [], rates: [] });
		const screen = await openNewZoneScreen();
		const warning = findBlocks(screen, "banner").find((b) => b.block_id === "ship:first-zone");
		expect(String(warning?.title)).toMatch(/first zone/i);
		const form = formFor(screen, "shipping:create-zone");
		const ack = ((form?.fields ?? []) as Array<Record<string, unknown>>).find(
			(f) => f.action_id === "ackFirstZone",
		);
		expect(ack?.type).toBe("toggle");
		expect(ack?.initial_value).toBe(false); // F-6b/X-24: a toggle must declare one

		const refused = await submitForm(
			"shipping:create-zone",
			{ id: "jp", name: "Japan", regions: "JP", ackFirstZone: false },
			form?.block_id,
		);
		expect(String(bannerOf(refused)?.title)).toBe("Zone not created");
		expect(String(bannerOf(refused)?.description)).toMatch(/confirm/i);
		expect(formInitialValues(refused, "shipping:create-zone")).toMatchObject({
			id: "jp",
			name: "Japan",
			regions: "JP",
		});
		expect(await shippingRules.getZone("jp")).toBeNull();

		const created = await submitForm(
			"shipping:create-zone",
			{ id: "jp", name: "Japan", regions: "JP", ackFirstZone: true },
			formFor(refused, "shipping:create-zone")?.block_id,
		);
		expect(bannerOf(created)?.variant).toBe("default");
		expect((await shippingRules.getZone("jp"))?.regions).toEqual(["JP"]);
	});

	test("deleting the LAST zone warns that checkout will ship anywhere again; deleting one of several does not", async () => {
		// The mirror of the first-zone warning: removing the only zone switches
		// checkout back to "no zones" — no address check, no shipping, no tax.
		await seedShipping({
			zones: [{ id: "jp", name: "Japan", regions: ["JP"] }],
			methods: [],
			rates: [],
		});
		const only = buttons(groupBlocks(await loadZones(), "ship:zone:jp")).find(
			(b) => b.action_id === "shipping:delete-zone",
		);
		expect(String(confirmOf(only).text)).toMatch(/only zone.*ship.*anywhere again/i);
		expect(String(confirmOf(only).text).length).toBeLessThanOrEqual(200);

		await seedShipping();
		const oneOfTwo = buttons(groupBlocks(await loadZones(), "ship:zone:us")).find(
			(b) => b.action_id === "shipping:delete-zone",
		);
		expect(String(confirmOf(oneOfTwo).text)).not.toMatch(/anywhere again/i);
	});

	test("once a zone exists, later zones need no acknowledgement", async () => {
		await seedShipping();
		const screen = await openNewZoneScreen();
		expect(findBlocks(screen, "banner").some((b) => b.block_id === "ship:first-zone")).toBe(false);
		expect(fieldIds(formFor(screen, "shipping:create-zone"))).not.toContain("ackFirstZone");
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

		// A `select` trigger renders the option VALUE, not its label (R-17a), so
		// the values themselves are words — QA saw `flat_rate` in the trigger. The
		// action maps the word back to the enum, so the domain and the stored row
		// still spell `flat_rate`.
		const createForm = formFor(await openNewMethodScreen(blocks), "shipping:create-method");
		const typeField = field(createForm, "type");
		const typeOptions = typeField?.options as Array<{ value: string; label: string }>;
		expect(typeOptions.map((o) => o.value)).toEqual(["Flat rate", "Free shipping"]);
		expect(typeField?.initial_value).toBe("Flat rate");
		expect((await shippingRules.getMethod("standard"))?.type).toBe("flat_rate");
		const edit = field(formFor(blocks, "shipping:save-method"), "type");
		expect(edit?.initial_value).toBe("Flat rate");

		await submitForm(
			"shipping:create-method",
			{ id: "free", name: "Free over $50", type: "Free shipping" },
			createForm?.block_id,
		);
		expect((await shippingRules.getMethod("free"))?.type).toBe("free_shipping");
	});

	test("a zone with no methods yet shows the `empty` block, never a fail-closed banner", async () => {
		await seedShipping();
		const blocks = await openPath(["empty"]);
		expect(blocks.some((b) => b.type === "header" && b.text === "Shipping methods — empty")).toBe(
			true,
		);
		expect(findBlock(blocks, "empty")?.title).toBe("No shipping methods yet");
		// The ONLY banner is ADR-0021's warning that this regions-less zone matches
		// no address — never a fail-closed or error banner.
		const banners = findBlocks(blocks, "banner");
		expect(banners.map((b) => b.block_id)).toEqual(["ship:no-match-zones"]);
		expect(banners[0]?.variant).toBe("alert");
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
		expect(fieldIds(editForm)).toEqual(["name", "type", "taxable"]);
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

	test("switching a free-shipping method to FLAT RATE says its thresholds stop applying", async () => {
		await seedShipping({
			methods: [{ id: "free", zoneId: "us", name: "Free over $50", type: "free_shipping" }],
			rates: [{ methodId: "free", currency: "USD", amountCents: 499, minSubtotalCents: 5000 }],
		});
		const editForm = formFor(
			groupBlocks(await openPath(["us"]), "ship:method:us:free"),
			"shipping:save-method",
		);
		const blocks = await submitForm(
			"shipping:save-method",
			{ name: "Free over $50", type: "Flat rate" },
			editForm?.block_id,
		);
		expect((await shippingRules.getMethod("free"))?.type).toBe("flat_rate");
		expect(String(bannerOf(blocks)?.title)).toBe("Saved as flat rate");
		expect(String(bannerOf(blocks)?.description)).toMatch(
			/if any of this method's rates had a free-shipping threshold/i,
		);
		expect(String(bannerOf(blocks)?.description)).toMatch(/threshold/i);
	});

	test("the bare enum values a form rendered before the word values still submit", async () => {
		await seedShipping();
		const methods = await openPath(["us"]);
		const createForm = formFor(await openNewMethodScreen(methods), "shipping:create-method");
		await submitForm(
			"shipping:create-method",
			{ id: "legacy-free", name: "Legacy", type: "free_shipping" },
			createForm?.block_id,
		);
		expect((await shippingRules.getMethod("legacy-free"))?.type).toBe("free_shipping");
	});

	test("create-method carries the zoneId invisibly (no visible field) and writes the method UNDER that zone, then reloads the methods level", async () => {
		await seedShipping();
		const createForm = formFor(
			await openNewMethodScreen(await openPath(["us"])),
			"shipping:create-method",
		);
		expect(fieldIds(createForm)).toEqual(["id", "name", "type", "taxable"]);
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
			taxable: true,
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
			type: "Flat rate",
			taxable: true,
		});
	});

	// -- PR 2b: "Charge tax on this method" -----------------------------------

	test("the method toggle declares its state; switching it off is saved and shown on the row", async () => {
		await seedShipping();
		const editForm = formFor(
			groupBlocks(await openPath(["us"]), "ship:method:us:standard"),
			"shipping:save-method",
		);
		// F-6b/X-24: declared, or an untouched toggle is absent from `values`.
		expect(field(editForm, "taxable")?.initial_value).toBe(true);
		const blocks = await submitForm(
			"shipping:save-method",
			{ name: "Standard", type: "Flat rate", taxable: false },
			editForm?.block_id,
		);
		expect(bannerOf(blocks)?.variant).toBe("default");
		expect((await shippingRules.getMethod("standard"))?.taxable).toBe(false);
		const row = group(blocks, "ship:method:us:standard");
		expect(String(row?.label)).toContain("not taxed");
		expect(
			field(
				formFor(groupBlocks(blocks, "ship:method:us:standard"), "shipping:save-method"),
				"taxable",
			)?.initial_value,
		).toBe(false);
	});

	test("a save without the toggle in `values` PRESERVES the method's flag", async () => {
		await seedShipping();
		await shippingRules.updateMethod("standard", {
			name: "Standard",
			type: "flat_rate",
			taxable: false,
		});
		const editForm = formFor(
			groupBlocks(await openPath(["us"]), "ship:method:us:standard"),
			"shipping:save-method",
		);
		await submitForm(
			"shipping:save-method",
			{ name: "Standard 2", type: "Flat rate" },
			editForm?.block_id,
		);
		expect(await shippingRules.getMethod("standard")).toMatchObject({
			name: "Standard 2",
			taxable: false,
		});
	});

	test("a new method can be created untaxed; a refusal restates the toggle", async () => {
		await seedShipping();
		const createForm = formFor(
			await openNewMethodScreen(await openPath(["us"])),
			"shipping:create-method",
		);
		expect(field(createForm, "taxable")?.initial_value).toBe(true);
		const refused = await submitForm(
			"shipping:create-method",
			{ id: "", name: "Courier", type: "Flat rate", taxable: false },
			createForm?.block_id,
		);
		expect(bannerOf(refused)?.variant).toBe("error");
		expect(formInitialValues(refused, "shipping:create-method")).toMatchObject({ taxable: false });
		await submitForm(
			"shipping:create-method",
			{ id: "courier", name: "Courier", type: "Flat rate", taxable: false },
			createForm?.block_id,
		);
		expect((await shippingRules.getMethod("courier"))?.taxable).toBe(false);
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

	test("a currency-SHAPED code that is not a supported currency (XYZ) is refused — nothing is written", async () => {
		// QA saved an "XYZ" rate: three letters passes the shape check, and a rate
		// in a currency no cart is ever in is a price nobody is quoted.
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		const blocks = await submitForm(
			"shipping:create-rate",
			{ currency: "xyz", amount: "4.99", minSubtotal: "" },
			createForm?.block_id,
		);
		expect(await shippingRules.getRate("bare", toCurrency("XYZ"))).toBeNull();
		expect(String(bannerOf(blocks)?.description)).toMatch(/XYZ isn't a supported currency/);
	});

	test("a JPY rate is read in whole yen: '1500' is stored as 1500, and the edit form shows 1500 back", async () => {
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		await submitForm(
			"shipping:create-rate",
			{ currency: "JPY", amount: "1500", minSubtotal: "" },
			createForm?.block_id,
		);
		expect(await shippingRules.getRate("bare", toCurrency("JPY"))).toEqual({
			methodId: "bare",
			currency: "JPY",
			amountCents: 1500,
			minSubtotalCents: null,
		});
		// A fraction of a yen is no amount at all — refused, nothing written.
		const again = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		const refused = await submitForm(
			"shipping:create-rate",
			{ currency: "JPY", amount: "15.5", minSubtotal: "" },
			again?.block_id,
		);
		expect(String(bannerOf(refused)?.description)).toMatch(/whole numbers only/);
		expect((await shippingRules.getRate("bare", toCurrency("JPY")))?.amountCents).toBe(1500);
	});

	test("a free-shipping threshold on a FLAT-RATE method is refused with the reason — the domain would never apply it", async () => {
		// `shippingCost` charges a flat rate's amount whatever the subtotal; only a
		// free_shipping method reads `minSubtotalCents`. QA saved one anyway and the
		// console said "Rate created", promising free shipping that never happens.
		await seedShipping();
		const createForm = formFor(await openPath(["us", "bare"]), "shipping:create-rate");
		const blocks = await submitForm(
			"shipping:create-rate",
			{ currency: "USD", amount: "4.99", minSubtotal: "35.00" },
			createForm?.block_id,
		);
		expect(await shippingRules.getRate("bare", toCurrency("USD"))).toBeNull();
		expect(String(bannerOf(blocks)?.description)).toMatch(
			/flat-rate method always charges its rate/i,
		);
	});

	test("a free-shipping method still takes its threshold", async () => {
		await seedShipping({
			methods: [{ id: "free", zoneId: "us", name: "Free over $50", type: "free_shipping" }],
			rates: [],
		});
		const createForm = formFor(await openPath(["us", "free"]), "shipping:create-rate");
		await submitForm(
			"shipping:create-rate",
			{ currency: "USD", amount: "4.99", minSubtotal: "50.00" },
			createForm?.block_id,
		);
		expect((await shippingRules.getRate("free", toCurrency("USD")))?.minSubtotalCents).toBe(5000);
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

	test("saving an existing flat-rate rate that carries a LEGACY threshold asks for it to be blanked; blanking it saves", async () => {
		// The fixture's `standard` is a flat-rate method whose USD rate was stored
		// with a $35 threshold before the rule — the edit form prefills it.
		await seedShipping();
		const editForm = formFor(await openPath(["us", "standard"]), "shipping:save-rate");
		expect(field(editForm, "minSubtotal")?.initial_value).toBe("35.00");
		const untouched = await submitForm(
			"shipping:save-rate",
			{ amount: "4.99", minSubtotal: "35.00" },
			editForm?.block_id,
		);
		expect(String(bannerOf(untouched)?.description)).toMatch(
			/flat-rate method always charges its rate/i,
		);
		expect((await shippingRules.getRate("standard", toCurrency("USD")))?.minSubtotalCents).toBe(
			3500,
		);

		const blanked = await submitForm(
			"shipping:save-rate",
			{ amount: "4.99", minSubtotal: "" },
			formFor(untouched, "shipping:save-rate")?.block_id ?? editForm?.block_id,
		);
		expect(bannerOf(blanked)?.variant).toBe("default");
		expect(
			(await shippingRules.getRate("standard", toCurrency("USD")))?.minSubtotalCents,
		).toBeNull();
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

/**
 * ADR-0021: zone regions are ISO codes, because checkout now DERIVES the zone
 * from the buyer's address by matching them. The console refuses anything else
 * on write, refuses overlaps, and says out loud which stored zones (written
 * before this rule) can never match.
 */
describe("admin Shipping console — regions are ISO codes (ADR-0021, workerd sandbox)", () => {
	test("create with 'UK, United States, US-XX' is refused: the banner names EVERY bad token with a hint, the draft comes back, nothing is written", async () => {
		await seedShipping();
		const before = await shippingRules.listZones();

		const blocks = await submitForm("shipping:create-zone", {
			id: "bad",
			name: "Bad",
			regions: "UK, United States, US-XX, US-TX",
		});

		expect(await shippingRules.listZones()).toEqual(before);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		const text = String(banner?.description);
		expect(text).toContain("UK");
		expect(text).toMatch(/GB/);
		expect(text).toContain("United States");
		expect(text).toContain("US-XX");
		expect(text).not.toContain("US-TX");
		// The refusal re-renders the create screen with what was typed.
		expect(formInitialValues(blocks, "shipping:create-zone")).toMatchObject({
			id: "bad",
			name: "Bad",
			regions: "UK, United States, US-XX, US-TX",
		});
	});

	test("a code another zone already lists is an OVERLAP: refused on create and on save, naming the other zone", async () => {
		await seedShipping();

		const created = await submitForm("shipping:create-zone", {
			id: "us2",
			name: "US again",
			regions: "us, US-CA",
		});
		expect(bannerOf(created)?.variant).toBe("error");
		expect(String(bannerOf(created)?.description)).toContain("United States");
		expect(String(bannerOf(created)?.description)).toContain("US");
		expect(await shippingRules.getZone("us2")).toBeNull();

		const list = await loadZones();
		const form = formFor(groupBlocks(list, "ship:zone:empty"), "shipping:save-zone");
		const saved = await submitForm(
			"shipping:save-zone",
			{ name: "Empty zone", regions: "US" },
			form?.block_id,
		);
		expect(bannerOf(saved)?.variant).toBe("error");
		expect(String(bannerOf(saved)?.description)).toContain("United States");
		expect((await shippingRules.getZone("empty"))?.regions).toBeNull();
	});

	test("re-saving a zone with its OWN codes is not an overlap", async () => {
		await seedShipping();
		const list = await loadZones();
		const form = formFor(groupBlocks(list, "ship:zone:us"), "shipping:save-zone");
		const saved = await submitForm(
			"shipping:save-zone",
			{ name: "USA", regions: "US" },
			form?.block_id,
		);
		expect(bannerOf(saved)?.variant).toBe("default");
		expect(await shippingRules.getZone("us")).toMatchObject({ name: "USA", regions: ["US"] });
	});

	describe("a zone stored BEFORE the rule, holding free text", () => {
		const LEGACY: ShippingFixture = {
			zones: [
				{ id: "legacy", name: "Old zone", regions: ["United States", "de"] },
				{ id: "empty", name: "Empty zone", regions: null },
			],
			methods: [{ id: "m-legacy", zoneId: "legacy", name: "Old method", type: "flat_rate" }],
			rates: [],
		};

		test("the landing page warns that it can never match, naming the zone and its bad tokens", async () => {
			await seedShipping(LEGACY);
			const blocks = await loadZones();
			const warning = blocks.find((b) => b.block_id === "ship:legacy-regions");
			expect(warning?.type).toBe("banner");
			expect(warning?.variant).toBe("alert");
			expect(String(warning?.description)).toContain("Old zone");
			expect(String(warning?.description)).toContain("United States");
			// INC-14's order survives: the warning never displaces the create button.
			expect(blocks.map((b) => String(b.type)).slice(0, 3)).toEqual([
				"header",
				"context",
				"actions",
			]);
		});

		test("its row labels the legacy tokens 'never matches'; a zone with no codes says 'Matches no address'", async () => {
			await seedShipping(LEGACY);
			const blocks = await loadZones();
			const legacy = contextTexts(groupBlocks(blocks, "ship:zone:legacy")).join(" | ");
			expect(legacy).toMatch(/Matches: DE/);
			expect(legacy).toMatch(/United States \(not a region code — never matches\)/);
			const empty = contextTexts(groupBlocks(blocks, "ship:zone:empty")).join(" | ");
			expect(empty).toMatch(/Matches no address/);
		});

		// Before ADR-0021 a blank regions list was normal — nothing read it. Now a
		// zone that lists no code matches no address, its methods are never offered,
		// and a store whose zones ALL match nothing refuses every physical checkout.
		test("a zone that MATCHES NO ADDRESS (null, [] or only legacy text) is warned about on the landing page and its methods screen", async () => {
			await seedShipping({
				zones: [
					{ id: "blank", name: "Blank zone", regions: null },
					{ id: "none", name: "Empty list", regions: [] },
					{ id: "legacy", name: "Old zone", regions: ["United States"] },
					{ id: "ok", name: "Good zone", regions: ["US-CA"] },
				],
				methods: [{ id: "m-blank", zoneId: "blank", name: "Standard", type: "flat_rate" }],
				rates: [],
			});
			const landing = await loadZones();
			const warning = landing.find((b) => b.block_id === "ship:no-match-zones");
			expect(warning?.type).toBe("banner");
			expect(warning?.variant).toBe("alert");
			const text = String(warning?.description);
			for (const name of ["Blank zone", "Empty list", "Old zone"]) expect(text).toContain(name);
			expect(text.length).toBeLessThanOrEqual(240);
			expect(text).not.toContain("Good zone");
			expect(String(warning?.title)).toMatch(/match no address/i);
			expect(text).toMatch(/US, US-CA/);
			expect(landing.map((b) => String(b.type)).slice(0, 3)).toEqual([
				"header",
				"context",
				"actions",
			]);

			const methods = await openPath(["blank"]);
			const onMethods = methods.find((b) => b.block_id === "ship:no-match-zones");
			expect(onMethods?.variant).toBe("alert");
			expect(String(onMethods?.description)).toContain("Blank zone");

			const good = await openPath(["ok"]);
			expect(good.find((b) => b.block_id === "ship:no-match-zones")).toBeUndefined();
		});

		test("the matches-no-address warning names as many zones as fit, then a count — it stays within the banner budget however many there are", async () => {
			await seedShipping({
				zones: Array.from({ length: 6 }, (_, i) => ({
					id: `blank-${String(i)}`,
					name: `A rather long zone name number ${String(i)}`,
					regions: null,
				})),
				methods: [],
				rates: [],
			});
			const warning = (await loadZones()).find((b) => b.block_id === "ship:no-match-zones");
			const text = String(warning?.description);
			expect(text).toContain("number 0");
			expect(text).toMatch(/and \d more\.$/);
			expect(text).not.toContain("number 5");
			expect(text.length).toBeLessThanOrEqual(240);
		});

		test("one zone whose name alone would overflow is cut to fit, never past the budget", async () => {
			await seedShipping({
				zones: [
					// Listed by id: the long one comes first.
					{ id: "a-long", name: "N".repeat(200), regions: null },
					{ id: "b-blank", name: "Blank", regions: null },
				],
				methods: [],
				rates: [],
			});
			const text = String(
				(await loadZones()).find((b) => b.block_id === "ship:no-match-zones")?.description,
			);
			expect(text.length).toBeLessThanOrEqual(240);
			expect(text).toMatch(/N…; and 1 more\.$/);
		});

		test("its methods screen carries the same warning", async () => {
			await seedShipping(LEGACY);
			const blocks = await openPath(["legacy"]);
			const warning = blocks.find((b) => b.block_id === "ship:legacy-regions");
			expect(warning?.variant).toBe("alert");
			expect(String(warning?.description)).toContain("United States");
		});

		test("saving it with its legacy text is refused until it is fixed; with codes it saves", async () => {
			await seedShipping(LEGACY);
			const list = await loadZones();
			const form = formFor(groupBlocks(list, "ship:zone:legacy"), "shipping:save-zone");
			expect(field(form, "regions")?.initial_value).toBe("United States, de");

			const refused = await submitForm(
				"shipping:save-zone",
				{ name: "Old zone", regions: "United States, de" },
				form?.block_id,
			);
			expect(bannerOf(refused)?.variant).toBe("error");
			expect((await shippingRules.getZone("legacy"))?.regions).toEqual(["United States", "de"]);

			const fixed = await submitForm(
				"shipping:save-zone",
				{ name: "Old zone", regions: "US, de" },
				form?.block_id,
			);
			expect(bannerOf(fixed)?.variant).toBe("default");
			expect((await shippingRules.getZone("legacy"))?.regions).toEqual(["US", "DE"]);
		});
	});
});

// Currency PR 2: the rate currency the methods and rates levels start on (and
// the new-rate form prefills) is the STORE currency — USD until one is saved.
describe("admin Shipping console — the currency filter defaults to the store currency (workerd sandbox)", () => {
	async function saveStoreCurrency(code: string): Promise<void> {
		const settings = new EmdashSettingsStore({ storage, clock: systemClock });
		await settings.update({ currency: code }, idempotencyKey(`ship-store-currency-${code}`));
	}

	test("never saved: the rates level and the new-rate form start on USD, with no filter summary", async () => {
		await seedShipping();
		const opened = await openPath(["us", "standard"]);
		expect(field(formFor(opened, "shipping:apply-filter"), "currency")?.initial_value).toBe("USD");
		const bare = await openPath(["us", "bare"]);
		expect(field(formFor(bare, "shipping:create-rate"), "currency")?.initial_value).toBe("USD");
		expect(findBlocks(bare, "section").some((b) => String(b.text).includes("currency:"))).toBe(
			false,
		);
	});

	test("saved EUR: both levels read in EUR by default, the new-rate form prefills EUR, and USD is now a filter", async () => {
		await seedShipping({
			rates: [
				...DEFAULT_RATES,
				{ methodId: "standard", currency: "EUR", amountCents: 1200, minSubtotalCents: null },
			],
		});
		await saveStoreCurrency("EUR");

		const rates = await openPath(["us", "standard"]);
		expect(field(formFor(rates, "shipping:apply-filter"), "currency")?.initial_value).toBe("EUR");
		expect(findBlocks(rates, "fields").some((b) => JSON.stringify(b).includes("EUR"))).toBe(true);
		// The default is not a filter, so there is nothing to clear.
		expect(findBlocks(rates, "section").some((b) => String(b.text).includes("currency:"))).toBe(
			false,
		);

		const bare = await openPath(["us", "bare"]);
		expect(field(formFor(bare, "shipping:create-rate"), "currency")?.initial_value).toBe("EUR");

		const methods = await openPath(["us"]);
		expect(contextTexts(methods).some((t) => t.includes("Prices in EUR"))).toBe(true);

		// Asking for USD explicitly is now a narrowing away from the default.
		const usd = await submitForm(
			"shipping:apply-filter",
			{ currency: "USD" },
			formFor(rates, "shipping:apply-filter")?.block_id,
		);
		expect(field(formFor(usd, "shipping:apply-filter"), "currency")?.initial_value).toBe("USD");
		expect(findBlocks(usd, "section").some((b) => String(b.text).includes("currency: USD"))).toBe(
			true,
		);
	});
});
