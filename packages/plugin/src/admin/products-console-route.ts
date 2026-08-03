/**
 * The React console's read/write surface on the Pricing & inventory screen
 * (INC-21).
 *
 * IT IS `orders-console-route.ts` ONE SCREEN ALONG, and the reasoning there
 * applies here unchanged: ADR-0014 Decision 3 gives `otta-console` exactly one
 * data path — it calls the existing authenticated `otta` admin route from the
 * browser with the operator's own session, holding zero capabilities and zero
 * `allowedHosts` — and a React screen must not consume Block Kit blocks,
 * because a Block Kit row carries `"$15.00"` (money already spent, G1) and
 * `"3 · Low"` (a decision already made) rather than the raw amount and the raw
 * count a React tier needs to render either.
 *
 * WRITES ARE STRUCTURED ACTIONS NOW (INC-R3, ADR-0015). They used to be
 * forwarded through the Block Kit Pricing & inventory page handler: four of the
 * five are FORM-shaped, so this module minted the `block_id` CARRIER those forms
 * rode their context in, synthesized the `form_submit` the handler read, and
 * then SCRAPED the outcome back out of the rendered block tree. That made the
 * renderer of the screen this one replaced load-bearing for this one.
 * `products-actions.ts` is that write path, re-expressed as functions returning
 * an outcome: {@link consoleAct} looks the id up in the same table the gate
 * reads and returns what it produced. The console sends one flat payload and the
 * action takes its fields as arguments — no carrier, because a carrier was a
 * rendering device (it kept `productId` from being drawn as a single-option
 * select) rather than a check. Every watermark, every content-derived
 * idempotency key and every word of refusal copy moved across verbatim.
 *
 * THE LIST IS NARROWED AFTER THE FETCH, AND THE `total` GOES WITH IT. "Low
 * stock only" has no service-side predicate: it narrows the page this request
 * fetched, so the service's exact count describes a DIFFERENT set of rows than
 * the ones on screen and must be withheld while it is on.
 * `applyLowStockNarrowing` (now in `products-read.ts`) makes that one decision —
 * see its doc. A screen that re-derived it could show three rows under a caption
 * reading "137 products".
 *
 * WHAT THIS MODULE DOES NOT DO: decide anything about stock or money. Every
 * idempotency key, every watermark comparison, every guarded decrement and
 * every refusal sentence a write can produce is in `products-actions.ts` and
 * covered by `products-actions.sandbox.test.ts`.
 *
 * G5 APPLIES UNCHANGED: every response here is HTTP 200 with an outcome in the
 * body. A refusal is a value.
 */
import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type { PluginContext, RouteHandler, SelectOption } from "../types.js";
import {
	AdminProductsClient,
	type ProductDetailWire,
	type ProductSummaryWire,
	type TaxClassWire,
} from "./admin-products-client.js";
import {
	PRODUCTS_UNAVAILABLE_DESCRIPTION,
	PRODUCTS_UNAVAILABLE_TITLE,
	PRODUCT_NOT_FOUND_TITLE,
} from "@otta-sh/admin-presentation";
import {
	CONSOLE_ACT_INTERACTION,
	UNKNOWN_ACTION,
	UNREADABLE_REQUEST,
	readConsolePayload,
	type ConsoleFailure,
} from "./console-transport.js";
import {
	PRODUCTS_ACTION_IDS,
	dispatchProductsAction,
	type ProductsActionResult,
} from "./products-actions.js";
import {
	PAGE_LIMIT,
	PRODUCTS_FILTER_ANY,
	PRODUCTS_KIND_OPTIONS,
	PRODUCTS_STATUS_OPTIONS,
	applyLowStockNarrowing,
	filterFormFromValues,
	readLowStockThreshold,
	readTaxClasses,
	toClientFilter,
} from "./products-read.js";
import { ReportingSettingsClient } from "./reporting-client.js";
import { readAdminTokens, readString } from "./scaffold/index.js";

/** The resources the console can read on this screen. One per SURFACE, not one
 *  per service endpoint: the detail fans out to three reads in PARALLEL, because
 *  a screen making three sequential round trips through this route would be
 *  slower than the one it replaced. */
export type ProductsConsoleResource = "products.list" | "products.detail";

/**
 * Everything the console needs to render the filter controls.
 *
 * SENT AS DATA, for the reason `ConsoleVocabulary` gives on Orders: the
 * alternative is the React package holding its own copy of "All statuses
 * (live)" and "Archived (deleted)" in a package that cannot import the one
 * place they are defined. Every authored string that decides what an operator
 * can ASK FOR travels down the wire; every authored string that decides what an
 * operator READS is in `@otta-sh/admin-presentation`, which both packages
 * import. Nothing is copied.
 */
export interface ProductsConsoleVocabulary {
	/** The combined Status select — `active`/`archived` as ONE mutually-exclusive
	 *  choice, because a soft-deleted row is always inactive. */
	readonly statuses: readonly SelectOption[];
	readonly kinds: readonly SelectOption[];
	/** The all-values sentinel both selects use. A real word, never `""`. */
	readonly any: string;
	/** The keyset page size, so the console's "Load more" matches the page the
	 *  service was actually asked for rather than guessing. */
	readonly pageLimit: number;
}

