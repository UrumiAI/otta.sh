import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	AccordionBlock,
	ActionsBlock,
	AdminPageConfig,
	Block,
	ButtonElement,
	FieldsBlock,
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
	carriedForm,
	createListDetailHandler,
	customAction,
	decodePath,
	emptyState,
	encodePath,
	failClosedResponse,
	filterSummary,
	listLevel,
	noticeBanner,
	PATH_FIELD,
	readAdminTokens,
	readString,
	screenActions,
	type ListDetailInput,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Shipping console page (design spec §12.4 — the deepest of the
 * seven admin screens, drilling zones → methods → rates). Built on the shared
 * list/detail scaffold (`./scaffold`) and `AdminRulesClient`, both already
 * proven by `orders-page.ts`/`tax-page.ts` — this is the FIRST production
 * screen to actually reach depth 3 (the scaffold's own synthetic geo fixture,
 * `scaffold/testing/geo-screen.ts`, is what proved the N-level nav core works
 * before any real screen needed it).
 *
 * L-9: the zones and methods levels render as a per-row `accordion` list
 * (edit form + "View …" drill-in button + delete, all collapsed) ONLY when
 * the fetched page is complete (`nextCursor === null`) AND `items.length <=
 * 25` — otherwise a `table` + a standalone `combobox` drill-in form (L-7),
 * with editing moving to the next level's list. Both branches ship; the
 * sandbox suite asserts the branch at 25 rows and at 26. The zones/methods
 * registries have no real cursor pagination (`AdminRulesClient.listZones`/
 * `listMethods` return everything in one GET), so in practice `nextCursor` is
 * always `null` and the branch is decided by row count alone.
 *
 * L-9a: the RATES level is EXEMPT. A rate's identity is `(methodId,
 * currency)` and the service exposes only a single-currency `GET
 * .../rates?currency=` read — a 0-or-1-row lookup, never a true list — so one
 * accordion wrapping one row would cost a click and save nothing. It keeps
 * its existing inline `fields` + edit-or-create form shape.
 *
 * REGIONS, presented honestly: `ShippingZone.regions` is opaque config the
 * pricing engine never reads (`@otta-sh/domain`'s `ShippingRulesStore` doc:
 * "opaque config the engine never reads") — checkout/quote takes an explicit
 * `shippingZoneId`, not an address-to-zone match. That fact does not fit the
 * zones level's ≤140-char page context, so it lives as one `context` line
 * inside the "New zone" create group instead (F-8) — the one place an
 * operator is about to type into the field it explains.
 *
 * NO METHOD/RATE COUNT ON A ZONE OR METHOD LABEL (D-6): `ShippingZoneWire` is
 * `{id, name, regions}` and `ShippingMethodWire` carries no rate count either
 * — neither is on the wire, and fetching it per row would cost up to 200
 * extra `ctx.http` round trips per render at this level's `limit: 200`. Filed
 * as a listing gap (§12.4 shows a bare-noun zone label for exactly this
 * reason already); the PER-ROW DELETE-vs-DA-7 conditional the listing also
 * shows has the same defect and is NOT built for the same reason — see the
 * module's PR body for the full disclosure. Delete stays unconditional (DA-2)
 * and the existing "in_use" conflict is reported by the post-attempt banner,
 * exactly as it already was before this layout pass.
 *
 * THE PRICE IS THE ONE EXCEPTION TO THAT, AND IT IS PAID FOR DELIBERATELY.
 * A method's price is not on `ShippingMethodWire` either, and the service
 * exposes no cross-method rates read — only `GET
 * /admin/shipping/methods/:id/rates?currency=`, a 0-or-1-row lookup. So the
 * methods list used to name a method and its type and never the number the
 * operator came for: you could not see what express costs without drilling two
 * levels down. Unlike a rate COUNT (which nothing can price against), the
 * amount IS the screen's subject, so it is fetched — bounded and honestly:
 *
 *   - ONE `getRate` per method, in parallel, and ONLY on the L-9 accordion
 *     branch, so the fan-out can never exceed 25 (past that the level renders
 *     the table branch, which shows no price and fires no rate reads at all).
 *   - Each lookup is SECONDARY and independently contained: a failed one
 *     degrades that row to "Price unavailable" and never fails the level —
 *     the method list is the primary read, and losing the rates surface must
 *     not blank a screen whose other affordances still work.
 *   - A missing rate renders "No rate set", NEVER "Free" and never a zero
 *     amount. A free_shipping method with no rate row costs the buyer nothing
 *     to see here, but it is also not configured, and the two must not look
 *     alike.
 *
 * A rate is keyed by (methodId, currency), so a price cannot be read without
 * naming a currency: the methods level therefore carries the SAME currency
 * filter its rates level already had, defaulting to `DEFAULT_RATE_CURRENCY`,
 * and states that currency ONCE in the level's context line rather than per
 * row (G1). The two filters are independent — drilling in re-opens the rates
 * level at its own default, as every level's filter already resets on a
 * drill-in or a write (the engine re-lists with `filterFromValues({})`).
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
const ACTION_OPEN_CREATE_ZONE = SHIPPING_ACTIONS.custom("open-create-zone");
const ACTION_CREATE_METHOD = SHIPPING_ACTIONS.custom("create-method");
const ACTION_SAVE_METHOD = SHIPPING_ACTIONS.custom("save-method");
const ACTION_DELETE_METHOD = SHIPPING_ACTIONS.custom("delete-method");
const ACTION_OPEN_CREATE_METHOD = SHIPPING_ACTIONS.custom("open-create-method");
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
	"open-create-zone",
	"create-method",
	"save-method",
	"delete-method",
	"open-create-method",
	"create-rate",
	"save-rate",
	"delete-rate",
);

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type ShippingPageInput = ListDetailInput;

/**
 * What a custom action asks the zones/methods levels to render NOW, beyond
 * the notice banner — spec E-2/B-6's "empty state's create action forces the
 * create group open". Nothing else on this screen needs the channel: every
 * other write is DA-4 (one-shot) or DA-2 (unconditional delete), and an
 * ordinary create-form validation error stays visible via B-5 (the operator
 * had to have the group open to submit into it, and its `block_id` does not
 * change on that path) without needing to force anything.
 */
type ShippingRenderState = { kind: "zone-create-open" } | { kind: "method-create-open" };

/** The rates level's filter: a currency narrow that ALWAYS has a value (no
 *  "unfiltered" state exists — see the module doc's rates-identity note).
 *  Defaults to `"USD"`. The methods level carries the same shape, for the same
 *  reason: a rate is keyed by (methodId, currency), so neither level can name
 *  a price without naming a currency. */
interface RatesFilterForm {
	currency: string;
}

const DEFAULT_RATE_CURRENCY = "USD";

/** Read the currency filter off a submitted filter form — shared by the
 *  methods and rates levels so the two can never disagree about what an empty
 *  or whitespace value means (it means the default, never `""`). */
function currencyFromValues(values: Record<string, unknown>): RatesFilterForm {
	const currency = readString(values.currency)?.trim().toUpperCase();
	return {
		currency: currency !== undefined && currency.length > 0 ? currency : DEFAULT_RATE_CURRENCY,
	};
}

/** ISO-4217's shape. Not a membership test — the service owns the real code
 *  list; this only separates "a currency the store may not price in" from
 *  "not a currency code at all". */
const CURRENCY_CODE_SHAPE = /^[A-Z]{3}$/;

/**
 * The methods level's filter: the shared currency parse plus a validity flag.
 * The flag exists because this level spends a READ PER ROW on the filter
 * value: a typo would otherwise fire up to 25 requests that are all going to
 * fail, and then paint the whole list "Price unavailable" — blaming the
 * service for the operator's `usd ` fat-finger. Invalid ⇒ read nothing, price
 * nothing, and say which of the two it is.
 *
 * Kept OFF the rates level on purpose: that level passes the operator's
 * currency straight to a single read whose failure is already visible and
 * already correctly attributed, and silently substituting a default there
 * would turn a typo into a wrong answer rather than an error.
 */
interface MethodsFilterForm {
	/** Trimmed and upper-cased; the default when the field was blank. */
	currency: string;
	/** `currency` is not a 3-letter ISO-4217 shape. */
	invalid: boolean;
}

function methodsFilterFromValues(values: Record<string, unknown>): MethodsFilterForm {
	const { currency } = currencyFromValues(values);
	return { currency, invalid: !CURRENCY_CODE_SHAPE.test(currency) };
}

const BAD_CURRENCY_NOTICE: Notice = {
	variant: "error",
	title: "Prices not shown",
	description: "Enter a 3-letter currency code like USD.",
};

/** L-7's "nothing selected yet" sentinel — never `""` (F-6a/X-23: a `select`/
 *  `combobox` option value must never be the empty string). */
const NONE = "none";

/** A registry level renders as a per-row accordion list (L-9) only when the
 *  fetched page is complete and small; otherwise table + drill-in. */
function isRegistryAccordion(nextToken: string | undefined, itemCount: number): boolean {
	return nextToken === undefined && itemCount <= 25;
}

export function createShippingPageHandler(): RouteHandler<ShippingPageInput> {
	return createListDetailHandler<ShippingRenderState>({
		actions: SHIPPING_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminRulesClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// The zones level's per-row "View methods" BUTTON and the methods
		// level's per-row "View rates" BUTTON (§12.7) carry the FULL encoded
		// target path in `value.target` — a button carries no `block_id` (B-1),
		// so `parseOpen` must read `input.value?.target`. The L-9 FALLBACK
		// tables' standalone combobox drill-in (L-7) instead fires a
		// `form_submit`, whose target rides in `input.values.target`. One
		// `parseOpen` resolves either, at any depth.
		parseOpen(input) {
			const encoded = readString(asRecord(input.value)?.target) ?? readString(input.values?.target);
			if (encoded === undefined) return undefined;
			const targetPath = decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [zonesLevel(), methodsLevel(), ratesLevel()],
		customActions: {
			[ACTION_CREATE_ZONE]: createZoneAction(),
			[ACTION_SAVE_ZONE]: saveZoneAction(),
			[ACTION_DELETE_ZONE]: deleteZoneAction(),
			[ACTION_OPEN_CREATE_ZONE]: openCreateZoneAction(),
			[ACTION_CREATE_METHOD]: createMethodAction(),
			[ACTION_SAVE_METHOD]: saveMethodAction(),
			[ACTION_DELETE_METHOD]: deleteMethodAction(),
			[ACTION_OPEN_CREATE_METHOD]: openCreateMethodAction(),
			[ACTION_CREATE_RATE]: createRateAction(),
			[ACTION_SAVE_RATE]: saveRateAction(),
			[ACTION_DELETE_RATE]: deleteRateAction(),
		},
	});
}

// -- level 0: shipping zones ---------------------------------------------------

function zonesLevel() {
	return listLevel<AdminRulesClient, Record<string, never>, ShippingZoneWire, ShippingRenderState>({
		// No service-side pagination on the zones registry (`GET
		// /admin/shipping/zones` returns the full list) — same small-registry
		// shape as the Tax console's classes level.
		limit: 200,
		filterFromValues: () => ({}),
		async fetchPage(client) {
			const zones = await client.listZones();
			return { items: zones, nextCursor: null };
		},
		render({ items, nextToken, notice, renderState }) {
			return zonesBlocks(items, nextToken, notice, renderState);
		},
		onError: () => zonesFailClosed(),
	});
}

