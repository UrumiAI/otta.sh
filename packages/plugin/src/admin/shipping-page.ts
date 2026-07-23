import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
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
	type RulesUpdateResult,
	type ShippingMethodWire,
	type ShippingRateWire,
	type ShippingZoneWire,
} from "./admin-rules-client.js";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
import {
	asRecord,
	backButton,
	createListDetailHandler,
	customAction,
	decodePath,
	encodePath,
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
 * The admin Shipping console page (admin-UX Increment 3, slice 3 —
 * "shipping admin drill-down"): a THREE-level scaffold screen — zones (list/
 * create/edit-LWW/delete-forbid-if-methods) drilling into a zone's methods
 * (list/create/edit-LWW/delete-forbid-if-rates) drilling into a method's
 * rates (a currency-keyed list/create/edit-with-CAS/delete). Rendered by the
 * single `admin` dispatch route (`admin-route.ts`). Built on the shared
 * list/detail scaffold (`./scaffold`) and `AdminRulesClient`, both already
 * proven by `orders-page.ts`/`products-page.ts`/`tax-page.ts` — this is the
 * FIRST production screen to actually reach depth 3 (the scaffold's own
 * synthetic geo fixture, `scaffold/testing/geo-screen.ts`, is what proved the
 * N-level nav core works before any real screen needed it).
 *
 * ALL THREE levels are `listLevel`s (no leaf), same shape as the Tax console
 * — a row's "Open" form drills straight into the next level's LIST, never a
 * detail. Deep opens (zone → methods, method → rates) encode the FULL target
 * path into the open form's option value (`encodePath`/`decodePath`, the
 * `scaffold/testing/geo-screen.ts` pattern) rather than a single carried id,
 * since a single `parseOpen` here must resolve opens fired from TWO different
 * levels.
 *
 * REGIONS, presented honestly: `ShippingZone.regions` is opaque config the
 * pricing engine never reads (`@urumi/domain`'s `ShippingRulesStore` doc:
 * "opaque config the engine never reads") — checkout/quote takes an explicit
 * `shippingZoneId` (`checkoutBody`/`quoteBody` in `@urumi/service`'s
 * schemas), not an address-to-zone match. This screen therefore does NOT
 * claim regions drive automatic zone selection: the copy on the zones level
 * says so, and the field is a plain comma-separated code list (parsed to a
 * string array) for the merchant's own reference / a future matcher to read.
 *
 * RATES, presented honestly: unlike tax rates (which have their own `id` and
 * a per-zone LIST read), a shipping rate's identity is `(methodId, currency)`
 * and the service exposes only a single-currency `GET .../rates?currency=`
 * read — there is no "list every currency a method has" endpoint. The rates
 * level is therefore a currency-KEYED lookup (0 or 1 row) behind a currency
 * filter (default `"USD"`), not a true multi-row list — the same shape as
 * the zones/methods filter forms, just with a filter that always has some
 * value rather than an optional narrow. This is also where the scaffold's
 * auto filter-path-carry (`withFilterPathCarry` in `list-detail.ts`) gets
 * its first depth-2 production exercise: the currency filter form fires
 * `applyFilter` from path `[zoneId, methodId]` and never has to hand-carry
 * the path itself.
 */
export const SHIPPING_PAGE: AdminPageConfig = {
	path: "/shipping",
	label: "Shipping",
	icon: "truck",
};

/** This screen's namespaced action ids — the four scaffold nav verbs plus
 *  the zone/method/rate side-effecting verbs. */
const SHIPPING_ACTIONS: ScreenActions = screenActions("shipping");
const ACTION_CREATE_ZONE = SHIPPING_ACTIONS.custom("create-zone");
const ACTION_SAVE_ZONE = SHIPPING_ACTIONS.custom("save-zone");
const ACTION_DELETE_ZONE = SHIPPING_ACTIONS.custom("delete-zone");
const ACTION_CREATE_METHOD = SHIPPING_ACTIONS.custom("create-method");
const ACTION_SAVE_METHOD = SHIPPING_ACTIONS.custom("save-method");
const ACTION_DELETE_METHOD = SHIPPING_ACTIONS.custom("delete-method");
const ACTION_CREATE_RATE = SHIPPING_ACTIONS.custom("create-rate");
const ACTION_SAVE_RATE = SHIPPING_ACTIONS.custom("save-rate");
const ACTION_DELETE_RATE = SHIPPING_ACTIONS.custom("delete-rate");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Shipping console. Every `block_action`/`form_submit` this page can emit is
 * namespaced `shipping:*` and listed here, so none falls through the
 * dispatcher to the `{blocks:[]}` dead-end.
 */
