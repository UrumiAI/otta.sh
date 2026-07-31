import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type {
	AccordionBlock,
	AdminPageConfig,
	Block,
	ButtonElement,
	FormBlock,
	PlainBlockId,
	RouteHandler,
	SelectOption,
	TableBlock,
} from "../types.js";
import {
	AdminRulesClient,
	type RulesCasUpdateResult,
	type RulesCreateResult,
	type RulesDeleteResult,
	type RulesUpdateResult,
	type ShippingZoneWire,
	type TaxClassDeleteResult,
	type TaxClassWire,
	type TaxRateWire,
} from "./admin-rules-client.js";
import { formatBpsAsPercent, parsePercentToBps } from "./percent-input.js";
import {
	asRecord,
	backButton,
	carriedForm,
	createListDetailHandler,
	customAction,
	decodePath,
	emptyState,
	encodePath,
	failClosedResponse,
	filterPanel,
	filterSummary,
	leafLevel,
	listLevel,
	noticeBanner,
	PATH_FIELD,
	readAdminTokens,
	readBoolean,
	readCarrier,
	readString,
	screenActions,
	type ListDetailInput,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Tax console page (admin-UX density overhaul, §12.3 of
 * `docs/admin/ADMIN-CONSOLE.md`) — a 3-level scaffold screen: tax classes
 * (registry create/list) drilling into a class's tax rates (list/create/
 * edit-with-CAS/delete), which — ONLY past L-9's 25-row bound — drills once
 * more into a single rate's own detail (the L-7 fallback's "drill-in", so a
 * rate past row 25 stays reachable without reviving the per-row inline forms
 * this overhaul removes).
 *
 * THE DENSITY FIX THIS SCREEN EXISTS FOR. The previous layout rendered an edit
 * form plus a delete button INLINE, for every row, SIMULTANEOUSLY — N rows
 * cost N × (48px divider + ~5 field rows). Per-row content now lives inside a
 * collapsed `accordion` (default_open false), one per class / one per rate,
 * and every `divider` is gone (R-4).
 *
 * L-9 IS A RUNTIME BRANCH, NOT A DESIGN-TIME ASSUMPTION. A level renders as
 * the per-row accordion list ONLY when the fetched page is complete
 * (`nextCursor === null`, i.e. `nextToken === undefined`) AND `items.length
 * <= 25`; otherwise it renders a `table` + an L-7 `combobox` drill-in, because
 * `table.next_cursor` + "Load more" is the only paging affordance in the
 * whole vocabulary — deleting the table would make row 26 unreachable. Both
 * branches ship on both list levels; the sandbox suite asserts the branch at
 * 25 rows and at 26.
 *
 * TAX OWNS THE `toggle` ELEMENT. "Applies to shipping" is the one boolean on
 * this screen, and this is the first (only) screen to use `toggle` — see
 * `scaffold/list-detail.ts`'s `readBoolean`, added in this same change because
 * `readString` returns `undefined` for a real boolean and every prior parser
 * read `"true"`/`"false"` STRINGS that a toggle never sends.
 */
export const TAX_PAGE: AdminPageConfig = { path: "/tax", label: "Tax", icon: "percent" };

/** This screen's namespaced action ids — the four scaffold nav verbs plus
 *  the class/rate side-effecting verbs and the two `empty.actions` "open the
 *  create group" verbs (E-2/B-6). */
const TAX_ACTIONS: ScreenActions = screenActions("tax");
const ACTION_CREATE_CLASS = TAX_ACTIONS.custom("create-class");
const ACTION_SAVE_CLASS = TAX_ACTIONS.custom("save-class");
const ACTION_DELETE_CLASS = TAX_ACTIONS.custom("delete-class");
const ACTION_SHOW_NEW_CLASS = TAX_ACTIONS.custom("show-new-class");
const ACTION_CREATE_RATE = TAX_ACTIONS.custom("create-rate");
const ACTION_SAVE_RATE = TAX_ACTIONS.custom("save-rate");
const ACTION_DELETE_RATE = TAX_ACTIONS.custom("delete-rate");
const ACTION_SHOW_NEW_RATE = TAX_ACTIONS.custom("show-new-rate");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Tax console. Every `block_action`/`form_submit` this page can emit is
 * namespaced `tax:*` and listed here, so none falls through the dispatcher
 * to the `{blocks:[]}` dead-end.
 */
export const TAX_ACTION_IDS: ReadonlySet<string> = TAX_ACTIONS.actionIds(
	"create-class",
	"save-class",
	"delete-class",
	"show-new-class",
	"create-rate",
	"save-rate",
	"delete-rate",
	"show-new-rate",
);

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type TaxPageInput = ListDetailInput;