function zonesBlocks(
	zones: ShippingZoneWire[],
	nextToken: string | undefined,
	notice: Notice | undefined,
	renderState: ShippingRenderState | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Shipping zones" },
		{
			type: "context",
			text: "A zone groups the shipping methods you offer for a set of destinations.",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));

	const forceCreateOpen = renderState?.kind === "zone-create-open";
	if (zones.length === 0) {
		// E-2/B-6: the empty state's OWN create action re-renders THIS SAME
		// zero-row response with the create group forced open — so at zero rows
		// AND a force-open request, the create group replaces the `empty` block
		// rather than being shadowed by it (the whole point of clicking the
		// empty state's action would otherwise be silently lost).
		if (forceCreateOpen) {
			blocks.push(newZoneAccordion(true));
			return blocks;
		}
		blocks.push(
			emptyState({
				title: "No shipping zones yet",
				description:
					"Create a zone to start grouping the shipping methods you offer by destination.",
				size: "base",
				actions: [{ type: "button", action_id: ACTION_OPEN_CREATE_ZONE, label: "New zone" }],
			}),
		);
		return blocks;
	}

	if (isRegistryAccordion(nextToken, zones.length)) {
		for (const zone of zones) blocks.push(zoneAccordion(zone));
	} else {
		blocks.push(zonesFallbackTable(zones));
		blocks.push(openZoneForm(zones));
	}
	blocks.push(newZoneAccordion(forceCreateOpen));
	return blocks;
}

