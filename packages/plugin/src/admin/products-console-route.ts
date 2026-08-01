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
 * TWO THINGS ARE GENUINELY DIFFERENT FROM ORDERS, and both are worth reading
 * before touching this file.
 *
 * **1. MOST WRITES ARE FORM SUBMITS, NOT BUTTONS.** Every Orders write is a
 * Block Kit button, and a button carries its whole payload in `value`, so the
 * Orders console forwards a click verbatim. Four of this screen's five writes
 * are `form_submit`s whose internal context rides in the form's `block_id`
 * CARRIER — the mechanism that stopped operators being asked to "pick" a
 * `productId` from a single-option select. A React screen cannot mint a carrier
 * (it may not import this package at all), so this module mints it, from the
 * table `products-page.ts` publishes as `PRODUCTS_CONSOLE_FORMS`. The handler on
 * the other side reads exactly the shape it has always read; no write path is
 * duplicated, and no field skips a check. The carried values are the same
 * operator-round-tripped strings a Block Kit form would have carried, and both
 * watermarks in them (`expectedUpdatedAt`, `onHand`) are re-checked against live
 * truth before anything is written.
 *
 * **2. THE LIST IS NARROWED AFTER THE FETCH, AND THE `total` GOES WITH IT.**
 * "Low stock only" has no service-side predicate: it narrows the page this
 * request fetched, so the service's exact count describes a DIFFERENT set of
 * rows than the ones on screen and must be withheld while it is on.
 * `applyLowStockNarrowing` makes that one decision for both surfaces — see its
 * doc. A React screen that re-derived it could show three rows under a caption
 * reading "137 products", one sidebar entry away from the screen it replaces.
 *
 * WHAT THIS MODULE DOES NOT DO: decide anything about stock or money. Every
 * idempotency key, every watermark comparison, every guarded decrement and
 * every refusal sentence a write can produce is in `products-page.ts` and
 * covered by `products-page.sandbox.test.ts`.
 *
 * G5 APPLIES UNCHANGED: every response here is HTTP 200 with an outcome in the
 * body. A refusal is a value.
 */
import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type { PluginContext, RouteHandler, SandboxedRouteContext, SelectOption } from "../types.js";
import {
	AdminProductsClient,
	type ProductDetailWire,
	type ProductSummaryWire,
	type TaxClassWire,
} from "./admin-products-client.js";
import {
	PRODUCTS_UNAVAILABLE_DESCRIPTION,
	PRODUCTS_UNAVAILABLE_TITLE,
} from "@otta-sh/admin-presentation";
import {
	CONSOLE_ACT_INTERACTION,
	UNREADABLE_REQUEST,
	forwardConsoleAct,
	forwardedFormSubmit,
	readConsolePayload,
	type ConsoleActPayload,
	type ConsoleFailure,
} from "./console-transport.js";
import {
	PAGE_LIMIT,
	PRODUCTS_CONSOLE_ACTION_IDS,
	PRODUCTS_CONSOLE_FORMS,
	PRODUCTS_FILTER_ANY,
	PRODUCTS_KIND_OPTIONS,
	PRODUCTS_STATUS_OPTIONS,
	applyLowStockNarrowing,
	createProductsPageHandler,
	filterFormFromValues,
	readLowStockThreshold,
	readTaxClasses,
	toClientFilter,
	type ProductsPageInput,
} from "./products-page.js";
import { ReportingSettingsClient } from "./reporting-client.js";
import { readAdminTokens, readString } from "./scaffold/index.js";

/** The resources the console can read on this screen. One per SURFACE, not one
 *  per service endpoint: the detail fans out to three reads in parallel exactly
 *  as the Block Kit detail does, because a React screen making three sequential
 *  round trips through this route would be slower than the screen it replaces. */
export type ProductsConsoleResource = "products.list" | "products.detail";

/**
 * Everything the console needs to render the filter controls with the SAME
 * vocabulary the Block Kit screen offers.
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
	/** The keyset page size, so the console's "Load more" matches the Block Kit
	 *  screen's rather than guessing. */
	readonly pageLimit: number;
}

export const PRODUCTS_CONSOLE_VOCABULARY: ProductsConsoleVocabulary = {
	statuses: PRODUCTS_STATUS_OPTIONS,
	kinds: PRODUCTS_KIND_OPTIONS,
	any: PRODUCTS_FILTER_ANY,
	pageLimit: PAGE_LIMIT,
};