/**
 * What a custom action tells a level to render THIS response (design spec
 * §10 B-6 / DA-3a-iii's channel — "state, never data"): which create-group
 * accordion the operator just asked to open, from an `empty.actions` button
 * at true zero state (E-2). Nothing else on this screen needs the channel —
 * both registry levels are unconditional DA-2 deletes and LWW/CAS saves, none
 * of which stage a confirm.
 */
type TaxRenderState = { kind: "new-class-open" } | { kind: "new-rate-open" };

/** A tax rate ROW as this screen renders it: the wire shape plus the zone's
 *  human name, resolved from the SAME `listZones()` read every render already
 *  performs (D-6's one-extra-read allowance — see `fetchRatesForClass`). */
interface TaxRateRow extends TaxRateWire {
	zoneName?: string;
}

/** The rates level's own filter: an OPTIONAL zone-id narrow. Unset ⇒ every
 *  zone this store has (fanned out — see `fetchRatesForClass`); set ⇒ scoped
 *  to exactly that zone (one read, plus the always-on zones read the Zone
 *  select's options need). */
interface RatesFilterForm {
	zoneId?: string;
}

/** One rendered "page" of the rates level: the rows plus the zones list the
 *  Zone filter/create selects need — fetched ONCE per render regardless of
 *  row count, so the select still has its options at zero rows. Wrapped as a
 *  single-element `items` array so the scaffold's opaque `Summary` slot can
 *  carry both without a second read; L-9's branch decision inside `render`
 *  uses `bundle.rows.length`, never the wrapper array's own length. */
interface RatesPageBundle {
	rows: TaxRateRow[];
	zones: ShippingZoneWire[];
}

/** A level renders the per-row accordion list only when the page is COMPLETE
 *  and small (L-9). Both branches ship; the suite asserts the branch at this
 *  bound and one past it. */
const REGISTRY_ACCORDION_LIMIT = 25;

export function createTaxPageHandler(): RouteHandler<TaxPageInput> {
	return createListDetailHandler<TaxRenderState>({
		actions: TAX_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminRulesClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// Every drill-in on this screen is a BUTTON or an L-7 `combobox` carrying
		// the FULL target path (§12.7) — never a bare id, which would be silently
		// wrong the moment a fallback picker's option encodes a two-level path
		// (class + rate). A button's only context channel is `value` (B-1); a
		// combobox form submit's is `values` — read both, precedence to `value`.
		parseOpen(input) {
			const fromValue = asRecord(input.value)?.target;
			const fromValues = input.values?.target;
			const encoded =
				typeof fromValue === "string"
					? fromValue
					: typeof fromValues === "string"
						? fromValues
						: undefined;
			if (encoded === undefined) return undefined;
			const path = decodePath(encoded);
			return path === null || path.length === 0 ? undefined : { targetPath: path };
		},
		levels: [taxClassesLevel(), taxRatesLevel(), taxRateDetailLevel()],
		customActions: {
			[ACTION_CREATE_CLASS]: createClassAction(),
			[ACTION_SAVE_CLASS]: saveClassAction(),
			[ACTION_DELETE_CLASS]: deleteClassAction(),
			[ACTION_SHOW_NEW_CLASS]: showNewClassAction(),
			[ACTION_CREATE_RATE]: createRateAction(),
			[ACTION_SAVE_RATE]: saveRateAction(),
			[ACTION_DELETE_RATE]: deleteRateAction(),
			[ACTION_SHOW_NEW_RATE]: showNewRateAction(),
		},
	});
}

// -- level 0: the tax classes registry ----------------------------------------

function taxClassesLevel() {
	return listLevel<AdminRulesClient, Record<string, never>, TaxClassWire, TaxRenderState>({
		// The registry has no service-side pagination (`GET /admin/tax/classes`
		// returns the full list) — `limit` is unused by `fetchPage` (kept for the
		// level's shape) and `nextCursor` is always `null`. Deliberately above
		// L-9's 25-row bound, so a store with a genuinely large class count still
		// exercises the table+drill-in fallback rather than silently truncating.
		limit: 200,
		filterFromValues: () => ({}),
		async fetchPage(client) {
			const classes = await client.listTaxClasses();
			return { items: classes, nextCursor: null };
		},
		render({ actions, items, nextToken, notice, renderState }) {
			return classesBlocks(actions, items, nextToken, notice, renderState);
		},
		onError: () => classesFailClosed(),
	});
}