/** One zone's per-row group (L-9): edit form, the "View methods" drill-in
 *  (§12.7), and delete — all collapsed (L-9's own "zero open groups" rule). */
function zoneAccordion(zone: ShippingZoneWire): AccordionBlock {
	return {
		type: "accordion",
		label: `${zone.id} — ${zone.name}`,
		default_open: false,
		// A PLAIN key, not a minted carrier: this accordion never echoes
		// `block_id` back (only `form`/`table` do — B-1), so there is nothing to
		// decode. `zone.id` is the zone's own unique id, safe to interpolate
		// directly — unlike `encodeCarrier`'s NAMESPACE argument, which must stay
		// a constant literal (CLAUDE.md's carrier-namespace trap), a plain key is
		// just a string with no grammar to violate.
		block_id: `ship:zone:${zone.id}`,
		blocks: [
			editZoneForm(zone),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: SHIPPING_ACTIONS.open,
						label: "View methods",
						// FULL target path, never a bare id — required at any drill depth
						// (§12.7), and load-bearing at depth 3 for this screen's rates level.
						value: { target: encodePath([zone.id]) },
					},
				],
			},
			deleteZoneActions(zone),
		],
	};
}

/** Full-replace edit (LWW, no CAS — a zone carries no money): the form always
 *  submits BOTH `name` and `regions`, pre-filled from the loaded row, so an
 *  edit can never silently omit `regions` (the service 400s an omitted key —
 *  `AdminRulesClient.updateZone`'s doc). `zoneId` rides invisibly in the
 *  carrier, not as a visible field (F-2, F-3 — no more single-option
 *  "carrier" select). */
function editZoneForm(zone: ShippingZoneWire): FormBlock {
	return carriedForm({
		namespace: "ship:zone-save",
		context: { zoneId: zone.id },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "name",
					label: "Name",
					initial_value: zone.name,
					placeholder: "e.g. United States",
				},
				{
					type: "text_input",
					action_id: "regions",
					label: "Regions (comma-separated, blank = none)",
					initial_value: formatRegionsForInput(zone.regions),
				},
			],
			// A verb phrase naming the result, no id (M-7) — the enclosing
			// accordion's label already names the zone.
			submit: { label: "Save zone", action_id: ACTION_SAVE_ZONE },
		},
	});
}

