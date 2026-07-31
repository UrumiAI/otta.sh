import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	AdminPageConfig,
	Block,
	FormBlock,
	RouteHandler,
	SelectOption,
	TabPanel,
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
import { ReportingSettingsClient } from "./reporting-client.js";
import {
	asRecord,
	backButton,
	carriedForm,
	createListDetailHandler,
	customAction,
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
	readString,
	screenActions,
	type ListDetailInput,
	type NavPath,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Pricing & inventory console (`docs/admin/ADMIN-CONSOLE.md` §12.1) —
 * the last of the seven screens re-laid onto the shared list/detail scaffold,
 * pattern-matched against the reference screen (`orders-page.ts`).
 *
 * FIVE THINGS THAT DIFFER FROM ORDERS, worth reading before touching this file:
 *
 *  1. TWO FIELDS ON THIS SCREEN ARE OWNED BY THE CMS (F-2b, X-52): `Title` and
 *     `Status` (the `active` publish gate). Both render as READ-ONLY `fields`
 *     rows whose LABEL names the owner (`Title (set in the CMS)`,
 *     `Status (set in the CMS)`) and neither has a form field anywhere on this
 *     screen — `ProductEditWire` has no `title`/`active` member, so re-adding
 *     one fails to compile. See `adr/0013-product-title-is-cms-owned.md`.
 *  2. THE EDIT FORM IS SPLIT INTO THREE SIBLING FORMS (F-5a), not one. This is
 *     legal here — and ONLY here among the console's PUT/PATCH forms — because
 *     `updateProduct` is a verified sparse PATCH at every layer: `buildEditWire`
 *     assigns conditionally (a field absent from `values` is omitted from the
 *     wire, never nulled), every `ProductEditWire` member is `.optional()`
 *     (`service/src/schemas.ts`), the route spreads
 *     `...(body.x !== undefined ? {x} : {})` (`service/src/routes/admin.ts`),
 *     the use case threads the input straight through
 *     (`domain/src/product-commerce/use-cases.ts`), and the store's
 *     `updateCommerceFields` builds its `SET` clause the same way — a key
 *     absent from `input` never enters `set`
 *     (`store-postgres/src/kysely-product-commerce-store.ts`). Contrast the
 *     Coupons screen, forbidden from this split because `updateCoupon` is a
 *     PUT whose service handler coerces an absent key to `null`.
 *  3. OPEN-GROUP STATE IS STICKY (F-5a-i, B-5, B-8). A sibling the operator
 *     expanded is still expanded after saving a DIFFERENT sibling remounts it —
 *     unsubmitted edits in the others are discarded more often than "one group
 *     is realistically open" would suggest. One `context` line says so, once,
 *     above the three groups (not per group).
 *  4. ONLY `Remove stock` STAGES A CONFIRM (DA-3, DA-5's second exception).
 *     Restocking is DA-4 (one-shot, reversible by nature); a removal is not an
 *     undo of anything — it appends a second ledger entry — so it is the ONE
 *     act on this screen with `style:"danger"` and a `confirm`. Its
 *     idempotency key and its DA-3a re-read both use the observed `onHand` as
 *     the watermark (F-2a), exactly like a refund's `refundedSoFarCents`.
 *  5. NO NONCE, ANYWHERE (F-2a). The restock/removal keys are
 *     `${productId}:${direction}:${onHandAtRender}:${qty}` — content plus the
 *     watermark the operator saw — never a `crypto.randomUUID()` minted at
 *     render time.
 *  6. IT IS THE ONE SCREEN THAT READS TWO SERVICE SURFACES. The list and the
 *     detail both render stock, and what counts as LOW is the store's
 *     `lowStockThreshold` — a settings value, not a product field. So
 *     {@link ProductsScreenClient} pairs the products client with a
 *     settings client, and every threshold read is SECONDARY (E-1): it
 *     degrades the badge, never the page.
 *
 * Built on the shared list/detail scaffold (`./scaffold`).
 */
export const PRODUCTS_PAGE: AdminPageConfig = {
	path: "/products",
	label: "Pricing & inventory",
	icon: "box",
};

/** This screen's namespaced action ids. */
const PRODUCTS_ACTIONS: ScreenActions = screenActions("products");
/** The three split edit-form submits (F-5a) — one per sibling group. */
const ACTION_SAVE_IDENTITY = PRODUCTS_ACTIONS.custom("save-identity");
const ACTION_SAVE_PRICE = PRODUCTS_ACTIONS.custom("save-price");
const ACTION_SAVE_SHIPPING = PRODUCTS_ACTIONS.custom("save-shipping");
/** Restock stays DA-4: one-shot, no staging. */
const ACTION_RESTOCK = PRODUCTS_ACTIONS.custom("restock");
/** DA-3 state 1 → state 2 for a stock removal (the screen's one destructive act). */
const ACTION_REMOVE_REVIEW = PRODUCTS_ACTIONS.custom("remove-stock-review");
/** The DA-3 state-2 confirm for a stock removal. */
const ACTION_REMOVE = PRODUCTS_ACTIONS.custom("remove-stock");

export const PRODUCTS_ACTION_IDS: ReadonlySet<string> = PRODUCTS_ACTIONS.actionIds(
	"save-identity",
	"save-price",
	"save-shipping",
	"restock",
	"remove-stock-review",
	"remove-stock",
);

const PAGE_LIMIT = 25;

/** A `select`/`combobox` sentinel meaning "no constraint". NEVER `""` — the
 *  pinned renderer treats an empty value as "no value" and draws a blank
 *  trigger (R-17a), and the trigger renders the raw VALUE, so a sentinel has
 *  to read acceptably as a word (F-6a, F-6c). */
const ANY = "any";
/** The same, for the "Open product" picker with nothing selected (L-7). */
const NONE = "none";
/** The tax-class select's "clear it" sentinel — never `""` (F-6a). */
const NO_TAX_CLASS = "none";

/** §1's accordion-label budget (X-11). */
const LABEL_BUDGET = 60;

/** The console's own filter form values, kept alongside the opaque service
 *  cursor so paging preserves the form. `active`/`productKind` are tri-state
 *  strings (`ANY` ⇒ no constraint) because a Block Kit `select` has no
 *  "unset" value distinct from its options.
 *
 *  `archived` is the archive-view toggle: unset ⇒ the default (live products
 *  only, active + inactive both listed); `"true"` ⇒ ONLY soft-deleted rows. A
 *  soft-deleted row is always inactive, so the combined "Status" select
 *  offers the two as ONE mutually-exclusive choice rather than two
 *  independently-toggleable axes.
 *
 *  `lowStock` is the "Low stock only" toggle: unset ⇒ every row; `"true"` ⇒
 *  only rows whose on-hand count is at or below the store's threshold. Stored
 *  as the same `"true"` string as `archived` because this object is JSON —
 *  it rides in the list cursor (`f`) so the filter survives paging. */
interface ProductsFilterForm {
	active?: "true" | "false";
	productKind?: "physical" | "digital";
	search?: string;
	archived?: "true";
	lowStock?: "true";
}

/**
 * THIS SCREEN'S RENDER STATE (DA-3a-iii) — one discriminated union, named at
 * {@link createProductsPageHandler}'s `createListDetailHandler<ProductsRenderState>`.
 * Products has exactly one destructive, staged flow (removing stock), so this
 * union has two members instead of Orders' four:
 *
 *  - `remove-staged` is DA-3 state 2: the typed quantity has passed every
 *    check (parses, ≤ the live on-hand), so it carries the parsed qty AND the
 *    watermark (the on-hand figure the re-read just confirmed) that the
 *    state-2 confirm button echoes into `value` for the write to re-compare.
 *  - `remove-draft` is a refusal (a bad parse, a missing watermark, or the
 *    qty exceeding the live on-hand): state 1 re-rendered into the SAME
 *    group, forced open, flattened, with the typed quantity prefilled and no
 *    confirm control (DA-3a-i).
 *
 * `qtyInput` on the draft member is the operator's RAW TEXT, not a parsed
 * number — DA-3a-iii property 5: the commonest refusal is an unparseable
 * quantity, and on that path there is no integer to re-derive a prefill from.
 */
type ProductsRenderState =
	| { kind: "remove-staged"; qty: number; onHand: number }
	| { kind: "remove-draft"; qtyInput: string };

/** The em-dash BlockInteraction envelope this page consumes. */
export type ProductsPageInput = ListDetailInput;

/**
 * The two service surfaces this screen reads (see the file header's point 6).
 *
 * `settings` is here for exactly ONE field — `lowStockThreshold`, the number
 * that decides whether an on-hand count reads `Low` — which lives on the admin
 * settings surface (ADR-0010's guarded `GET /settings`), not on any product.
 * It is never written from this screen: the threshold is edited on Settings,
 * and a form field for it here would be a second home for one value (G2).
 */
interface ProductsScreenClient {
	products: AdminProductsClient;
	settings: ReportingSettingsClient;
}

export function createProductsPageHandler(): RouteHandler<ProductsPageInput> {
	return createListDetailHandler<ProductsRenderState>({
		actions: PRODUCTS_ACTIONS,
		async createClient(ctx): Promise<ProductsScreenClient> {
			const tokens = await readAdminTokens(ctx);
			const transport = {
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...(tokens.adminToken !== undefined ? { adminToken: tokens.adminToken } : {}),
			};
			return {
				products: new AdminProductsClient({
					...transport,
					// The edit PATCH and the stock-movement POSTs are NON-GETs the write
					// gate blocks without this.
					...(tokens.serviceToken !== undefined ? { serviceToken: tokens.serviceToken } : {}),
				}),
				// GET-only from this screen, so it carries the admin token alone — the
				// write-gate token belongs on the surface that writes.
				settings: new ReportingSettingsClient(transport),
			};
		},
		// The "Open product" picker carries the product id in `values.productId`;
		// the target is a single-level drill, so the path is just `[productId]`.
		// The L-7 "nothing selected" sentinel re-renders the list unchanged.
		parseOpen(input) {
			const productId = readString(input.values?.productId);
			if (productId === undefined || productId.length === 0 || productId === NONE) {
				return undefined;
			}
			return { targetPath: [productId] };
		},
		levels: [productsListLevel(), productDetailLevel()],
		customActions: (() => {
			const save = saveAction();
			return {
				[ACTION_SAVE_IDENTITY]: save,
				[ACTION_SAVE_PRICE]: save,
				[ACTION_SAVE_SHIPPING]: save,
				[ACTION_RESTOCK]: restockAction(),
				[ACTION_REMOVE_REVIEW]: removeStockReviewAction(),
				[ACTION_REMOVE]: removeStockAction(),
			};
		})(),
	});
}

// -- level 0: the products list (§12.1 list) ----------------------------------

/**
 * What the LIST knows about stock, decided in `fetchPage` and handed to
 * `render`. It has to be decided there because `ListLevelDef.render` is
 * SYNCHRONOUS while the low-stock threshold is a service read — so the row a
 * renderer receives is a product plus its already-resolved `On hand` cell,
 * not a bare `ProductSummaryWire`.
 */
interface ProductsListRow {
	product: ProductSummaryWire;
	/** The pre-resolved `On hand` cell text — see {@link onHandCell}. */
	onHand: string;
	/** Page-wide stock context, the SAME object on every row of a page: a
	 *  renderer reads it off any row it has, and an empty page has nothing to
	 *  say about stock in the first place. */
	stock: StockPageContext;
}

interface StockPageContext {
	/** The store's low-stock threshold, or `null` when the settings read failed
	 *  (which costs the `Low` band and nothing else). */
	threshold: number | null;
	/** The page came back carrying no stock figure on ANY row — a degraded read
	 *  rather than a catalog fact. Every cell reads `—` and the list says so
	 *  once, in a banner, inside a 200 (G5/E-1). */
	unreadable: boolean;
	/** "Low stock only" was asked for and could not be honoured (no threshold,
	 *  or no stock to compare it against), so the page is UNFILTERED and says
	 *  so — never silently the wrong set of rows. */
	filterUnavailable: boolean;
}

function productsListLevel() {
	return listLevel<ProductsScreenClient, ProductsFilterForm, ProductsListRow>({
		limit: PAGE_LIMIT,
		filterFromValues,
		async fetchPage(client, _path, form, opts) {
			// The threshold read runs ALONGSIDE the page read and is secondary in
			// both directions: it can never delay the list beyond its own latency,
			// and it can never fail it (E-1) — `readLowStockThreshold` resolves to
			// null instead of throwing.
			const [page, threshold] = await Promise.all([
				client.products.listProducts(toClientFilter(form), {
					limit: opts.limit,
					...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
				}),
				readLowStockThreshold(client.settings),
			]);
			const read = page.products.map((product) => ({ product, onHand: readOnHand(product) }));
			const unreadable = read.length > 0 && read.every((r) => r.onHand === undefined);
			const wantsLowStock = form.lowStock === "true";
			const canFilter = threshold !== null && !unreadable;
			const stock: StockPageContext = {
				threshold,
				unreadable,
				filterUnavailable: wantsLowStock && !canFilter,
			};
			// "Low stock only" is applied to the fetched page, not to the query: the
			// service's products list has no stock predicate, and the measurement
			// behind that (INC-03) chose ONE unconditional join over a gated one
			// precisely because the gated shape had to walk ~9x the rows. So the
			// filter narrows what this page shows and `Load more` keeps scanning —
			// a row with no inventory record is never "low", only unknown.
			const visible =
				wantsLowStock && canFilter && threshold !== null
					? read.filter((r) => r.onHand !== undefined && r.onHand !== null && r.onHand <= threshold)
					: read;
			return {
				items: visible.map((r) => ({
					product: r.product,
					onHand: onHandCell(r.onHand, threshold),
					stock,
				})),
				nextCursor: page.nextCursor,
			};
		},
		render({ actions, path, filter, items, nextToken, notice }) {
			return listBlocks(actions, path, filter, items, nextToken, notice);
		},
		onError: () => failClosed(),
	});
}

/**
 * Read one list row's on-hand count off the wire, keeping THREE cases apart
 * that must never be folded into each other:
 *
 *  - a number — a known count, `0` included ("out of stock" is a FACT);
 *  - `null` — the sku carries no inventory record, so the count is unknown for
 *    this row (and a row with no sku at all can have nothing else);
 *  - `undefined` — the response carried no stock figure at all. `ProductSummaryWire`
 *    types `onHand` as required, so this is reachable only at runtime (a service
 *    older than the on-hand projection, or one whose stock read degraded), which
 *    is why it is read as `unknown` here instead of trusted.
 */
function readOnHand(p: ProductSummaryWire): number | null | undefined {
	const raw: unknown = (p as { onHand?: unknown }).onHand;
	if (raw === null) return null;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * The `On hand` cell — text, always, and never an empty string: the pinned
 * renderer's `format:"number"` cell does `Number(value)` and prints the RAW
 * string only when that is NaN (`blocks/table.tsx`), so `"—"` and
 * `"0 · Out of stock"` survive verbatim, `"12"` renders as a number, and `""`
 * or a missing key would render as `0` — a zero nobody counted.
 *
 * BADGE THE EXCEPTIONS AND ONLY THEM (T-5 keeps `Status` as the table's one
 * badge COLUMN, so the exception rides in the cell's own text): `0` is out of
 * stock, `1..threshold` is low, and anything above the threshold is a plain
 * count that competes with nothing.
 */
function onHandCell(onHand: number | null | undefined, threshold: number | null): string {
	if (onHand === undefined || onHand === null) return "—";
	if (onHand <= 0) return `${onHand} · Out of stock`;
	if (threshold !== null && onHand <= threshold) return `${onHand} · Low`;
	return String(onHand);
}

/** The store's low-stock threshold, or null when it cannot be read. A refusal
 *  here costs the `Low` band alone — a count still renders and `0` still reads
 *  `Out of stock`, neither of which needs a threshold. */
async function readLowStockThreshold(client: ReportingSettingsClient): Promise<number | null> {
	try {
		const { lowStockThreshold } = await client.getSettings();
		return Number.isSafeInteger(lowStockThreshold) && lowStockThreshold >= 0
			? lowStockThreshold
			: null;
	} catch {
		// A settings read is never allowed to take the screen with it (E-1).
		return null;
	}
}

/** The ONE stock-degradation banner. Two cases share a single slot because
 *  X-31 caps a response at two top-level banners and the notice may already
 *  hold one. `alert`, never `error`: the list rendered, and E-1/E-6 keep the
 *  error variant for a fail-close or a refusal. */
function stockBanner(stock: StockPageContext | undefined): Block | undefined {
	if (stock === undefined) return undefined;
	if (stock.unreadable) {
		return {
			type: "banner",
			variant: "alert",
			title: "Stock levels are unavailable",
			description:
				"On hand reads — for every row here. Open a product to read its stock, and check the service connection and the admin token in Settings.",
		};
	}
	if (stock.filterUnavailable) {
		return {
			type: "banner",
			variant: "alert",
			title: "Low stock only was not applied",
			description:
				"The store's low-stock threshold could not be read, so every product is listed. Set it under Checkout & holds on Settings, then apply the filter again.",
		};
	}
	return undefined;
}

/**
 * The lifecycle status label a merchant reads: a soft-deleted row shows
 * "deleted", never "inactive" — `deletedAt` outranks `active` (a tombstoned
 * row is always inactive too, but "deleted" is the honest, non-recoverable-
 * from-here status a merchant needs to see). Shared by the list table, the
 * "Open product" picker, and the detail fields so the three surfaces can
 * never disagree.
 *
 * FOUR VALUES: the CMS sync upserts a `product_commerce` row for EVERY
 * products document ("one home per field" PR 1b), so publishing a product
 * that has never been priced sets `active: true` on a row with no
 * sku/price. A bare "active" there would be a lie — the service's catalog
 * read filters commerce-incomplete rows — so this mirrors that exact filter.
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
	const sellable = p.sku !== null && p.priceCents !== null && p.currency !== null;
	return sellable ? "active" : "active (not priced)";
}

/** Human label for the out-of-stock policy (read-only display; the single-option
 *  select that used to carry this is deleted per F-3 — see the context line in
 *  `productPanel`). Only `"deny"` exists this slice; any other stored value
 *  renders verbatim (forward-safe). */
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

/** Build the tax-class select options: a "clear it" sentinel (never `""` —
 *  F-6a), every registry entry, and — if the product currently references a
 *  class the registry read did not include — that id too, so an existing
 *  value is never silently dropped from the picker. */
function taxClassOptions(current: string | null, taxClasses: TaxClassWire[]): SelectOption[] {
	const options: SelectOption[] = [{ value: NO_TAX_CLASS, label: "— None (standard) —" }];
	for (const c of taxClasses) options.push({ value: c.id, label: `${c.name} (${c.id})` });
	if (current !== null && !taxClasses.some((c) => c.id === current)) {
		options.push({ value: current, label: current });
	}
	return options;
}

/** §12.1's list block order, exactly: `header` · `context` · notice `banner` ·
 *  the COLLAPSED filter panel · the active-filter `section` · THE DATA (or
 *  `empty` in its place) · the "Open product" drill-in. Nothing else may
 *  precede the table (P-1/L-1). */
function listBlocks(
	actions: ScreenActions,
	path: NavPath,
	form: ProductsFilterForm,
	rows: ProductsListRow[],
	nextToken: string | undefined,
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Pricing & inventory" },
		{
			type: "context",
			// 97 chars ≤ 140 (§1). The "Archived" explanation lives in the filter
			// accordion; stock is now a COLUMN, so this line says what the count
			// means instead of pointing at the detail.
			text: "Filter and open a product. Money in each product's own currency; On hand is what can be sold now.",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	// Page-wide and identical on every row, so any row answers for the page.
	const stock = rows[0]?.stock;
	const degraded = stockBanner(stock);
	if (degraded !== undefined) blocks.push(degraded);

	// ONE PART PER AUTHORED FILTER FIELD (L-3): the combined Status select is
	// one field (active/archived share it), so it contributes one part.
	const statusValue = form.archived === "true" ? "archived" : form.active;
	const activeFilters = [
		statusValue !== undefined && `status: ${statusValue}`,
		form.productKind !== undefined && `kind: ${form.productKind}`,
		form.lowStock === "true" && "stock: low only",
		form.search !== undefined && `search: ${form.search}`,
	];
	blocks.push(
		filterPanel({
			form: filterForm(actions, path, form),
			// STABLE across an apply AND across `Clear filters` (B-7).
			blockId: "products:filters",
			activeFilters,
		}),
	);
	const summary = filterSummary(activeFilters);
	if (summary !== undefined) {
		blocks.push({
			type: "section",
			text: summary,
			accessory: {
				type: "button",
				action_id: actions.applyFilter,
				label: "Clear filters",
				value: { [PATH_FIELD]: encodePath(path) },
			},
			block_id: "products:filter-summary",
		});
	}

	const filtered = summary !== undefined;
	if (rows.length === 0 && !filtered) {
		// E-2: the primary collection at its TRUE zero state. No `actions` —
		// products originate in the CMS, not on this console.
		blocks.push(
			emptyState({
				title: "No products yet",
				description:
					"Products appear here as soon as a product document is saved in the CMS — pricing them is the next step, not a precondition.",
				size: "base",
				blockId: "products:empty",
			}),
		);
		return blocks;
	}

	blocks.push({
		type: "table",
		block_id: "products:list",
		columns: [
			{ key: "title", label: "Title" },
			{ key: "sku", label: "SKU", format: "code" },
			{ key: "status", label: "Status", format: "badge" }, // the ONE badge column (T-5)
			// `Kind` column DELETED: near-constant across a live catalog, so its
			// badge would be a column of identical pills (T-5, X-4). Kind is on
			// the detail's identity strip.
			//
			// `On hand` is a COUNT, never money — `format: "number"` is right here
			// and would be an X-9 violation one column along.
			{ key: "onHand", label: "On hand", format: "number" },
			{ key: "price", label: "Price" }, // money LAST, pre-formatted (T-2, M-1)
		],
		rows: rows.map((r) => ({
			title: r.product.title ?? "(untitled)",
			sku: r.product.sku ?? "—",
			status: statusLabel(r.product),
			onHand: r.onHand,
			price: formatOptionalTotal(r.product.priceCents, r.product.currency),
		})),
		page_action_id: actions.page,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text: "No products match these filters.",
	});
	if (rows.length > 0) blocks.push(openProductForm(actions, path, rows));
	return blocks;
}

/**
 * The four-field filter (L-2 ⇒ an accordion, `filterPanel`'s default
 * `inlineUpTo` of 2), built by {@link carriedForm} LAST so the digest it
 * carries matches the form.
 *
 * "Low stock only" is a `toggle`, not a fifth select: it is one boolean, and a
 * select would cost a second full row on a panel the audit already calls too
 * tall. It states WHERE the threshold lives rather than its value — the number
 * is a service read, this render is synchronous, and a filter control that
 * sometimes carries a number and sometimes does not is worse than one that
 * never does.
 */
function filterForm(actions: ScreenActions, path: NavPath, form: ProductsFilterForm): FormBlock {
	const statusOptions: SelectOption[] = [
		{ value: ANY, label: "All statuses (live)" },
		{ value: "true", label: "Active" },
		{ value: "false", label: "Inactive" },
		{ value: "archived", label: "Archived (deleted)" },
	];
	const kindOptions: SelectOption[] = [
		{ value: ANY, label: "All kinds" },
		{ value: "physical", label: "physical" },
		{ value: "digital", label: "digital" },
	];
	const statusInitialValue = form.archived === "true" ? "archived" : (form.active ?? ANY);
	return carriedForm({
		namespace: "products:filter",
		context: { [PATH_FIELD]: encodePath(path) },
		form: {
			type: "form",
			fields: [
				{
					// NOTE: the wire action_id is "status", not "active" — the CMS-owned
					// `active` publish gate (F-2b, X-52) is a DIFFERENT thing from this
					// filter parameter, and sharing a name would make the mechanical
					// owned-field guard unable to tell a filter control from a write.
					type: "select",
					action_id: "status",
					label: "Status",
					options: statusOptions,
					initial_value: statusInitialValue,
				},
				{
					type: "select",
					action_id: "productKind",
					label: "Kind",
					options: kindOptions,
					initial_value: form.productKind ?? ANY,
				},
				{
					type: "toggle",
					action_id: "lowStock",
					label: "Low stock only",
					description: "Products at or below the low-stock threshold set on Settings.",
					// F-6b/X-24: REQUIRED — a toggle reads its value at mount only.
					initial_value: form.lowStock === "true",
				},
				{
					type: "text_input",
					action_id: "search",
					label: "Search (SKU exact, or title contains)",
					...(form.search !== undefined ? { initial_value: form.search } : {}),
				},
			],
			submit: { label: "Apply filters", action_id: actions.applyFilter },
		},
	});
}

/**
 * The drill-in picker (L-7): a `combobox`, because a page holds up to 25 rows
 * and this field never prefills (R-12a, F-6, X-30). The option VALUE is the
 * product id; the LABEL never contains it (X-22, M-7, D4) — it is
 * `<title> · <sku> · <status>`, where `statusLabel` is the SAME helper the
 * table's Status column and the detail's Status row use, so the three surfaces
 * cannot disagree.
 *
 * WHAT THE SEPARATOR AND THE SKU FIX, both observed on the rendered screen:
 *
 *  - `·` REPLACES ` — `. A title is merchant prose and can hold an em-dash of
 *    its own: `Washed Linen Apron — Natural — active` reads as three fields of
 *    which two are the title, and nothing in the label says which. `·` is not
 *    a character a product title spends.
 *  - THE SKU IS IN THE LABEL. Low stock is reported by sku and this picker was
 *    keyed by title alone, which left the sku→title mapping in the operator's
 *    head. A null sku DROPS its segment instead of rendering a dash — a
 *    freshly-synced row would otherwise read "… · — · active (not priced)",
 *    noise on a control whose whole job is identification. `price` stays out:
 *    it is already a column, and money in a picker label competes with the
 *    handle. A null title reads `(untitled)`, the same as the table's Title
 *    cell, and never the product id.
 */
function openProductForm(
	actions: ScreenActions,
	path: NavPath,
	rows: ProductsListRow[],
): FormBlock {
	return carriedForm({
		namespace: "products:open",
		context: { [PATH_FIELD]: encodePath(path) },
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "productId",
					label: "Open product",
					placeholder: "Choose a product…",
					options: [
						{ value: NONE, label: "Choose a product…" },
						...rows.map(({ product: p }) => ({
							value: p.productId,
							label: [p.title ?? "(untitled)", p.sku, statusLabel(p)]
								.filter((part) => part !== null)
								.join(" · "),
						})),
					],
					initial_value: NONE,
				},
			],
			submit: { label: "Open product", action_id: actions.open },
		},
	});
}

// -- level 1: the product detail (§12.1 detail) -------------------------------

/**
 * A small static tax-class registry the edit-form select falls back to when
 * the live registry read is unavailable/empty. Deliberately the near-
 * universal defaults; the live `GET /admin/tax/classes` set, when present, is
 * the source of truth and this only backstops it.
 */
const DEFAULT_TAX_CLASSES: TaxClassWire[] = [
	{ id: "standard", name: "Standard" },
	{ id: "reduced", name: "Reduced" },
	{ id: "zero", name: "Zero-rated" },
	{ id: "digital", name: "Digital goods" },
];

/** The live tax-class registry, falling back to {@link DEFAULT_TAX_CLASSES} on
 *  a failed or empty read — a registry read must never break the detail (E-1). */
async function readTaxClasses(client: AdminProductsClient): Promise<TaxClassWire[]> {
	try {
		const fetched = await client.getTaxClasses();
		return fetched.length > 0 ? fetched : DEFAULT_TAX_CLASSES;
	} catch {
		return DEFAULT_TAX_CLASSES;
	}
}

function productDetailLevel() {
	return leafLevel<ProductsScreenClient, ProductDetailWire, ProductsRenderState>({
		load: (client, _path, id) => client.products.getProduct(id),
		async render({ client, actions, id, detail, notice, renderState }) {
			// TWO SECONDARY, best-effort reads, run together: the tax-class registry
			// that sources the edit-form select, and the low-stock threshold that
			// decides whether this product's count reads `Low`. Either one failing
			// degrades its own control and nothing else — never the detail (E-1).
			const [taxClasses, threshold] = await Promise.all([
				readTaxClasses(client.products),
				readLowStockThreshold(client.settings),
			]);
			return detailBlocks(actions, id, detail, notice, renderState, taxClasses, threshold);
		},
		notFound({ actions, path, id }) {
			return [
				{ type: "header", text: "Product not found" },
				backButton(actions.back, "← Back to pricing & inventory", path),
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

/**
 * D-5, evaluated ONCE per rendered response: at most one group is
 * `default_open: true` (X-18), and which one is computed, never chosen.
 *
 * RULE 1 — the staged-confirm-or-refusal override, keyed on
 * `renderState !== undefined`: BOTH members of {@link ProductsRenderState} name
 * the "remove" group. Every other group is `false`.
 *
 * RULE 2 — otherwise: this screen's named primary edit group is `Identity`
 * (D-5 rank 3), open whenever the record is editable — i.e. not tombstoned.
 * Products has no reconciliation flag and no `paid`/`processing`-shaped
 * fulfilment state, so ranks 1–2 never apply here.
 */
type OpenGroup = "identity" | "remove" | undefined;

function openGroup(p: ProductDetailWire, renderState: ProductsRenderState | undefined): OpenGroup {
	if (renderState !== undefined) return "remove";
	if (p.deletedAt !== null) return undefined;
	return "identity";
}

/** §4's detail skeleton: blocks 1–5 outside the tabs (header, back, up to two
 *  banners, the identity strip), then the two constant panels (D-2:
 *  `Product` · `Stock`). */
function detailBlocks(
	actions: ScreenActions,
	id: string,
	p: ProductDetailWire,
	notice: Notice | undefined,
	renderState: ProductsRenderState | undefined,
	taxClasses: TaxClassWire[],
	threshold: number | null,
): Block[] {
	const open = openGroup(p, renderState);
	const blocks: Block[] = [
		// M-10: the human handle (product title) stands in for the uuid when one
		// exists.
		{ type: "header", text: p.title ?? id },
		backButton(actions.back, "← Back to pricing & inventory"),
	];
	// At most 2 banners at the top level (X-31): the notice and the tombstone
	// alert.
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	if (p.deletedAt !== null) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "This product was deleted in the CMS",
			description: `Deleted on ${utc(p.deletedAt)}. It cannot be edited or restocked from here; existing orders that included it are unaffected.`,
		});
	}
	// The identity strip: "what am I looking at, and is it healthy" without a
	// click. 6 entries in 3 row-major PAIRS (R-3, §4). `Title` and `Status` are
	// CMS-owned (F-2b, X-52) — read-only, and the LABEL names the owner.
	blocks.push(
		fields("products:identity", [
			["Title (set in the CMS)", p.title ?? "(untitled)"],
			["SKU", p.sku ?? "—"],
			["Price", formatOptionalTotal(p.priceCents, p.currency)],
			["Status (set in the CMS)", statusLabel(p)],
			// The most operationally urgent number on the page, carrying its own
			// exception (`Out of stock` / `Low`) so it does not read at the same
			// weight as `Kind: physical`. Same helper as the list's `On hand`
			// column, so a product cannot be low in one place and plain in the
			// other. The detail's count is a plain number — never null — so the
			// helper's "—" branch is unreachable here.
			["Stock on hand", onHandCell(p.onHand, threshold)],
			["Kind", p.productKind],
		]),
	);
	const panels: TabPanel[] = [
		{ label: "Product", blocks: productPanel(id, p, taxClasses, open) },
		{ label: "Stock", blocks: stockPanel(id, p, open, renderState, threshold) },
	];
	blocks.push({
		type: "tab",
		// STABLE (B-4): a volatile key would throw the operator back to panel 0
		// after every action's re-render.
		block_id: `products:${id}:tabs`,
		default_tab: 0, // ALWAYS (D-4)
		panels,
	});
	return blocks;
}

/** One line naming both what happened and what to do, for a tombstoned
 *  product — shown in place of the edit/stock-movement forms, in EITHER
 *  panel (DA-7). Editing and stock forms on a soft-deleted product are
 *  omitted entirely (never rendered-then-rejected), which is already
 *  correct; D-3 requires the panel itself keep rendering regardless. */
const TOMBSTONE_CONTEXT =
	"This product was deleted in the CMS — editing and stock moves are unavailable. Restore the document to re-enable them.";

/** F-5a-i's normative sibling-discard line — ONE line, above the three split
 *  groups, never repeated inside them (X-45). Written to DA-7a's discipline:
 *  no "deliberately" / "there is no" / "we do not" (X-41). */
const SPLIT_DISCARD_CONTEXT =
	"Each section saves on its own. Save the section you are editing before you open another — saving one reloads the product and clears unsaved edits in the others.";

// -- panel "Product" -----------------------------------------------------------

function productPanel(
	id: string,
	p: ProductDetailWire,
	taxClasses: TaxClassWire[],
	open: OpenGroup,
): Block[] {
	const blocks: Block[] = [
		fields("products:more", [
			["Compare-at", formatOptionalTotal(p.compareAtCents, p.compareAtCurrency)],
			["Unit cost", formatOptionalTotal(p.unitCostCents, p.unitCostCurrency)],
			["Tax class", taxClassLabel(p.taxClass, taxClasses)],
			["Inventory policy", inventoryPolicyLabel(p.inventoryPolicy)],
			["Weight (g)", p.weightGrams === null ? "—" : String(p.weightGrams)],
			["Dimensions (mm, LxWxH)", dimensionsSummary(p)],
			["Created (UTC)", utc(p.createdAt)],
			["Updated (UTC)", utc(p.updatedAt)],
		]),
	];
	if (p.deletedAt !== null) {
		blocks.push({ type: "context", text: TOMBSTONE_CONTEXT });
		return blocks;
	}
	blocks.push({ type: "context", text: SPLIT_DISCARD_CONTEXT });
	blocks.push({
		type: "accordion",
		block_id: `products:${id}:edit-identity`,
		label: "Identity",
		default_open: open === "identity",
		blocks: [
			{
				type: "context",
				text: "SKU is the stock-keeping code the store sells against. The title is set in the CMS.",
			},
			identityForm(id, p),
		],
	});
	blocks.push({
		type: "accordion",
		block_id: `products:${id}:edit-price`,
		label: fitLabel(priceGroupLabel(p)),
		default_open: false, // ALWAYS — not a D-5 rank (only Identity is)
		blocks: [
			{
				type: "context",
				text: "Price, compare-at and unit cost all use the product's one currency. A blank compare-at or unit cost clears it.",
			},
			priceForm(id, p),
		],
	});
	blocks.push({
		type: "accordion",
		block_id: `products:${id}:edit-shipping`,
		label: "Classification & shipping",
		default_open: false, // ALWAYS
		blocks: [
			{
				type: "context",
				text: "Weight and dimensions feed shipping quotes; blank leaves them unchanged. A blank tax class clears it.",
			},
			shippingForm(id, p, taxClasses),
		],
	});
	// Replaces the deleted single-option "When out of stock" select (F-3) AND
	// the banned "no overselling" phrasing (X-20) with the mechanism sentence,
	// which is the whole of what the operator needs. Out-of-stock policy stays
	// DENY-ONLY this slice — no `allow_backorder` option exists anywhere in
	// this form. The no-oversell invariant is non-negotiable, and backorders
	// are a future capability that needs its own races and an ADR.
	blocks.push({
		type: "context",
		text: "The store stops selling at zero stock; backorders are a future capability.",
	});
	return blocks;
}

/** D-6: the Price group's label carries the answer, so it can be skipped
 *  unopened. ≤60 chars (X-11), enforced by `fitLabel`. */
function priceGroupLabel(p: ProductDetailWire): string {
	if (p.priceCents === null || p.currency === null) return "Price — not priced yet";
	return `Price — ${formatOptionalTotal(p.priceCents, p.currency)} ${p.currency}`;
}

/**
 * The Identity group's form — SKU only (F-5a: the split is by MEANING, not
 * just field count; a one-field accordion is deliberate because SKU is
 * identity, not pricing). Title is NOT here: `product_commerce.title` is a
 * CMS-owned derived cache (ADR-0013) and `ProductEditWire` has no `title`
 * member, so a form field for it does not compile.
 */
function identityForm(id: string, p: ProductDetailWire): FormBlock {
	return carriedForm({
		namespace: "products:identity",
		context: { productId: id, expectedUpdatedAt: p.updatedAt },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "sku",
					label: "SKU",
					...(p.sku !== null ? { initial_value: p.sku } : {}),
				},
			],
			submit: { label: "Save identity", action_id: ACTION_SAVE_IDENTITY },
		},
	});
}

/**
 * The Price group's form (F-5a): price, an optional currency, compare-at and
 * unit cost — the four fields that must co-reside because they all read the
 * product's one currency (`buildEditWire`'s currency-resolution logic depends
 * on all three money fields agreeing).
 *
 * CURRENCY IS NEVER A FIXED SINGLE-OPTION SELECT (F-3 — that was one of the
 * four `""`-valued-option/one-option violations on this screen). For an
 * ALREADY-PRICED product the currency cannot change here, so it rides
 * INVISIBLY in this form's own carrier instead of as a field at all; only a
 * first-time pricing renders it as a real `text_input`.
 */
function priceForm(id: string, p: ProductDetailWire): FormBlock {
	const priced = p.priceCents !== null && p.currency !== null;
	const priceFields: FormBlock["fields"] = [
		{
			type: "text_input",
			action_id: "price",
			label: `Price (${p.currency ?? "set currency below"}, e.g. 19.99)`,
			placeholder: "19.99",
			...(p.priceCents !== null ? { initial_value: formatPriceMinorUnits(p.priceCents) } : {}),
		},
	];
	if (!priced) {
		priceFields.push({
			type: "text_input",
			action_id: "currency",
			label: "Currency (ISO-4217, e.g. USD) — set once when first pricing",
			placeholder: "USD",
		});
	}
	priceFields.push(
		{
			type: "text_input",
			action_id: "compareAt",
			label: `Compare-at / was price (${p.currency ?? "same as price"}, e.g. 29.99) — blank to clear`,
			placeholder: "29.99",
			...(p.compareAtCents !== null
				? { initial_value: formatPriceMinorUnits(p.compareAtCents) }
				: {}),
		},
		{
			type: "text_input",
			action_id: "unitCost",
			label: `Unit cost — admin only, never shown to buyers (${p.currency ?? "same as price"}) — blank to clear`,
			placeholder: "8.50",
			...(p.unitCostCents !== null
				? { initial_value: formatPriceMinorUnits(p.unitCostCents) }
				: {}),
		},
	);
	return carriedForm({
		namespace: "products:price",
		context: {
			productId: id,
			expectedUpdatedAt: p.updatedAt,
			// Priced: the fixed currency rides here, invisibly, never as a field.
			...(priced ? { currency: p.currency ?? "" } : {}),
		},
		form: {
			type: "form",
			fields: priceFields,
			submit: { label: "Save price", action_id: ACTION_SAVE_PRICE },
		},
	});
}

/** The Classification & shipping group's form (F-5a): exactly 6 fields — the
 *  F-5 budget. `Kind` and `Tax class` are closed sets ≤8 options (F-6 ⇒
 *  `select`); the four measurements are non-money integers (F-6 ⇒
 *  `text_input`, `/^\d+$/`-parsed). */
function shippingForm(id: string, p: ProductDetailWire, taxClasses: TaxClassWire[]): FormBlock {
	return carriedForm({
		namespace: "products:shipping",
		context: { productId: id, expectedUpdatedAt: p.updatedAt },
		form: {
			type: "form",
			fields: [
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
					initial_value: p.taxClass ?? NO_TAX_CLASS,
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
			],
			submit: { label: "Save classification", action_id: ACTION_SAVE_SHIPPING },
		},
	});
}

// -- panel "Stock" --------------------------------------------------------------

function stockPanel(
	id: string,
	p: ProductDetailWire,
	open: OpenGroup,
	renderState: ProductsRenderState | undefined,
	threshold: number | null,
): Block[] {
	const blocks: Block[] = [
		fields("products:stock", [
			// Badged exactly as the identity strip above and the list column
			// before it — one helper, three surfaces (see `onHandCell`).
			["On hand", onHandCell(p.onHand, threshold)],
			["Inventory policy", inventoryPolicyLabel(p.inventoryPolicy)],
		]),
	];
	if (p.deletedAt !== null) {
		blocks.push({ type: "context", text: TOMBSTONE_CONTEXT });
		return blocks;
	}
	blocks.push({
		type: "context",
		// X-20-safe rewrite: "on hand" and "the count available to sell right
		// now" say the same thing the banned phrasing used to.
		text: "On hand is what can be sold right now — open cart holds are already subtracted. Whole units only.",
	});
	if (p.sku === null) {
		// D-7: a skuless "create then price" product has nothing to move stock
		// against (the service would 409 NO_SKU anyway) — one line, no forms.
		blocks.push({
			type: "context",
			text: "Stock movements need a SKU first — set one under Identity on the Product tab.",
		});
		return blocks;
	}
	blocks.push(restockGroup(id, p));
	blocks.push(removeStockGroup(id, p, open, renderState));
	return blocks;
}

/** Restock stays DA-4: a plain one-shot form, no confirm, no danger. */
function restockGroup(id: string, p: ProductDetailWire): Block {
	return {
		type: "accordion",
		block_id: `products:${id}:restock`,
		label: "Add stock",
		default_open: false,
		blocks: [restockForm(id, p)],
	};
}

/** `productId` and the `onHand` watermark ride invisibly in the carrier
 *  (F-2). No nonce anywhere (F-2a): the idempotency key is derived from
 *  `${productId}:restock:${onHandAtRender}:${qty}` — content plus the
 *  watermark the operator saw, at write time (`stockMovementKey`). */
function restockForm(id: string, p: ProductDetailWire): FormBlock {
	return carriedForm({
		namespace: "products:restock",
		context: { productId: id, onHand: String(p.onHand) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "qty",
					label: "Units to add",
					placeholder: "e.g. 12",
				},
			],
			submit: { label: "Add stock", action_id: ACTION_RESTOCK },
		},
	});
}