function classesBlocks(
	actions: ScreenActions,
	classes: TaxClassWire[],
	nextToken: string | undefined,
	notice: Notice | undefined,
	renderState: TaxRenderState | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Tax classes" },
		{
			type: "context",
			text: "A tax class is a rate group; products and rates reference one by id.",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	// No filter block: this level has no filter fields (L-2, count 0).

	const forceNewClassOpen = renderState?.kind === "new-class-open";
	const accordionBranch = nextToken === undefined && classes.length <= REGISTRY_ACCORDION_LIMIT;
	if (accordionBranch) {
		if (classes.length === 0) {
			blocks.push(
				emptyState({
					title: "No tax classes yet",
					description:
						"A tax class groups tax rates that share the same treatment — products and rates reference one by id.",
					actions: [
						{ type: "button", action_id: ACTION_SHOW_NEW_CLASS, label: "Create a tax class" },
					],
				}),
			);
		} else {
			for (const cls of classes) blocks.push(classRow(actions, cls));
		}
	} else {
		blocks.push(classesTable(actions, classes, nextToken));
		blocks.push(openClassForm(classes));
	}
	blocks.push(newClassAccordion(forceNewClassOpen));
	return blocks;
}

function classGroupId(classId: string): PlainBlockId {
	return `tax:class:${classId}` as PlainBlockId;
}

/** One class's per-row group (L-9): a rename form (LWW, DA-4), the drill-in
 *  to its rates (§12.7's full-path button), and its delete (DA-2). Whether the
 *  class is referenced by a product or another rate is NOT on `TaxClassWire`
 *  (`{id, name}` only) — see the module doc's "Listing defects" disclosure:
 *  the delete stays an unconditional DA-2 with an HONEST post-hoc refusal
 *  (`deleteClassNotice`), the same shape D-6 already accepts for
 *  `ShippingZoneWire`'s missing method count, rather than a per-row
 *  reference-count fetch this level's own read never returns. */
function classRow(actions: ScreenActions, cls: TaxClassWire): AccordionBlock {
	const renameForm = carriedForm({
		namespace: "tax:class-save",
		context: { classId: cls.id },
		form: {
			type: "form",
			fields: [{ type: "text_input", action_id: "name", label: "Name", initial_value: cls.name }],
			submit: { label: "Save name", action_id: ACTION_SAVE_CLASS },
		},
	});
	const viewRatesButton: ButtonElement = {
		type: "button",
		action_id: actions.open,
		label: "View rates",
		value: { target: encodePath([cls.id]) },
	};
	const deleteButton: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_CLASS,
		label: "Delete class",
		style: "danger",
		value: { classId: cls.id },
		confirm: {
			title: `Delete tax class ${cls.id}?`,
			text: "Deleting is blocked while any product or tax rate still references this class. This cannot be undone.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return {
		type: "accordion",
		block_id: classGroupId(cls.id),
		label: `${cls.id} — ${cls.name}`,
		default_open: false,
		// ORDER IS THE AFFORDANCE HERE, because there is no other. A `form` is
		// always `flex flex-col` in the pinned renderer, so these can never sit in
		// a horizontal row with the primary on the end — every control is a
		// full-width stack item, and the only thing left to say "this one first" is
		// which one is first. So: the COMMON path (opening the class's rates)
		// leads, the rename it wraps follows, and the destructive delete goes LAST,
		// pushed off the stack by the context line below.
		//
		// That line is the spacer. Block Kit has no spacer block, and `divider` is
		// off the console's vocabulary — so the separation between "edit this" and
		// "destroy this" has to be carried by a block that also earns its height.
		// This one does: it states the refusal BEFORE the click, where the confirm
		// dialog's own copy only appears after.
		blocks: [
			{ type: "actions", elements: [viewRatesButton] },
			renameForm,
			{
				type: "context",
				text: "Deleting is blocked while any product or tax rate still references this class.",
			},
			{ type: "actions", elements: [deleteButton] },
		],
	};
}

const NEW_CLASS_FORM_ID = "tax:new-class-form" as PlainBlockId;

function newClassForm(): FormBlock {
	return {
		type: "form",
		block_id: NEW_CLASS_FORM_ID,
		fields: [
			{ type: "text_input", action_id: "id", label: "Class ID", placeholder: "e.g. reduced" },
			{ type: "text_input", action_id: "name", label: "Name", placeholder: "e.g. Reduced rate" },
		],
		submit: { label: "Create tax class", action_id: ACTION_CREATE_CLASS },
	};
}

/** The "New tax class" group (L-8). `forceOpen` is set only by the E-2
 *  create-from-empty-state flow (B-6: both the changed `block_id` AND
 *  `default_open: true`, never just one). */
function newClassAccordion(forceOpen: boolean): AccordionBlock {
	return {
		type: "accordion",
		block_id: (forceOpen ? "tax:new-class:opened" : "tax:new-class") as PlainBlockId,
		label: "New tax class",
		default_open: forceOpen,
		blocks: [newClassForm()],
	};
}

/** L-9 fallback (>25 classes, or a next page): the raw list plus an L-7
 *  `combobox` drill-in. Editing a class's name is not offered here — it moves
 *  to opening the class (matching §12.3's own "editing moves to a rate-level
 *  list" note for this branch). */
function classesTable(
	actions: ScreenActions,
	classes: TaxClassWire[],
	nextToken: string | undefined,
): TableBlock {
	return {
		type: "table",
		block_id: "tax:classes" as PlainBlockId,
		columns: [
			{ key: "id", label: "Class ID", format: "code" },
			{ key: "name", label: "Name" },
		],
		rows: classes.map((c) => ({ id: c.id, name: c.name })),
		page_action_id: actions.page, // never fires: this registry has no service-side pagination
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text: "No tax classes yet.",
	};
}

/** L-7 drill-in: always a `combobox` (never a `select`, R-17a/R-17b), because
 *  the option value is the opaque encoded target path. Wrapped in
 *  `carriedForm` because its `initial_value: "none"` makes it mechanically a
 *  "prefilling" form (X-17) even though nothing per-render is carried. */
function openClassForm(classes: TaxClassWire[]): FormBlock {
	const options: SelectOption[] = [
		{ value: "none", label: "Choose a tax class…" },
		...classes.map((c) => ({ value: encodePath([c.id]), label: c.name })),
	];
	return carriedForm({
		namespace: "tax:open-class",
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "target",
					label: "Open class",
					options,
					initial_value: "none",
					placeholder: "Choose a tax class…",
				},
			],
			submit: { label: "Open class", action_id: TAX_ACTIONS.open },
		},
	});
}