function deleteZoneActions(zone: ShippingZoneWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_ZONE,
		label: "Delete zone", // no id (M-7) — the accordion label already names it
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

/** L-8's create group. `forceOpen` is B-6's "empty.actions' create button"
 *  case (E-2): BOTH the `block_id` and `default_open` change together, or the
 *  group either never opens or opens with the wrong `default_open` re-read
 *  (R-14a). */
function newZoneAccordion(forceOpen: boolean): AccordionBlock {
	return {
		type: "accordion",
		label: "New zone",
		default_open: forceOpen,
		block_id: forceOpen ? "ship:new-zone:open" : "ship:new-zone",
		blocks: [
			{
				type: "context",
				text: "Regions are a reference list only — checkout does not yet auto-match a buyer's address to a zone.",
			},
			createZoneForm(),
		],
	};
}

function createZoneForm(): FormBlock {
	return carriedForm({
		namespace: "ship:zone-create",
		form: {
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
		},
	});
}

/** L-9 fallback (>25 rows, or an incomplete page): table + L-7 drill-in.
 *  T-7/L-9b: every L-9 fallback table sets `empty_text`. */
function zonesFallbackTable(zones: ShippingZoneWire[]): TableBlock {
	return {
		type: "table",
		columns: [
			{ key: "id", label: "Zone ID", format: "code" },
			{ key: "name", label: "Name" },
			{ key: "regions", label: "Regions" },
		],
		rows: zones.map((z) => ({ id: z.id, name: z.name, regions: regionsSummary(z.regions) })),
		page_action_id: SHIPPING_ACTIONS.page, // never fires: the registry has no paging
		empty_text: "No shipping zones yet — create one below.",
	};
}

/** L-7's standalone drill-in, used only by the fallback branch (the
 *  accordion branch uses the per-row "View methods" button instead — §12.7).
 *  ALWAYS a `combobox`: the option value is an opaque encoded path, and a
 *  `select` would render that in its trigger (R-17a, X-22). The label is the
 *  zone's name plus its regions as a disambiguator — never the id (M-7). */
function openZoneForm(zones: ShippingZoneWire[]): FormBlock {
	// Wrapped in `carriedForm` even though `NONE` is a constant sentinel, never
	// record-derived data (R-12a — a record picker never prefills, so there is
	// no staleness for a change token to guard against): every prefilling
	// control still goes through the one mechanism, matching `orders-page.ts`'s
	// own L-7 picker.
	return carriedForm({
		namespace: "ship:open-zone",
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "target",
					label: "Open zone",
					options: [
						{ value: NONE, label: "Choose a zone…" },
						...zones.map((z) => ({
							value: encodePath([z.id]),
							label: `${z.name} — ${regionsSummary(z.regions)}`,
						})),
					],
					initial_value: NONE,
				},
			],
			submit: { label: "Open", action_id: SHIPPING_ACTIONS.open },
		},
	});
}

function zonesFailClosed() {
	return failClosedResponse({
		header: "Shipping zones",
		title: "Shipping zones are unavailable",
		description:
			"Shipping zones could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load shipping zones",
	});
}

// -- level 1: a zone's shipping methods -----------------------------------------

function methodsLevel() {
	return listLevel<AdminRulesClient, MethodsFilterForm, MethodRow, ShippingRenderState>({
		limit: 200,
		filterFromValues: methodsFilterFromValues,
		async fetchPage(client, path, filter) {
			const zoneId = path[0];
			if (zoneId === undefined) return { items: [], nextCursor: null };
			const methods = await client.listMethods(zoneId);
			return { items: await pricedMethods(client, methods, filter), nextCursor: null };
		},
		render({ path, filter, items, nextToken, notice, renderState }) {
			const zoneId = path[0] ?? "";
			return methodsBlocks(zoneId, filter, items, nextToken, notice, renderState);
		},
		onError: () => methodsFailClosed(),
	});
}

/**
 * What this render could learn about a method's price in the filter currency.
 * FOUR outcomes, kept apart on purpose — an amount, a service that says there
 * is none, a lookup that did not answer, and a lookup never attempted. None of
 * them may collapse into another, and none but the first may render as a
 * number.
 *
 * `not-priced` is the one that looks redundant and is not. It marks "we did
 * not ask", which is true of the table branch and of a rejected currency, and
 * it exists so that a future change — service-side paging on this registry,
 * say, letting a priced-looking row reach `render` un-priced — cannot print
 * `Price unavailable` and blame the service for a read nobody made.
 */
type MethodPrice =
	| { kind: "amount"; rate: ShippingRateWire }
	| { kind: "none" }
	| { kind: "unknown" }
	| { kind: "not-priced" };

/** A method ROW as this level renders it: the wire shape plus its price in the
 *  level's filter currency (see the module doc's price note for the bound). */
interface MethodRow extends ShippingMethodWire {
	price: MethodPrice;
}

