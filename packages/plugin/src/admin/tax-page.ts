import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type {
	ActionsBlock,
	AdminPageConfig,
	Block,
	ButtonElement,
	FormBlock,
	RouteHandler,
	SelectOption,
	TableBlock,
} from "../types.js";
import {
	AdminRulesClient,
	type RulesCasUpdateResult,
	type RulesCreateResult,
	type RulesDeleteResult,
	type TaxClassWire,
	type TaxRateWire,
} from "./admin-rules-client.js";
import { formatBpsAsPercent, parsePercentToBps } from "./percent-input.js";
import {
	asRecord,
	backButton,
	createListDetailHandler,
	customAction,
	failClosedResponse,
	listLevel,
	noticeBanner,
	readAdminTokens,
	readString,
	screenActions,
	type ListDetailInput,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Tax console page (admin-UX Increment 3, slice 2 — "tax admin
 * drill-down"): a 2-level scaffold screen — tax classes (registry
 * create/list) drilling into a class's tax rates (list/create/edit-with-CAS/
 * delete). Rendered by the single `admin` dispatch route (`admin-route.ts`).
 * Built on the shared list/detail scaffold (`./scaffold`), the SAME as
 * Products/Orders — but the FIRST production screen where BOTH levels are
 * `listLevel`s (no leaf): a class drills straight into its rates LIST, not a
 * detail. Row-level mutations (create/edit/delete) are `customAction`s that
 * re-render the relevant list via `showList(path, notice)` — the scaffold's
 * list-level notice surface this screen's own slice added (`list-detail.ts`).
 *
 * SCOPE NOTE (read before extending): renaming or deleting a tax CLASS is
 * NOT offered here. `deleteTaxClass` (the in-use guard, guarding on both
 * referencing products AND referencing rates) exists in `@urumi/domain`
 * (`packages/domain/src/pricing/delete-tax-class.ts`) and is contract-tested,
 * but has NO service HTTP route — its own doc comment says so explicitly
 * ("intentionally NO service endpoint for this in THIS slice"). Renaming a
 * class has no domain port method at all (`TaxRulesStore` only has
 * `createClass`/`listClasses`/`deleteClass`). Per this slice's own guardrail
 * ("if you find a missing capability, STOP and report rather than adding
 * domain surface in a UI slice"), this screen does NOT add a
 * `PUT`/`DELETE /admin/tax/classes/:id` route, a domain `updateClass` port
 * method, or client wrappers for either — that is real domain/service work
 * for a future slice. Tax RATES, by contrast, are fully wired end-to-end
 * (create/list/update-with-CAS/delete-idempotent all have live routes and
 * `AdminRulesClient` methods already) and get the full CRUD this slice asks
 * for.
 */
export const TAX_PAGE: AdminPageConfig = { path: "/tax", label: "Tax", icon: "percent" };

/** This screen's namespaced action ids — the four scaffold nav verbs plus
 *  the class/rate side-effecting verbs. */
const TAX_ACTIONS: ScreenActions = screenActions("tax");
const ACTION_CREATE_CLASS = TAX_ACTIONS.custom("create-class");
const ACTION_CREATE_RATE = TAX_ACTIONS.custom("create-rate");
const ACTION_SAVE_RATE = TAX_ACTIONS.custom("save-rate");
const ACTION_DELETE_RATE = TAX_ACTIONS.custom("delete-rate");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Tax console. Every `block_action`/`form_submit` this page can emit is
 * namespaced `tax:*` and listed here, so none falls through the dispatcher
 * to the `{blocks:[]}` dead-end.
 */
export const TAX_ACTION_IDS: ReadonlySet<string> = TAX_ACTIONS.actionIds(
	"create-class",
	"create-rate",
	"save-rate",
	"delete-rate",
);

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type TaxPageInput = ListDetailInput;

/** A tax rate ROW as this screen renders it: the wire shape plus the zone's
 *  human name when the ALL-zones fan-out resolved one (see
 *  `fetchRatesForClass`) — undefined when the row came from a single
 *  zone-scoped filter read (no extra lookup spent on a name the admin
 *  already typed the id for). */
interface TaxRateRow extends TaxRateWire {
	zoneName?: string;
}

/** The rates level's own filter: an OPTIONAL zone-id narrow. Unset ⇒ the
 *  default view (every zone this store has, fanned out — see
 *  `fetchRatesForClass`); set ⇒ scoped to exactly that zone (one read). */
interface RatesFilterForm {
	zoneId?: string;
}

export function createTaxPageHandler(): RouteHandler<TaxPageInput> {
	return createListDetailHandler({
		actions: TAX_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminRulesClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// A class row's "Open class" form carries the class id in
		// `values.classId`; the target is a single-level drill, so the path is
		// just `[classId]` — the rates LIST for that class.
		parseOpen(input) {
			const classId = readString(input.values?.classId);
			return classId === undefined ? undefined : { targetPath: [classId] };
		},
		levels: [taxClassesLevel(), taxRatesLevel()],
		customActions: {
			[ACTION_CREATE_CLASS]: createClassAction(),
			[ACTION_CREATE_RATE]: createRateAction(),
			[ACTION_SAVE_RATE]: saveRateAction(),
			[ACTION_DELETE_RATE]: deleteRateAction(),
		},
	});
}

// -- level 0: the tax classes registry ----------------------------------------

function taxClassesLevel() {
	return listLevel<AdminRulesClient, Record<string, never>, TaxClassWire>({
		// The registry has no service-side pagination (`GET /admin/tax/classes`
		// returns the full list) — same small-registry shape as the product edit
		// form's `DEFAULT_TAX_CLASSES` fallback. `limit` is unused by `fetchPage`
		// (kept for the level's shape) and `nextCursor` is always `null`.
		limit: 200,
		filterFromValues: () => ({}),
		async fetchPage(client) {
			const classes = await client.listTaxClasses();
			return { items: classes, nextCursor: null };
		},
		render({ actions, items, notice }) {
			return classesBlocks(actions, items, notice);
		},
		onError: () => classesFailClosed(),
	});
}

function classesBlocks(
	actions: ScreenActions,
	classes: TaxClassWire[],
	notice: Notice | undefined,
): Block[] {
	const table: TableBlock = {
		type: "table",
		columns: [
			{ key: "id", label: "Class ID", format: "code" },
			{ key: "name", label: "Name" },
		],
		rows: classes.map((c) => ({ id: c.id, name: c.name })),
		page_action_id: actions.page, // never fires: the registry has no paging
		empty_text: "No tax classes yet — create one below.",
	};
	const blocks: Block[] = [
		{ type: "header", text: "Tax classes" },
		{
			type: "context",
			text: 'A tax class is a rate GROUP (e.g. "Standard", "Reduced", "Zero-rated") — products reference one by id; each class then has its own per-zone rate. Renaming or deleting a class is not available on this screen yet: create a new class instead if you need a different rate group.',
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push(table);
	if (classes.length > 0) blocks.push(openClassForm(actions, classes));
	blocks.push({ type: "divider" });
	blocks.push(createClassForm());
	return blocks;
}

function openClassForm(actions: ScreenActions, classes: TaxClassWire[]): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "classId",
				label: "Open class",
				options: classes.map((c) => ({ value: c.id, label: `${c.name} (${c.id})` })),
			},
		],
		submit: { label: "View rates", action_id: TAX_ACTIONS.open },
	};
}