/** DA-3 state 1's required alert banner + explanatory context, shared by the
 *  idle body and the flattened refusal body (DA-3a-i) so the two cannot
 *  drift — mirrors `orders-page.ts`'s `REFUND_PARTIAL_BANNER`. */
const REMOVE_STOCK_BANNER: Block = {
	type: "banner",
	variant: "alert",
	title: "Removing stock cannot be undone by restocking",
	description: "This records a stock removal — the store treats it as a separate ledger entry.",
};
const REMOVE_STOCK_CONTEXT: Block = {
	type: "context",
	text: "Restocking appends a second movement — it does not correct this one. Check the number before confirming.",
};

/**
 * The Remove-stock group — the screen's ONE destructive act (DA-5's second
 * exception: a removal is reversible only by a separate, forgettable manual
 * operation). Three render modes, chosen by render state, never by taste —
 * mirrors `orders-page.ts`'s `refundsGroup`:
 *
 * | Mode | `block_id` | Body |
 * |---|---|---|
 * | idle | `…:remove` | alert banner · context · the collect form |
 * | state 2 (`remove-staged`) | `…:remove:review` | its own banner · the staged form, remounted · ONE danger confirm |
 * | a refusal (`remove-draft`) | `…:remove:refused` | the SAME banner + context · the prefilled form — no confirm |
 *
 * THREE DISTINCT KEYS, for the same reason as Orders' refund group: a
 * refusal is reachable from BOTH idle (a typo in the qty field) and from
 * state 2 (the confirm, after stock moved), so B-6's remount half needs this
 * `block_id` to differ from whichever of those two was on screen — reusing
 * either leaves the force-open resting on the operator's click history
 * rather than on the response (B-7a).
 *
 * The `Add stock` group above is a SIBLING accordion with its own stable
 * `block_id`, always `default_open: false` — it is neither the refused group
 * nor a control of the refused class, so it renders unchanged on every mode.
 */
