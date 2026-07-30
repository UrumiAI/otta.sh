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
	type TaxClassWire,
} from "./admin-products-client.js";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
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
	label: "Pricing & inventory",
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

/**
 * The lifecycle status label a merchant reads (product lifecycle surfacing,
 * admin-UX Increment 2): a soft-deleted row shows "deleted", never "inactive" —
 * `deletedAt` outranks `active` (a tombstoned row is always inactive too, but
 * "deleted" is the honest, non-recoverable-from-here status a merchant needs to
 * see, not the publish-gate value underneath it). Shared by the list table, the
 * "Open product" picker, and the detail fields so the three surfaces can never
 * disagree.
 *
 * FOURTH VALUE, "active (not priced)" — added by "one home per field" (PR 1b),
 * which created the state. The CMS sync now upserts a row for EVERY products
 * document, so publishing a product that has never been priced sets
 * `active: true` on a row with no sku/price. A bare "active" there would be a
 * lie: the service's catalog read filters commerce-incomplete rows in SQL
 * (`sku`, `price_cents` and `price_currency` all non-null), so no commerce data
 * comes back for it and `joinProduct` reports `purchasable: false`. Precisely:
 * the product IS still listed on `/products` — the grid is built from CMS
 * content — but it renders with no price, no add-to-cart and a "not currently
 * available" note. Listed, not sellable. The label mirrors that exact filter,
 * which is why it needs sku + price + currency and not just `active`.
 */
function statusLabel(p: {
	active: boolean;
	deletedAt: string | null;
	sku: string | null;
	priceCents: number | null;
	currency: string | null;
}): string {
	if (p.deletedAt !== null) return "deleted";
	if (!p.active) return "inactive";
	// Mirrors the service's commerce-complete predicate exactly.
	const sellable = p.sku !== null && p.priceCents !== null && p.currency !== null;
	return sellable ? "active" : "active (not priced)";
}

/** Human label for the out-of-stock policy (Increment 2 slice 5). Only `"deny"`
 *  exists this slice; any other stored value renders verbatim (forward-safe). */
function inventoryPolicyLabel(policy: string): string {
	return policy === "deny" ? "Deny (stop selling at zero stock)" : policy;
}

/** Human label for a product's tax-class reference: the registry entry's name
 *  when known, else the raw id (a class the registry read didn't include),
 *  else "—" (unset ⇒ the checkout treats it as standard). */
function taxClassLabel(taxClass: string | null, taxClasses: TaxClassWire[]): string {
	if (taxClass === null) return "—";
	const match = taxClasses.find((c) => c.id === taxClass);
	return match !== undefined ? `${match.name} (${match.id})` : taxClass;
}

/** Build the tax-class select options: a "none" clear option, every registry
 *  entry, and — if the product currently references a class the registry read
 *  did not include — that id too, so an existing value is never silently
 *  dropped from the picker. */
