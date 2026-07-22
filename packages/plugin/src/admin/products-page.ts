import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	AdminPageConfig,
	Block,
	FormBlock,
	RouteHandler,
	SelectOption,
	TableBlock,
} from "../types.js";
import {
	AdminProductsClient,
	type ProductDetailWire,
	type ProductEditWire,
	type ProductsListFilter,
	type ProductSummaryWire,
	type RestockResult,
	type StockRemovalResult,
} from "./admin-products-client.js";
import {
	backButton,
	createListDetailHandler,
	customAction,
	leafLevel,
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
 * The admin Products console page's `admin.pages` manifest entry (admin-UX
 * Increment 2, "product enumerate + product list"). View-only: browse
 * products, filter, and drill into one for the full read-only detail — no
 * editing, no restock (both later increments; see the port/route docs).
 * Rendered by the single `admin` dispatch route (see `admin-route.ts`).
 * Built on the shared list/detail scaffold (`./scaffold`), mirroring
 * `orders-page.ts` — the reference consumer this screen is proven against.
 */
export const PRODUCTS_PAGE: AdminPageConfig = {
	path: "/products",
	label: "Products",
	icon: "box",
};

/** This screen's namespaced action ids — the four scaffold nav verbs plus the
 *  `save` verb the detail leaf's edit form submits (admin-UX Increment 2 slice
 *  2: the standalone product edit surface). */
const PRODUCTS_ACTIONS: ScreenActions = screenActions("products");

/** The detail leaf's edit-form submit (`products:save`). */
const ACTION_SAVE = PRODUCTS_ACTIONS.custom("save");
/** The detail leaf's stock-movement submits (admin-UX Increment 2 slice 3). */
const ACTION_RESTOCK = PRODUCTS_ACTIONS.custom("restock");
const ACTION_REMOVE = PRODUCTS_ACTIONS.custom("remove-stock");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Products console (mirrors `ORDERS_ACTION_IDS`). Every `block_action`/
 * `form_submit` this page can emit is namespaced `products:*` and listed
 * here, so none falls through the dispatcher to the `{blocks:[]}` dead-end.
 * `products:page` is ALSO the table's `page_action_id`.
 */
export const PRODUCTS_ACTION_IDS: ReadonlySet<string> = PRODUCTS_ACTIONS.actionIds(
	"save",
	"restock",
	"remove-stock",
);

const PAGE_LIMIT = 25;

/** The console's own filter form values, kept alongside the opaque service
 *  cursor so paging preserves the form (mirrors `OrdersFilterForm`).
 *  `active`/`productKind` are tri-state strings ("" ⇒ both) because a Block
 *  Kit `select` has no "unset" value distinct from its options.
 *
 *  `archived` (product lifecycle surfacing, admin-UX Increment 2) is the
 *  archive-view toggle: unset ⇒ the ORIGINAL default (live products only,
 *  active + inactive both listed); `"true"` ⇒ ONLY soft-deleted rows. A
 *  soft-deleted row is always inactive (`softDelete` sets `active=false`), so
 *  combining `active` with `archived: "true"` is a contradiction that returns
 *  no rows — the filter form's own context copy calls this out rather than
 *  silently reconciling the two into one control. */
interface ProductsFilterForm {
	active?: "true" | "false";
	productKind?: "physical" | "digital";
	search?: string;
	archived?: "true";
}

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type ProductsPageInput = ListDetailInput;

export function createProductsPageHandler(): RouteHandler<ProductsPageInput> {
	return createListDetailHandler({
		actions: PRODUCTS_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminProductsClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...(tokens.adminToken !== undefined ? { adminToken: tokens.adminToken } : {}),
				// The edit PATCH is a NON-GET the write gate blocks without this.
				...(tokens.serviceToken !== undefined ? { serviceToken: tokens.serviceToken } : {}),
			});
		},
		// A list row's "Open product" form carries the product id in
		// `values.productId`; the target is a single-level drill, so the path is
		// just `[productId]`.
		parseOpen(input) {
			const productId = readString(input.values?.productId);
			return productId === undefined ? undefined : { targetPath: [productId] };
		},
		levels: [productsListLevel(), productDetailLevel()],
		customActions: {
			[ACTION_SAVE]: saveAction(),
			[ACTION_RESTOCK]: restockAction(),
			[ACTION_REMOVE]: removeStockAction(),
		},
	});
}