function createClassForm(): FormBlock {
	return {
		type: "form",
		fields: [
			{ type: "text_input", action_id: "id", label: "Class ID", placeholder: "e.g. reduced" },
			{ type: "text_input", action_id: "name", label: "Name", placeholder: "e.g. Reduced rate" },
		],
		submit: { label: "Create tax class", action_id: ACTION_CREATE_CLASS },
	};
}

function classesFailClosed() {
	return failClosedResponse({
		header: "Tax classes",
		title: "Tax classes are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load tax classes",
	});
}

// -- level 1: a class's tax rates ----------------------------------------------

function taxRatesLevel() {
	return listLevel<AdminRulesClient, RatesFilterForm, TaxRateRow>({
		limit: 500,
		filterFromValues(values) {
			const zoneId = readString(values.zoneId)?.trim();
			return zoneId !== undefined && zoneId.length > 0 ? { zoneId } : {};
		},
		async fetchPage(client, path, filter) {
			const classId = path[0];
			if (classId === undefined) return { items: [], nextCursor: null };
			const rows = await fetchRatesForClass(client, classId, filter.zoneId);
			return { items: rows, nextCursor: null };
		},
		render({ actions, path, filter, items, notice }) {
			const classId = path[0] ?? "";
			return ratesBlocks(actions, classId, filter, items, notice);
		},
		onError: () => ratesFailClosed(),
	});
}