function classesFailClosed() {
	return failClosedResponse({
		header: "Tax classes",
		title: "Tax classes are unavailable",
		description:
			"Tax classes could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load tax classes",
	});
}

// -- level 1: a class's tax rates ----------------------------------------------

function taxRatesLevel() {
	return listLevel<AdminRulesClient, RatesFilterForm, RatesPageBundle, TaxRenderState>({
		limit: 500,
		filterFromValues(values) {
			const zoneId = readString(values.zoneId);
			return zoneId !== undefined && zoneId !== "any" && zoneId.length > 0 ? { zoneId } : {};
		},
		async fetchPage(client, path, filter) {
			const classId = path[0];
			if (classId === undefined) return { items: [], nextCursor: null };
			const zones = await client.listZones();
			const rows = await fetchRatesForClass(client, classId, filter.zoneId, zones);
			return { items: [{ rows, zones }], nextCursor: null };
		},
		render({ actions, path, filter, items, nextToken, notice, renderState }) {
			const classId = path[0] ?? "";
			const bundle = items[0] ?? { rows: [], zones: [] };
			return ratesBlocks(actions, classId, filter, bundle, nextToken, notice, renderState);
		},
		onError: () => ratesFailClosed(),
	});
}

/**
 * Load every rate for `classId`. `zoneId` unset (the default, unfiltered
 * view) ⇒ fan out across EVERY zone this store has (one `listTaxRates(zoneId)`
 * per zone, in parallel) and keep the rows whose `taxClassId` matches — the
 * service has no `GET /admin/tax/rates?taxClassId=` cross-zone read, only the
 * per-zone one, so "rates for this class" is necessarily N zone reads.
 * Accepted as fine for an admin console with a small zone count (this is not
 * a storefront hot path).
 * `zoneId` set ⇒ ONE rates read, scoped to that zone — no fan-out.
 * `zones` is ALWAYS supplied by the caller (one `listZones()` per render,
 * regardless of filter state) — the Zone select's options need the full list
 * even when scoped, which is the one extra read D-6 explicitly permits
 * (`r.zoneName ?? r.zoneId`, §12.3's own note).
 * Any read failure PROPAGATES (never silently degrades to "no rates" — this
 * is the level's PRIMARY data, unlike a leaf's secondary reads), so the
 * caller's `onError` fails closed instead of rendering a misleading empty list.
 */