// -- level 0: the products list -----------------------------------------------

function productsListLevel() {
	return listLevel<AdminProductsClient, ProductsFilterForm, ProductSummaryWire>({
		limit: PAGE_LIMIT,
		filterFromValues,
		async fetchPage(client, _path, form, opts) {
			const page = await client.listProducts(toClientFilter(form), {
				limit: opts.limit,
				...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
			});
			return { items: page.products, nextCursor: page.nextCursor };
		},
		render({ actions, filter, items, nextToken }) {
			return listBlocks(actions, filter, items, nextToken);
		},
		onError: () => failClosed(),
	});
}

/** The lifecycle status label a merchant reads (product lifecycle surfacing,
 *  admin-UX Increment 2): a soft-deleted row shows "deleted", never
 *  "inactive" — `deletedAt` outranks `active` (a tombstoned row is always
 *  inactive too, but "deleted" is the honest, non-recoverable-from-here
 *  status a merchant needs to see, not the publish-gate value underneath
 *  it). Shared by the list table, the "Open product" picker, and the detail
 *  fields so the three surfaces can never disagree. */
function statusLabel(p: { active: boolean; deletedAt: string | null }): string {
	if (p.deletedAt !== null) return "deleted";
	return p.active ? "active" : "inactive";
}

function listBlocks(
	actions: ScreenActions,
	form: ProductsFilterForm,
	products: ProductSummaryWire[],
	nextToken: string | undefined,
): Block[] {
	const table: TableBlock = {
		type: "table",
		columns: [
			{ key: "title", label: "Title" },
			{ key: "sku", label: "SKU", format: "code" },
			{ key: "price", label: "Price" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "kind", label: "Kind", format: "badge" },
		],
		rows: products.map((p) => ({
			title: p.title ?? "(untitled)",
			sku: p.sku ?? "—",
			price: formatOptionalTotal(p.priceCents, p.currency),
			status: statusLabel(p),
			kind: p.productKind,
		})),
		page_action_id: actions.page,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text:
			form.archived === "true"
				? "No archived (deleted) products match these filters."
				: "No products match these filters.",
	};

	const blocks: Block[] = [
		{ type: "header", text: "Products" },
		{
			type: "context",
			text: 'View-only console. Filter and open a product for its full read-only detail. Stock is shown on the detail view only (kept off this list to avoid a per-row inventory lookup). Money shown in the product\'s own currency. "Archived" is a separate view of products deleted (trashed or permanently removed) in the CMS — they never appear alongside live products, and there is no restore here (restoring the CMS document does not un-delete the commerce record).',
		},
		filterForm(actions, form),
		table,
	];
	if (products.length > 0) blocks.push(openProductForm(actions, products));
	return blocks;
}

/** The combined "Status" select's wire value: the ORIGINAL `active` tri-state
 *  plus a 4th `"archived"` option — one control, mutually exclusive, so a
 *  merchant can never combine "Active" with "Archived" into a filter
 *  contradiction (a soft-deleted row is always inactive under the hood, but
 *  the picker never exposes that as two independently-toggleable axes). */
function filterForm(actions: ScreenActions, form: ProductsFilterForm): FormBlock {
	const statusOptions: SelectOption[] = [
		{ value: "", label: "All statuses (live)" },
		{ value: "true", label: "Active" },
		{ value: "false", label: "Inactive" },
		{ value: "archived", label: "Archived (deleted)" },
	];
	const kindOptions: SelectOption[] = [
		{ value: "", label: "All kinds" },
		{ value: "physical", label: "physical" },
		{ value: "digital", label: "digital" },
	];
	const statusInitialValue = form.archived === "true" ? "archived" : (form.active ?? "");
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "active",
				label: "Status",
				options: statusOptions,
				initial_value: statusInitialValue,
			},
			{
				type: "select",
				action_id: "productKind",
				label: "Kind",
				options: kindOptions,
				initial_value: form.productKind ?? "",
			},
			{
				type: "text_input",
				action_id: "search",
				label: "Search (SKU exact, or title contains)",
				...(form.search !== undefined ? { initial_value: form.search } : {}),
			},
		],
		submit: { label: "Apply filters", action_id: actions.applyFilter },
	};
}