/**
 * Attach each method's price in the filter currency, or mark the row
 * `not-priced` when no read is going to be made: past 25 rows (the table
 * branch has no price column) or on a currency that is not a currency code at
 * all. Either way the level costs ZERO rate reads rather than up to
 * `limit: 200` of them.
 *
 * THE FAN-OUT IS PER RENDER OF THIS LEVEL, NOT PER DRILL-IN. `SandboxedPluginPage`
 * replaces the whole block tree on every interaction, so the ≤25 reads recur on
 * the drill-in, on every filter apply, and on every post-write `showList` —
 * a create/save/delete round trip pays for them again. That is affordable at
 * this bound and on this screen (a registry an operator configures once, not a
 * storefront path), and it is the reason the bound is 25 and not `limit`.
 *
 * FOLLOW-UP, deliberately not built here: these reads carry no `AbortSignal`
 * and no deadline, so a service that hangs rather than fails holds the render
 * open for as long as `ctx.http` will wait. Containment today is per-row and
 * on the ERROR path only. Wiring cancellation belongs with a timeout policy for
 * every admin read, not with a label change.
 */
async function pricedMethods(
	client: AdminRulesClient,
	methods: ShippingMethodWire[],
	filter: MethodsFilterForm,
): Promise<MethodRow[]> {
	// This level's `fetchPage` always returns `nextCursor: null` (the registry
	// has no service-side paging), so the branch is decided by row count alone
	// and can be asked here, before `render` asks it again for real.
	if (filter.invalid || !isRegistryAccordion(undefined, methods.length)) {
		return methods.map((method) => ({ ...method, price: { kind: "not-priced" } }));
	}
	return Promise.all(
		methods.map(async (method) => ({
			...method,
			price: await methodPrice(client, method.id, filter.currency),
		})),
	);
}

/** One method's price lookup, CONTAINED: this is a secondary read (the method
 *  list is the primary one), so a failure degrades this row alone. `null` from
 *  the client is the service's own "no rate in that currency" 404 — a fact,
 *  reported as such; a throw is an absence of information, reported as such. */
async function methodPrice(
	client: AdminRulesClient,
	methodId: string,
	currency: string,
): Promise<MethodPrice> {
	try {
		const rate = await client.getRate(methodId, currency);
		return rate === null ? { kind: "none" } : { kind: "amount", rate };
	} catch (err) {
		console.error("[otta] admin shipping method price read failed:", err);
		return { kind: "unknown" };
	}
}

/**
 * The leading token of a method's row label. Money goes through `formatMoney`
 * (via `formatCentsForDisplay`); the three non-amounts are named honestly and
 * never dressed up as a price.
 *
 * `No rate set` IS CURRENCY-SCOPED, AND THE CONTEXT LINE IS WHERE IT SAYS SO
 * ({@link methodsBlocks}). The read establishes only that this method has no
 * rate IN THE FILTER CURRENCY; a store pricing solely in EUR, read under the
 * USD default, would otherwise be told every method is unconfigured while its
 * configuration is complete — the same false absence this module refuses to
 * render as `Free`. Scoping it in the row instead ("No rate set for this
 * currency") reads better in isolation and was tried first: it makes a
 * realistic label 63 characters against X-11's 60-char accordion budget, and
 * the budget is the older constraint. So the qualifier lives once in the
 * context line, with the currency it qualifies — which is also where G1 wants
 * the currency named, rather than as an ISO code per row.
 */
function methodPriceLabel(price: MethodPrice): string {
	switch (price.kind) {
		case "amount":
			return formatCentsForDisplay(price.rate.amountCents, price.rate.currency);
		case "none":
			return "No rate set";
		case "unknown":
			return "Price unavailable";
		case "not-priced":
			return "Price not loaded";
	}
}

/** The level's one context line. On the priced branch it carries the currency
 *  AND what an unpriced row means in it — the whole of `No rate set`'s scope,
 *  stated once (G1, X-11's 140-char page-context budget: 138). Off that branch
 *  it claims no currency, because nothing was priced in one. */
function methodsContextText(currency: string, pricesShown: boolean): string {
	// The wire values stay `flat_rate`/`free_shipping` (see `methodTypeField`);
	// only the operator-facing copy is human.
	const types =
		'"Flat rate" always charges its rate; "Free shipping" charges nothing above its threshold.';
	return pricesShown
		? `${types} Prices in ${currency} — "No rate set" means no ${currency} rate.`
		: types;
}