async function fetchRatesForClass(
	client: AdminRulesClient,
	classId: string,
	zoneId: string | undefined,
	zones: ShippingZoneWire[],
): Promise<TaxRateRow[]> {
	if (zoneId !== undefined) {
		const rates = await client.listTaxRates(zoneId);
		const zoneName = zones.find((z) => z.id === zoneId)?.name;
		return rates
			.filter((r) => r.taxClassId === classId)
			.map((r) => ({ ...r, zoneName: zoneName ?? r.zoneId }));
	}
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
	bundle: RatesPageBundle,
	nextToken: string | undefined,
	notice: Notice | undefined,
	renderState: TaxRenderState | undefined,
): Block[] {
	const path = [classId];
	const blocks: Block[] = [
		{ type: "header", text: `Tax rates — ${classId}` },
		backButton(actions.back, "← Back to tax classes", path),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({ type: "context", text: "Each rate applies to purchases shipping to one zone." });

	blocks.push(zoneFilterBlock(classId, filter, bundle.zones));
	const activeParts = [filter.zoneId !== undefined && `zone: ${filter.zoneId}`];
	const summaryText = filterSummary(activeParts);
	if (summaryText !== undefined) {
		blocks.push({
			type: "section",
			text: summaryText,
			accessory: {
				type: "button",
				action_id: TAX_ACTIONS.applyFilter,
				label: "Clear filters",
				value: { [PATH_FIELD]: encodePath(path) }, // depth 1, REQUIRED (L-6)
			},
		});
	}

	const forceNewRateOpen = renderState?.kind === "new-rate-open";
	const accordionBranch = nextToken === undefined && bundle.rows.length <= REGISTRY_ACCORDION_LIMIT;
	if (accordionBranch) {
		if (bundle.rows.length === 0) {
			if (filter.zoneId === undefined) {
				// True zero, unfiltered (E-2) — never for a filtered-to-zero list.
				blocks.push(
					emptyState({
						title: "No tax rates yet",
						description: "Add a rate to start charging tax for purchases shipping to a zone.",
						actions: [
							{
								type: "button",
								action_id: ACTION_SHOW_NEW_RATE,
								label: "Add a tax rate",
								value: { [PATH_FIELD]: encodePath(path) },
							},
						],
					}),
				);
			} else {
				// Filtered to zero (E-1/E-2: never the `empty` illustration here — the
				// operator's next act is changing the filter, which is right above).
				blocks.push({
					type: "context",
					text: `No tax rates for zone "${filter.zoneId}" yet — use the form below to add one.`,
				});
			}
		} else {
			for (const row of bundle.rows) blocks.push(rateRow(classId, row));
		}
	} else {
		blocks.push(ratesTable(actions, bundle.rows, nextToken));
		blocks.push(openRateForm(classId, bundle.rows));
	}
	blocks.push(newRateAccordion(classId, filter, bundle.zones, forceNewRateOpen));
	return blocks;
}

/** The Zone filter (L-2: 1 field ⇒ inline, no accordion). A closed set from
 *  the `listZones` read this level already performs (D-6) — was a free-text
 *  "Zone ID (blank = every zone)" field; a `select` is correct here (F-6) and
 *  never blank (F-6a) because `"any"` is a real sentinel, never `""`. */
function zoneFilterBlock(
	classId: string,
	filter: RatesFilterForm,
	zones: ShippingZoneWire[],
): FormBlock | AccordionBlock {
	const options: SelectOption[] = [
		{ value: "any", label: "All zones" },
		...zones.map((z) => ({ value: z.id, label: z.name })),
	];
	const form = carriedForm({
		namespace: "tax:rate-filter",
		context: { [PATH_FIELD]: encodePath([classId]) },
		form: {
			type: "form",
			fields: [
				{
					type: "select",
					action_id: "zoneId",
					label: "Zone",
					options,
					initial_value: filter.zoneId ?? "any",
				},
			],
			submit: { label: "Apply filters", action_id: TAX_ACTIONS.applyFilter },
		},
	});
	return filterPanel({
		form,
		blockId: `tax:rate-filters:${classId}` as PlainBlockId,
		activeFilters: [filter.zoneId !== undefined && `zone: ${filter.zoneId}`],
	});
}

function rateGroupId(rateId: string): PlainBlockId {
	return `tax:rate:${rateId}` as PlainBlockId;
}

/** The per-rate edit form (CAS on `rateBps`) — shared by the accordion body
 *  (L-9's primary branch) and the rate-detail leaf (the L-9 fallback's
 *  drill-in target), so the two never drift. `expectedRateBps` rides in the
 *  form's carrier (`carriedForm`'s change token, B-3) — a concurrent edit that
 *  changed it loses the CAS and the reload shows the fresh value with a
 *  "reload" notice, never a silent clobber. */
function rateEditForm(classId: string, row: TaxRateRow): FormBlock {
	return carriedForm({
		namespace: "tax:rate-save",
		context: { classId, rateId: row.id, expectedRateBps: String(row.rateBps) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "ratePercent",
					label: "Rate (%)",
					initial_value: formatBpsAsPercent(row.rateBps),
				},
				{
					type: "toggle",
					action_id: "appliesToShipping",
					label: "Applies to shipping",
					initial_value: row.appliesToShipping, // F-6b/X-24: REQUIRED — toggle is mount-only
				},
			],
			submit: { label: "Save rate", action_id: ACTION_SAVE_RATE },
		},
	});
}