export const SHIPPING_ACTION_IDS: ReadonlySet<string> = SHIPPING_ACTIONS.actionIds(
	"create-zone",
	"save-zone",
	"delete-zone",
	"create-method",
	"save-method",
	"delete-method",
	"create-rate",
	"save-rate",
	"delete-rate",
);

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type ShippingPageInput = ListDetailInput;

/** The rates level's filter: a currency narrow that ALWAYS has a value (no
 *  "unfiltered" state exists — see the module doc's rates-identity note).
 *  Defaults to `"USD"`. */
interface RatesFilterForm {
	currency: string;
}

const DEFAULT_RATE_CURRENCY = "USD";

export function createShippingPageHandler(): RouteHandler<ShippingPageInput> {
	return createListDetailHandler({
		actions: SHIPPING_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminRulesClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// Both the zones level's "Open zone" form and the methods level's "Open
		// method" form submit the FULL encoded target path in `values.target`
		// (`openTargetForm` below) — one `parseOpen` resolves either.
		parseOpen(input) {
			const encoded = readString(input.values?.target);
			const targetPath = encoded === undefined ? null : decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [zonesLevel(), methodsLevel(), ratesLevel()],
		customActions: {
			[ACTION_CREATE_ZONE]: createZoneAction(),
			[ACTION_SAVE_ZONE]: saveZoneAction(),
			[ACTION_DELETE_ZONE]: deleteZoneAction(),
			[ACTION_CREATE_METHOD]: createMethodAction(),
			[ACTION_SAVE_METHOD]: saveMethodAction(),
			[ACTION_DELETE_METHOD]: deleteMethodAction(),
			[ACTION_CREATE_RATE]: createRateAction(),
			[ACTION_SAVE_RATE]: saveRateAction(),
			[ACTION_DELETE_RATE]: deleteRateAction(),
		},
	});
}

/** A row's "Open …" picker — shared shape for the zones→methods and the
 *  methods→rates drills. `target` carries the FULL encoded path. */
function openTargetForm(label: string, options: SelectOption[]): FormBlock {
	return {
		type: "form",
		fields: [{ type: "select", action_id: "target", label, options }],
		submit: { label: "Open", action_id: SHIPPING_ACTIONS.open },
	};
}

/** A hidden single-option carrier (the scaffold's proven pattern, e.g.
 *  `tax-page.ts`'s `hiddenCarrier`) that threads one value through a
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

// -- level 0: shipping zones ---------------------------------------------------

function zonesLevel() {
	return listLevel<AdminRulesClient, Record<string, never>, ShippingZoneWire>({
		// No service-side pagination on the zones registry (`GET
		// /admin/shipping/zones` returns the full list) — same small-registry
		// shape as the Tax console's classes level.
		limit: 200,
		filterFromValues: () => ({}),
		async fetchPage(client) {
			const zones = await client.listZones();
			return { items: zones, nextCursor: null };
		},
		render({ actions, items, notice }) {
			return zonesBlocks(actions, items, notice);
		},
		onError: () => zonesFailClosed(),
	});
}

function zonesBlocks(
	actions: ScreenActions,
	zones: ShippingZoneWire[],
	notice: Notice | undefined,
): Block[] {
	const table: TableBlock = {
		type: "table",
		columns: [
			{ key: "id", label: "Zone ID", format: "code" },
			{ key: "name", label: "Name" },
			{ key: "regions", label: "Regions" },
		],
		rows: zones.map((z) => ({ id: z.id, name: z.name, regions: regionsSummary(z.regions) })),
		page_action_id: actions.page, // never fires: the registry has no paging
		empty_text: "No shipping zones yet — create one below.",
	};
	const blocks: Block[] = [
		{ type: "header", text: "Shipping zones" },
		{
			type: "context",
			text: "A zone groups the shipping methods you offer for a set of destinations. Regions are a plain reference list (e.g. country codes) for your own bookkeeping — checkout does not yet auto-match a buyer's address to a zone; the zone is selected explicitly by id. Deleting a zone is blocked while it still has shipping methods — delete those first.",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push(table);
	if (zones.length > 0) {
		blocks.push(
			openTargetForm(
				"Open zone",
				zones.map((z) => ({ value: encodePath([z.id]), label: `${z.name} (${z.id})` })),
			),
		);
	}
	blocks.push({ type: "divider" });
	blocks.push(createZoneForm());
	for (const zone of zones) {
		blocks.push({ type: "divider" });
		blocks.push(editZoneForm(zone));
		blocks.push(deleteZoneActions(zone));
	}
	return blocks;
}

function createZoneForm(): FormBlock {
	return {
		type: "form",
		fields: [
			{ type: "text_input", action_id: "id", label: "Zone ID", placeholder: "e.g. us" },
			{ type: "text_input", action_id: "name", label: "Name", placeholder: "e.g. United States" },
			{
				type: "text_input",
				action_id: "regions",
				label: "Regions (comma-separated, blank = none)",
				placeholder: "e.g. US",
			},
		],
		submit: { label: "Create zone", action_id: ACTION_CREATE_ZONE },
	};
}

/** Full-replace edit (LWW, no CAS — a zone carries no money): the form always
 *  submits BOTH `name` and `regions`, pre-filled from the loaded row, so an
 *  edit can never silently omit `regions` (the service 400s an omitted key —
 *  `AdminRulesClient.updateZone`'s doc). */
function editZoneForm(zone: ShippingZoneWire): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("zoneId", zone.id),
			{
				type: "text_input",
				action_id: "name",
				label: `Name for ${zone.id}`,
				initial_value: zone.name,
			},
			{
				type: "text_input",
				action_id: "regions",
				label: "Regions (comma-separated, blank = none)",
				initial_value: formatRegionsForInput(zone.regions),
			},
		],
		submit: { label: `Save ${zone.id}`, action_id: ACTION_SAVE_ZONE },
	};
}