function removeStockGroup(
	id: string,
	p: ProductDetailWire,
	open: OpenGroup,
	renderState: ProductsRenderState | undefined,
): Block {
	const blockId = `products:${id}:remove`;
	const staged = renderState?.kind === "remove-staged" ? renderState : undefined;
	const draft = renderState?.kind === "remove-draft" ? renderState : undefined;
	const body: Block[] =
		staged !== undefined
			? removeReviewBody(id, staged)
			: draft !== undefined
				? [REMOVE_STOCK_BANNER, REMOVE_STOCK_CONTEXT, removeStockForm(id, p.onHand, draft.qtyInput)]
				: [REMOVE_STOCK_BANNER, REMOVE_STOCK_CONTEXT, removeStockForm(id, p.onHand)];
	return {
		type: "accordion",
		block_id:
			staged !== undefined
				? `${blockId}:review`
				: draft !== undefined
					? `${blockId}:refused`
					: blockId,
		// D-6a: the label carries the CONSEQUENCE, not just the verb — X-35's
		// bare-verb-label check, and the reason §12.1's own "Remove stock" listing
		// line is a defect (reported in the PR body).
		label: fitLabel("Remove stock — permanent, cannot be undone by restocking"),
		default_open: open === "remove",
		blocks: body,
	};
}