export const PRODUCTS_CONSOLE_VOCABULARY: ProductsConsoleVocabulary = {
	statuses: PRODUCTS_STATUS_OPTIONS,
	kinds: PRODUCTS_KIND_OPTIONS,
	any: PRODUCTS_FILTER_ANY,
	pageLimit: PAGE_LIMIT,
};

/** The page context a row cannot carry, forwarded so the React list can raise
 *  the stock-degradation banner — and, crucially, can raise it on a page
 *  narrowed to ZERO rows, which is exactly when it has to speak. */
export interface ConsoleStockContext {
	/** The store's low-stock threshold, or `null` when the settings read failed
	 *  (which costs the `Low` band and nothing else). */
	readonly threshold: number | null;
	readonly unreadable: boolean;
	readonly filterUnavailable: boolean;
}

export interface ProductsConsoleListPayload {
	readonly ok: true;
	readonly products: readonly ProductSummaryWire[];
	readonly nextCursor: string | null;
	/**
	 * The service's EXACT count of the filtered set (INC-23) — present only when
	 * it describes the rows above it.
	 *
	 * ABSENT STAYS ABSENT, and here it is absent for TWO reasons rather than
	 * one: a service older than the field, and a "Low stock only" page whose
	 * rows this module narrowed after the count was taken. Both land in the same
	 * place, which is the point — `rowCountLine`'s page-scoped fallback is a
	 * claim the render can back up on its own.
	 */
	readonly total?: number;
	readonly stock: ConsoleStockContext;
	readonly vocabulary: ProductsConsoleVocabulary;
}

export interface ProductsConsoleDetailPayload {
	readonly ok: true;
	readonly product: ProductDetailWire;
	/** The live tax-class registry, already backstopped by the static defaults
	 *  (`readTaxClasses`), so the edit form's select is never empty because one
	 *  best-effort read failed. */
	readonly taxClasses: readonly TaxClassWire[];
	/** Secondary (E-1): `null` costs the `Low` band and nothing else. */
	readonly threshold: number | null;
	readonly vocabulary: ProductsConsoleVocabulary;
}

/** The console's fail-closed copy, and now the only Pricing & inventory copy of
 *  it — the Block Kit screen it was written to match was retired by ADR-0015.
 *
 *  It says three things and no more: the symptom, the two settings to check, and
 *  the possibility that this is a console bug rather than an outage. It names no
 *  cause it does not know, because this path swallows an unreachable service, an
 *  auth failure, a malformed response and a defect in the console's own code
 *  alike — asserting any one of them sends whoever the operator pages to the
 *  wrong team. It also carries no status code and no upstream path: a banner
 *  gets screenshotted. */
const UNAVAILABLE: ConsoleFailure = {
	ok: false,
	title: PRODUCTS_UNAVAILABLE_TITLE,
	description: PRODUCTS_UNAVAILABLE_DESCRIPTION,
};

const NOT_FOUND: ConsoleFailure = {
	ok: false,
	title: PRODUCT_NOT_FOUND_TITLE,
	description:
		"No product matches that id. It may have been deleted in the CMS since the list was loaded.",
};

/** The console's request envelope, narrowed to what this module reads. Every
 *  field is untrusted operator-round-tripped input and is re-validated here. */
export interface ProductsConsoleInput {
	type?: unknown;
	resource?: unknown;
	productId?: unknown;
	cursor?: unknown;
	filter?: unknown;
	action_id?: unknown;
	value?: unknown;
}

interface ProductsConsoleClient {
	products: AdminProductsClient;
	settings: ReportingSettingsClient;
}

/**
 * Both service surfaces this screen reads — the products client carrying the
 * write-gate service token (the edit PATCH and the stock-movement POSTs are
 * non-GETs the gate blocks without it) and the settings client carrying the
 * admin token alone, because a GET-only surface has no business holding the
 * token that writes.
 */
async function createClient(ctx: PluginContext): Promise<ProductsConsoleClient> {
	const tokens = await readAdminTokens(ctx);
	const transport = {
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(tokens.adminToken !== undefined ? { adminToken: tokens.adminToken } : {}),
	};
	return {
		products: new AdminProductsClient({
			...transport,
			...(tokens.serviceToken !== undefined ? { serviceToken: tokens.serviceToken } : {}),
		}),
		settings: new ReportingSettingsClient(transport),
	};
}

/**
 * Read the filter the console sent into a `ProductsFilterForm`.
 *
 * It goes through `filterFormFromValues` — so `status: "archived"` becomes
 * `archived: "true"`, `status: "any"` becomes no constraint, and an unknown
 * token is dropped. The ONE adaptation is the toggle, which arrives from a
 * browser as either a real boolean or the string `"true"`, so it is normalised
 * before the shared reader sees it. A React screen building its own
 * `ProductsListFilter` would be the second place this console decides what
 * "archived" means.
 */