function methodsBlocks(
	zoneId: string,
	filter: MethodsFilterForm,
	methods: MethodRow[],
	nextToken: string | undefined,
	notice: Notice | undefined,
	renderState: ShippingRenderState | undefined,
): Block[] {
	// The context line is where this level states its currency — ONCE, for the
	// whole list (G1), never repeated as an ISO code per row. It claims a
	// currency only when rows were actually priced in it.
	const accordionBranch = isRegistryAccordion(nextToken, methods.length);
	const pricesShown = accordionBranch && methods.length > 0 && !filter.invalid;
	const blocks: Block[] = [
		{ type: "header", text: `Shipping methods — ${zoneId}` },
		backButton(SHIPPING_ACTIONS.back, "← Back to zones", [zoneId]),
		{ type: "context", text: methodsContextText(filter.currency, pricesShown) },
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	// G5: a rejected filter is a banner inside a 200, never a refused render —
	// the method list is unaffected by it and stays on screen, editable.
	if (filter.invalid) blocks.push(noticeBanner(BAD_CURRENCY_NOTICE));

	const forceCreateOpen = renderState?.kind === "method-create-open";
	if (methods.length === 0) {
		// See the matching comment in `zonesBlocks` — force-open must win over
		// the empty state on the SAME zero-row render, or clicking "New method"
		// from the empty state has no visible effect.
		if (forceCreateOpen) {
			blocks.push(newMethodAccordion(zoneId, true));
			return blocks;
		}
		blocks.push(
			emptyState({
				title: "No shipping methods yet",
				description: "Add a method to start offering shipping for this zone.",
				size: "base",
				actions: [
					{
						type: "button",
						action_id: ACTION_OPEN_CREATE_METHOD,
						label: "New method",
						value: { [PATH_FIELD]: encodePath([zoneId]) },
					},
				],
			}),
		);
		return blocks;
	}

	if (accordionBranch) {
		// L-2: one filter field renders INLINE, no accordion. It is the price
		// column's currency, so it ships with the priced branch and not with the
		// table branch, which prices nothing. It renders on a REJECTED currency
		// too — that is the field the operator has to fix.
		blocks.push(methodCurrencyForm(zoneId, filter));
		for (const method of methods) blocks.push(methodAccordion(zoneId, method));
	} else {
		blocks.push(methodsFallbackTable(methods));
		blocks.push(openMethodForm(zoneId, methods));
	}
	blocks.push(newMethodAccordion(zoneId, forceCreateOpen));
	return blocks;
}

/** The currency the per-row price is read in. Same field, same submit verb and
 *  same default as the rates level's own `currencyFilterForm` one level down —
 *  deliberately, so the control an operator learns here is the control they
 *  meet there. Carries the depth-1 drill path INVISIBLY (L-6), so
 *  `apply-filter` re-lists THIS zone's methods and not the root. */
function methodCurrencyForm(zoneId: string, filter: MethodsFilterForm): FormBlock {
	return carriedForm({
		namespace: "ship:method-currency",
		context: { [PATH_FIELD]: encodePath([zoneId]) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "currency",
					label: "Price currency (ISO-4217, e.g. USD)",
					initial_value: filter.currency,
				},
			],
			submit: { label: "Apply filters", action_id: SHIPPING_ACTIONS.applyFilter },
		},
	});
}

/** The human name for a method `type`, matching the create/edit select's
 *  option labels verbatim. The WIRE VALUE is untouched — `flat_rate` /
 *  `free_shipping` still go over `ctx.http` and still come back; only the copy
 *  an operator reads is human. */
function methodTypeName(type: string): string {
	return type === "free_shipping" ? "Free shipping" : "Flat rate";
}

/** {@link methodTypeName} lowercased for mid-label use (D-6) — never a bare
 *  code, and never the select's raw value (that wart is confined to the
 *  `select` trigger itself, R-17a). */
function methodTypeLabel(type: string): string {
	return type === "free_shipping" ? "free shipping" : "flat rate";
}

/**
 * One method's per-row group (L-9). THE PRICE LEADS THE LABEL: it is the
 * number the operator came for, and before this it was not on the screen at
 * all — not in the row, not even inside the expanded row, only two levels down
 * under the rates drill-in. Leading with it also starts every row's amount at
 * the same left edge, so a zone's methods can be compared down the column
 * (the slug, which varies in length, moves to second position — in FULL: a
 * method id is a readable natural key, not an opaque uuid).
 */
function methodAccordion(zoneId: string, method: MethodRow): AccordionBlock {
	return {
		type: "accordion",
		label: `${methodPriceLabel(method.price)} — ${method.name} · ${method.id} · ${methodTypeLabel(method.type)}`,
		default_open: false,
		block_id: `ship:method:${zoneId}:${method.id}`,
		blocks: [
			editMethodForm(zoneId, method),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: SHIPPING_ACTIONS.open,
						label: "View rates",
						value: { target: encodePath([zoneId, method.id]) },
					},
				],
			},
			deleteMethodActions(zoneId, method),
		],
	};
}

function methodTypeField(actionId: string, initial: string): FormBlock["fields"][number] {
	const options: SelectOption[] = [
		{ value: "flat_rate", label: "Flat rate" },
		{ value: "free_shipping", label: "Free shipping (threshold-based)" },
	];
	return { type: "select", action_id: actionId, label: "Type", options, initial_value: initial };
}

function editMethodForm(zoneId: string, method: ShippingMethodWire): FormBlock {
	return carriedForm({
		namespace: "ship:method-save",
		context: { zoneId, methodId: method.id },
		form: {
			type: "form",
			fields: [
				{ type: "text_input", action_id: "name", label: "Name", initial_value: method.name },
				methodTypeField("type", method.type),
			],
			submit: { label: "Save method", action_id: ACTION_SAVE_METHOD },
		},
	});
}

