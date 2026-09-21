import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashProductCommerceStore,
	EmdashShippingRulesStore,
	EmdashTaxRulesStore,
	systemClock,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { COMMERCE_STORAGE_COLLECTION_NAMES } from "../src/commerce/commerce-storage.js";
import { decodeCarrier } from "../src/admin/scaffold/carrier.js";
import { encodePath } from "../src/admin/scaffold/nav.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	buttons,
	contextTexts,
	field,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	openGroupIds,
	type LooseBlock,
} from "./helpers/blocks.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

// The admin Tax console under the REAL workerd-on-Node sandbox (design spec
// §12.3, the density-overhaul layout): tax classes (list/create/rename-LWW/
// delete-forbid-if-in-use) drilling into a class's tax rates (list/create/
// edit-with-CAS/delete), which — only past L-9's 25-row bound — drills once
// more into a single rate's own detail. Per-row content lives inside a
// collapsed accordion (L-9); a level falls back to a table + `combobox`
// drill-in only when the fetched page is complete AND has more than 25 rows.
//
// THE RULES SURFACE IS NO LONGER AN HTTP SERVICE (INC-D3a). `makeAdminClients`
// hands this screen an `InProcessAdminRulesClient` composed over `ctx.storage`,
// so the fixtures below are REAL documents written through the same
// `@otta-sh/store-emdash` stores the plugin itself reads, and every "did the
// write land" claim is read back off the store rather than off a recorded
// request body. That is strictly stronger: a recorded `PUT /admin/tax/rates/std-us`
// proved a request was FORMED, while a re-read row proves the edit was APPLIED.
//
// The consequences worth stating once, because several cases below inherit them:
//  * There is no admin token. `X-Internal-Token` / `X-Service-Token`
//    authenticated a caller TO the commerce service; the console routes are
//    gated by EmDash's own admin auth and CSRF (ADR-0014 D3), so there is
//    nothing to forward and nothing to withhold.
//  * `listZones()` sorts by zone id (the store reads `ORDER BY id`), where the
//    old stub answered in insertion order — so the Zone select's options are
//    `eu` before `us`, and the assertion says so.
//  * A duplicate id is a THROWN collision from the store, not a 500 the client
//    maps to `{ok:false}`. See the duplicate-create case for what the operator
//    sees now.

/** One process-wide store, wiped between cases — see `resetStore`. */
let storage: StorageAccess;
let shippingRules: EmdashShippingRulesStore;
let taxRules: EmdashTaxRulesStore;
let productCommerce: EmdashProductCommerceStore;
let sandbox: SandboxHandle;

interface ZoneFixture {
	id: string;
	name: string;
	regions: string[];
}
interface ClassFixture {
	id: string;
	name: string;
}
interface RateFixture {
	id: string;
	taxClassId: string;
	zoneId: string;
	rateBps: number;
	appliesToShipping: boolean;
}

const DEFAULT_ZONES: ZoneFixture[] = [
	{ id: "us", name: "United States", regions: ["US"] },
	{ id: "eu", name: "Europe", regions: ["EU"] },
];
const DEFAULT_CLASSES: ClassFixture[] = [{ id: "standard", name: "Standard" }];
const DEFAULT_RATES: RateFixture[] = [
	{ id: "std-us", taxClassId: "standard", zoneId: "us", rateBps: 725, appliesToShipping: false },
	{ id: "std-eu", taxClassId: "standard", zoneId: "eu", rateBps: 2000, appliesToShipping: true },
];

interface RulesFixture {
	zones?: ZoneFixture[];
	classes?: ClassFixture[];
	rates?: RateFixture[];
	/** LIVE product references per tax-class id — real product-commerce rows, so
	 *  the delete's product guard counts documents rather than a stub's map. */
	productsByClass?: Record<string, number>;
}

/** Empty every declared collection. The store is process-scoped by design
 *  (`storageBridge`), and this screen's reads are REGISTRY-WIDE — "25 classes"
 *  is a claim about the whole store, not about a namespace — so each case starts
 *  from nothing rather than trying to narrow a shared catalogue. */
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

/** Write one case's fixture as REAL documents, through the same stores the
 *  plugin reads. Defaults mirror the old stub's seed exactly, so the cases below
 *  read as they always did. */
async function seedRules(fixture: RulesFixture = {}): Promise<void> {
	await resetStore();
	for (const zone of fixture.zones ?? DEFAULT_ZONES) {
		await shippingRules.createZone({ id: zone.id, name: zone.name, regions: zone.regions });
	}
	for (const cls of fixture.classes ?? DEFAULT_CLASSES) {
		await taxRules.createClass({ id: cls.id, name: cls.name });
	}
	for (const rate of fixture.rates ?? DEFAULT_RATES) {
		await taxRules.createRate(rate);
	}
	for (const [classId, count] of Object.entries(fixture.productsByClass ?? {})) {
		for (let i = 0; i < count; i++) {
			await productCommerce.upsert(
				{
					productId: toProductId(`${classId}-p${String(i)}`),
					sku: toSku(`${classId.toUpperCase()}-${String(i)}`),
					title: `Product ${String(i)}`,
					price: money(cents(1999), toCurrency("USD")),
					taxClass: classId,
					weightGrams: 100,
					productKind: "physical",
				},
				idempotencyKey(`seed-${classId}-${String(i)}`),
			);
		}
	}
}

/** The declared classes, read back the way the console reads them. */
async function listClassIds(): Promise<string[]> {
	return (await taxRules.listClasses()).map((c) => c.id);
}

/** Every rate the store holds for a zone, for a "did the write land" re-read. */
async function findRate(zoneId: string, rateId: string) {
	return (await taxRules.listRatesForZone(zoneId)).find((r) => r.id === rateId);
}

function bannerOf(blocks: readonly LooseBlock[]) {
	return findBlock(blocks, "banner") as
		| { variant?: string; title?: string; description?: string }
		| undefined;
}

/** What `blocks/form.tsx` would post for an UNTOUCHED form: every field's
 *  `initial_value`, and no key at all for a field without one. This is how a
 *  "the refusal put my typing back" claim is checked without asserting on the
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

beforeAll(async () => {
	({ storage } = await storageBridge());
	shippingRules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	taxRules = new EmdashTaxRulesStore({ storage, clock: systemClock });
	productCommerce = new EmdashProductCommerceStore({ storage, clock: systemClock });
	// ONE boot for the file: the isolate holds no per-case state of its own now
	// that the fixtures live in the store, so rebooting it between cases would buy
	// nothing but seconds.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox.close();
});

beforeEach(async () => {
	await resetStore();
});

/** Render the classes list. */
async function loadClasses(): Promise<LooseBlock[]> {
	return blocksOf(await sandbox.invokeRoute("admin", { type: "page_load", page: "/tax" }));
}