function openProductForm(actions: ScreenActions, products: ProductSummaryWire[]): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "productId",
				label: "Open product",
				options: products.map((p) => ({
					value: p.productId,
					label: `${p.title ?? p.productId} — ${statusLabel(p)}`,
				})),
			},
		],
		submit: { label: "Open product", action_id: actions.open },
	};
}

// -- level 1: the product detail ----------------------------------------------

function productDetailLevel() {
	return leafLevel<AdminProductsClient, ProductDetailWire>({
		load: (client, _path, id) => client.getProduct(id),
		render({ actions, id, detail, notice }) {
			return detailBlocks(actions, id, detail, notice);
		},
		notFound({ actions, id }) {
			return [
				{ type: "header", text: "Product not found" },
				backButton(actions.back, "← Back to products"),
				{
					type: "banner",
					variant: "error",
					title: "Product not found",
					description: `No product matches "${id}".`,
				},
			];
		},
		onError: () => failClosed(),
	});
}

function detailBlocks(
	actions: ScreenActions,
	id: string,
	p: ProductDetailWire,
	notice: Notice | undefined,
): Block[] {
	const fields: Array<{ label: string; value: string }> = [
		{ label: "Title", value: p.title ?? "(untitled)" },
		{ label: "SKU", value: p.sku ?? "—" },
		{ label: "Price", value: formatOptionalTotal(p.priceCents, p.currency) },
		{ label: "Status", value: statusLabel(p) },
		{ label: "Kind", value: p.productKind },
		{ label: "Stock on hand", value: String(p.onHand) },
		{ label: "Tax class", value: p.taxClass ?? "—" },
		{ label: "Weight (g)", value: p.weightGrams === null ? "—" : String(p.weightGrams) },
		{ label: "Dimensions (mm, LxWxH)", value: dimensionsSummary(p) },
		{ label: "Created (UTC)", value: p.createdAt },
		{ label: "Updated (UTC)", value: p.updatedAt },
	];
	const blocks: Block[] = [
		{ type: "header", text: p.title ?? id },
		backButton(actions.back, "← Back to products"),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({ type: "fields", fields });

	// -- Soft-deleted (product lifecycle surfacing, admin-UX Increment 2) -----
	// A tombstoned row is READ-ONLY here: no edit form, no stock forms. Editing
	// or restocking a deleted product is meaningless (the write routes 404 it
	// anyway — see `admin.ts`'s GET-vs-write-routes doc), so the forms are never
	// rendered rather than rendered-then-rejected. There is no restore action:
	// the CMS-sync/lifecycle paths (`softDelete`/`activate`/`deactivate`) are
	// the only writers of this state, and restoring the CMS document does NOT
	// undo a soft delete (`upsert` never touches `deletedAt`/`active` — see the
	// port doc) — a known, called-out gap, not something this read-only view can
	// paper over.
	if (p.deletedAt !== null) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "This product was deleted",
			description: `Deleted (trashed or permanently removed) in the CMS on ${p.deletedAt}. It no longer appears in the storefront or the default product list, and it cannot be edited or restocked from here. It stays visible in the "Archived" filter for reference; existing orders that included it are unaffected — an order snapshots its price and title at purchase time.`,
		});
		return blocks;
	}

	blocks.push({ type: "divider" });
	blocks.push({
		type: "header",
		text: "Edit commerce fields",
	});
	blocks.push({
		type: "context",
		text: "Editing the commerce fields this store owns. The status (active/inactive) is the CMS publish state — publish or unpublish the document to change it, not here. Titles/images are also managed in the CMS. Money is shown in the product's own currency.",
	});
	blocks.push(editForm(actions, p));

	// -- Stock management (admin-UX Increment 2 slice 3) ----------------------
	// Only meaningful for a product with a sku AND an inventory row. A skuless
	// "create then price" product has nothing to move stock against, so the forms
	// are omitted (the service would 409 NO_SKU anyway).
	if (p.sku !== null) {
		blocks.push({ type: "divider" });
		blocks.push({ type: "header", text: "Stock" });
		blocks.push({
			type: "context",
			text: `Current available (on hand): ${p.onHand}. "On hand" is the count available to sell right now — every open cart hold has already been subtracted, so restocking adds to this number and it can never be oversold. Enter whole units only.`,
		});
		blocks.push(restockForm(actions, p));
		blocks.push(removeStockForm(actions, p));
	}
	return blocks;
}