function readFilter(raw: unknown): ReturnType<typeof filterFormFromValues> {
	const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	return filterFormFromValues({
		...record,
		lowStock: record["lowStock"] === true || record["lowStock"] === "true",
	});
}

async function consoleList(
	input: ProductsConsoleInput,
	ctx: PluginContext,
): Promise<ProductsConsoleListPayload | ConsoleFailure> {
	const client = await createClient(ctx);
	const cursor = readString(input.cursor);
	const form = readFilter(input.filter);
	// The threshold read runs ALONGSIDE the page read and is secondary in both
	// directions: it can never delay the list beyond its own latency, and it can
	// never fail it (E-1) — `readLowStockThreshold` resolves to null instead of
	// throwing.
	const [page, threshold] = await Promise.all([
		client.products.listProducts(toClientFilter(form), {
			limit: PAGE_LIMIT,
			...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
		}),
		readLowStockThreshold(client.settings),
	]);
	const narrowed = applyLowStockNarrowing(page.products, {
		wantsLowStock: form.lowStock === "true",
		threshold,
		total: page.total,
	});
	return {
		ok: true,
		products: narrowed.rows.map((r) => r.product),
		nextCursor: page.nextCursor,
		...(narrowed.total !== undefined ? { total: narrowed.total } : {}),
		stock: narrowed.stock,
		vocabulary: PRODUCTS_CONSOLE_VOCABULARY,
	};
}

async function consoleDetail(
	input: ProductsConsoleInput,
	ctx: PluginContext,
): Promise<ProductsConsoleDetailPayload | ConsoleFailure> {
	const productId = readString(input.productId);
	if (productId === undefined || productId.length === 0) return UNREADABLE_REQUEST;
	const client = await createClient(ctx);
	const product = await client.products.getProduct(productId);
	if (product === null) return NOT_FOUND;
	// E-1, unchanged for the React tier: two best-effort reads, run together,
	// each degrading on its own rather than failing the screen.
	const [taxClasses, threshold] = await Promise.all([
		readTaxClasses(client.products),
		readLowStockThreshold(client.settings),
	]);
	return {
		ok: true,
		product,
		taxClasses,
		threshold,
		vocabulary: PRODUCTS_CONSOLE_VOCABULARY,
	};
}

/**
 * Run a console write and return its outcome.
 *
 * THE OUTCOME IS A VALUE NOW, not something read back off a render. Everything
 * in the payload — the product id, the `expectedUpdatedAt` or `onHand` watermark
 * the operator observed, the typed amounts — is untrusted operator-round-tripped
 * input, and every one of those fields is re-validated (and, for stock,
 * re-checked against live truth) inside `products-actions.ts` before a single
 * byte is written. This module adds no trust and removes none.
 *
 * THE GATE ON THE ID IS NOT BELT-AND-BRACES. An id this screen does not offer is
 * reachable from a stale tab after a deploy that renamed one, and from a caller
 * bug — never from a control this release rendered. Answering it as an outcome
 * would report a stock movement that never happened as a quiet success, so an
 * unknown id is a refusal with copy. `PRODUCTS_ACTION_IDS` is read straight off
 * the same dispatch table `dispatchProductsAction` runs, so the two cannot
 * disagree about what exists.
 */
async function consoleAct(
	input: ProductsConsoleInput,
	ctx: PluginContext,
): Promise<ProductsActionResult | ConsoleFailure> {
	const actionId = readString(input.action_id);
	if (actionId === undefined) return UNREADABLE_REQUEST;
	if (!PRODUCTS_ACTION_IDS.has(actionId)) return UNKNOWN_ACTION;
	const client = await createClient(ctx);
	const outcome = await dispatchProductsAction(
		actionId,
		readConsolePayload(input.value),
		client.products,
	);
	// Unreachable while the gate above reads the same table — kept because the two
	// are separate statements, and "the id was registered but nothing ran" must
	// never fall through to a quiet success.
	return outcome ?? UNKNOWN_ACTION;
}

/**
 * The console's half of the `otta` admin route, for Pricing & inventory.
 */
export function createProductsConsoleHandler(): RouteHandler<ProductsConsoleInput> {
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		try {
			if (readString(input.type) === CONSOLE_ACT_INTERACTION) {
				return await consoleAct(input, ctx);
			}
			const resource = readString(input.resource);
			if (resource === "products.list") return await consoleList(input, ctx);
			if (resource === "products.detail") return await consoleDetail(input, ctx);
			return UNREADABLE_REQUEST;
		} catch {
			// G5's reasoning, one tier up: the console renders a refusal, never a
			// blank pane, and a non-2xx would be indistinguishable from the transport
			// failing. Everything lands here — an unreachable service, a 401 on a
			// missing admin token, a malformed response, a bug in this file — so the
			// copy names the SYMPTOM and says the last possibility out loud rather
			// than asserting a cause it does not know.
			return UNAVAILABLE;
		}
	};
}

/** The `resource` prefix `admin-route.ts` dispatches on. Exported so the
 *  dispatcher and this module cannot disagree about which screen a console read
 *  belongs to. */
export const PRODUCTS_CONSOLE_RESOURCE_PREFIX = "products.";