/** Open a class's rates the way the per-row "View rates" button does — a
 *  `block_action` carrying the FULL target path in `value.target` (§12.7). */
async function openClass(classId: string): Promise<LooseBlock[]> {
	return blocksOf(
		await sandbox.invokeRoute("admin", {
			type: "block_action",
			action_id: "tax:open",
			value: { target: encodePath([classId]) },
		}),
	);
}

/** Submit a form the way em-dash does: `values` PLUS the `block_id` the form
 *  carried, which is where every id and watermark now rides (F-2, B-1).
 *  Driving it any other way exercises a wire shape the renderer never sends. */
async function submitForm(
	blocks: readonly LooseBlock[],
	submitActionId: string,
	values: Record<string, unknown>,
): Promise<LooseBlock[]> {
	const form = formFor(blocks, submitActionId);
	expect(form, `no form submitting ${submitActionId}`).toBeDefined();
	return blocksOf(
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: submitActionId,
			values,
			block_id: form!.block_id,
		}),
	);
}

/** Click a button the way em-dash does: `action_id` + `value`, and NO
 *  `block_id` — a button echoes none (B-1). */
async function clickButton(actionId: string, value: unknown): Promise<LooseBlock[]> {
	return blocksOf(
		await sandbox.invokeRoute("admin", { type: "block_action", action_id: actionId, value }),
	);
}

/** The promoted create button on a rendered level (INC-14), by action id — so
 *  a test can only reach a create screen the way an operator does. */
function createButton(blocks: readonly LooseBlock[], actionId: string) {
	return buttons(blocks).find((b) => b.action_id === actionId);
}

/** Drill into the "New tax class" screen by clicking the promoted button. */
async function openNewClassScreen(from?: LooseBlock[]): Promise<LooseBlock[]> {
	const list = from ?? (await loadClasses());
	const button = createButton(list, "tax:show-new-class");
	expect(button, "no New tax class button").toBeDefined();
	return clickButton("tax:show-new-class", button!.value);
}

/** Drill into a class's "New tax rate" screen by clicking its promoted
 *  button — which is what carries the class path (L-6). */
async function openNewRateScreen(classId: string): Promise<LooseBlock[]> {
	const rates = await openClass(classId);
	const button = createButton(rates, "tax:show-new-rate");
	expect(button, "no New tax rate button").toBeDefined();
	return clickButton("tax:show-new-rate", button!.value);
}