function deleteZoneActions(zone: ShippingZoneWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_ZONE,
		label: `Delete ${zone.id}`,
		style: "danger",
		value: { zoneId: zone.id },
		confirm: {
			title: `Delete zone ${zone.id}?`,
			text: "This only works while the zone has no shipping methods — delete those first if this fails. This cannot be undone.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions", elements: [button] };
}

function zonesFailClosed() {
	return failClosedResponse({
		header: "Shipping zones",
		title: "Shipping zones are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load shipping zones",
	});
}

// -- level 1: a zone's shipping methods -----------------------------------------

function methodsLevel() {
	return listLevel<AdminRulesClient, Record<string, never>, ShippingMethodWire>({
		limit: 200,
		filterFromValues: () => ({}),
		async fetchPage(client, path) {
			const zoneId = path[0];
			if (zoneId === undefined) return { items: [], nextCursor: null };
			const methods = await client.listMethods(zoneId);
			return { items: methods, nextCursor: null };
		},
		render({ actions, path, items, notice }) {
			const zoneId = path[0] ?? "";
			return methodsBlocks(actions, zoneId, items, notice);
		},
		onError: () => methodsFailClosed(),
	});
}

function methodsBlocks(
	actions: ScreenActions,
	zoneId: string,
	methods: ShippingMethodWire[],
	notice: Notice | undefined,
): Block[] {
	const table: TableBlock = {
		type: "table",
		columns: [
			{ key: "id", label: "Method ID", format: "code" },
			{ key: "name", label: "Name" },
			{ key: "type", label: "Type", format: "badge" },
		],
		rows: methods.map((m) => ({ id: m.id, name: m.name, type: m.type })),
		page_action_id: actions.page, // never fires: no paging at this level
		empty_text: "No shipping methods yet for this zone.",
	};
	const blocks: Block[] = [
		{ type: "header", text: `Shipping methods — ${zoneId}` },
		backButton(actions.back, "← Back to zones", [zoneId]),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({
		type: "context",
		text: '"flat_rate" always charges its rate; "free_shipping" charges its rate only BELOW the rate\'s minimum-subtotal threshold (0 above it, or always if no threshold is set) — configure the price on the method\'s rates. Deleting a method is blocked while it still has rates; delete those first.',
	});
	blocks.push(table);
	if (methods.length > 0) {
		blocks.push(
			openTargetForm(
				"Open method",
				methods.map((m) => ({
					value: encodePath([zoneId, m.id]),
					label: `${m.name} (${m.id})`,
				})),
			),
		);
	}
	blocks.push({ type: "divider" });
	blocks.push(createMethodForm(zoneId));
	for (const method of methods) {
		blocks.push({ type: "divider" });
		blocks.push(editMethodForm(zoneId, method));
		blocks.push(deleteMethodActions(zoneId, method));
	}
	return blocks;
}

function methodTypeField(actionId: string, initial: string): FormBlock["fields"][number] {
	const options: SelectOption[] = [
		{ value: "flat_rate", label: "Flat rate" },
		{ value: "free_shipping", label: "Free shipping (threshold-based)" },
	];
	return { type: "select", action_id: actionId, label: "Type", options, initial_value: initial };
}

function createMethodForm(zoneId: string): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("zoneId", zoneId),
			{ type: "text_input", action_id: "id", label: "Method ID", placeholder: "e.g. standard" },
			{
				type: "text_input",
				action_id: "name",
				label: "Name",
				placeholder: "e.g. Standard shipping",
			},
			methodTypeField("type", "flat_rate"),
		],
		submit: { label: "Add method", action_id: ACTION_CREATE_METHOD },
	};
}