function deleteMethodActions(zoneId: string, method: ShippingMethodWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_METHOD,
		label: "Delete method",
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

function newMethodAccordion(zoneId: string, forceOpen: boolean): AccordionBlock {
	return {
		type: "accordion",
		label: "New method",
		default_open: forceOpen,
		block_id: forceOpen ? `ship:new-method:${zoneId}:open` : `ship:new-method:${zoneId}`,
		blocks: [createMethodForm(zoneId)],
	};
}

function createMethodForm(zoneId: string): FormBlock {
	return carriedForm({
		namespace: "ship:method-create",
		context: { zoneId },
		form: {
			type: "form",
			fields: [
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
		},
	});
}

function methodsFallbackTable(methods: ShippingMethodWire[]): TableBlock {
	return {
		type: "table",
		columns: [
			{ key: "id", label: "Method ID", format: "code" },
			{ key: "name", label: "Name" },
			// `Type` keeps its badge (T-5's own exception): a two-value closed set
			// (flat_rate/free_shipping) genuinely distinguished at a glance, and
			// this level's only badge column. The badge reads the HUMAN name — the
			// raw enum was the last operator-facing place this screen leaked one.
			{ key: "type", label: "Type", format: "badge" },
		],
		rows: methods.map((m) => ({ id: m.id, name: m.name, type: methodTypeName(m.type) })),
		page_action_id: SHIPPING_ACTIONS.page, // never fires: no paging at this level
		empty_text: "No shipping methods yet for this zone.",
	};
}

function openMethodForm(zoneId: string, methods: ShippingMethodWire[]): FormBlock {
	// See `openZoneForm`'s note: carried even though `NONE` is a constant.
	return carriedForm({
		namespace: "ship:open-method",
		context: { zoneId },
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "target",
					label: "Open method",
					options: [
						{ value: NONE, label: "Choose a method…" },
						...methods.map((m) => ({
							value: encodePath([zoneId, m.id]),
							label: `${m.name} (${methodTypeLabel(m.type)})`,
						})),
					],
					initial_value: NONE,
				},
			],
			submit: { label: "Open", action_id: SHIPPING_ACTIONS.open },
		},
	});
}

function methodsFailClosed() {
	return failClosedResponse({
		header: "Shipping methods",
		title: "Shipping methods are unavailable",
		description:
			"Shipping methods could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load shipping methods",
	});
}

// -- level 2: a method's rates (currency-keyed, L-9a EXEMPT from the accordion list) --

function ratesLevel() {
	return listLevel<AdminRulesClient, RatesFilterForm, ShippingRateWire>({
		limit: 1, // a rate is keyed by (methodId, currency) — at most one row per filter
		filterFromValues: currencyFromValues,
		async fetchPage(client, path, filter) {
			const methodId = path[1];
			if (methodId === undefined) return { items: [], nextCursor: null };
			const rate = await client.getRate(methodId, filter.currency);
			return { items: rate === null ? [] : [rate], nextCursor: null };
		},
		render({ path, filter, items, notice }) {
			const zoneId = path[0] ?? "";
			const methodId = path[1] ?? "";
			return ratesBlocks(zoneId, methodId, filter, items, notice);
		},
		onError: () => ratesFailClosed(),
	});
}

function ratesBlocks(
	zoneId: string,
	methodId: string,
	filter: RatesFilterForm,
	rows: ShippingRateWire[],
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: `Shipping rates — ${methodId}` },
		backButton(SHIPPING_ACTIONS.back, "← Back to methods", [zoneId, methodId]),
		{
			type: "context",
			text: "A rate is keyed by currency — one method can price differently per currency.",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));

	blocks.push(currencyFilterForm(zoneId, methodId, filter));
	if (filter.currency !== DEFAULT_RATE_CURRENCY) {
		const summary = filterSummary([`currency: ${filter.currency}`]);
		if (summary !== undefined) {
			const clearButton: ButtonElement = {
				type: "button",
				action_id: SHIPPING_ACTIONS.applyFilter,
				label: "Clear filters",
				value: { [PATH_FIELD]: encodePath([zoneId, methodId]) },
			};
			blocks.push({ type: "section", text: summary, accessory: clearButton });
		}
	}

	const row = rows[0];
	if (row === undefined) {
		blocks.push({
			type: "context",
			text: "No rate set for that currency yet — use the form below.",
		});
		blocks.push(createRateForm(zoneId, methodId, filter));
	} else {
		blocks.push(rateFields(methodId, row));
		blocks.push(editRateForm(zoneId, methodId, row));
		blocks.push(deleteRateActions(zoneId, methodId, row));
	}
	return blocks;
}

function currencyFilterForm(zoneId: string, methodId: string, filter: RatesFilterForm): FormBlock {
	// L-2: a single filter field renders INLINE (no accordion). Carries the
	// depth-2 drill path INVISIBLY via the carrier so `apply-filter` re-lists
	// THIS method's rates, never the root — required at depth > 0 (L-6).
	return carriedForm({
		namespace: "ship:rate-lookup",
		context: { [PATH_FIELD]: encodePath([zoneId, methodId]) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "currency",
					label: "Currency (ISO-4217, e.g. USD)",
					initial_value: filter.currency,
				},
			],
			// L-5 wants the standard verb phrase, not "Look up rate".
			submit: { label: "Apply filters", action_id: SHIPPING_ACTIONS.applyFilter },
		},
	});
}