/** The page context a synchronous render cannot discover for itself, forwarded
 *  so the React list can raise the SAME degradation banner the Block Kit list
 *  raises — and, crucially, can raise it on a page narrowed to ZERO rows, which
 *  is exactly when it has to speak. */
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
	/** The live tax-class registry, already backstopped by the static defaults —
	 *  the SAME set the Block Kit edit form offers, computed by the same
	 *  function, so a class present on one surface is present on the other. */
	readonly taxClasses: readonly TaxClassWire[];
	/** Secondary (E-1): `null` costs the `Low` band and nothing else. */
	readonly threshold: number | null;
	readonly vocabulary: ProductsConsoleVocabulary;
}

/** The console's fail-closed copy. It says the same three things
 *  `products-page.ts`'s `failClosed()` says — symptom, the two things to check,
 *  and the possibility that this is a console bug rather than an outage — for
 *  the same reason: naming a cause it does not know sends whoever the operator
 *  pages to the wrong team. */
const UNAVAILABLE: ConsoleFailure = {
	ok: false,
	title: PRODUCTS_UNAVAILABLE_TITLE,
	description: PRODUCTS_UNAVAILABLE_DESCRIPTION,
};

const NOT_FOUND: ConsoleFailure = {
	ok: false,
	title: "Product not found",
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
 * Both service surfaces this screen reads, wired exactly as the Block Kit
 * screen wires them — the products client carrying the write-gate service token
 * and the settings client carrying the admin token alone, because a GET-only
 * surface has no business holding the token that writes.
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
 * Read the filter the console sent back into the SAME `ProductsFilterForm` a
 * Block Kit form submit produces.
 *
 * It goes through `filterFormFromValues`, which is the Block Kit form's own
 * reader — so `status: "archived"` becomes `archived: "true"` on both surfaces,
 * `status: "any"` becomes no constraint on both, and an unknown token is
 * dropped on both. The ONE adaptation is the toggle: a Block Kit `toggle`
 * submits a real boolean, and JSON from a browser could carry either, so the
 * string form is normalised before the shared reader sees it. A React screen
 * building its own `ProductsListFilter` would be the second place this console
 * decides what "archived" means.
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
 * Forward a console click to the Block Kit action handler and return its notice.
 *
 * A write listed in `PRODUCTS_CONSOLE_FORMS` is a FORM on the Block Kit side, so
 * it is forwarded as the `form_submit` that form would have fired — the named
 * keys minted into the carrier, everything else a visible field.
 * `products:remove-stock` is a BUTTON, so it is forwarded as a `block_action`
 * with its payload untouched, exactly as every Orders write is.
 *
 * The gate is `PRODUCTS_CONSOLE_ACTION_IDS`, a strict subset of the dispatcher's
 * set: the Block Kit screen keeps a staged `-review` step the React screen does
 * not have, and a console asking for it is asking for something that screen does
 * not offer.
 */
async function consoleAct(
	input: ProductsConsoleInput,
	ctx: PluginContext,
	products: RouteHandler<ProductsPageInput>,
	request: SandboxedRouteContext<ProductsConsoleInput>["request"],
): Promise<ConsoleActPayload | ConsoleFailure> {
	const actionId = readString(input.action_id);
	if (actionId === undefined) return UNREADABLE_REQUEST;
	const payload = readConsolePayload(input.value);
	const form = PRODUCTS_CONSOLE_FORMS.get(actionId);
	return forwardConsoleAct({
		actionId,
		interaction:
			form !== undefined
				? forwardedFormSubmit(actionId, payload, form)
				: { type: "block_action", action_id: actionId, value: input.value },
		registered: PRODUCTS_CONSOLE_ACTION_IDS,
		handler: products,
		ctx,
		request,
		record: "product",
	});
}

/**
 * The console's half of the `otta` admin route, for Pricing & inventory.
 *
 * It constructs the Block Kit Products handler ONCE and holds it, the way
 * `admin-route.ts` holds the seven page handlers — the write path is that
 * handler, so there is exactly one of it.
 */
export function createProductsConsoleHandler(): RouteHandler<ProductsConsoleInput> {
	const products = createProductsPageHandler();

	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		try {
			if (readString(input.type) === CONSOLE_ACT_INTERACTION) {
				return await consoleAct(input, ctx, products, routeCtx.request);
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