function rateDeleteActions(classId: string, row: TaxRateRow) {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_RATE,
		label: "Delete rate",
		style: "danger",
		value: { classId, rateId: row.id },
		confirm: {
			title: `Delete tax rate ${row.id}?`,
			text: "In-flight carts recompute their tax without this rate. Orders already placed are unaffected — they snapshot the tax charged at purchase time.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions" as const, elements: [button] };
}

/**
 * One rate's per-row group (L-9). D-6's label carries the answer — zone,
 * percent, and whether it also taxes shipping — so an operator can skip the
 * group entirely from the label alone.
 *
 * THE RATE LEADS THE LABEL. It used to trail the slug (`std-eu — Europe ·
 * 20.00% · …`), which starts every row's number at a different x — slug lengths
 * differ — so 20.00% / 0.00% / 8.75% could not be compared down the column,
 * which is the one comparison this level exists to support. Leading with the
 * percent puts every rate within a few px of the same left edge. The slug keeps
 * its place in the label IN FULL (a tax rate id is a readable natural key, not
 * an opaque uuid — the short-id rule does not apply to it).
 *
 * A percent is NOT money: it is formatted by `formatBpsAsPercent` (exact
 * integer basis points), never by `formatMoney`, and carries no currency.
 */
function rateRow(classId: string, row: TaxRateRow): AccordionBlock {
	const percent = formatBpsAsPercent(row.rateBps);
	const appliesLabel = row.appliesToShipping ? "also shipping" : "goods only";
	return {
		type: "accordion",
		block_id: rateGroupId(row.id),
		label: `${percent}% — ${row.zoneName ?? row.zoneId} · ${row.id} · ${appliesLabel}`,
		default_open: false,
		blocks: [rateEditForm(classId, row), rateDeleteActions(classId, row)],
	};
}

/** L-9 fallback (>25 rates for this class, or a next page): the raw list,
 *  `Applies to shipping` as PLAIN TEXT (never a badge — T-5, X-4: a
 *  yes/mostly-no boolean is exactly the "constant-ish" case T-5 forbids), plus
 *  an L-7 drill-in to the rate-detail leaf. */
function ratesTable(
	actions: ScreenActions,
	rows: TaxRateRow[],
	nextToken: string | undefined,
): TableBlock {
	return {
		type: "table",
		block_id: "tax:rates" as PlainBlockId,
		columns: [
			{ key: "id", label: "Rate ID", format: "code" },
			{ key: "zone", label: "Zone" },
			{ key: "rate", label: "Rate" },
			{ key: "appliesToShipping", label: "Applies to shipping" },
		],
		rows: rows.map((r) => ({
			id: r.id,
			zone: r.zoneName ?? r.zoneId,
			rate: `${formatBpsAsPercent(r.rateBps)}%`,
			appliesToShipping: r.appliesToShipping ? "yes" : "—",
		})),
		page_action_id: actions.page, // never fires: this registry has no service-side pagination
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text: "No tax rates yet for this class.",
	};
}

/** L-7 drill-in to the rate-detail LEAF (the fallback's "editing moves to a
 *  detail level") — always a `combobox` (R-17a/R-17b), option value the FULL
 *  two-level target path, never a bare rate id. The option label leads with
 *  the rate for the same reason the accordion label does: in a list of options
 *  the number is what is being chosen between. */
function openRateForm(classId: string, rows: TaxRateRow[]): FormBlock {
	const options: SelectOption[] = [
		{ value: "none", label: "Choose a tax rate…" },
		...rows.map((r) => ({
			value: encodePath([classId, r.id]),
			label: `${formatBpsAsPercent(r.rateBps)}% · ${r.zoneName ?? r.zoneId}`,
		})),
	];
	return carriedForm({
		namespace: "tax:open-rate",
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "target",
					label: "Open rate",
					options,
					initial_value: "none",
					placeholder: "Choose a tax rate…",
				},
			],
			submit: { label: "Open rate", action_id: TAX_ACTIONS.open },
		},
	});
}

/** The "New tax rate" group (L-8). Defaults the Zone select to the active
 *  filter (if any) or the store's first zone; when there are no zones at all
 *  the form cannot be built without an F-6a-violating empty select, so the
 *  body degrades to one honest line instead (DA-7-shaped: names the actual
 *  next step). `forceOpen` mirrors `newClassAccordion` — B-6, both halves. */