/** `productId` and the `onHand` watermark ride invisibly in the carrier —
 *  the SAME shape as `restockForm`. No nonce (F-2a). `prefillQty` is the
 *  RAW operator string (DA-3a-iii property 5), used verbatim whether it came
 *  from a refusal or from state 2 (formatted back from the parsed qty by the
 *  caller). */
function removeStockForm(id: string, onHand: number, prefillQty?: string): FormBlock {
	return carriedForm({
		namespace: "products:remove",
		context: { productId: id, onHand: String(onHand) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "qty",
					label: "Units to remove (damaged / shrinkage)",
					placeholder: "e.g. 3",
					...(prefillQty !== undefined ? { initial_value: prefillQty } : {}),
				},
			],
			// The operator re-submits `-review` even from the remounted state-2
			// form — there is no `-edit` id (DA-3).
			submit: { label: "Review removal", action_id: ACTION_REMOVE_REVIEW },
		},
	});
}

/**
 * DA-3 state 2 for a stock removal: the staged form remounted plus ONE danger
 * confirm. The idle banner/context are replaced by this state's OWN copy
 * (naming the concrete quantity), mirroring `refundReviewBody` — a second
 * reading of the generic warning beside a confirm naming the specific act
 * would be noise.
 */
function removeReviewBody(
	id: string,
	staged: ProductsRenderState & { kind: "remove-staged" },
): Block[] {
	const unit = staged.qty === 1 ? "unit" : "units";
	return [
		{
			type: "banner",
			variant: "alert",
			title: "Removing stock cannot be undone by restocking",
			description: `Confirm below to remove ${staged.qty} ${unit}. Edit the form and review again to change the amount.`,
		},
		removeStockForm(id, staged.onHand, String(staged.qty)),
		{
			type: "actions",
			block_id: `products:${id}:remove-confirm`,
			elements: [
				{
					type: "button",
					action_id: ACTION_REMOVE,
					label: `Remove ${staged.qty} ${unit}`,
					// The watermark AS THE OPERATOR SAW IT (the on-hand the -review
					// step just confirmed live) — the DA-3a re-read key AND the third
					// component of the idempotency key (F-2a).
					value: { productId: id, qty: String(staged.qty), onHand: String(staged.onHand) },
					style: "danger",
					confirm: {
						title: fit(`Remove ${staged.qty} ${unit}?`, LABEL_BUDGET),
						text: `Remove ${staged.qty} ${unit} from stock? This records a removal and cannot be undone by restocking.`,
						confirm: `Yes, remove ${staged.qty}`,
						deny: "Keep as is",
						style: "danger",
					},
				},
			],
		},
	];
}