function taxClassOptions(current: string | null, taxClasses: TaxClassWire[]): SelectOption[] {
	const options: SelectOption[] = [{ value: "", label: "— None (standard) —" }];
	for (const c of taxClasses) options.push({ value: c.id, label: `${c.name} (${c.id})` });
	if (current !== null && !taxClasses.some((c) => c.id === current)) {
		options.push({ value: current, label: current });
	}
	return options;
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
		{ type: "header", text: "Pricing & inventory" },
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

/**
 * A small static tax-class registry the edit-form select falls back to when the
 * live registry read is unavailable/empty (Increment 2 slice 5; the guardrail
 * permits a static-seeded registry read). Deliberately the near-universal
 * defaults; the live `GET /admin/tax/classes` set, when present, is the source
 * of truth and this only backstops it.
 */
const DEFAULT_TAX_CLASSES: TaxClassWire[] = [
	{ id: "standard", name: "Standard" },
	{ id: "reduced", name: "Reduced" },
	{ id: "zero", name: "Zero-rated" },
	{ id: "digital", name: "Digital goods" },
];

function productDetailLevel() {
	return leafLevel<AdminProductsClient, ProductDetailWire>({
		load: (client, _path, id) => client.getProduct(id),
		async render({ client, actions, id, detail, notice }) {
			// SECONDARY, best-effort read (the scaffold's documented pattern): the
			// tax-class registry that sources the edit-form select. A failure/empty
			// read degrades to the static defaults, never fails the whole detail.
			let taxClasses: TaxClassWire[] = DEFAULT_TAX_CLASSES;
			try {
				const fetched = await client.getTaxClasses();
				if (fetched.length > 0) taxClasses = fetched;
			} catch {
				// keep the static fallback — a registry read must never break the detail.
			}
			return detailBlocks(actions, id, detail, notice, taxClasses);
		},
		notFound({ actions, id }) {
			return [
				{ type: "header", text: "Product not found" },
				backButton(actions.back, "← Back to pricing & inventory"),
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
	taxClasses: TaxClassWire[],
): Block[] {
	const fields: Array<{ label: string; value: string }> = [
		// READ-ONLY, exactly like Status below it, and for the same reason: the CMS
		// owns the title and the content sync is the only writer of
		// `product_commerce.title`, so a Title input here would be silently
		// overwritten by the merchant's next CMS save. Rename the CMS document
		// instead. DO NOT add a Title field to the edit form below — the port type
		// `UpdateProductCommerceFieldsInput` has no `title`, so it will not compile,
		// and the service PATCH schema is `.strict()`, so it would 400 anyway.
		// Spec rule F-2b; reasoning: `adr/0013-product-title-is-cms-owned.md`.
		//
		// THE LABEL CARRIES THE OWNER (F-2b): the merchant looking for "why can't I
		// edit this" is looking at the row, not at the help paragraph below — which
		// is already over the ≤200-char context budget and cannot absorb another
		// clause.
		{ label: "Title (set in the CMS)", value: p.title ?? "(untitled)" },
		{ label: "SKU", value: p.sku ?? "—" },
		{ label: "Price", value: formatOptionalTotal(p.priceCents, p.currency) },
		{
			label: "Compare-at price",
			value: formatOptionalTotal(p.compareAtCents, p.compareAtCurrency),
		},
		{
			label: "Unit cost (admin only)",
			value: formatOptionalTotal(p.unitCostCents, p.unitCostCurrency),
		},
		{ label: "Status", value: statusLabel(p) },
		{ label: "Kind", value: p.productKind },
		{ label: "Stock on hand", value: String(p.onHand) },
		{ label: "Inventory policy", value: inventoryPolicyLabel(p.inventoryPolicy) },
		{ label: "Tax class", value: taxClassLabel(p.taxClass, taxClasses) },
		{ label: "Weight (g)", value: p.weightGrams === null ? "—" : String(p.weightGrams) },
		{ label: "Dimensions (mm, LxWxH)", value: dimensionsSummary(p) },
		{ label: "Created (UTC)", value: p.createdAt },
		{ label: "Updated (UTC)", value: p.updatedAt },
	];
	const blocks: Block[] = [
		{ type: "header", text: p.title ?? id },
		backButton(actions.back, "← Back to pricing & inventory"),
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
		// PR 1b rewrote this line: the CMS no longer holds commercial data, so this
		// page is the sole editor of it, and setting a SKU here is what creates the
		// product's stock record. Kept SHORTER than the copy it replaces, and the
		// "no overselling" phrasing is gone (`docs/admin/ADMIN-CONSOLE.md` X-20
		// bans it in a rendered string; the code comments that document the
		// invariant are exempt and stay). It is still over the ≤200-char context
		// budget (X-11) — splitting it into three sub-200 lines is the Pricing &
		// inventory rebuild's job (spec §12.1), not this merge's.
		text: 'This is the only place pricing, stock and the other commercial fields are edited — the CMS holds no commerce data. Status is the CMS publish state: publish or unpublish the document to change it. Title and images work the same way: rename the document in the CMS and the new title appears here on the next save. Stock starts at zero when a SKU is set here; add units with Restock below. Price, compare-at and unit cost all use the product\'s one currency — set the price first on a new product. Compare-at is the struck-through "was" price; a value at or below the price is allowed and saved as-is, so double-check it. Unit cost is admin-only margin data, never shown to buyers. Out-of-stock policy is Deny only for now: the store stops selling at zero stock; backorders are a future capability.',
	});
	blocks.push(editForm(actions, p, taxClasses));

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
function editForm(
	actions: ScreenActions,
	p: ProductDetailWire,
	taxClasses: TaxClassWire[],
): FormBlock {
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
		// NO Title input, deliberately — see the read-only Title row in
		// `detailBlocks` and `adr/0013-product-title-is-cms-owned.md`.
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
			type: "text_input",
			action_id: "compareAt",
			label: `Compare-at / was price (${p.currency ?? "same as price"}, e.g. 29.99) — blank to clear`,
			...(p.compareAtCents !== null
				? { initial_value: formatPriceMinorUnits(p.compareAtCents) }
				: {}),
			placeholder: "29.99",
		},
		{
			type: "text_input",
			action_id: "unitCost",
			label: `Unit cost — admin only, never shown to buyers (${p.currency ?? "same as price"}) — blank to clear`,
			...(p.unitCostCents !== null
				? { initial_value: formatPriceMinorUnits(p.unitCostCents) }
				: {}),
			placeholder: "8.50",
		},
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
			type: "select",
			action_id: "taxClass",
			label: "Tax class",
			options: taxClassOptions(p.taxClass, taxClasses),
			initial_value: p.taxClass ?? "",
		},
		{
			// Out-of-stock policy — DENY-ONLY this slice. The select shows a single
			// option (no `allow_backorder`): the no-oversell invariant is
			// non-negotiable, and backorders are a future capability that needs its
			// own races + an ADR. Rendered as a select (not omitted) so the field is
			// visible and future-extensible, with the context line below explaining
			// the constraint.
			type: "select",
			action_id: "inventoryPolicy",
			label: "When out of stock",
			options: [{ value: "deny", label: "Deny — stop selling at zero stock" }],
			initial_value: "deny",
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
			{ type: "header" as const, text: "Pricing & inventory" },
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
// The exact-integer-string parse/format pair lives in `./money-input.js`,
// SHARED with the Shipping console; the one behavioral fork (whether zero is
// a valid amount) is that module's explicit `allowZero` parameter. These two
// thin wrappers pin the Products screens' choice — prices are strictly
// positive (the domain's own `price > 0` invariant: a free product is
// "unpriced", not priced at 0) — in one place instead of at every call site.

/** Parse a merchant-entered decimal price into integer MINOR UNITS; null for
 *  any non-conforming or NON-POSITIVE input (never throws). Exported for its
 *  own unit test. */
export function parsePriceMinorUnits(input: string): number | null {
	return parseMinorUnitsInput(input, { allowZero: false });
}

/** Format integer minor units back to a hundredths decimal string for a text
 *  input's initial value. Exported for its own unit test. */
export function formatPriceMinorUnits(minorUnits: number): string {
	return formatMinorUnitsInput(minorUnits);
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

	// `values.title` is NOT read: the form has no Title input, and the service's
	// `.strict()` PATCH schema rejects one outright (ADR-0013). A stale bundle's
	// stray value dies here rather than travelling to a 400.
	const sku = readString(values.sku)?.trim();
	if (sku !== undefined && sku.length > 0) wire.sku = sku;

	// The row currency (shared by price / compare-at / cost). For an already-
	// priced product this is the fixed carrier (= the product currency); for a
	// first pricing it is the merchant-entered code. Parsed ONCE so all three
	// money fields agree by construction.
	const currencyStr = readString(values.currency)?.trim().toUpperCase();
	const currency =
		currencyStr !== undefined && /^[A-Z]{3}$/.test(currencyStr) ? currencyStr : undefined;

	const priceStr = readString(values.price)?.trim();
	if (priceStr !== undefined && priceStr.length > 0) {
		const minorUnits = parsePriceMinorUnits(priceStr);
		if (minorUnits === null) {
			return {
				ok: false,
				message: "Price must be a positive amount like 19.99 (up to two decimal places).",
			};
		}
		if (currency === undefined) {
			return { ok: false, message: "Currency must be a 3-letter ISO-4217 code like USD." };
		}
		wire.price = { amount: minorUnits, currency };
	}

	// compare-at / unit cost: a BLANK entry clears the field (null); a value is
	// parsed to minor units and MUST carry the row currency. They can only be set
	// once the product has (or is being given) a currency — otherwise there is
	// nothing to match. Both share the same `parseMoneyField` shape.
	for (const [field, key] of [
		["compareAt", "compareAtPrice"],
		["unitCost", "unitCost"],
	] as const) {
		const raw = readString(values[field]);
		if (raw === undefined) continue; // field not in the form ⇒ preserve.
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			wire[key] = null; // explicit clear.
			continue;
		}
		const minorUnits = parsePriceMinorUnits(trimmed);
		if (minorUnits === null) {
			return {
				ok: false,
				message: `${field === "compareAt" ? "Compare-at price" : "Unit cost"} must be a positive amount like 29.99, or blank to clear.`,
			};
		}
		const rowCurrency = currency ?? (wire.price !== undefined ? wire.price.currency : undefined);
		if (rowCurrency === undefined) {
			return {
				ok: false,
				message:
					"Set the product's price and currency before adding a compare-at price or unit cost.",
			};
		}
		wire[key] = { amount: minorUnits, currency: rowCurrency };
	}

	const productKind = readString(values.productKind);
	if (productKind === "physical" || productKind === "digital") wire.productKind = productKind;

	// inventoryPolicy: only "deny" is a legal value this slice (the select offers
	// no other). Anything else is ignored (preserve) rather than sent.
	const inventoryPolicy = readString(values.inventoryPolicy);
	if (inventoryPolicy === "deny") wire.inventoryPolicy = "deny";

	// taxClass (now a registry select): an explicit blank clears it (null); a
	// non-blank value is the chosen `TaxClass.id`.
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
		// No `title` component — the wire cannot carry one (ADR-0013). Removing it
		// CHANGES the derived key, which is correct: it is a different payload.
		wire.taxClass ?? null,
		wire.compareAtPrice ?? null,
		wire.unitCost ?? null,
		wire.inventoryPolicy ?? null,
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
			// SHOULD NEVER HAPPEN since PR 1a: a stock record is created the moment
			// a product gets a SKU, on both write paths (this edit form and the
			// integrator PUT) — including a SKU rename, since the seed follows the
			// row's resulting sku. Kept as defence for the two cases still able to
			// reach it: a product priced BEFORE 1a (there is no backfill), and a
			// write that bypasses the use-case. Re-saving the SKU here fixes both.
			return {
				variant: "error",
				title: "No stock record yet",
				description:
					"This product has a SKU but no stock record, so there is nothing to add to or remove from. A stock record is normally created as soon as a SKU is set — re-save the SKU on the edit form above to create one.",
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
