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
	type ProductsListFilter,
	type ProductSummaryWire,
} from "./admin-products-client.js";
import {
	backButton,
	createListDetailHandler,
	leafLevel,
	listLevel,
	readAdminTokens,
	readString,
	screenActions,
	type ListDetailInput,
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

/** This screen's namespaced action ids — the four scaffold nav verbs only
 *  (view-only slice: no custom side-effecting verb exists yet). */
const PRODUCTS_ACTIONS: ScreenActions = screenActions("products");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Products console (mirrors `ORDERS_ACTION_IDS`). Every `block_action`/
 * `form_submit` this page can emit is namespaced `products:*` and listed
 * here, so none falls through the dispatcher to the `{blocks:[]}` dead-end.
 * `products:page` is ALSO the table's `page_action_id`.
 */
export const PRODUCTS_ACTION_IDS: ReadonlySet<string> = PRODUCTS_ACTIONS.actionIds();

const PAGE_LIMIT = 25;

/** The console's own filter form values, kept alongside the opaque service
 *  cursor so paging preserves the form (mirrors `OrdersFilterForm`).
 *  `active`/`productKind` are tri-state strings ("" ⇒ both) because a Block
 *  Kit `select` has no "unset" value distinct from its options. */
interface ProductsFilterForm {
	active?: "true" | "false";
	productKind?: "physical" | "digital";
	search?: string;
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
			status: p.active ? "active" : "inactive",
			kind: p.productKind,
		})),
		page_action_id: actions.page,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text: "No products match these filters.",
	};

	const blocks: Block[] = [
		{ type: "header", text: "Products" },
		{
			type: "context",
			text: "View-only console. Filter and open a product for its full read-only detail. Stock is shown on the detail view only (kept off this list to avoid a per-row inventory lookup). Money shown in the product's own currency.",
		},
		filterForm(actions, form),
		table,
	];
	if (products.length > 0) blocks.push(openProductForm(actions, products));
	return blocks;
}

function filterForm(actions: ScreenActions, form: ProductsFilterForm): FormBlock {
	const activeOptions: SelectOption[] = [
		{ value: "", label: "All statuses" },
		{ value: "true", label: "Active" },
		{ value: "false", label: "Inactive" },
	];
	const kindOptions: SelectOption[] = [
		{ value: "", label: "All kinds" },
		{ value: "physical", label: "physical" },
		{ value: "digital", label: "digital" },
	];
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "active",
				label: "Status",
				options: activeOptions,
				initial_value: form.active ?? "",
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
					label: `${p.title ?? p.productId} — ${p.active ? "active" : "inactive"}`,
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
		render({ actions, id, detail }) {
			return detailBlocks(actions, id, detail);
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

function detailBlocks(actions: ScreenActions, id: string, p: ProductDetailWire): Block[] {
	const fields: Array<{ label: string; value: string }> = [
		{ label: "Title", value: p.title ?? "(untitled)" },
		{ label: "SKU", value: p.sku ?? "—" },
		{ label: "Price", value: formatOptionalTotal(p.priceCents, p.currency) },
		{ label: "Status", value: p.active ? "active" : "inactive" },
		{ label: "Kind", value: p.productKind },
		{ label: "Stock on hand", value: String(p.onHand) },
		{ label: "Tax class", value: p.taxClass ?? "—" },
		{ label: "Weight (g)", value: p.weightGrams === null ? "—" : String(p.weightGrams) },
		{ label: "Dimensions (mm, LxWxH)", value: dimensionsSummary(p) },
		{ label: "Created (UTC)", value: p.createdAt },
		{ label: "Updated (UTC)", value: p.updatedAt },
	];
	return [
		{ type: "header", text: p.title ?? id },
		backButton(actions.back, "← Back to products"),
		{ type: "fields", fields },
	];
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
function toClientFilter(form: ProductsFilterForm): ProductsListFilter {
	const filter: ProductsListFilter = {};
	if (form.active !== undefined) filter.active = form.active === "true";
	if (form.productKind !== undefined) filter.productKind = form.productKind;
	if (form.search !== undefined && form.search.length > 0) filter.search = form.search;
	return filter;
}

function filterFromValues(values: Record<string, unknown>): ProductsFilterForm {
	const form: ProductsFilterForm = {};
	const active = readString(values.active);
	const productKind = readString(values.productKind);
	const search = readString(values.search);
	if (active === "true" || active === "false") form.active = active;
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