function dimensionsSummary(p: ProductDetailWire): string {
	if (p.lengthMm === null && p.widthMm === null && p.heightMm === null) return "—";
	const dims = [p.lengthMm, p.widthMm, p.heightMm].map((d) => (d === null ? "?" : String(d)));
	return dims.join(" x ");
}

// -- shared --------------------------------------------------------------------

/** A `fields` block from label/value PAIRS, so an odd entry count is visible
 *  at the call site — `fields` is row-major `grid-cols-2` (R-3). */
function fields(
	blockId: string,
	entries: ReadonlyArray<readonly [string, string]>,
): { type: "fields"; block_id: string; fields: Array<{ label: string; value: string }> } {
	return {
		type: "fields",
		block_id: blockId,
		fields: entries.map(([label, value]) => ({ label, value })),
	};
}

/** An `accordion.label` inside §1's 60-char budget (X-11). */
function fit(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function fitLabel(text: string): string {
	return fit(text, LABEL_BUDGET);
}

/** An absolute UTC timestamp TRIMMED TO SECONDS (M-6): milliseconds are
 *  noise, and X-13 rejects them outright. No timezone conversion, ever. */
function utc(iso: string): string {
	return iso.replace(/\.\d+(?=Z$)/, "");
}

/** E-7's normative fail-closed banner — the copy names the symptom, lists the
 *  two things the operator can check, then says the remaining possibility
 *  out loud, so a console bug landing on this same path is never reported as
 *  an outage. */
function failClosed() {
	return failClosedResponse({
		header: "Pricing & inventory",
		title: "Pricing & inventory is unavailable",
		description:
			"Pricing & inventory could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load pricing & inventory",
	});
}

/** Translate the console's filter form into the client's list filter.
 *  `archived` wins over `active`: the two are mutually exclusive by
 *  construction (one combined "Status" select), but `deleted: true` is
 *  asserted alone regardless, so a hand-crafted `form_submit` can never
 *  smuggle both axes into one request. */
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
	const status = readString(values.status);
	const productKind = readString(values.productKind);
	const search = readString(values.search);
	// A `toggle` submits a REAL boolean, never a string (types.ts) — so this one
	// field is read with a typeof check rather than `readString`.
	if (values.lowStock === true) form.lowStock = "true";
	if (status === "archived") {
		form.archived = "true";
	} else if (status === "true" || status === "false") {
		form.active = status;
	}
	// `status === ANY` (or absent) ⇒ no constraint — both fields stay unset.
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
// a valid amount) is that module's explicit `allowZero` parameter. Prices are
// strictly positive (the domain's own `price > 0` invariant: a free product
// is "unpriced", not priced at 0).

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

// -- custom action: the guarded commerce edit (split three ways, F-5a) -------

type BuildEditResult = { ok: true; wire: ProductEditWire } | { ok: false; message: string };

/**
 * Assemble a validated {@link ProductEditWire} from ONE of the three split
 * forms' captured `values` — whichever submitted, since a stateless
 * `form_submit` only ever carries the ONE form's own fields (the other two
 * forms' keys are simply absent from `values`, which `buildEditWire` already
 * treats as "field not in the form ⇒ preserve"). So this single function
 * serves all three submits; no per-form variant is needed.
 *
 * Boundary validation (mirrors the service's zod + the domain's `price > 0`):
 * a bad price/currency/dimension is a per-field message, never an opaque
 * save.
 */
function buildEditWire(
	values: Record<string, unknown>,
	expectedUpdatedAt: string,
): BuildEditResult {
	const wire: ProductEditWire = { expectedUpdatedAt };

	const sku = readString(values.sku)?.trim();
	if (sku !== undefined && sku.length > 0) wire.sku = sku;

	// The row currency (shared by price / compare-at / cost): the merchant-
	// entered code on a first pricing, or the Price form's OWN fixed carrier
	// for an already-priced product (merged into `values.currency` by the
	// caller before this runs — see `saveAction`). Parsed ONCE so all three
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
	// parsed to minor units and MUST carry the row currency.
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

	// taxClass: the sentinel `NO_TAX_CLASS` (or a blank) clears it (null); any
	// other value is the chosen `TaxClass.id`.
	const taxClass = readString(values.taxClass);
	if (taxClass !== undefined) {
		const trimmed = taxClass.trim();
		wire.taxClass = trimmed.length === 0 || trimmed === NO_TAX_CLASS ? null : trimmed;
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

/** Stable content-derived idempotency key for an edit save (F-2a, `Edit /
 *  save` row: "content hash of the submitted wire + `expectedUpdatedAt`").
 *  FNV-1a twice with independent seeds — dependency-free and sandbox-safe. */
function deriveEditIdempotencyKey(productId: string, wire: ProductEditWire): string {
	const canonical = JSON.stringify([
		productId,
		wire.expectedUpdatedAt,
		wire.sku ?? null,
		wire.price ?? null,
		// No `title` component — the wire cannot carry one (ADR-0013).
		wire.taxClass ?? null,
		wire.compareAtPrice ?? null,
		wire.unitCost ?? null,
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

/** The refusal/unreadable-payload notice shared by every custom action on
 *  this screen whose carrier fails to decode (DA-3b): "nothing was changed",
 *  never a silent redirect. */
const UNREADABLE: Notice = {
	variant: "error",
	title: "Not changed",
	description:
		"That action could not be read — nothing was changed. Reload the product and try again.",
};

/** A refusal draft carrying the operator's RAW typed quantity (DA-3a-iii
 *  property 5) — shared by the confirm handler's refusal branches. */
function removeDraftState(qtyInput: string): ProductsRenderState {
	return { kind: "remove-draft", qtyInput };
}

/**
 * The three split forms' Save handler (F-5a — one handler serves all three
 * submits). Reads `productId`/`expectedUpdatedAt` off the FIRING FORM's own
 * carrier (never a visible field, per F-2), validates, PATCHes under the
 * optimistic-concurrency watermark, then RE-RENDERS the leaf (a fresh
 * reload) with a per-outcome notice.
 */
function saveAction() {
	return customAction<ProductsScreenClient, ProductsRenderState>(
		async ({ input, client, carried, showLeaf, showList }) => {
			const productId = readString(carried?.productId);
			const expectedUpdatedAt = readString(carried?.expectedUpdatedAt);
			if (productId === undefined || expectedUpdatedAt === undefined) {
				return showList(undefined, UNREADABLE);
			}
			const values = input.values ?? {};
			// The Price group's currency rides in ITS OWN carrier when the product is
			// already priced (never a visible field — F-3); merge it in here so
			// `buildEditWire`'s single currency-resolution branch sees it exactly as
			// it would a first-pricing's visible field.
			const effectiveValues: Record<string, unknown> =
				values.currency === undefined && readString(carried?.currency) !== undefined
					? { ...values, currency: carried?.currency }
					: values;

			const built = buildEditWire(effectiveValues, expectedUpdatedAt);
			if (!built.ok) {
				return showLeaf([productId], {
					variant: "error",
					title: "Check the highlighted value",
					description: built.message,
				});
			}

			const key = deriveEditIdempotencyKey(productId, built.wire);
			const result = await client.products.updateProduct(productId, built.wire, key);
			// showLeaf RELOADS the fresh detail, so a stale save renders the latest
			// row (the merchant re-applies against current values) — and the OTHER
			// two split forms remount too (their carriers change with `updatedAt`),
			// which is the sibling-discard hazard `SPLIT_DISCARD_CONTEXT` names.
			return showLeaf([productId], editNotice(result));
		},
	);
}

// -- custom actions: merchant stock movements ---------------------------------

/** Parse a merchant-entered stock quantity into a POSITIVE WHOLE number — a
 *  TEXT input (never `number_input`, which hands back a float). Null for any
 *  non-conforming or non-positive input; never throws. Exported for its own
 *  test. */
export function parseStockQty(input: string | undefined): number | null {
	if (input === undefined) return null;
	const trimmed = input.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const n = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Read the `onHand` watermark out of an untrusted carried payload — a plain
 *  non-negative integer string, or `null` for anything else (B-2: money and
 *  count watermarks never cross as floats or negatives). */
function parseOnHand(value: unknown): number | null {
	const raw = readString(value);
	if (raw === undefined || !/^\d+$/.test(raw)) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isSafeInteger(n) ? n : null;
}

/** F-2a: `${productId}:${direction}:${onHandAtRender}:${qty}` — content plus
 *  the watermark the operator saw. No nonce anywhere on this screen. */
function stockMovementKey(
	productId: string,
	direction: "restock" | "removal",
	onHand: number,
	qty: number,
): string {
	return `${productId}:${direction}:${onHand}:${qty}`;
}

/**
 * The restock handler (DA-4 — one-shot, no staging, no confirm; restocking is
 * not the destructive act on this screen). Reads `productId`/`onHand` off
 * the form's own carrier, validates the qty, POSTs under the derived key,
 * then RE-RENDERS the leaf with a per-outcome notice.
 */
function restockAction() {
	return customAction<ProductsScreenClient, ProductsRenderState>(async (api) => {
		const productId = readString(api.carried?.productId);
		if (productId === undefined) return api.showList(undefined, UNREADABLE);
		const onHand = parseOnHand(api.carried?.onHand);
		if (onHand === null) return api.showLeaf([productId], UNREADABLE);
		const qty = parseStockQty(readString(api.input.values?.qty));
		if (qty === null) {
			return api.showLeaf([productId], {
				variant: "error",
				title: "Enter a whole number of units",
				description: "Units to add must be a positive whole number, like 12.",
			});
		}
		const key = stockMovementKey(productId, "restock", onHand, qty);
		const result = await api.client.products.restock(productId, qty, key);
		return api.showLeaf([productId], restockNotice(result, qty));
	});
}

/** A refusal on the stock-changed-since-render path — shared by the
 *  `-review` handler and the confirm handler so the two cannot drift
 *  (mirrors `orders-page.ts`'s `staleLedgerNotice`). */
function stockChangedNotice(liveOnHand: number): Notice {
	const unit = liveOnHand === 1 ? "unit is" : "units are";
	return {
		variant: "error",
		title: "Stock changed — nothing was removed",
		description: `Stock on hand changed since you started — ${liveOnHand} ${unit} on hand now. Re-enter the amount below to try again.`,
	};
}

/**
 * DA-3's `-review` step for a stock removal — stages, never writes. Runs the
 * checks DA-3c requires (not just parseability): the qty parses to a
 * positive whole number, the `onHand` watermark is present (DA-3a-iv — an
 * absent watermark refuses, its own branch, never folded into the
 * parse-failure copy), stock has not moved since the group was rendered
 * (DA-3a, a fresh re-read), and the qty is ≤ the LIVE on-hand (DA-3c, against
 * a ceiling this step just confirmed current).
 */
function removeStockReviewAction() {
	return customAction<ProductsScreenClient, ProductsRenderState>(async (api) => {
		const productId = readString(api.carried?.productId);
		if (productId === undefined) return api.showList(undefined, UNREADABLE);
		const observedOnHand = parseOnHand(api.carried?.onHand);
		const qtyInput = (readString(api.input.values?.qty) ?? "").trim();
		const draft = (): ProductsRenderState => ({ kind: "remove-draft", qtyInput });

		// DA-3a-iv: an absent watermark refuses — its own branch, never folded
		// into the qty check, which could otherwise blame a field that already
		// parsed fine.
		if (observedOnHand === null) {
			return api.showLeaf([productId], UNREADABLE, draft());
		}
		const qty = parseStockQty(qtyInput);
		if (qty === null) {
			return api.showLeaf(
				[productId],
				{
					variant: "error",
					title: "Not removed",
					description:
						"Enter a whole number of units greater than zero, like 3. Nothing was changed.",
				},
				draft(),
			);
		}
		// DA-3c-i: re-read before rendering a button/confirm the write might
		// refuse.
		const live = await api.client.products.getProduct(productId).catch(() => null);
		if (live === null) {
			return api.showLeaf(
				[productId],
				{
					variant: "error",
					title: "Could not check the current stock",
					description:
						"Stock could not be re-read, so nothing was staged and nothing was changed. Reload and try again.",
				},
				draft(),
			);
		}
		// DA-3a: has stock moved since this group was rendered?
		if (live.onHand !== observedOnHand) {
			return api.showLeaf([productId], stockChangedNotice(live.onHand), draft());
		}
		// DA-3c: the bound check, against a ceiling just confirmed current.
		if (qty > live.onHand) {
			const unit = live.onHand === 1 ? "unit" : "units";
			return api.showLeaf(
				[productId],
				{
					variant: "error",
					title: "Not enough stock to remove",
					description: `${qty} is more than the ${live.onHand} ${unit} on hand. Enter ${live.onHand} or less.`,
				},
				draft(),
			);
		}
		return api.showLeaf([productId], undefined, {
			kind: "remove-staged",
			qty,
			onHand: live.onHand,
		});
	});
}

/**
 * The stock-moving confirm — DA-3's state-2 write. Re-reads and refuses on a
 * watermark mismatch (DA-3a) before deriving the key and writing (F-2a),
 * exactly like `orders-page.ts`'s `refundOrderAction`. The service applies a
 * GUARDED decrement, so removing more than is on hand is refused cleanly
 * (never a negative or an oversell) — the live re-read above catches the
 * common case before the write; this is the backstop.
 */
function removeStockAction() {
	return customAction<ProductsScreenClient, ProductsRenderState>(
		async ({ input, client, showLeaf, showList }) => {
			const payload = asRecord(input.value);
			const productId = readString(payload?.productId);
			if (productId === undefined) return showList(undefined, UNREADABLE);
			const qty = parseStockQty(readString(payload?.qty));
			const observedOnHand = parseOnHand(payload?.onHand);
			if (qty === null || observedOnHand === null) {
				return showLeaf([productId], UNREADABLE, removeDraftState(qty !== null ? String(qty) : ""));
			}
			const live = await client.products.getProduct(productId).catch(() => null);
			if (live === null) {
				return showLeaf(
					[productId],
					{
						variant: "error",
						title: "Nothing was removed",
						description:
							"Stock could not be re-checked, so nothing was applied. Reload and try again.",
					},
					removeDraftState(String(qty)),
				);
			}
			if (live.onHand !== observedOnHand) {
				return showLeaf(
					[productId],
					stockChangedNotice(live.onHand),
					removeDraftState(String(qty)),
				);
			}
			const key = stockMovementKey(productId, "removal", observedOnHand, qty);
			const result = await client.products.removeStock(productId, qty, key);
			return showLeaf([productId], removeStockNotice(result, qty));
		},
	);
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
			description: `Only ${result.onHand} unit${result.onHand === 1 ? "" : "s"} on hand — you cannot remove ${qty}.`,
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
					"This product has no SKU yet, so it has no stock to manage. Set a SKU on Identity above first.",
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
					"This product has a SKU but no stock record, so there is nothing to add to or remove from. Re-save the SKU on Identity above to create one.",
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