function editMethodForm(zoneId: string, method: ShippingMethodWire): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("zoneId", zoneId),
			hiddenCarrier("methodId", method.id),
			{
				type: "text_input",
				action_id: "name",
				label: `Name for ${method.id}`,
				initial_value: method.name,
			},
			methodTypeField("type", method.type),
		],
		submit: { label: `Save ${method.id}`, action_id: ACTION_SAVE_METHOD },
	};
}

function deleteMethodActions(zoneId: string, method: ShippingMethodWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_METHOD,
		label: `Delete ${method.id}`,
		style: "danger",
		value: { zoneId, methodId: method.id },
		confirm: {
			title: `Delete method ${method.id}?`,
			text: "This only works while the method has no rates — delete those first if this fails. This cannot be undone.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions", elements: [button] };
}

function methodsFailClosed() {
	return failClosedResponse({
		header: "Shipping methods",
		title: "Shipping methods are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load shipping methods",
	});
}

// -- level 2: a method's rates (currency-keyed) ---------------------------------

function ratesLevel() {
	return listLevel<AdminRulesClient, RatesFilterForm, ShippingRateWire>({
		limit: 1, // a rate is keyed by (methodId, currency) — at most one row per filter
		filterFromValues(values) {
			const currency = readString(values.currency)?.trim().toUpperCase();
			return {
				currency: currency !== undefined && currency.length > 0 ? currency : DEFAULT_RATE_CURRENCY,
			};
		},
		async fetchPage(client, path, filter) {
			const methodId = path[1];
			if (methodId === undefined) return { items: [], nextCursor: null };
			const rate = await client.getRate(methodId, filter.currency);
			return { items: rate === null ? [] : [rate], nextCursor: null };
		},
		render({ actions, path, filter, items, notice }) {
			const zoneId = path[0] ?? "";
			const methodId = path[1] ?? "";
			return ratesBlocks(actions, zoneId, methodId, filter, items, notice);
		},
		onError: () => ratesFailClosed(),
	});
}

function ratesBlocks(
	actions: ScreenActions,
	zoneId: string,
	methodId: string,
	filter: RatesFilterForm,
	rows: ShippingRateWire[],
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: `Shipping rates — ${methodId}` },
		backButton(actions.back, "← Back to methods", [zoneId, methodId]),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({
		type: "context",
		text: "A rate is keyed by currency — one method can price differently per currency. Money shown as exact integer minor units, never a float. Deleting a rate only affects future carts: in-flight carts recompute at their next quote/checkout, and orders already placed keep the shipping fee they were charged at purchase time.",
	});
	blocks.push(currencyFilterForm(filter));
	blocks.push(ratesTable(actions, rows));
	blocks.push({ type: "divider" });
	blocks.push(createRateForm(zoneId, methodId, filter));
	for (const row of rows) {
		blocks.push({ type: "divider" });
		blocks.push(editRateForm(zoneId, methodId, row));
		blocks.push(deleteRateActions(zoneId, methodId, row));
	}
	return blocks;
}