/**
 * Load every rate for `classId`. `zoneId` unset (the default, unfiltered
 * view) ⇒ fan out across EVERY zone this store has (`listZones()` then one
 * `listTaxRates(zoneId)` per zone, in parallel) and keep the rows whose
 * `taxClassId` matches — the service has no `GET
 * /admin/tax/rates?taxClassId=` cross-zone read, only the per-zone one, so
 * "rates for this class" is necessarily N zone reads. Accepted as fine for
 * an admin console with a small zone count (this is not a storefront hot
 * path); a `taxClassId` filter on the list endpoint would collapse this to
 * one call and is a natural service-side follow-up.
 * `zoneId` set ⇒ ONE read, scoped to that zone (the merchant-supplied
 * narrow) — no fan-out.
 * Any read failure PROPAGATES (never silently degrades to "no rates" —
 * this is the level's PRIMARY data, unlike a leaf's secondary reads), so the
 * caller's `onError` fails closed instead of rendering a misleading empty list.
 */
async function fetchRatesForClass(
	client: AdminRulesClient,
	classId: string,
	zoneId: string | undefined,
): Promise<TaxRateRow[]> {
	if (zoneId !== undefined) {
		const rates = await client.listTaxRates(zoneId);
		return rates.filter((r) => r.taxClassId === classId);
	}
	const zones = await client.listZones();
	const perZone = await Promise.all(zones.map((z) => client.listTaxRates(z.id)));
	const zoneNameById = new Map(zones.map((z) => [z.id, z.name]));
	return perZone
		.flat()
		.filter((r) => r.taxClassId === classId)
		.map((r) => ({ ...r, zoneName: zoneNameById.get(r.zoneId) ?? r.zoneId }));
}

function ratesBlocks(
	actions: ScreenActions,
	classId: string,
	filter: RatesFilterForm,
	rows: TaxRateRow[],
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: `Tax rates — ${classId}` },
		backButton(actions.back, "← Back to tax classes", [classId]),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({
		type: "context",
		text: "Each rate applies to purchases shipping to one zone. Rates are shown as a percent (e.g. 7.25%), stored as exact integer basis points (no floating point). Deleting a rate only affects future carts — orders already placed keep the tax they were charged at purchase time.",
	});
	blocks.push(zoneFilterForm(classId, filter));
	blocks.push(ratesTable(actions, rows));
	blocks.push({ type: "divider" });
	blocks.push(createRateForm(classId, filter));
	for (const row of rows) {
		blocks.push({ type: "divider" });
		blocks.push(editRateForm(classId, row));
		blocks.push(deleteRateActions(classId, row));
	}
	return blocks;
}

function zoneFilterForm(classId: string, filter: RatesFilterForm): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("classId", classId),
			{
				type: "text_input",
				action_id: "zoneId",
				label: "Zone ID (blank = every zone)",
				placeholder: "e.g. us",
				...(filter.zoneId !== undefined ? { initial_value: filter.zoneId } : {}),
			},
		],
		submit: { label: "Filter by zone", action_id: TAX_ACTIONS.applyFilter },
	};
}