/**
 * The restock form (admin-UX Increment 2 slice 3): ADD units. A hidden
 * `productId` carrier threads the target through the stateless submit, and a
 * hidden `nonce` (a fresh `crypto.randomUUID()` per render) is the per-
 * submission idempotency seed — a true double-submit of THIS rendered form
 * resends the same nonce (dedupes to one add), while every fresh reload mints a
 * new nonce so two DELIBERATE restocks each apply. Qty is a TEXT input (never
 * `number_input`, which would hand back a JS float) parsed to a positive whole
 * number.
 */
function restockForm(actions: ScreenActions, p: ProductDetailWire): FormBlock {
	return {
		type: "form",
		fields: [
			stockCarrier("productId", p.productId),
			stockCarrier("nonce", crypto.randomUUID()),
			{
				type: "text_input",
				action_id: "qty",
				label: "Units to add",
				placeholder: "e.g. 12",
			},
		],
		submit: { label: "Add stock", action_id: actions.custom("restock") },
	};
}

/**
 * The stock-removal form (admin-UX Increment 2 slice 3): REMOVE damaged/
 * shrinkage units — a DANGER path, so the copy is explicit. Same hidden
 * carriers + per-submission nonce as {@link restockForm}. The service applies a
 * GUARDED decrement, so removing more than is on hand is refused cleanly (never
 * a negative or an oversell), but the merchant is warned up front.
 */
function removeStockForm(actions: ScreenActions, p: ProductDetailWire): FormBlock {
	return {
		type: "form",
		fields: [
			stockCarrier("productId", p.productId),
			stockCarrier("nonce", crypto.randomUUID()),
			{
				type: "text_input",
				action_id: "qty",
				label: "Units to remove (damaged / shrinkage)",
				placeholder: "e.g. 3",
			},
		],
		submit: { label: "Remove stock", action_id: actions.custom("remove-stock") },
	};
}

/** A hidden single-option carrier (the scaffold's proven pattern) that threads
 *  one value through a stateless `form_submit`. */
function stockCarrier(actionId: string, value: string): FormBlock["fields"][number] {
	return {
		type: "select",
		action_id: actionId,
		label: actionId,
		options: [{ value, label: value }],
		initial_value: value,
	};
}

/**
 * The standalone product edit form (admin-UX Increment 2 slice 2). Only the
 * commerce-owned fields — NO `active` (the CMS publish gate). Two hidden
 * single-option carriers (the scaffold's `filterPathField` pattern) thread the
 * target id and the optimistic-concurrency watermark through the stateless
 * `form_submit`:
 *  - `productId` — the edit target.
 *  - `expectedUpdatedAt` — the `updatedAt` the admin loaded; the service
 *    compare-and-sets on it, so a concurrent edit is a stale reload, never a
 *    silent clobber.
 * Price is a TEXT input (never `number_input`): a Block Kit number widget hands
 * back a JS float, and money is integer minor units (CLAUDE.md) — the text is
 * parsed to minor units by exact integer string math. Currency is FIXED for an
 * already-priced product (a single-option carrier, so a price edit can never
 * silently switch it) and an editable input only for first-time pricing.
 */