function currencyFilterForm(filter: RatesFilterForm): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "text_input",
				action_id: "currency",
				label: "Currency (ISO-4217, e.g. USD)",
				initial_value: filter.currency,
			},
		],
		submit: { label: "Look up rate", action_id: SHIPPING_ACTIONS.applyFilter },
	};
}

function ratesTable(actions: ScreenActions, rows: ShippingRateWire[]): TableBlock {
	return {
		type: "table",
		columns: [
			{ key: "currency", label: "Currency", format: "code" },
			{ key: "amount", label: "Amount" },
			{ key: "minSubtotal", label: "Free-shipping threshold" },
		],
		rows: rows.map((r) => ({
			currency: r.currency,
			amount: formatCentsForDisplay(r.amountCents, r.currency),
			minSubtotal:
				r.minSubtotalCents === null
					? "No minimum"
					: formatCentsForDisplay(r.minSubtotalCents, r.currency),
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no paging
		empty_text: "No rate configured yet for this currency — add one below.",
	};
}

function createRateForm(zoneId: string, methodId: string, filter: RatesFilterForm): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("zoneId", zoneId),
			hiddenCarrier("methodId", methodId),
			{
				type: "text_input",
				action_id: "currency",
				label: "Currency (ISO-4217, e.g. USD)",
				initial_value: filter.currency,
			},
			{
				type: "text_input",
				action_id: "amount",
				label: "Amount (up to 2 decimals, e.g. 4.99 — 0 is allowed)",
				placeholder: "4.99",
			},
			{
				type: "text_input",
				action_id: "minSubtotal",
				label: "Free-shipping threshold (blank = none)",
				placeholder: "35.00",
			},
		],
		submit: { label: "Add rate", action_id: ACTION_CREATE_RATE },
	};
}

/**
 * The per-rate edit form (CAS on `amountCents`): `expectedAmountCents` rides
 * along as a hidden carrier holding the value THIS render loaded — a
 * concurrent edit that changed it in the meantime loses the CAS and the
 * reloaded list shows the fresh value with a "reload" notice, never a silent
 * clobber. `minSubtotalCents` is required-nullable on the wire, so the form
 * always submits it (blank ⇒ explicit clear).
 */
function editRateForm(zoneId: string, methodId: string, row: ShippingRateWire): FormBlock {
	return {
		type: "form",
		fields: [
			hiddenCarrier("zoneId", zoneId),
			hiddenCarrier("methodId", methodId),
			hiddenCarrier("currency", row.currency),
			hiddenCarrier("expectedAmountCents", String(row.amountCents)),
			{
				type: "text_input",
				action_id: "amount",
				label: `Amount for ${row.currency} (up to 2 decimals)`,
				initial_value: formatMinorUnitsInput(row.amountCents),
			},
			{
				type: "text_input",
				action_id: "minSubtotal",
				label: "Free-shipping threshold (blank = none)",
				...(row.minSubtotalCents !== null
					? { initial_value: formatMinorUnitsInput(row.minSubtotalCents) }
					: {}),
			},
		],
		submit: { label: `Save ${row.currency} rate`, action_id: ACTION_SAVE_RATE },
	};
}

function deleteRateActions(zoneId: string, methodId: string, row: ShippingRateWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_RATE,
		label: `Delete ${row.currency} rate`,
		style: "danger",
		value: { zoneId, methodId, currency: row.currency },
		confirm: {
			title: `Delete the ${row.currency} rate for ${methodId}?`,
			text: "In-flight carts recompute their shipping without this rate the next time they're touched. Orders already placed are unaffected — an order snapshots the shipping fee it was charged at purchase time.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions", elements: [button] };
}

function ratesFailClosed() {
	return failClosedResponse({
		header: "Shipping rates",
		title: "Shipping rates are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load shipping rates",
	});
}

// -- regions (opaque, string[]-or-null) helpers ---------------------------------

/** Parse the comma-separated regions text input into the wire's `string[] |
 *  null` — blank ⇒ `null` (an explicit clear on edit; simply "no regions" on
 *  create). Never throws: any token that trims to empty is dropped. */
function parseRegionsInput(raw: string): string[] | null {
	const parts = raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return parts.length > 0 ? parts : null;
}