function ratesTable(actions: ScreenActions, rows: TaxRateRow[]): TableBlock {
	return {
		type: "table",
		columns: [
			{ key: "id", label: "Rate ID", format: "code" },
			{ key: "zone", label: "Zone" },
			{ key: "rate", label: "Rate" },
			{ key: "appliesToShipping", label: "Applies to shipping", format: "badge" },
		],
		rows: rows.map((r) => ({
			id: r.id,
			zone: r.zoneName ?? r.zoneId,
			rate: `${formatBpsAsPercent(r.rateBps)}%`,
			appliesToShipping: r.appliesToShipping ? "yes" : "no",
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text: "No tax rates yet for this class.",
	};
}

function createRateForm(classId: string, filter: RatesFilterForm): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("classId", classId),
			{ type: "text_input", action_id: "id", label: "Rate ID", placeholder: "e.g. std-us" },
			{
				type: "text_input",
				action_id: "zoneId",
				label: "Zone ID",
				placeholder: "e.g. us",
				...(filter.zoneId !== undefined ? { initial_value: filter.zoneId } : {}),
			},
			{
				type: "text_input",
				action_id: "ratePercent",
				label: "Rate (%, up to 2 decimals — e.g. 7.25)",
				placeholder: "7.25",
			},
			appliesToShippingField("false"),
		],
		submit: { label: "Add tax rate", action_id: ACTION_CREATE_RATE },
	};
}

/**
 * The per-rate edit form (CAS on `rateBps`): `expectedRateBps` rides along as
 * a hidden carrier holding the value THIS render loaded — a concurrent edit
 * that changed it in the meantime loses the CAS and the reloaded list shows
 * the fresh value with a "reload" notice, never a silent clobber.
 */
function editRateForm(classId: string, row: TaxRateRow): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("classId", classId),
			hiddenCarrier("rateId", row.id),
			hiddenCarrier("expectedRateBps", String(row.rateBps)),
			{
				type: "text_input",
				action_id: "ratePercent",
				label: `Rate for zone ${row.zoneName ?? row.zoneId} (%)`,
				initial_value: formatBpsAsPercent(row.rateBps),
			},
			appliesToShippingField(row.appliesToShipping ? "true" : "false"),
		],
		submit: { label: `Save ${row.id}`, action_id: ACTION_SAVE_RATE },
	};
}

function deleteRateActions(classId: string, row: TaxRateRow): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_RATE,
		label: `Delete ${row.id}`,
		style: "danger",
		value: { classId, rateId: row.id },
		confirm: {
			title: `Delete tax rate ${row.id}?`,
			text: "In-flight carts recompute their tax without this rate the next time they're touched. Orders already placed are unaffected — an order snapshots the tax it was charged at purchase time.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions", elements: [button] };
}

function appliesToShippingField(initial: "true" | "false"): FormBlock["fields"][number] {
	const options: SelectOption[] = [
		{ value: "false", label: "No — tax on goods only" },
		{ value: "true", label: "Yes — also tax the shipping charge" },
	];
	return {
		type: "select",
		action_id: "appliesToShipping",
		label: "Applies to shipping",
		options,
		initial_value: initial,
	};
}

/** A hidden single-option carrier (the scaffold's proven pattern, e.g.
 *  `products-page.ts`'s `stockCarrier`) that threads one value through a
 *  stateless `form_submit`. */
function hiddenCarrier(actionId: string, value: string): FormBlock["fields"][number] {
	return {
		type: "select",
		action_id: actionId,
		label: actionId,
		options: [{ value, label: value }],
		initial_value: value,
	};
}

function ratesFailClosed() {
	return failClosedResponse({
		header: "Tax rates",
		title: "Tax rates are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load tax rates",
	});
}

// -- percent ↔ basis-points math (NO float arithmetic — CLAUDE.md) -----------
// The exact-integer parse/format pair lives in `./percent-input.js`, SHARED
// with the Coupons console (extracted at the second consumer, the same
// precedent as `money-input.ts`).

// -- custom action: create a tax class ----------------------------------------

function createClassAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const id = (readString(values.id) ?? "").trim();
		const name = (readString(values.name) ?? "").trim();
		// Local guard: blank id/name never leaves the plugin (the service rejects
		// them too, but this gives immediate inline feedback without a round trip).
		if (id.length === 0 || name.length === 0) {
			return showList(undefined, {
				variant: "error",
				title: "Tax class not created",
				description: "Enter both a class ID and a name.",
			});
		}
		const result = await client.createTaxClass({ id, name });
		return showList(undefined, createClassNotice(result, id, name));
	});
}

function createClassNotice(
	result: RulesCreateResult<TaxClassWire>,
	id: string,
	name: string,
): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Tax class created",
			description: `"${name}" (${id}) was added.`,
		};
	}
	return {
		variant: "error",
		title: "Tax class not created",
		description: `Could not create "${id}" — check the class ID isn't already in use, then try again.`,
	};
}