function editForm(actions: ScreenActions, p: ProductDetailWire): FormBlock {
	const priced = p.priceCents !== null && p.currency !== null;
	const currencyField: FormBlock["fields"][number] = priced
		? {
				// Fixed carrier: the loaded currency round-trips, never editable.
				type: "select",
				action_id: "currency",
				label: `Currency (fixed: ${p.currency})`,
				options: [{ value: p.currency ?? "", label: p.currency ?? "" }],
				initial_value: p.currency ?? "",
			}
		: {
				type: "text_input",
				action_id: "currency",
				label: "Currency (ISO-4217, e.g. USD) — set once when first pricing",
				placeholder: "USD",
			};

	const fields: FormBlock["fields"] = [
		// Hidden carriers (single-option selects — the scaffold's proven pattern).
		{
			type: "select",
			action_id: "productId",
			label: "Product",
			options: [{ value: p.productId, label: p.productId }],
			initial_value: p.productId,
		},
		{
			type: "select",
			action_id: "expectedUpdatedAt",
			label: "Revision",
			options: [{ value: p.updatedAt, label: p.updatedAt }],
			initial_value: p.updatedAt,
		},
		{
			type: "text_input",
			action_id: "title",
			label: "Title",
			...(p.title !== null ? { initial_value: p.title } : {}),
		},
		{
			type: "text_input",
			action_id: "sku",
			label: "SKU",
			...(p.sku !== null ? { initial_value: p.sku } : {}),
		},
		{
			type: "text_input",
			action_id: "price",
			label: `Price (${p.currency ?? "set currency below"}, e.g. 19.99)`,
			...(p.priceCents !== null ? { initial_value: formatPriceMinorUnits(p.priceCents) } : {}),
			placeholder: "19.99",
		},
		currencyField,
		{
			type: "select",
			action_id: "productKind",
			label: "Kind",
			options: [
				{ value: "physical", label: "physical" },
				{ value: "digital", label: "digital" },
			],
			initial_value: p.productKind,
		},
		{
			type: "text_input",
			action_id: "taxClass",
			label: "Tax class (blank to clear)",
			...(p.taxClass !== null ? { initial_value: p.taxClass } : {}),
		},
		{
			type: "text_input",
			action_id: "weightGrams",
			label: "Weight (g)",
			...(p.weightGrams !== null ? { initial_value: String(p.weightGrams) } : {}),
		},
		{
			type: "text_input",
			action_id: "lengthMm",
			label: "Length (mm)",
			...(p.lengthMm !== null ? { initial_value: String(p.lengthMm) } : {}),
		},
		{
			type: "text_input",
			action_id: "widthMm",
			label: "Width (mm)",
			...(p.widthMm !== null ? { initial_value: String(p.widthMm) } : {}),
		},
		{
			type: "text_input",
			action_id: "heightMm",
			label: "Height (mm)",
			...(p.heightMm !== null ? { initial_value: String(p.heightMm) } : {}),
		},
	];
	return {
		type: "form",
		fields,
		submit: { label: "Save changes", action_id: actions.custom("save") },
	};
}

function dimensionsSummary(p: ProductDetailWire): string {
	if (p.lengthMm === null && p.widthMm === null && p.heightMm === null) return "—";
	const dims = [p.lengthMm, p.widthMm, p.heightMm].map((d) => (d === null ? "?" : String(d)));
	return dims.join(" x ");
}

// -- shared --------------------------------------------------------------------

/** Fail CLOSED with a GENERIC, em-dash-correct banner — never leaks a raw HTTP
 *  status/URL (e.g. an auth 401 from a missing/expired admin token). */
function failClosed() {
	return {
		blocks: [
			{ type: "header" as const, text: "Products" },
			{
				type: "banner" as const,
				variant: "error" as const,
				title: "Products are unavailable",
				description:
					"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
			},
		],
		toast: { message: "Could not load products", type: "error" as const },
	};
}

/** Translate the console's filter form into the client's list filter. */
/** Translate the console's filter form into the client's list filter.
 *  `archived` (product lifecycle surfacing) wins over `active`: the two are
 *  mutually exclusive by construction (one combined "Status" select — see
 *  `filterForm`), but `deleted: true` is asserted alone regardless, so a
 *  hand-crafted `form_submit` can never smuggle both axes into one request. */
function toClientFilter(form: ProductsFilterForm): ProductsListFilter {
	const filter: ProductsListFilter = {};
	if (form.archived === "true") {
		filter.deleted = true;
	} else if (form.active !== undefined) {
		filter.active = form.active === "true";
	}
	if (form.productKind !== undefined) filter.productKind = form.productKind;
	if (form.search !== undefined && form.search.length > 0) filter.search = form.search;
	return filter;
}

function filterFromValues(values: Record<string, unknown>): ProductsFilterForm {
	const form: ProductsFilterForm = {};
	const active = readString(values.active);
	const productKind = readString(values.productKind);
	const search = readString(values.search);
	if (active === "archived") {
		form.archived = "true";
	} else if (active === "true" || active === "false") {
		form.active = active;
	}
	if (productKind === "physical" || productKind === "digital") form.productKind = productKind;
	if (search !== undefined && search.length > 0) form.search = search;
	return form;
}

/** Format an optional (currency, minor-units) pair for display — either half
 *  missing (a "create then price" row) renders "—", never a partial/garbled
 *  string. Falls back to `${CUR} ${cents}` if `Intl` rejects the currency
 *  (never throws into the render path). */