/** Pre-fill the regions text input from whatever the wire returned — only a
 *  `string[]` round-trips to a comma list; anything else (a legacy shape, or
 *  simply absent) renders blank rather than guessing. */
function formatRegionsForInput(regions: unknown): string {
	if (Array.isArray(regions) && regions.every((r): r is string => typeof r === "string")) {
		return regions.join(", ");
	}
	return "";
}

/** The zones-list column summary — honest about non-array/absent shapes
 *  rather than silently rendering "—" for a legacy non-array value. */
function regionsSummary(regions: unknown): string {
	if (Array.isArray(regions)) {
		return regions.length > 0 ? regions.join(", ") : "— (none)";
	}
	if (regions === null || regions === undefined) return "— (none)";
	return typeof regions === "string" ? regions : JSON.stringify(regions);
}

// -- money input parsing (NO float arithmetic — CLAUDE.md) ----------------------
// The exact-integer-string parse/format pair lives in `./money-input.js`,
// SHARED with the Products console; the one behavioral fork (whether zero is
// a valid amount) is that module's explicit `allowZero` parameter. This thin
// wrapper pins the Shipping screens' choice — ZERO is accepted (a $0 flat
// rate, or a free-shipping method's below-threshold fallback, are both
// legitimate; the service's own `shippingRateBody`/`shippingRateUpdateBody`
// schemas use `nonnegative()`, not `positive()`) — in one place instead of at
// every call site.

/** Parse a merchant-entered decimal amount into integer minor units; null
 *  for any non-conforming or NEGATIVE input (never throws). */
function parseAmountInput(input: string): number | null {
	return parseMinorUnitsInput(input, { allowZero: true });
}

/** Display-format (with currency symbol) for the rates table — falls back to
 *  a plain `CUR amount` string if `Intl`/the branding constructors reject the
 *  wire value (never throws into the render path). */
function formatCentsForDisplay(minorUnits: number, currencyCode: string): string {
	try {
		return formatMoney(toCents(minorUnits), toCurrency(currencyCode), "en-US");
	} catch {
		return `${currencyCode} ${formatMinorUnitsInput(minorUnits)}`;
	}
}

// -- custom action: create a zone ------------------------------------------------

function createZoneAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const id = (readString(values.id) ?? "").trim();
		const name = (readString(values.name) ?? "").trim();
		if (id.length === 0 || name.length === 0) {
			return showList(undefined, {
				variant: "error",
				title: "Zone not created",
				description: "Enter both a zone ID and a name.",
			});
		}
		const regions = parseRegionsInput(readString(values.regions) ?? "");
		const result = await client.createZone({ id, name, regions });
		return showList(undefined, createZoneNotice(result, id, name));
	});
}

function createZoneNotice(
	result: RulesCreateResult<ShippingZoneWire>,
	id: string,
	name: string,
): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Zone created",
			description: `"${name}" (${id}) was added.`,
		};
	}
	return {
		variant: "error",
		title: "Zone not created",
		description: `Could not create "${id}" — check the zone ID isn't already in use, then try again.`,
	};
}

// -- custom action: edit a zone (LWW) ---------------------------------------------

function saveZoneAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const zoneId = readString(values.zoneId);
		if (zoneId === undefined) return showList();
		const name = (readString(values.name) ?? "").trim();
		if (name.length === 0) {
			return showList(undefined, {
				variant: "error",
				title: "Zone not saved",
				description: "Name cannot be blank.",
			});
		}
		const regions = parseRegionsInput(readString(values.regions) ?? "");
		const result = await client.updateZone(zoneId, { name, regions });
		return showList(undefined, saveZoneNotice(result));
	});
}

function saveZoneNotice(result: RulesUpdateResult<ShippingZoneWire>): Notice {
	if (result.ok) {
		return { variant: "default", title: "Zone saved", description: "The zone was updated." };
	}
	if (result.reason === "not_found") {
		return {
			variant: "error",
			title: "Zone not found",
			description: "This zone no longer exists — it may have already been deleted.",
		};
	}
	return {
		variant: "error",
		title: "Zone not saved",
		description:
			"The change could not be saved — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: delete a zone (forbid-if-methods) ------------------------------

function deleteZoneAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const payload = asRecord(input.value);
		const zoneId = readString(payload?.zoneId);
		if (zoneId === undefined) return showList();
		const result = await client.deleteZone(zoneId);
		return showList(undefined, deleteZoneNotice(result));
	});
}