// -- custom action: create a tax rate ------------------------------------------

function createRateAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const classId = readString(values.classId);
		if (classId === undefined) return showList();
		const id = (readString(values.id) ?? "").trim();
		const zoneId = (readString(values.zoneId) ?? "").trim();
		if (id.length === 0 || zoneId.length === 0) {
			return showList([classId], {
				variant: "error",
				title: "Tax rate not created",
				description: "Enter both a rate ID and a zone ID.",
			});
		}
		const bps = parsePercentToBps(readString(values.ratePercent) ?? "");
		if (bps === null) {
			return showList([classId], {
				variant: "error",
				title: "Tax rate not created",
				description: "Rate must be a percent like 7.25 (0 to 1000, up to two decimal places).",
			});
		}
		const appliesToShipping = readString(values.appliesToShipping) === "true";
		const result = await client.createTaxRate({
			id,
			taxClassId: classId,
			zoneId,
			rateBps: bps,
			appliesToShipping,
		});
		return showList([classId], createRateNotice(result, id));
	});
}

function createRateNotice(result: RulesCreateResult<TaxRateWire>, id: string): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Tax rate created",
			description: `Rate "${id}" was added.`,
		};
	}
	return {
		variant: "error",
		title: "Tax rate not created",
		description: `Could not create "${id}" — check the rate ID isn't already in use and the class/zone ids are correct, then try again.`,
	};
}

// -- custom action: edit a tax rate (CAS on rateBps) ---------------------------

function saveRateAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const classId = readString(values.classId);
		const rateId = readString(values.rateId);
		const expectedRateBpsRaw = readString(values.expectedRateBps);
		if (classId === undefined || rateId === undefined || expectedRateBpsRaw === undefined) {
			return showList();
		}
		const expectedRateBps = Number.parseInt(expectedRateBpsRaw, 10);
		const bps = parsePercentToBps(readString(values.ratePercent) ?? "");
		if (bps === null) {
			return showList([classId], {
				variant: "error",
				title: "Rate not saved",
				description: "Rate must be a percent like 7.25 (0 to 1000, up to two decimal places).",
			});
		}
		const appliesToShipping = readString(values.appliesToShipping) === "true";
		const result = await client.updateTaxRate(rateId, {
			rateBps: bps,
			appliesToShipping,
			expectedRateBps,
		});
		return showList([classId], saveRateNotice(result));
	});
}

function saveRateNotice(result: RulesCasUpdateResult<TaxRateWire>): Notice {
	if (result.ok) {
		return { variant: "default", title: "Rate saved", description: "The tax rate was updated." };
	}
	if (result.reason === "stale") {
		return {
			variant: "error",
			title: "This rate changed since you loaded it — reload",
			description:
				"Your edit was NOT applied — the latest value is shown below. Re-apply your change and save again.",
		};
	}
	if (result.reason === "not_found") {
		return {
			variant: "error",
			title: "Rate not found",
			description: "This tax rate no longer exists — it may have already been deleted.",
		};
	}
	return {
		variant: "error",
		title: "Rate not saved",
		description:
			"The change could not be saved — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: delete a tax rate ------------------------------------------

function deleteRateAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const payload = asRecord(input.value);
		const classId = readString(payload?.classId);
		const rateId = readString(payload?.rateId);
		if (classId === undefined || rateId === undefined) return showList();
		const result = await client.deleteTaxRate(rateId);
		return showList([classId], deleteRateNotice(result));
	});
}

function deleteRateNotice(result: RulesDeleteResult): Notice {
	if (result.ok) {
		return { variant: "default", title: "Rate deleted", description: "The tax rate was removed." };
	}
	if (result.reason === "not_found") {
		// Idempotent no-op (a double-submit, or someone else already deleted it) —
		// not a failure: surface a non-error notice rather than a scary banner.
		return {
			variant: "default",
			title: "Already deleted",
			description: "This tax rate was already removed.",
		};
	}
	return {
		variant: "error",
		title: "Rate not deleted",
		description:
			"The rate could not be deleted — check the service connection and the admin token in Settings.",
	};
}