function newRateAccordion(
	classId: string,
	filter: RatesFilterForm,
	zones: ShippingZoneWire[],
	forceOpen: boolean,
): AccordionBlock {
	const body: Block[] =
		zones.length === 0
			? [
					{
						type: "context",
						text: "Create a shipping zone first — a tax rate applies to one zone.",
					},
				]
			: [newRateForm(classId, filter, zones)];
	return {
		type: "accordion",
		block_id: (forceOpen
			? `tax:new-rate:${classId}:opened`
			: `tax:new-rate:${classId}`) as PlainBlockId,
		label: "New tax rate",
		default_open: forceOpen,
		blocks: body,
	};
}

function newRateForm(
	classId: string,
	filter: RatesFilterForm,
	zones: ShippingZoneWire[],
): FormBlock {
	const defaultZoneId = filter.zoneId ?? zones[0]?.id ?? "";
	const options: SelectOption[] = zones.map((z) => ({ value: z.id, label: z.name }));
	return carriedForm({
		namespace: "tax:rate-create",
		context: { classId },
		form: {
			type: "form",
			fields: [
				{ type: "text_input", action_id: "id", label: "Rate ID", placeholder: "e.g. std-us" },
				{
					type: "select",
					action_id: "zoneId",
					label: "Zone",
					options,
					initial_value: defaultZoneId,
				},
				{
					type: "text_input",
					action_id: "ratePercent",
					label: "Rate (%, up to 2 decimals)",
					placeholder: "e.g. 7.25",
				},
				{
					type: "toggle",
					action_id: "appliesToShipping",
					label: "Applies to shipping",
					initial_value: false,
				},
			],
			submit: { label: "Add tax rate", action_id: ACTION_CREATE_RATE },
		},
	});
}

function ratesFailClosed() {
	return failClosedResponse({
		header: "Tax rates",
		title: "Tax rates are unavailable",
		description:
			"Tax rates could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load tax rates",
	});
}

// -- level 2: a single rate's own detail (the L-9 fallback's drill-in target) --

/**
 * Reached ONLY via the rates level's L-7 `combobox` once that class has more
 * than 25 rates (or a next page) — the table+drill-in branch needs somewhere
 * for "editing moves to a detail level" (§12.3) to land, or row 26 is
 * editable in the accordion branch but unreachable in the fallback one.
 * Shares `rateEditForm`/`rateDeleteActions` with the accordion body verbatim,
 * so the two never drift.
 */
function taxRateDetailLevel() {
	return leafLevel<AdminRulesClient, TaxRateRow>({
		async load(client, path, id) {
			const classId = path[0];
			if (classId === undefined) return null;
			const zones = await client.listZones();
			const rows = await fetchRatesForClass(client, classId, undefined, zones);
			return rows.find((r) => r.id === id) ?? null;
		},
		render({ actions, path, detail, notice }) {
			const classId = path[0] ?? "";
			return rateDetailBlocks(actions, classId, detail, notice);
		},
		notFound({ actions, path }) {
			const classId = path[0] ?? "";
			return [
				{ type: "header", text: "Tax rate not found" },
				backButton(actions.back, "← Back to tax rates", path),
				{
					type: "banner",
					variant: "error",
					title: "Tax rate not found",
					description: `No tax rate matches that id for class "${classId}" — it may have already been deleted.`,
				},
			];
		},
		onError: () => rateDetailFailClosed(),
	});
}

function rateDetailBlocks(
	actions: ScreenActions,
	classId: string,
	row: TaxRateRow,
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: `Tax rate — ${row.id}` },
		backButton(actions.back, "← Back to tax rates", [classId, row.id]),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({
		type: "context",
		text: "Deleting only affects future carts — orders already placed keep the tax they were charged at purchase time.",
	});
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Zone", value: row.zoneName ?? row.zoneId },
			{ label: "Rate", value: `${formatBpsAsPercent(row.rateBps)}%` },
		],
	});
	blocks.push(rateEditForm(classId, row));
	blocks.push(rateDeleteActions(classId, row));
	return blocks;
}

function rateDetailFailClosed() {
	return failClosedResponse({
		header: "Tax rate",
		title: "Tax rate is unavailable",
		description:
			"Tax rate could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load this tax rate",
	});
}

// -- percent ↔ basis-points math (NO float arithmetic — CLAUDE.md) -----------
// The exact-integer parse/format pair lives in `./percent-input.js`, SHARED
// with the Coupons console (extracted at the second consumer, the same
// precedent as `money-input.ts`).

// -- custom action: create a tax class ----------------------------------------

function createClassAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, client, showList }) => {
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

// -- custom action: show the "New tax class" group forced open (E-2) ---------

function showNewClassAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ showList }) =>
		showList(undefined, undefined, { kind: "new-class-open" }),
	);
}