function deleteZoneNotice(result: RulesDeleteResult): Notice {
	if (result.ok) {
		return { variant: "default", title: "Zone deleted", description: "The zone was removed." };
	}
	if (result.reason === "not_found") {
		return {
			variant: "default",
			title: "Already deleted",
			description: "This zone was already removed.",
		};
	}
	if (result.reason === "in_use") {
		return {
			variant: "error",
			title: "Zone not deleted",
			description: "This zone still has shipping methods — delete its methods first, then retry.",
		};
	}
	return {
		variant: "error",
		title: "Zone not deleted",
		description:
			"The zone could not be deleted — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: create a method -----------------------------------------------

function createMethodAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const zoneId = readString(values.zoneId);
		if (zoneId === undefined) return showList();
		const id = (readString(values.id) ?? "").trim();
		const name = (readString(values.name) ?? "").trim();
		const type = readString(values.type) ?? "";
		if (
			id.length === 0 ||
			name.length === 0 ||
			(type !== "flat_rate" && type !== "free_shipping")
		) {
			return showList([zoneId], {
				variant: "error",
				title: "Method not created",
				description: "Enter a method ID, a name, and a valid type.",
			});
		}
		const result = await client.createMethod(zoneId, { id, name, type });
		return showList([zoneId], createMethodNotice(result, id, name));
	});
}

function createMethodNotice(
	result: RulesCreateResult<ShippingMethodWire>,
	id: string,
	name: string,
): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Method created",
			description: `"${name}" (${id}) was added.`,
		};
	}
	return {
		variant: "error",
		title: "Method not created",
		description: `Could not create "${id}" — check the method ID isn't already in use, then try again.`,
	};
}

// -- custom action: edit a method (LWW) --------------------------------------------

function saveMethodAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const zoneId = readString(values.zoneId);
		const methodId = readString(values.methodId);
		if (zoneId === undefined || methodId === undefined) return showList();
		const name = (readString(values.name) ?? "").trim();
		const type = readString(values.type) ?? "";
		if (name.length === 0 || (type !== "flat_rate" && type !== "free_shipping")) {
			return showList([zoneId], {
				variant: "error",
				title: "Method not saved",
				description: "Enter a name and a valid type.",
			});
		}
		const result = await client.updateMethod(methodId, { name, type });
		return showList([zoneId], saveMethodNotice(result));
	});
}

function saveMethodNotice(result: RulesUpdateResult<ShippingMethodWire>): Notice {
	if (result.ok) {
		return { variant: "default", title: "Method saved", description: "The method was updated." };
	}
	if (result.reason === "not_found") {
		return {
			variant: "error",
			title: "Method not found",
			description: "This method no longer exists — it may have already been deleted.",
		};
	}
	return {
		variant: "error",
		title: "Method not saved",
		description:
			"The change could not be saved — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: delete a method (forbid-if-rates) -------------------------------

function deleteMethodAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const payload = asRecord(input.value);
		const zoneId = readString(payload?.zoneId);
		const methodId = readString(payload?.methodId);
		if (zoneId === undefined || methodId === undefined) return showList();
		const result = await client.deleteMethod(methodId);
		return showList([zoneId], deleteMethodNotice(result));
	});
}