function formatOptionalTotal(minorUnits: number | null, currencyCode: string | null): string {
	if (minorUnits === null || currencyCode === null) return "—";
	try {
		return formatMoney(toCents(minorUnits), toCurrency(currencyCode), "en-US");
	} catch {
		return `${currencyCode} ${minorUnits}`;
	}
}

// -- money input parsing (NO float arithmetic — CLAUDE.md) --------------------

/**
 * Parse a merchant-entered decimal price into integer MINOR UNITS with EXACT
 * integer string math — never `parseFloat(...)*100` (which yields 1998.9999…
 * for "19.99"). A Block Kit `number_input` hands back a JS float, so money is a
 * TEXT input parsed here instead. Hundredths scale (two fractional digits — the
 * near-universal case; zero-decimal currencies like JPY are out of scope for
 * this slice, consistent with the codebase's minor-units convention). Returns
 * null for any non-conforming or non-positive input (the caller surfaces a
 * per-field error); never throws. Exported for its own unit test.
 */
export function parsePriceMinorUnits(input: string): number | null {
	const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
	if (m === null) return null;
	const major = Number.parseInt(m[1] ?? "", 10);
	// Pad fractional digits to hundredths: ""→"00", "9"→"90", "99"→"99".
	const minor = Number.parseInt((m[2] ?? "").padEnd(2, "0"), 10);
	if (!Number.isSafeInteger(major)) return null;
	// major×100 + minor: all integer operands, exact for safe integers.
	const units = major * 100 + minor;
	return Number.isSafeInteger(units) && units > 0 ? units : null;
}

/**
 * Format integer minor units back to a hundredths decimal string for a text
 * input's initial value — pure integer math (no float division on money).
 * Exported for its own unit test.
 */
export function formatPriceMinorUnits(minorUnits: number): string {
	const abs = Math.abs(minorUnits);
	const frac = abs % 100;
	const major = (abs - frac) / 100; // (abs - frac) is a multiple of 100 ⇒ exact.
	const fracStr = frac < 10 ? `0${frac}` : String(frac);
	return `${minorUnits < 0 ? "-" : ""}${major}.${fracStr}`;
}

// -- custom action: the guarded commerce edit ---------------------------------

type BuildEditResult = { ok: true; wire: ProductEditWire } | { ok: false; message: string };

/** Assemble a validated {@link ProductEditWire} from the form's captured values.
 *  Boundary validation (mirrors the service's zod + the domain's `price > 0`):
 *  a bad price/currency/dimension is a per-field message, never an opaque save. */
function buildEditWire(
	values: Record<string, unknown>,
	expectedUpdatedAt: string,
): BuildEditResult {
	const wire: ProductEditWire = { expectedUpdatedAt };

	const title = readString(values.title)?.trim();
	if (title !== undefined && title.length > 0) wire.title = title;

	const sku = readString(values.sku)?.trim();
	if (sku !== undefined && sku.length > 0) wire.sku = sku;

	const priceStr = readString(values.price)?.trim();
	if (priceStr !== undefined && priceStr.length > 0) {
		const minorUnits = parsePriceMinorUnits(priceStr);
		if (minorUnits === null) {
			return {
				ok: false,
				message: "Price must be a positive amount like 19.99 (up to two decimal places).",
			};
		}
		const currency = readString(values.currency)?.trim().toUpperCase();
		if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
			return { ok: false, message: "Currency must be a 3-letter ISO-4217 code like USD." };
		}
		wire.price = { amount: minorUnits, currency };
	}

	const productKind = readString(values.productKind);
	if (productKind === "physical" || productKind === "digital") wire.productKind = productKind;

	// taxClass: an explicit blank clears it (null); a non-blank sets it.
	const taxClass = readString(values.taxClass);
	if (taxClass !== undefined) {
		const trimmed = taxClass.trim();
		wire.taxClass = trimmed.length > 0 ? trimmed : null;
	}

	// weight/dims: blank ⇒ preserve (omit); present ⇒ a non-negative whole number.
	const numericFields = ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const;
	for (const field of numericFields) {
		const raw = readString(values[field])?.trim();
		if (raw === undefined || raw.length === 0) continue;
		if (!/^\d+$/.test(raw)) {
			return { ok: false, message: `${field} must be a non-negative whole number.` };
		}
		const n = Number.parseInt(raw, 10);
		if (!Number.isSafeInteger(n)) return { ok: false, message: `${field} is too large.` };
		wire[field] = n;
	}

	return { ok: true, wire };
}