describe("admin Tax console — classes level (workerd sandbox)", () => {
	test("page_load /tax renders the classes list as per-row accordions, off the plugin's own store", async () => {
		await seedRules();
		const blocks = await loadClasses();
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
		const row = group(blocks, "tax:class:standard");
		expect(row?.label).toBe("standard — Standard");
		expect(row?.default_open).toBe(false);
		expect(findBlock(blocks, "table")).toBeUndefined(); // L-9 accordion branch at 1 row
	});

	// DELETED: "NO-TOKEN page_load /tax fails closed with the E-7 normative
	// banner". It withheld the kv admin token so the stub answered 401 and the
	// level's `onError` fired. There is no token — `makeAdminClients` builds the
	// rules client over `ctx.storage` with no credential of any kind — so the
	// input that produced it cannot be expressed. `classesFailClosed()` is still
	// wired as the level's `onError`, but its only remaining producer is storage
	// itself failing, which this tier cannot induce without breaking the bridge
	// the whole suite runs on; a fixture that faked one would assert on itself.

	test("create-class with blank fields is caught at the plugin boundary — nothing is written", async () => {
		await seedRules();
		const blocks = await openNewClassScreen();
		const after = await submitForm(blocks, "tax:create-class", { id: "", name: "" });
		expect(await listClassIds()).toEqual(["standard"]);
		expect(bannerOf(after)?.variant).toBe("error");
	});

	test("create-class writes {id,name} to the store, then re-lists with a success notice", async () => {
		await seedRules();
		const blocks = await openNewClassScreen();
		const after = await submitForm(blocks, "tax:create-class", {
			id: "reduced",
			name: "Reduced rate",
		});
		// The ROW, not a request body: the class exists, under the name submitted.
		expect(await taxRules.listClasses()).toContainEqual({ id: "reduced", name: "Reduced rate" });

		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		// The re-rendered (root) list reflects the new class — a fresh read, not a
		// locally-patched echo.
		expect(group(after, "tax:class:standard")).toBeDefined();
		expect(group(after, "tax:class:reduced")?.label).toBe("reduced — Reduced rate");
	});

	test("creating a class with a duplicate id refuses with a GENERIC error banner and writes nothing", async () => {
		// THE MECHANISM CHANGED AND THE GUARANTEE DID NOT. A duplicate used to be a
		// 500 the HTTP client mapped to `{ok:false}`, which the screen dressed as its
		// own "Tax class not created". In-process the store REJECTS with a collision
		// error, which the scaffold's custom-action net catches — so the operator
		// gets the engine's "outcome unknown, re-check the record" banner instead of
		// the screen's copy. Worth stating plainly because it is a REGRESSION IN
		// COPY, not in safety: the banner is still an error, still carries no status
		// code or path, and the registry is provably unchanged. (Recovering the
		// screen's own copy would need the client to catch the collision and answer
		// `{ok:false}` — a `src/` change, not a test one.)
		await seedRules();
		const blocks = await openNewClassScreen();
		const after = await submitForm(blocks, "tax:create-class", {
			id: "standard",
			name: "Standard again",
		});
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		// Never applied — exactly one "standard", still under its original name.
		expect(await taxRules.listClasses()).toEqual([{ id: "standard", name: "Standard" }]);
	});

	// -- INC-14: the create action is a button above the data ------------------

	test("INC-14: `New tax class` is a primary BUTTON directly under the intro line, above the rows — and no create accordion survives below them", async () => {
		await seedRules();
		const blocks = await loadClasses();
		expect(blocks.map((b) => String(b.type)).slice(0, 3)).toEqual(["header", "context", "actions"]);
		const button = createButton(blocks, "tax:show-new-class");
		expect(button?.type).toBe("button");
		expect(button?.label).toBe("New tax class");
		expect(button?.style).toBe("primary");
		// The button is above the first data row (the per-row accordion branch).
		const firstRow = blocks.findIndex((b) => String(b.block_id).startsWith("tax:class:"));
		expect(blocks.findIndex((b) => b.type === "actions")).toBeLessThan(firstRow);
		// L-8's bottom create group is gone, in either block_id, and no create
		// form renders on the registry at all.
		expect(group(blocks, "tax:new-class")).toBeUndefined();
		expect(group(blocks, "tax:new-class:opened")).toBeUndefined();
		expect(formFor(blocks, "tax:create-class")).toBeUndefined();
		expect(openGroupIds(blocks)).toEqual([]); // X-18
	});

	test("INC-14: the New tax class screen is a drill-in — header, a back control that returns to the registry, and the form", async () => {
		await seedRules();
		const screen = await openNewClassScreen();
		expect(screen.some((b) => b.type === "header" && b.text === "New tax class")).toBe(true);
		// The registry is REPLACED, not pushed down.
		expect(
			findBlocks(screen, "accordion").filter((a) => String(a.block_id).startsWith("tax:class:")),
		).toHaveLength(0);
		expect(formFor(screen, "tax:create-class")).toBeDefined();

		const back = buttons(screen).find((b) => b.action_id === "tax:cancel-new");
		expect(String(back?.label)).toMatch(/back to tax classes/i);
		const list = await clickButton("tax:cancel-new", back?.value);
		expect(list.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
		expect(group(list, "tax:class:standard")).toBeDefined();
	});

	// THE PROPERTY THIS INCREMENT MUST NOT LOSE: a refusal never costs the
	// operator their typing. Before INC-14 that held only as long as the client
	// kept the create form mounted; now every refusal carries the submitted
	// values back as `initial_value` (DA-3a-i), which is checkable here.
	test("INC-14/DA-3a-i: a REFUSED class create re-renders the create screen with both typed values put back", async () => {
		await seedRules();
		const screen = await openNewClassScreen();
		// Blank id, real name — the refusal is about one field, and the other
		// must not be retyped.
		const refused = await submitForm(screen, "tax:create-class", { id: "", name: "Reduced rate" });
		expect(await listClassIds()).toEqual(["standard"]);
		expect(bannerOf(refused)?.variant).toBe("error");
		expect(refused.some((b) => b.type === "header" && b.text === "New tax class")).toBe(true);
		expect(formInitialValues(refused, "tax:create-class")).toEqual({ name: "Reduced rate" });

		// A STORE refusal does NOT keep them — asserted, not described. Under the
		// transport a duplicate id came back as `{ok:false}` and the screen
		// re-rendered ITSELF with the draft intact ("a SERVICE refusal keeps them
		// too"); in-process the collision REJECTS, the scaffold's custom-action net
		// catches it and renders the ROOT registry, which carries no draft by
		// construction. That is a real narrowing of the property above, so it gets
		// a real assertion rather than a comment: if the client ever learns to
		// answer `{ok:false}` on a collision, this is what fails and says the
		// create screen — and the operator's typing — came back.
		const dup = await submitForm(refused, "tax:create-class", {
			id: "standard",
			name: "Standard again",
		});
		expect(bannerOf(dup)?.variant).toBe("error");
		expect(dup.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
		expect(formFor(dup, "tax:create-class")).toBeUndefined();
		// And the refusal really was a refusal: the registry is unchanged.
		expect(await listClassIds()).toEqual(["standard"]);

		// Success drops the draft and returns to the registry.
		const created = await submitForm(refused, "tax:create-class", {
			id: "reduced",
			name: "Reduced",
		});
		expect(bannerOf(created)?.variant).toBe("default");
		expect(group(created, "tax:class:reduced")).toBeDefined();
		expect(formFor(created, "tax:create-class")).toBeUndefined();
	});

	// THE PROPERTY THE WHOLE DRAFT MECHANISM RESTS ON, asserted directly rather
	// than left holding by construction. A prefilled create form is remounted by
	// the renderer only when its `block_id` CHANGES, and that id is minted by
	// `carriedForm`'s `__v` prefill digest (B-3a, `scaffold/carrier.ts`) — the
	// ONE shared primitive behind every create form on all three of these
	// screens, which is why pinning it here pins it for coupons and shipping
	// too. If that digest ever stopped varying with the prefill, today's
	// value-equality assertions would still pass while the operator's second
	// refusal silently re-rendered the FIRST refusal's values.
	test("INC-14/B-3a: the create form's block_id tracks the draft — it changes when the resubmitted values differ, and is stable when they do not", async () => {
		await seedRules();
		const fresh = await openNewClassScreen();
		const virginId = formFor(fresh, "tax:create-class")!.block_id as string;

		const first = await submitForm(fresh, "tax:create-class", { id: "", name: "Reduced rate" });
		const firstId = formFor(first, "tax:create-class")!.block_id as string;
		const second = await submitForm(first, "tax:create-class", { id: "", name: "Zero rate" });
		const secondId = formFor(second, "tax:create-class")!.block_id as string;
		// DIFFERENT drafts ⇒ different id ⇒ the renderer remounts, so the second
		// refusal actually shows the second set of values.
		expect(secondId).not.toBe(firstId);
		expect(formInitialValues(second, "tax:create-class")).toEqual({ name: "Zero rate" });
		// And each refusal differs from the virgin form, which prefills nothing.
		expect(firstId).not.toBe(virginId);

		// IDENTICAL resubmit ⇒ the SAME id: nothing is remounted for a repeat of
		// the same rejected input (B-3a is a change token, not a nonce).
		const again = await submitForm(second, "tax:create-class", { id: "", name: "Zero rate" });
		expect(formFor(again, "tax:create-class")!.block_id).toBe(secondId);
	});

	test("INC-14: a draft never outlives its create screen — after a success, and after abandoning via back, the next create opens virgin-blank", async () => {
		await seedRules();
		const virginId = formFor(await openNewClassScreen(), "tax:create-class")!.block_id as string;

		// (a) refuse → succeed → reopen: byte-identical to a first open.
		const refused = await submitForm(await openNewClassScreen(), "tax:create-class", {
			id: "",
			name: "Reduced rate",
		});
		const created = await submitForm(refused, "tax:create-class", {
			id: "reduced",
			name: "Reduced",
		});
		expect(bannerOf(created)?.variant).toBe("default");
		const afterSuccess = await openNewClassScreen();
		expect(formInitialValues(afterSuccess, "tax:create-class")).toEqual({});
		expect(formFor(afterSuccess, "tax:create-class")!.block_id).toBe(virginId);

		// (b) refuse → abandon via the back control → reopen: same.
		const refusedAgain = await submitForm(afterSuccess, "tax:create-class", {
			id: "",
			name: "Zero rate",
		});
		const back = buttons(refusedAgain).find((b) => b.action_id === "tax:cancel-new");
		await clickButton("tax:cancel-new", back?.value);
		const afterAbandon = await openNewClassScreen();
		expect(formInitialValues(afterAbandon, "tax:create-class")).toEqual({});
		expect(formFor(afterAbandon, "tax:create-class")!.block_id).toBe(virginId);
	});

	test("a class row offers a rename form, a View-rates drill-in, and a delete button — the id rides in the carrier, never a visible field (F-2/X-1)", async () => {
		await seedRules();
		const blocks = await loadClasses();
		const row = group(blocks, "tax:class:standard")!;
		const renameForm = formFor([row], "tax:save-class")!;
		expect(fieldIds(renameForm)).toEqual(["name"]);
		expect(decodeCarrier(renameForm.block_id as string)).toMatchObject({ classId: "standard" });

		const rowButtons = buttons([row]);
		const viewRates = rowButtons.find((b) => b.action_id === "tax:open");
		expect((viewRates?.value as { target?: string } | undefined)?.target).toBe(
			encodePath(["standard"]),
		);
		const del = rowButtons.find((b) => b.action_id === "tax:delete-class");
		expect(del?.style).toBe("danger");
		expect(del?.confirm).toBeDefined();
		expect((del?.value as { classId?: string } | undefined)?.classId).toBe("standard");
	});

	test("a class group orders its controls common-path-first and destructive-last, with a spacer between the edit and the delete", async () => {
		await seedRules();
		const body = groupBlocks(await loadClasses(), "tax:class:standard");
		// ORDER IS THE ONLY AFFORDANCE AVAILABLE. A `form` renders `flex flex-col`
		// in the pinned renderer, so nothing here can sit in a horizontal row with
		// the primary on the end; which control comes FIRST is the whole signal.
		expect(body.map((b) => String(b.type))).toEqual(["actions", "form", "context", "actions"]);
		expect(buttons([body[0]!])[0]?.action_id).toBe("tax:open"); // View rates leads
		expect((body[1]?.submit as { action_id?: unknown } | undefined)?.action_id).toBe(
			"tax:save-class",
		);
		// Block Kit has no spacer block and `divider` is off this console's
		// vocabulary, so the separation is a context line that also earns its
		// height — it states the refusal BEFORE the click, where the confirm
		// dialog's copy only appears after.
		expect(String(body[2]?.text)).toMatch(/blocked while any product or tax rate/i);
		const last = buttons([body[3]!])[0];
		expect(last?.action_id).toBe("tax:delete-class"); // destructive LAST
		expect(last?.style).toBe("danger");
	});

	test("save-class renames the stored class (reading the id from the carrier) and reloads the list with a 'saved' notice", async () => {
		await seedRules();
		const row = group(await loadClasses(), "tax:class:standard")!;
		const after = await submitForm([row], "tax:save-class", { name: "Standard rate" });
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		// Reloaded from a real read, not a locally-patched echo — and the row in
		// the store carries the new name.
		expect(group(after, "tax:class:standard")?.label).toBe("standard — Standard rate");
		expect(await taxRules.listClasses()).toEqual([{ id: "standard", name: "Standard rate" }]);
	});

	test("save-class with a blank name is caught at the plugin boundary — the stored name is untouched", async () => {
		await seedRules();
		const row = group(await loadClasses(), "tax:class:standard")!;
		const after = await submitForm([row], "tax:save-class", { name: "" });
		expect(await taxRules.listClasses()).toEqual([{ id: "standard", name: "Standard" }]);
		expect(bannerOf(after)?.variant).toBe("error");
	});

	test("delete-class removes the class and reloads with a 'deleted' notice; a repeat delete is idempotent, never an error", async () => {
		await seedRules({ classes: [...DEFAULT_CLASSES, { id: "zero", name: "Zero-rated" }] });
		const first = await clickButton("tax:delete-class", { classId: "zero" });
		expect(await listClassIds()).toEqual(["standard"]);
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(group(first, "tax:class:zero")).toBeUndefined();

		const second = await clickButton("tax:delete-class", { classId: "zero" });
		const secondBanner = bannerOf(second);
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("delete-class refused while a RATE references it renders the HONEST count, never a bare refusal", async () => {
		await seedRules(); // "standard" has 2 seeded rates (std-us, std-eu)
		const outcome = await clickButton("tax:delete-class", { classId: "standard" });
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toContain("2 tax rates");
		// Nothing was applied — the class survives.
		expect(await listClassIds()).toContain("standard");
	});

	test("delete-class refused while a PRODUCT references it renders the HONEST count", async () => {
		// The product guard is checked FIRST, and it counts real product-commerce
		// rows now: three live products declaring `taxClass: "reduced"`.
		await seedRules({
			classes: [...DEFAULT_CLASSES, { id: "reduced", name: "Reduced" }],
			productsByClass: { reduced: 3 },
		});
		const outcome = await clickButton("tax:delete-class", { classId: "reduced" });
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toContain("3 products");
		expect(await listClassIds()).toContain("reduced");
	});

	test("zero classes shows the empty illustration whose create action opens the SAME create screen as the promoted button (E-2)", async () => {
		await seedRules({ classes: [], rates: [] });
		const blocks = await loadClasses();
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No tax classes yet");
		const createBtn = (empty?.actions as Array<Record<string, unknown>> | undefined)?.[0];
		expect(createBtn?.action_id).toBe("tax:show-new-class");
		// One act, one wording — the empty state and the promoted button above it.
		expect(createBtn?.label).toBe("New tax class");
		expect(findBlock(blocks, "table")).toBeUndefined();

		const after = await clickButton("tax:show-new-class", createBtn?.value);
		expect(after.some((b) => b.type === "header" && b.text === "New tax class")).toBe(true);
		expect(formFor(after, "tax:create-class")).toBeDefined();
		expect(openGroupIds(after)).toEqual([]); // X-18
	});

	test("25 classes still render the per-row accordion branch (L-9)", async () => {
		await seedRules({
			classes: Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` })),
			rates: [],
		});
		const blocks = await loadClasses();
		expect(findBlock(blocks, "table")).toBeUndefined();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:class:"))
				.length,
		).toBe(25);
	});

	test("26 classes fall back to the table + combobox drill-in branch (L-9)", async () => {
		await seedRules({
			classes: Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` })),
			rates: [],
		});
		const blocks = await loadClasses();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:class:"))
				.length,
		).toBe(0);
		const table = findBlock(blocks, "table");
		expect(table).toBeDefined();
		expect((table!.rows as unknown[]).length).toBe(26);
		const openForm = formFor(blocks, "tax:open");
		expect(openForm).toBeDefined();
		const picker = field(openForm, "target");
		expect(picker?.type).toBe("combobox"); // R-17a/R-17b: never a select
	});

	test("opening a class from the fallback combobox drill-in opens its rates list (L-7, full path)", async () => {
		await seedRules({
			classes: Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` })),
			rates: [],
		});
		const blocks = await loadClasses();
		const openForm = formFor(blocks, "tax:open")!;
		const picker = field(openForm, "target")!;
		const options = picker.options as Array<{ value: string; label: string }>;
		expect(options[0]).toEqual({ value: "none", label: "Choose a tax class…" });
		const target = options.find((o) => o.label === "Class 5")!.value;
		const after = await submitForm(blocks, "tax:open", { target });
		expect(after.some((b) => b.type === "header" && b.text === "Tax rates — c5")).toBe(true);
	});
});

describe("admin Tax console — rates level (workerd sandbox)", () => {
	test("opening a class renders its rates as per-row accordions, fanned out across every zone by default (D-6 labels)", async () => {
		await seedRules();
		const blocks = await openClass("standard");
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		expect(buttons(blocks).some((e) => e.action_id === "tax:back")).toBe(true);
		expect(findBlock(blocks, "table")).toBeUndefined(); // L-9 accordion branch at 2 rows

		// THE FAN-OUT IS PROVEN BY THE ROWS, not by a request log. The store's only
		// rates read is per-zone (`listRatesForZone`), so a class whose rates live in
		// two different zones can only be complete if every zone was read: one row
		// from `us` and one from `eu` is that proof, and unlike a recorded
		// `?zoneId=eu` it also proves the answer was USED.
		//
		// THE RATE LEADS THE LABEL. It used to trail a slug of varying length, so
		// no two rows started their number at the same x and 7.25 / 20.00 could
		// not be compared down the column — the one comparison this level exists
		// for. The slug keeps its place IN FULL (a natural key, not a uuid).
		expect(group(blocks, "tax:rate:std-us")?.label).toBe(
			"7.25% — United States · std-us · goods only",
		);
		expect(group(blocks, "tax:rate:std-eu")?.label).toBe(
			"20.00% — Europe · std-eu · also shipping",
		);
	});

	test("a rate label's leading token is a PERCENT, not money — no currency symbol or code anywhere in it", async () => {
		await seedRules();
		const labels = findBlocks(await openClass("standard"), "accordion")
			.filter((a) => String(a.block_id).startsWith("tax:rate:"))
			.map((a) => String(a.label));
		expect(labels).toHaveLength(2);
		for (const label of labels) {
			expect(label).toMatch(/^\d+\.\d{2}% — /);
			expect(label).not.toMatch(/[$€£¥]|USD|EUR/);
		}
	});

	test("the Zone filter is a non-blank select seeded from the zones read this level already performs (D-6, F-6a)", async () => {
		await seedRules();
		const blocks = await openClass("standard");
		const filterForm = formFor(blocks, "tax:apply-filter")!;
		const zoneField = field(filterForm, "zoneId")!;
		expect(zoneField.type).toBe("select");
		expect(zoneField.initial_value).toBe("any");
		const options = zoneField.options as Array<{ value: string; label: string }>;
		// The registry read is `ORDER BY id` (the store sorts `listZones`), so the
		// picker is alphabetical by id rather than in creation order — the sentinel
		// still leads it.
		expect(options.map((o) => o.value)).toEqual(["any", "eu", "us"]);
		expect(options.every((o) => o.value !== "")).toBe(true); // F-6a: no "" option
	});

	test("filtering by a zone scopes the list to that zone and excludes the others", async () => {
		await seedRules();
		const opened = await openClass("standard");
		const filtered = await submitForm(opened, "tax:apply-filter", { zoneId: "us" });
		expect(group(filtered, "tax:rate:std-us")).toBeDefined();
		expect(group(filtered, "tax:rate:std-eu")).toBeUndefined();

		const section = findBlock(filtered, "section");
		expect(section?.text).toBe("zone: us");
		expect((section?.accessory as { label?: string } | undefined)?.label).toBe("Clear filters");
	});

	test("clearing the filter re-lists every zone's rates for the class (L-6)", async () => {
		await seedRules();
		const opened = await openClass("standard");
		const filtered = await submitForm(opened, "tax:apply-filter", { zoneId: "us" });
		const section = findBlock(filtered, "section")!;
		const clearValue = (section.accessory as { value?: unknown } | undefined)?.value;
		const cleared = await clickButton("tax:apply-filter", clearValue);
		expect(group(cleared, "tax:rate:std-us")).toBeDefined();
		expect(group(cleared, "tax:rate:std-eu")).toBeDefined();
		expect(findBlock(cleared, "section")).toBeUndefined();
	});

	test("a class with no rates yet (unfiltered) shows the empty illustration, whose action opens that class's create screen (E-2)", async () => {
		await seedRules({ classes: [...DEFAULT_CLASSES, { id: "zero", name: "Zero-rated" }] });
		const blocks = await openClass("zero");
		expect(blocks.some((b) => b.type === "header" && b.text === "Tax rates — zero")).toBe(true);
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No tax rates yet");
		const createBtn = (empty?.actions as Array<Record<string, unknown>> | undefined)?.[0];
		expect(createBtn?.action_id).toBe("tax:show-new-rate");
		expect(createBtn?.label).toBe("New tax rate"); // one act, one wording
		expect(createBtn?.value).toMatchObject({ __path: encodePath(["zero"]) });

		const after = await clickButton("tax:show-new-rate", createBtn?.value);
		// The class the operator was in, not the root registry — the path rode
		// in the button's own value (L-6).
		expect(after.some((b) => b.type === "header" && b.text === "New tax rate — zero")).toBe(true);
		expect(decodeCarrier(formFor(after, "tax:create-rate")!.block_id as string)).toMatchObject({
			classId: "zero",
		});
		expect(openGroupIds(after)).toEqual([]); // X-18
	});

	test('filtering to a zone with no rates for this class shows a plain context line, never the empty illustration (E-1/E-2 "never for a filtered-to-zero list")', async () => {
		await seedRules({ zones: [...DEFAULT_ZONES, { id: "jp", name: "Japan", regions: ["JP"] }] });
		const opened = await openClass("standard");
		const filtered = await submitForm(opened, "tax:apply-filter", { zoneId: "jp" });
		expect(findBlock(filtered, "empty")).toBeUndefined();
		expect(contextTexts(filtered).some((t) => /no tax rates for zone "jp"/i.test(t))).toBe(true);
	});

	test("create-rate stores the percent as EXACT integer bps (real boolean toggle), then reloads the class's rates with a success notice", async () => {
		await seedRules();
		const opened = await openNewRateScreen("standard");
		const after = await submitForm(opened, "tax:create-rate", {
			id: "std-us-b",
			zoneId: "us",
			ratePercent: "20",
			appliesToShipping: true,
		});
		// THE STORED ROW is the assertion: "20" became 2000 basis points by exact
		// integer math (no float ever touches it), under the class the create screen
		// carried and the zone the select named.
		const created = await findRate("us", "std-us-b");
		expect(created).toMatchObject({
			id: "std-us-b",
			taxClassId: "standard",
			zoneId: "us",
			rateBps: 2000,
			appliesToShipping: true,
		});
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		expect(after.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		expect(group(after, "tax:rate:std-us-b")).toBeDefined();
	});

	test("a malformed rate percent is caught at the plugin boundary — nothing is written", async () => {
		await seedRules();
		const opened = await openNewRateScreen("standard");
		const after = await submitForm(opened, "tax:create-rate", {
			id: "bad",
			zoneId: "us",
			ratePercent: "7.255",
			appliesToShipping: false,
		});
		expect(await findRate("us", "bad")).toBeUndefined();
		expect(bannerOf(after)?.variant).toBe("error");
	});

	// -- INC-14: the create action is a button above the data ------------------

	test("INC-14: `New tax rate` is a primary BUTTON under the intro line, above the rows, carrying its class path — and no create accordion survives below them", async () => {
		await seedRules();
		const blocks = await openClass("standard");
		const types = blocks.map((b) => String(b.type));
		// header · back · context · the create button (this level's intro line is
		// the context under the back control).
		expect(types.slice(0, 4)).toEqual(["header", "actions", "context", "actions"]);
		const button = createButton(blocks, "tax:show-new-rate");
		expect(button?.label).toBe("New tax rate");
		expect(button?.style).toBe("primary");
		// L-6: depth 1, so the path is not optional — without it the create
		// screen would open at the root registry.
		expect(button?.value).toMatchObject({ __path: encodePath(["standard"]) });
		const firstRow = blocks.findIndex((b) => String(b.block_id).startsWith("tax:rate:"));
		expect(blocks.findIndex((b, i) => b.type === "actions" && i > 0)).toBeLessThan(firstRow);
		expect(group(blocks, "tax:new-rate:standard")).toBeUndefined();
		expect(group(blocks, "tax:new-rate:standard:opened")).toBeUndefined();
		expect(formFor(blocks, "tax:create-rate")).toBeUndefined();
	});

	test("INC-14: the New tax rate screen is a drill-in whose back control returns to THAT class's rates", async () => {
		await seedRules();
		const screen = await openNewRateScreen("standard");
		expect(screen.some((b) => b.type === "header" && b.text === "New tax rate — standard")).toBe(
			true,
		);
		expect(
			findBlocks(screen, "accordion").filter((a) => String(a.block_id).startsWith("tax:rate:")),
		).toHaveLength(0);
		const back = buttons(screen).find((b) => b.action_id === "tax:cancel-new");
		expect(String(back?.label)).toMatch(/back to tax rates/i);
		const rates = await clickButton("tax:cancel-new", back?.value);
		// The class the operator came from, NOT the root registry.
		expect(rates.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
		expect(group(rates, "tax:rate:std-us")).toBeDefined();
	});

	test("INC-14/DA-3a-i: a REFUSED rate create re-renders the create screen with the id, zone, percent and toggle put back", async () => {
		await seedRules();
		const screen = await openNewRateScreen("standard");
		const refused = await submitForm(screen, "tax:create-rate", {
			id: "std-eu-b",
			zoneId: "eu",
			ratePercent: "7.255", // 3 decimals — refused at the plugin boundary
			appliesToShipping: true,
		});
		expect(await findRate("eu", "std-eu-b")).toBeUndefined();
		expect(bannerOf(refused)?.variant).toBe("error");
		expect(refused.some((b) => b.type === "header" && b.text === "New tax rate — standard")).toBe(
			true,
		);
		expect(formInitialValues(refused, "tax:create-rate")).toEqual({
			id: "std-eu-b",
			zoneId: "eu", // the select survives — never silently reset to the first zone
			ratePercent: "7.255", // VERBATIM: there are no bps to re-derive it from
			appliesToShipping: true, // X-24: a toggle is mount-only, so it must be restated
		});
		// Fixing the one field and resubmitting creates the rate and returns.
		const created = await submitForm(refused, "tax:create-rate", {
			id: "std-eu-b",
			zoneId: "eu",
			ratePercent: "7.25",
			appliesToShipping: true,
		});
		expect((await findRate("eu", "std-eu-b"))?.rateBps).toBe(725);
		expect(bannerOf(created)?.variant).toBe("default");
		expect(formFor(created, "tax:create-rate")).toBeUndefined();
	});

	test("INC-14: a draft zone that no longer exists falls back rather than rendering a blank select trigger (X-23)", async () => {
		await seedRules();
		const screen = await openNewRateScreen("standard");
		const refused = await submitForm(screen, "tax:create-rate", {
			id: "ghost",
			zoneId: "atlantis", // never a real zone
			ratePercent: "nope",
			appliesToShipping: false,
		});
		const zoneField = field(formFor(refused, "tax:create-rate"), "zoneId");
		const options = (zoneField?.options ?? []) as Array<{ value: string }>;
		expect(options.some((o) => o.value === String(zoneField?.initial_value))).toBe(true);
	});

	test("INC-14: with no zones at all the create screen degrades to one honest line, never an empty select (F-6a)", async () => {
		await seedRules({ zones: [] });
		const screen = await openNewRateScreen("standard");
		expect(formFor(screen, "tax:create-rate")).toBeUndefined();
		expect(contextTexts(screen).some((t) => /create a shipping zone first/i.test(t))).toBe(true);
	});

	test("a rate row carries a per-row edit form (CAS) prefilled from the loaded rate — ids and watermark in the carrier, never a visible field (F-2/X-1)", async () => {
		await seedRules();
		const blocks = await openClass("standard");
		const row = group(blocks, "tax:rate:std-us")!;
		const form = formFor([row], "tax:save-rate")!;
		expect(fieldIds(form)).toEqual(["ratePercent", "appliesToShipping"]);
		expect(decodeCarrier(form.block_id as string)).toMatchObject({
			classId: "standard",
			rateId: "std-us",
			expectedRateBps: "725",
		});
		expect(field(form, "ratePercent")?.type).toBe("text_input"); // never number_input
		expect(field(form, "ratePercent")?.initial_value).toBe("7.25");
		expect(field(form, "appliesToShipping")?.type).toBe("toggle");
		expect(field(form, "appliesToShipping")?.initial_value).toBe(false); // F-6b/X-24: REQUIRED
	});

	test("save-rate applies the CAS edit (reading ids from the carrier) and reloads with a 'saved' notice", async () => {
		await seedRules();
		const row = group(await openClass("standard"), "tax:rate:std-us")!;
		const after = await submitForm([row], "tax:save-rate", {
			ratePercent: "8.25",
			appliesToShipping: true,
		});
		const banner = bannerOf(after);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		// The EDIT LANDED, both fields of it — `appliesToShipping` is the required
		// full-replace key, so a save that dropped it would silently clear the flag.
		expect(await findRate("us", "std-us")).toMatchObject({
			rateBps: 825,
			appliesToShipping: true,
		});
	});

	test("a concurrent-edit conflict is caught via the carrier's own watermark — reloads the fresh rate with a re-apply warning, never a clobber", async () => {
		await seedRules();
		const opened = await openClass("standard");
		const row = group(opened, "tax:rate:std-us")!;
		const form = formFor([row], "tax:save-rate")!;
		// Move the record since THIS render loaded it (the carrier this form carries
		// still says 725) — someone else's edit lands in between, exactly the race
		// the watermark exists to catch (DA-2a). Written through the store's own CAS,
		// so the concurrent edit is as real as the one it is about to beat.
		await taxRules.updateRate("std-us", { rateBps: 900, appliesToShipping: false }, 725);
		const after = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "tax:save-rate",
			values: { ratePercent: "9.00", appliesToShipping: false },
			block_id: form.block_id,
		});
		const blocks = blocksOf(after);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/changed since you loaded it|reload/i);
		// The submitted edit was NOT applied — the concurrent 900 stands.
		expect((await findRate("us", "std-us"))?.rateBps).toBe(900);
		// The re-render shows the FRESH value, from a real reload — never the stale
		// 725 the carrier was minted against, and never a blind clobber either.
		expect(group(blocks, "tax:rate:std-us")?.label).toBe(
			"9.00% — United States · std-us · goods only",
		);
	});

	test("delete-rate removes the rate and reloads with a 'deleted' notice; a repeat delete is an idempotent 'already deleted' notice, never an error", async () => {
		await seedRules();
		const first = await clickButton("tax:delete-rate", { classId: "standard", rateId: "std-us" });
		expect(await findRate("us", "std-us")).toBeUndefined();
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(group(first, "tax:rate:std-us")).toBeUndefined();

		const second = await clickButton("tax:delete-rate", { classId: "standard", rateId: "std-us" });
		const secondBanner = bannerOf(second);
		expect(secondBanner?.variant).toBe("default"); // idempotent no-op, never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("back from the rates level returns to the tax classes list", async () => {
		await seedRules();
		const rates = await openClass("standard");
		const backButtonValue = buttons(rates).find((e) => e.action_id === "tax:back")?.value as
			| Record<string, string>
			| undefined;
		expect(backButtonValue).toBeDefined();
		const back = await clickButton("tax:back", backButtonValue);
		expect(back.some((b) => b.type === "header" && b.text === "Tax classes")).toBe(true);
	});

	test("25 rates for a class still render the per-row accordion branch (L-9)", async () => {
		await seedRules({
			rates: Array.from({ length: 25 }, (_, i) => ({
				id: `r${i}`,
				taxClassId: "standard",
				zoneId: "us",
				rateBps: 100 + i,
				appliesToShipping: false,
			})),
		});
		const blocks = await openClass("standard");
		expect(findBlock(blocks, "table")).toBeUndefined();
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:rate:"))
				.length,
		).toBe(25);
	});

	test("26 rates for a class fall back to the table + combobox drill-in branch (L-9), and Applies-to-shipping is plain text, never a badge (T-5/X-4)", async () => {
		await seedRules({
			rates: Array.from({ length: 26 }, (_, i) => ({
				id: `r${i}`,
				taxClassId: "standard",
				zoneId: "us",
				rateBps: 100 + i,
				appliesToShipping: i % 2 === 0,
			})),
		});
		const blocks = await openClass("standard");
		expect(
			findBlocks(blocks, "accordion").filter((a) => String(a.block_id).startsWith("tax:rate:"))
				.length,
		).toBe(0);
		const table = findBlock(blocks, "table")!;
		expect(table).toBeDefined();
		expect((table.rows as unknown[]).length).toBe(26);
		const columns = table.columns as Array<{ key: string; format?: string }>;
		const appliesCol = columns.find((c) => c.key === "appliesToShipping");
		expect(appliesCol?.format).not.toBe("badge");
		const openForm = formFor(blocks, "tax:open")!;
		expect(field(openForm, "target")?.type).toBe("combobox");
	});

	test("opening a rate from the fallback combobox drill-in reaches its own detail leaf (§12.7 full path, depth 2)", async () => {
		await seedRules({
			rates: Array.from({ length: 26 }, (_, i) => ({
				id: `r${i}`,
				taxClassId: "standard",
				zoneId: "us",
				rateBps: 100 + i,
				appliesToShipping: false,
			})),
		});
		const blocks = await openClass("standard");
		const openForm = formFor(blocks, "tax:open")!;
		const picker = field(openForm, "target")!;
		const options = picker.options as Array<{ value: string; label: string }>;
		expect(options[0]).toEqual({ value: "none", label: "Choose a tax rate…" });
		// The picker options lead with the rate too — it is what the operator is
		// choosing between — and still never carry the id (M-7/X-22).
		expect(options.slice(1).every((o) => /^\d+\.\d{2}% · /.test(o.label))).toBe(true);
		expect(options.some((o) => o.label.includes("r5"))).toBe(false);
		const target = options.find((o) => o.label.endsWith("United States"))!.value;
		const after = await submitForm(blocks, "tax:open", { target });
		expect(
			after.some((b) => b.type === "header" && String(b.text).startsWith("Tax rate — r")),
		).toBe(true);
		const form = formFor(after, "tax:save-rate")!;
		expect(decodeCarrier(form.block_id as string)).toMatchObject({ classId: "standard" });
	});

	test("a rate's own detail leaf edits and deletes exactly like the accordion body, and its back button returns to the rates list", async () => {
		await seedRules({
			rates: Array.from({ length: 26 }, (_, i) => ({
				id: `r${i}`,
				taxClassId: "standard",
				zoneId: "us",
				rateBps: 100 + i,
				appliesToShipping: false,
			})),
		});
		const detail = await submitForm(await openClass("standard"), "tax:open", {
			target: encodePath(["standard", "r5"]),
		});
		expect(detail.some((b) => b.type === "header" && b.text === "Tax rate — r5")).toBe(true);
		const backValue = buttons(detail).find((e) => e.action_id === "tax:back")?.value;
		expect(backValue).toBeDefined();

		const saved = await submitForm(detail, "tax:save-rate", {
			ratePercent: "9.00",
			appliesToShipping: true,
		});
		expect(await findRate("us", "r5")).toMatchObject({ rateBps: 900, appliesToShipping: true });
		expect(bannerOf(saved)?.variant).toBe("default");

		const deleted = await clickButton("tax:delete-rate", { classId: "standard", rateId: "r5" });
		expect(await findRate("us", "r5")).toBeUndefined();
		expect(bannerOf(deleted)?.variant).toBe("default");

		const back = await clickButton("tax:back", backValue);
		expect(back.some((b) => b.type === "header" && b.text === "Tax rates — standard")).toBe(true);
	});

	test("a rate detail leaf for an id that no longer resolves renders notFound, never a blank page", async () => {
		await seedRules();
		// Driven as a bare block_action (matching a button/combobox click) rather
		// than through the accordion branch's row list, which offers no direct
		// per-rate "open" control of its own — the leaf is reachable at any row
		// count via a fully-encoded target path.
		const after = await clickButton("tax:open", { target: encodePath(["standard", "nope"]) });
		expect(after.some((b) => b.type === "header" && b.text === "Tax rate not found")).toBe(true);
		expect(bannerOf(after)?.variant).toBe("error");
	});
});

describe("admin Tax console — assertBlockContract (§15 V-3)", () => {
	// Every H-marked §13 row this helper enforces, on every distinct render
	// shape this screen produces: both L-9 branches (accordion at ≤25 rows,
	// table+combobox past it) on both list levels, both levels' zero-row empty
	// states, a filtered rates render, and the rate-detail leaf. `level: "list"`
	// throughout, including for the rate-detail leaf — Tax has no TABBED detail
	// screen (§4: "every level is a list"), and this leaf carries no `tab`/D-2
	// panel set of its own; it is a single-record page, not a §4-shaped detail
	// screen, so `checkX16`'s D-2 comparison (which has no entry for "tax" and
	// deliberately refuses `level:"detail"` for a screen absent from it) does
	// not apply. See the PR body's disclosure section.
	test("assertBlockContract holds on every rendered shape this screen produces", async () => {
		await seedRules();
		assertBlockContract(await loadClasses(), { screen: "tax", level: "list" });
		assertBlockContract(await openClass("standard"), { screen: "tax", level: "list" });
		const filtered = await submitForm(await openClass("standard"), "tax:apply-filter", {
			zoneId: "us",
		});
		assertBlockContract(filtered, { screen: "tax", level: "list" });
		assertBlockContract(
			await clickButton("tax:open", { target: encodePath(["standard", "std-us"]) }),
			{ screen: "tax", level: "list" },
		);
		// INC-14's four new list-level renders: each create screen, and each
		// after a refusal (a banner plus a form full of prefilled values).
		const classScreen = await openNewClassScreen();
		assertBlockContract(classScreen, { screen: "tax", level: "list" });
		assertBlockContract(await submitForm(classScreen, "tax:create-class", { id: "", name: "x" }), {
			screen: "tax",
			level: "list",
		});
		const rateScreen = await openNewRateScreen("standard");
		assertBlockContract(rateScreen, { screen: "tax", level: "list" });
		assertBlockContract(
			await submitForm(rateScreen, "tax:create-rate", {
				id: "r",
				zoneId: "us",
				ratePercent: "nope",
				appliesToShipping: true,
			}),
			{ screen: "tax", level: "list" },
		);

		// The fixture is re-seeded rather than the sandbox rebooted: the isolate
		// holds no state, so a case's shape comes entirely from what the store says.
		await seedRules({ classes: [], rates: [] });
		assertBlockContract(await loadClasses(), { screen: "tax", level: "list" });

		await seedRules({ classes: [...DEFAULT_CLASSES, { id: "zero", name: "Zero-rated" }] });
		assertBlockContract(await openClass("zero"), { screen: "tax", level: "list" });

		await seedRules({
			classes: Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `Class ${i}` })),
			rates: Array.from({ length: 26 }, (_, i) => ({
				id: `r${i}`,
				taxClassId: "c0",
				zoneId: "us",
				rateBps: 100 + i,
				appliesToShipping: i % 2 === 0,
			})),
		});
		assertBlockContract(await loadClasses(), { screen: "tax", level: "list" });
		assertBlockContract(await openClass("c0"), { screen: "tax", level: "list" });
	}, 120_000);
});