function deleteMethodNotice(result: RulesDeleteResult): Notice {
	if (result.ok) {
		return { variant: "default", title: "Method deleted", description: "The method was removed." };
	}
	if (result.reason === "not_found") {
		return {
			variant: "default",
			title: "Already deleted",
			description: "This method was already removed.",
		};
	}
	if (result.reason === "in_use") {
		return {
			variant: "error",
			title: "Method not deleted",
			description: "This method still has rates — delete its rates first, then retry.",
		};
	}
	return {
		variant: "error",
		title: "Method not deleted",
		description:
			"The method could not be deleted — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: create a rate ---------------------------------------------------

function createRateAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const zoneId = readString(values.zoneId);
		const methodId = readString(values.methodId);
		if (zoneId === undefined || methodId === undefined) return showList();
		const currency = (readString(values.currency) ?? "").trim().toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency)) {
			return showList([zoneId, methodId], {
				variant: "error",
				title: "Rate not created",
				description: "Currency must be a 3-letter ISO-4217 code like USD.",
			});
		}
		const amountCents = parseAmountInput(readString(values.amount) ?? "");
		if (amountCents === null) {
			return showList([zoneId, methodId], {
				variant: "error",
				title: "Rate not created",
				description: "Amount must be 0 or a positive number like 4.99 (up to two decimal places).",
			});
		}
		const minSubtotalRaw = (readString(values.minSubtotal) ?? "").trim();
		let minSubtotalCents: number | null = null;
		if (minSubtotalRaw.length > 0) {
			minSubtotalCents = parseAmountInput(minSubtotalRaw);
			if (minSubtotalCents === null) {
				return showList([zoneId, methodId], {
					variant: "error",
					title: "Rate not created",
					description:
						"Free-shipping threshold must be 0 or a positive number like 35.00, or blank for none.",
				});
			}
		}
		const result = await client.createRate(methodId, { currency, amountCents, minSubtotalCents });
		return showList([zoneId, methodId], createRateNotice(result, currency));
	});
}

function createRateNotice(result: RulesCreateResult<ShippingRateWire>, currency: string): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Rate created",
			description: `The ${currency} rate was added.`,
		};
	}
	return {
		variant: "error",
		title: "Rate not created",
		description: `Could not create a ${currency} rate — check a rate for this currency doesn't already exist, then try again.`,
	};
}

// -- custom action: edit a rate (CAS on amountCents) ---------------------------------

function saveRateAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const zoneId = readString(values.zoneId);
		const methodId = readString(values.methodId);
		const currency = readString(values.currency);
		const expectedAmountCentsRaw = readString(values.expectedAmountCents);
		if (
			zoneId === undefined ||
			methodId === undefined ||
			currency === undefined ||
			expectedAmountCentsRaw === undefined
		) {
			return showList();
		}
		const expectedAmountCents = Number.parseInt(expectedAmountCentsRaw, 10);
		const amountCents = parseAmountInput(readString(values.amount) ?? "");
		if (amountCents === null) {
			return showList([zoneId, methodId], {
				variant: "error",
				title: "Rate not saved",
				description: "Amount must be 0 or a positive number like 4.99 (up to two decimal places).",
			});
		}
		const minSubtotalRaw = (readString(values.minSubtotal) ?? "").trim();
		let minSubtotalCents: number | null = null;
		if (minSubtotalRaw.length > 0) {
			minSubtotalCents = parseAmountInput(minSubtotalRaw);
			if (minSubtotalCents === null) {
				return showList([zoneId, methodId], {
					variant: "error",
					title: "Rate not saved",
					description:
						"Free-shipping threshold must be 0 or a positive number like 35.00, or blank for none.",
				});
			}
		}
		const result = await client.updateRate(methodId, currency, {
			amountCents,
			minSubtotalCents,
			expectedAmountCents,
		});
		return showList([zoneId, methodId], saveRateNotice(result));
	});
}

function saveRateNotice(result: RulesCasUpdateResult<ShippingRateWire>): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Rate saved",
			description: "The shipping rate was updated.",
		};
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
			description: "This shipping rate no longer exists — it may have already been deleted.",
		};
	}
	return {
		variant: "error",
		title: "Rate not saved",
		description:
			"The change could not be saved — check the service connection and the admin token in Settings.",
	};
}

// -- custom action: delete a rate ------------------------------------------------------

function deleteRateAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const payload = asRecord(input.value);
		const zoneId = readString(payload?.zoneId);
		const methodId = readString(payload?.methodId);
		const currency = readString(payload?.currency);
		if (zoneId === undefined || methodId === undefined || currency === undefined) return showList();
		const result = await client.deleteRate(methodId, currency);
		return showList([zoneId, methodId], deleteRateNotice(result));
	});
}

function deleteRateNotice(result: RulesDeleteResult): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Rate deleted",
			description: "The shipping rate was removed.",
		};
	}
	if (result.reason === "not_found") {
		return {
			variant: "default",
			title: "Already deleted",
			description: "This shipping rate was already removed.",
		};
	}
	return {
		variant: "error",
		title: "Rate not deleted",
		description:
			"The rate could not be deleted — check the service connection and the admin token in Settings.",
	};
}
