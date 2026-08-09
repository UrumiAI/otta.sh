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
 * "LOW STOCK ONLY" IS A SERVER-SIDE PREDICATE NOW. The console resolves
 * the store's threshold via the settings read this module already made for the
 * `Low` band, and — only once that resolves to a real number — carries it on
 * the outgoing list request as `ProductsListFilter.lowStockThreshold`, the same
 * axis every other filter travels on. The service applies it to the WHOLE
 * catalogue (not the fetched page) and its exact count is taken under the same
 * predicate, so the count now describes the rows on screen and is forwarded
 * rather than withheld. `resolveStockContext` (in `products-read.ts`) makes
 * that one decision, and the one case it still withholds `total` for is the
 * threshold-unreadable one: the request never carried a predicate, so a `total`
 * there would caption an UNFILTERED page as though "Low stock only" had been
 * honoured — see its doc.
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
	type ProductsListResult,
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
	filterFormFromValues,
	readLowStockThreshold,
	readTaxClasses,
	resolveStockContext,
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
	 * one: a service older than the field, and a "Low stock only" request whose
	 * threshold could not be resolved, so the outgoing query never carried a
	 * predicate and a count would caption an unfiltered page as filtered
	 * (`stock.filterUnavailable`; see `resolveStockContext`'s doc). Both land in
	 * the same place, which is the point — `rowCountLine`'s page-scoped fallback
	 * is a claim the render can back up on its own.
	 */
	readonly total?: number;
	/**
	 * THE PAGE THE REQUEST ASKED FOR WAS REFUSED, and these are the first page's
	 * rows instead — the cursor disagreed with the filters beside it, or would not
	 * decode, and `AdminProductsClient` performed the service's own prescribed
	 * remedy (drop the token, re-issue page one) before this route saw a result.
	 * On the SUCCESS payload because the request was answered; forwarded because
	 * an address naming that page must be corrected and the merchant is owed a
	 * sentence. Same contract as the Orders route's.
	 */
	readonly cursorRejected?: true;
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
	const wantsLowStock = form.lowStock === "true";
	const hasCursor = cursor !== undefined && cursor.length > 0;
	const pageOpts = { limit: PAGE_LIMIT, ...(hasCursor ? { cursor } : {}) };

	let page: ProductsListResult;
	let threshold: number | null;
	if (wantsLowStock) {
		/*
		 * THE THRESHOLD GATES THE QUERY, on a continuation as much as on a fresh
		 * request: the server can only filter by a number it was given, so the
		 * settings read runs FIRST rather than alongside the page read — the one
		 * case where E-1's "never delays the list beyond its own latency" no longer
		 * holds, and a `lowStock` filter is worth the extra round trip.
		 *
		 * A CONTINUATION USED TO SKIP THIS, and the reason it gave has stopped
		 * being true. The filter did ride inside the opaque cursor, and the client
		 * did ignore its filter argument once a cursor was present — so resolving
		 * the threshold again could only add latency. The client now states the
		 * filter on EVERY request, because the service compares the two and fails
		 * closed on a disagreement; a paged low-stock request that omitted the
		 * threshold would be a subset of what the token carries, which is a
		 * mismatch, which would drop the merchant back to page one on every `Load
		 * more`. So the read is sequenced here whenever the filter is on, and the
		 * cursor branch pays the same round trip page one always did.
		 */
		threshold = await readLowStockThreshold(client.settings);
		const filter = toClientFilter(form);
		if (threshold !== null) filter.lowStockThreshold = threshold;
		page = await client.products.listProducts(filter, pageOpts);
	} else {
		[page, threshold] = await Promise.all([
			client.products.listProducts(toClientFilter(form), pageOpts),
			readLowStockThreshold(client.settings),
		]);
	}

	const resolved = resolveStockContext(page.products, {
		wantsLowStock,
		threshold,
		total: page.total,
		// THE CURSOR IS THE PREDICATE'S EVIDENCE on a continuation — but only on a
		// continuation the service HONOURED. A refused cursor was answered with
		// page one instead, and that page was filtered (or not) by the threshold
		// resolved just now, exactly like any fresh request; reading it as a
		// continuation would let an unfiltered page-one retry claim the filter had
		// been applied. See `resolveStockContext`'s decision 3.
		continuation: hasCursor && page.cursorRejected !== true,
	});
	return {
		ok: true,
		products: page.products,
		nextCursor: page.nextCursor,
		...(resolved.total !== undefined ? { total: resolved.total } : {}),
		// FORWARDED, NEVER RE-DERIVED: only the client sees the service's refusal
		// code and knows whether these rows came from the cursor or from the
		// page-one retry it made instead.
		...(page.cursorRejected === true ? { cursorRejected: true as const } : {}),
		stock: resolved.stock,
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