// -- custom action: rename a tax class (LWW) -----------------------------------

function saveClassAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, client, showList }) => {
		const classId = readCarrier(input)?.classId;
		if (classId === undefined) return showList();
		const values = input.values ?? {};
		const name = (readString(values.name) ?? "").trim();
		if (name.length === 0) {
			return showList(undefined, {
				variant: "error",
				title: "Class not saved",
				description: "Enter a name.",
			});
		}
		const result = await client.updateTaxClass(classId, { name });
		return showList(undefined, saveClassNotice(result));
	});
}

function saveClassNotice(result: RulesUpdateResult<TaxClassWire>): Notice {
	if (result.ok) {
		return { variant: "default", title: "Class saved", description: "The tax class was renamed." };
	}
	if (result.reason === "not_found") {
		return {
			variant: "error",
			title: "Class not found",
			description: "This tax class no longer exists — it may have already been deleted.",
		};
	}
	return {
		variant: "error",
		title: "Class not saved",
		description:
			"The change could not be saved — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: delete a tax class (forbid-if-in-use, honest count) -------

function deleteClassAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, client, showList }) => {
		const payload = asRecord(input.value);
		const classId = readString(payload?.classId);
		if (classId === undefined) return showList();
		const result = await client.deleteTaxClass(classId);
		return showList(undefined, deleteClassNotice(result));
	});
}

function deleteClassNotice(result: TaxClassDeleteResult): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Class deleted",
			description: "The tax class was removed.",
		};
	}
	if (result.reason === "not_found") {
		// Idempotent no-op (a double-submit, or someone else already deleted it) —
		// not a failure: surface a non-error notice rather than a scary banner.
		return {
			variant: "default",
			title: "Already deleted",
			description: "This tax class was already removed.",
		};
	}
	if (result.reason === "in_use_by_products") {
		return {
			variant: "error",
			title: "Class not deleted",
			description: `${result.count} product${result.count === 1 ? "" : "s"} still reference${result.count === 1 ? "s" : ""} this class — clear those references first, then retry.`,
		};
	}
	if (result.reason === "in_use_by_rates") {
		return {
			variant: "error",
			title: "Class not deleted",
			description: `${result.count} tax rate${result.count === 1 ? "" : "s"} still reference${result.count === 1 ? "s" : ""} this class — delete those rates first, then retry.`,
		};
	}
	return {
		variant: "error",
		title: "Class not deleted",
		description:
			"The class could not be deleted — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: create a tax rate ------------------------------------------

function createRateAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, client, showList }) => {
		const classId = readCarrier(input)?.classId;
		if (classId === undefined) return showList();
		const values = input.values ?? {};
		const id = (readString(values.id) ?? "").trim();
		const zoneId = (readString(values.zoneId) ?? "").trim();
		if (id.length === 0 || zoneId.length === 0) {
			return showList([classId], {
				variant: "error",
				title: "Tax rate not created",
				description: "Enter both a rate ID and a zone.",
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
		const appliesToShipping = readBoolean(values.appliesToShipping) ?? false;
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
		description: `Could not create "${id}" — check the rate ID isn't already in use and the zone id is correct, then try again.`,
	};
}

// -- custom action: show the "New tax rate" group forced open (E-2) ----------

function showNewRateAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, showList }) => {
		const payload = asRecord(input.value);
		const encoded = readString(payload?.[PATH_FIELD]);
		const path = encoded !== undefined ? decodePath(encoded) : null;
		if (path === null || path.length === 0) return showList();
		return showList(path, undefined, { kind: "new-rate-open" });
	});
}

// -- custom action: edit a tax rate (CAS on rateBps) ---------------------------

function saveRateAction() {
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, client, showList }) => {
		const carried = readCarrier(input);
		const classId = carried?.classId;
		const rateId = carried?.rateId;
		const expectedRateBpsRaw = carried?.expectedRateBps;
		if (classId === undefined || rateId === undefined || expectedRateBpsRaw === undefined) {
			return showList();
		}
		const expectedRateBps = Number.parseInt(expectedRateBpsRaw, 10);
		const values = input.values ?? {};
		const bps = parsePercentToBps(readString(values.ratePercent) ?? "");
		if (bps === null) {
			return showList([classId], {
				variant: "error",
				title: "Rate not saved",
				description: "Rate must be a percent like 7.25 (0 to 1000, up to two decimal places).",
			});
		}
		const appliesToShipping = readBoolean(values.appliesToShipping) ?? false;
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
	return customAction<AdminRulesClient, TaxRenderState>(async ({ input, client, showList }) => {
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