/** Stable content-derived idempotency key for an edit save (mirrors the panel
 *  route's `derivePanelIdempotencyKey`): a retry/double-submit of the SAME
 *  submission (same fields + watermark) dedupes to one applied write; any
 *  changed field derives a different key and applies. FNV-1a twice with
 *  independent seeds — dependency-free and sandbox-safe. */
function deriveEditIdempotencyKey(productId: string, wire: ProductEditWire): string {
	const canonical = JSON.stringify([
		productId,
		wire.expectedUpdatedAt,
		wire.sku ?? null,
		wire.price ?? null,
		wire.title ?? null,
		wire.taxClass ?? null,
		wire.weightGrams ?? null,
		wire.lengthMm ?? null,
		wire.widthMm ?? null,
		wire.heightMm ?? null,
		wire.productKind ?? null,
	]);
	return `${productId}:edit:${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01234567)}`;
}

function fnv1a(input: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/**
 * The detail leaf's Save handler (admin-UX Increment 2 slice 2). Validates the
 * form, PATCHes the commerce fields under the optimistic-concurrency watermark,
 * then RE-RENDERS the leaf (a fresh reload) with a per-outcome notice — a
 * concurrent-edit conflict shows the latest values with a "re-apply" banner
 * (never a silent clobber), a currency/SKU conflict a per-field warning.
 */
function saveAction() {
	return customAction<AdminProductsClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const productId = readString(values.productId);
		const expectedUpdatedAt = readString(values.expectedUpdatedAt);
		if (productId === undefined || expectedUpdatedAt === undefined) return showList();

		const built = buildEditWire(values, expectedUpdatedAt);
		if (!built.ok) {
			return showLeaf([productId], {
				variant: "error",
				title: "Check the highlighted value",
				description: built.message,
			});
		}

		const key = deriveEditIdempotencyKey(productId, built.wire);
		const result = await client.updateProduct(productId, built.wire, key);
		// showLeaf RELOADS the fresh detail, so a stale save renders the latest row
		// (the merchant re-applies against current values).
		return showLeaf([productId], editNotice(result));
	});
}

// -- custom actions: merchant stock movements (Increment 2 slice 3) -----------

/** Parse a merchant-entered stock quantity into a POSITIVE WHOLE number — a TEXT
 *  input (never `number_input`, which hands back a float). Null for any non-
 *  conforming or non-positive input; never throws. Exported for its own test. */
export function parseStockQty(input: string | undefined): number | null {
	if (input === undefined) return null;
	const trimmed = input.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The detail leaf's restock handler (admin-UX Increment 2 slice 3). Validates
 * the qty, POSTs the additive restock under a stable per-submission key (the
 * form's hidden `nonce`), then RE-RENDERS the leaf (a fresh reload showing the
 * new on-hand) with a per-outcome notice.
 */
function restockAction() {
	return customAction<AdminProductsClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const productId = readString(values.productId);
		if (productId === undefined) return showList();
		const qty = parseStockQty(readString(values.qty));
		if (qty === null) {
			return showLeaf([productId], {
				variant: "error",
				title: "Enter a whole number of units",
				description: "Units to add must be a positive whole number, like 12.",
			});
		}
		const key = stockMovementKey(productId, "restock", readString(values.nonce), qty);
		const result = await client.restock(productId, qty, key);
		return showLeaf([productId], restockNotice(result, qty));
	});
}

/**
 * The detail leaf's stock-removal handler (admin-UX Increment 2 slice 3). Same
 * shape as {@link restockAction}; the guarded decrement means an over-removal
 * comes back as a clean `insufficient_stock` notice, never a silent negative.
 */
function removeStockAction() {
	return customAction<AdminProductsClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const productId = readString(values.productId);
		if (productId === undefined) return showList();
		const qty = parseStockQty(readString(values.qty));
		if (qty === null) {
			return showLeaf([productId], {
				variant: "error",
				title: "Enter a whole number of units",
				description: "Units to remove must be a positive whole number, like 3.",
			});
		}
		const key = stockMovementKey(productId, "removal", readString(values.nonce), qty);
		const result = await client.removeStock(productId, qty, key);
		return showLeaf([productId], removeStockNotice(result, qty));
	});
}