/** A 0-or-1-row lookup is `fields`, not a 1-row `table` (P-3, L-9a). */
function rateFields(methodId: string, row: ShippingRateWire): FieldsBlock {
	return {
		type: "fields",
		block_id: "shipping:rate",
		fields: [
			{ label: "Currency", value: row.currency },
			{ label: "Amount", value: formatCentsForDisplay(row.amountCents, row.currency) },
			{
				label: "Free-shipping threshold",
				value:
					row.minSubtotalCents === null
						? "No minimum"
						: formatCentsForDisplay(row.minSubtotalCents, row.currency),
			},
			{ label: "Method", value: methodId },
		],
	};
}

function createRateForm(zoneId: string, methodId: string, filter: RatesFilterForm): FormBlock {
	return carriedForm({
		namespace: "ship:rate-create",
		context: { zoneId, methodId },
		form: {
			type: "form",
			fields: [
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
		},
	});
}

/**
 * The rate edit form (CAS on `amountCents`): `expectedAmountCents` rides
 * invisibly in the carrier alongside `zoneId`/`methodId`/`currency`, holding
 * the value THIS render loaded (B-3's change token) — a concurrent edit that
 * changed it in the meantime loses the CAS and the reloaded list shows the
 * fresh value with a "reload" notice, never a silent clobber.
 * `minSubtotalCents` is required-nullable on the wire, so the form always
 * submits it (blank ⇒ explicit clear).
 */
function editRateForm(zoneId: string, methodId: string, row: ShippingRateWire): FormBlock {
	return carriedForm({
		namespace: "ship:rate-save",
		context: {
			zoneId,
			methodId,
			currency: row.currency,
			expectedAmountCents: String(row.amountCents),
		},
		form: {
			type: "form",
			fields: [
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
			submit: { label: "Save rate", action_id: ACTION_SAVE_RATE },
		},
	});
}

function deleteRateActions(zoneId: string, methodId: string, row: ShippingRateWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE_RATE,
		label: "Delete rate",
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
			"Shipping rates could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load shipping rates",
	});
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
	return customAction<AdminRulesClient>(async ({ input, carried, client, showList }) => {
		const zoneId = carried?.zoneId;
		if (zoneId === undefined) return showList();
		const values = input.values ?? {};
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

// -- custom action: force the "New zone" group open from the empty state (E-2) ----

function openCreateZoneAction() {
	return customAction<AdminRulesClient, ShippingRenderState>(async ({ showList }) => {
		return showList(undefined, undefined, { kind: "zone-create-open" });
	});
}

// -- custom action: create a method -----------------------------------------------

function createMethodAction() {
	return customAction<AdminRulesClient>(async ({ input, carried, client, showList }) => {
		const zoneId = carried?.zoneId;
		if (zoneId === undefined) return showList();
		const values = input.values ?? {};
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
	return customAction<AdminRulesClient>(async ({ input, carried, client, showList }) => {
		const zoneId = carried?.zoneId;
		const methodId = carried?.methodId;
		if (zoneId === undefined || methodId === undefined) return showList();
		const values = input.values ?? {};
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

// -- custom action: force the "New method" group open from the empty state (E-2) --

function openCreateMethodAction() {
	return customAction<AdminRulesClient, ShippingRenderState>(async ({ carriedPath, showList }) => {
		return showList(carriedPath, undefined, { kind: "method-create-open" });
	});
}

// -- custom action: create a rate ---------------------------------------------------

function createRateAction() {
	return customAction<AdminRulesClient>(async ({ input, carried, client, showList }) => {
		const zoneId = carried?.zoneId;
		const methodId = carried?.methodId;
		if (zoneId === undefined || methodId === undefined) return showList();
		const values = input.values ?? {};
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
	return customAction<AdminRulesClient>(async ({ input, carried, client, showList }) => {
		const zoneId = carried?.zoneId;
		const methodId = carried?.methodId;
		const currency = carried?.currency;
		const expectedAmountCentsRaw = carried?.expectedAmountCents;
		if (
			zoneId === undefined ||
			methodId === undefined ||
			currency === undefined ||
			expectedAmountCentsRaw === undefined
		) {
			return showList();
		}
		const expectedAmountCents = Number.parseInt(expectedAmountCentsRaw, 10);
		const values = input.values ?? {};
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

/** Display-format (with currency symbol) for the rate readout — falls back to
 *  a plain `CUR amount` string if `Intl`/the branding constructors reject the
 *  wire value (never throws into the render path). */
function formatCentsForDisplay(minorUnits: number, currencyCode: string): string {
	try {
		return formatMoney(toCents(minorUnits), toCurrency(currencyCode), "en-US");
	} catch {
		return `${currencyCode} ${formatMinorUnitsInput(minorUnits)}`;
	}
}