/** Build the stable per-submission idempotency key for a stock movement. The
 *  form's hidden `nonce` (a per-render `crypto.randomUUID()`) is the entropy: a
 *  double-submit of the SAME rendered form reuses it (dedupes), a fresh reload
 *  mints a new one. Falls back to the qty if a nonce is somehow absent. */
function stockMovementKey(
	productId: string,
	direction: "restock" | "removal",
	nonce: string | undefined,
	qty: number,
): string {
	return `${productId}:${direction}:${nonce ?? String(qty)}`;
}

/** Map a restock outcome to the notice banner shown above the reloaded detail. */
function restockNotice(result: RestockResult, qty: number): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Stock added",
			description: `Added ${qty} unit${qty === 1 ? "" : "s"}. Available is now ${result.onHand}.`,
		};
	}
	return stockFailureNotice(result.reason);
}

/** Map a stock-removal outcome to the notice banner. */
function removeStockNotice(result: StockRemovalResult, qty: number): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Stock removed",
			description: `Removed ${qty} unit${qty === 1 ? "" : "s"}. Available is now ${result.onHand}.`,
		};
	}
	if (result.reason === "insufficient_stock") {
		return {
			variant: "error",
			title: "Not enough stock to remove",
			description: `Only ${result.onHand} unit${result.onHand === 1 ? "" : "s"} on hand — you cannot remove ${qty}. Stock is never driven below zero.`,
		};
	}
	return stockFailureNotice(result.reason);
}

/** Shared mapping for the non-success stock-movement reasons common to both
 *  restock and removal (no_sku / no_inventory_row / invalid / not_found /
 *  error). */
function stockFailureNotice(
	reason: "not_found" | "no_sku" | "no_inventory_row" | "invalid" | "error",
): Notice {
	switch (reason) {
		case "no_sku":
			return {
				variant: "error",
				title: "No SKU set",
				description:
					"This product has no SKU yet, so it has no stock to manage. Set a SKU on the edit form above first.",
			};
		case "no_inventory_row":
			return {
				variant: "error",
				title: "No stock record yet",
				description:
					"This product has a SKU but no inventory record was ever created for it, so there is nothing to add to or remove from. Initial stock is set when the product is first priced in the CMS.",
			};
		case "invalid":
			return {
				variant: "error",
				title: "Invalid quantity",
				description: "The quantity must be a positive whole number.",
			};
		case "not_found":
			return {
				variant: "error",
				title: "Product not found",
				description: "This product no longer exists — it may have been deleted in the CMS.",
			};
		default:
			return {
				variant: "error",
				title: "Stock change failed",
				description:
					"The change could not be saved — check the service connection and the admin token in Settings.",
			};
	}
}

/** Map an edit outcome to the notice banner shown above the reloaded detail. */
function editNotice(result: Awaited<ReturnType<AdminProductsClient["updateProduct"]>>): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Saved",
			description: "The product's commerce fields were updated.",
		};
	}
	switch (result.reason) {
		case "stale":
			return {
				variant: "error",
				title: "This product changed since you opened it",
				description:
					"Your edit was NOT applied — the latest values are shown below. Re-apply your changes and save again.",
			};
		case "currency_mismatch":
			return {
				variant: "error",
				title: "Currency cannot be changed here",
				description: `This product is priced in ${result.currency ?? "its existing currency"}. A price edit keeps the same currency; re-currencying a product is not supported on this page.`,
			};
		case "sku_taken":
			return {
				variant: "error",
				title: "SKU already in use",
				description: `SKU "${result.sku ?? ""}" is already used by another live product. Choose a different SKU.`,
			};
		case "invalid":
			return {
				variant: "error",
				title: "Invalid value",
				description: `The field "${result.field ?? "input"}" is out of range — price must be greater than zero and measurements must be non-negative whole numbers.`,
			};
		case "not_found":
			return {
				variant: "error",
				title: "Product not found",
				description: "This product no longer exists — it may have been deleted in the CMS.",
			};
		default:
			return {
				variant: "error",
				title: "Save failed",
				description:
					"The change could not be saved — check the service connection and the admin token in Settings.",
			};
	}
}
