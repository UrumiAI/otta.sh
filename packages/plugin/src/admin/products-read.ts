/**
 * The Pricing & inventory READ path's Block-Kit-free helpers and vocabularies.
 *
 * WHY THIS MODULE EXISTS (ADR-0015 Decision 5). Every symbol below used to live
 * in `products-page.ts`, the Block Kit screen. The React console's list and
 * detail never depended on that screen's BEHAVIOUR — none of these helpers
 * renders or reads a block tree — but they depended on it in the BUILD, because
 * deleting a module deletes its exports. So they move here first, as a
 * behaviour-free relocation, and the page module is deleted afterwards. Nothing
 * here changed in the move; the comments are the ones the symbols arrived with.
 *
 * BLOCK-KIT-FREE IS NOT SIDE-EFFECT-FREE: {@link readLowStockThreshold} and
 * {@link readTaxClasses} each issue an admin-client call. The narrower claim is
 * the one being made — none of these functions renders a block, and none of them
 * reads one.
 */
import {
	AdminProductsClient,
	type ProductsListFilter,
	type ProductSummaryWire,
	type TaxClassWire,
} from "./admin-products-client.js";
import { ReportingSettingsClient } from "./reporting-client.js";
import { readString } from "./scaffold/index.js";
import { PRODUCT_KIND_LABELS } from "@otta-sh/admin-presentation";
import type { SelectOption } from "../types.js";

export const PAGE_LIMIT = 25;

/** A `select`/`combobox` sentinel meaning "no constraint". NEVER `""` — the
 *  pinned renderer treats an empty value as "no value" and draws a blank
 *  trigger (R-17a), and the trigger renders the raw VALUE, so a sentinel has
 *  to read acceptably as a word (F-6a, F-6c). */
const ANY = "any";
/** The Status filter's all-values sentinel, exported so the React screen offers
 *  the SAME token rather than inventing one — a screen sending `""` here would
 *  be indistinguishable from a screen sending nothing (F-6a). */
export const PRODUCTS_FILTER_ANY = ANY;

/**
 * The two filter selects' options, authored ONCE and shipped to the React
 * screen as data (INC-21).
 *
 * The alternative is the console package holding its own copy of
 * "All statuses (live)" and "Archived (deleted)", in a package that cannot
 * import the one place they are defined — four more strings that can disagree
 * with the screen they were migrated from. `orders-console-route.ts` sends its
 * period presets down the wire for exactly this reason and at exactly this
 * cost: a few hundred bytes on a list load.
 *
 * THE COMBINED STATUS SELECT IS ONE CONTROL, not two axes. A soft-deleted row
 * is always inactive, so `archived` and `active` are mutually exclusive by
 * construction and offering them as one select is what makes that true in the
 * UI rather than merely true in {@link toClientFilter}.
 */
export const PRODUCTS_STATUS_OPTIONS: readonly SelectOption[] = [
	{ value: ANY, label: "All statuses (live)" },
	{ value: "true", label: "Active" },
	{ value: "false", label: "Inactive" },
	{ value: "archived", label: "Archived (deleted)" },
];

export const PRODUCTS_KIND_OPTIONS: readonly SelectOption[] = [
	{ value: ANY, label: "All kinds" },
	{ value: "physical", label: PRODUCT_KIND_LABELS.physical },
	{ value: "digital", label: PRODUCT_KIND_LABELS.digital },
];

/** The console's own filter form values, kept alongside the opaque service
 *  cursor so paging preserves the form. `active`/`productKind` are tri-state
 *  strings ({@link PRODUCTS_FILTER_ANY} ⇒ no constraint) because a Block Kit
 *  `select` had no "unset" value distinct from its options.
 *
 *  `archived` is the archive-view toggle: unset ⇒ the default (live products
 *  only, active + inactive both listed); `"true"` ⇒ ONLY soft-deleted rows. A
 *  soft-deleted row is always inactive, so the combined "Status" select
 *  offers the two as ONE mutually-exclusive choice rather than two
 *  independently-toggleable axes.
 *
 *  `lowStock` is the "Low stock only" toggle: unset ⇒ every row; `"true"` ⇒
 *  only rows whose on-hand count is at or below the store's threshold. Stored
 *  as the same `"true"` string as `archived` because this object is JSON. */
export interface ProductsFilterForm {
	active?: "true" | "false";
	productKind?: "physical" | "digital";
	search?: string;
	archived?: "true";
	lowStock?: "true";
}

/** Translate the console's filter form into the client's list filter.
 *  `archived` wins over `active`: the two are mutually exclusive by
 *  construction (one combined "Status" select), but `deleted: true` is
 *  asserted alone regardless, so a hand-crafted request can never smuggle both
 *  axes into one query. */
export function toClientFilter(form: ProductsFilterForm): ProductsListFilter {
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

export function filterFormFromValues(values: Record<string, unknown>): ProductsFilterForm {
	const form: ProductsFilterForm = {};
	const status = readString(values.status);
	const productKind = readString(values.productKind);
	const search = readString(values.search);
	// The toggle arrives as a REAL boolean, never a string — so this one field is
	// read with a typeof check rather than `readString`.
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
export function readOnHand(p: ProductSummaryWire): number | null | undefined {
	const raw: unknown = (p as { onHand?: unknown }).onHand;
	if (raw === null) return null;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** The store's low-stock threshold, or null when it cannot be read. A refusal
 *  here costs the `Low` band alone — a count still renders and `0` still reads
 *  `Out of stock`, neither of which needs a threshold. */
export async function readLowStockThreshold(
	client: ReportingSettingsClient,
): Promise<number | null> {
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

/**
 * A small static tax-class registry the edit form falls back to when the live
 * registry read is unavailable/empty. Deliberately the near-universal defaults;
 * the live `GET /admin/tax/classes` set, when present, is the source of truth
 * and this only backstops it.
 */
const DEFAULT_TAX_CLASSES: TaxClassWire[] = [
	{ id: "standard", name: "Standard" },
	{ id: "reduced", name: "Reduced" },
	{ id: "zero", name: "Zero-rated" },
	{ id: "digital", name: "Digital goods" },
];

/** The live tax-class registry, falling back to {@link DEFAULT_TAX_CLASSES} on
 *  a failed or empty read — a registry read must never break the detail (E-1). */
export async function readTaxClasses(client: AdminProductsClient): Promise<TaxClassWire[]> {
	try {
		const fetched = await client.getTaxClasses();
		return fetched.length > 0 ? fetched : DEFAULT_TAX_CLASSES;
	} catch {
		return DEFAULT_TAX_CLASSES;
	}
}

export interface StockPageContext {
	/** The store's low-stock threshold, or `null` when the settings read failed
	 *  (which costs the `Low` band and nothing else). */
	threshold: number | null;
	/** The page came back carrying no stock figure on ANY row — a degraded read
	 *  rather than a catalog fact. Every cell reads `—` and the list says so
	 *  once, in a banner, inside a 200 (G5/E-1). Independent of
	 *  `filterUnavailable` — see `resolveStockContext`'s doc. */
	unreadable: boolean;
	/**
	 * "Low stock only" was asked for and the outgoing request could not carry a
	 * predicate, so the page is UNFILTERED and says so — never silently the
	 * wrong set of rows.
	 *
	 * ONE CAUSE ONLY, where the client-side narrowing this replaced
	 * folded two into one. The threshold could not be read is the sole reason
	 * left: `unreadable` used to ALSO force this true, because the old
	 * narrowing could not tell "no threshold" apart from "nothing to compare
	 * it against" — both cost the same thing then, a page that stayed
	 * unfiltered. Now the predicate is the SERVER's, so a resolved threshold
	 * means the request really did carry it and the page really is filtered,
	 * whether or not THIS page's own on-hand DISPLAY column came back
	 * readable. Folding `unreadable` back in here would raise "the filter was
	 * not applied" over a list that is — see `resolveStockContext`'s doc.
	 */
	filterUnavailable: boolean;
}

/** What {@link resolveStockContext} decides. */
export interface StockPageResult {
	readonly stock: StockPageContext;
	/** The `total` this render may state, or `undefined` when it must not. See
	 *  {@link resolveStockContext}'s doc. */
	readonly total: number | undefined;
}

/**
 * The page context "Low stock only" and the settings read leave behind, now
 * that the predicate is the SERVER's rather than a narrowing this
 * module used to apply to an already-fetched page. Two decisions live here:
 *
 *  1. **`filterUnavailable` has ONE cause, not two.** The retired client-side
 *     narrowing conflated "no threshold to filter by" with "every row's
 *     on-hand came back unreadable" into one `canFilter` boolean, because both
 *     used to cost the SAME thing — the page stayed unfiltered either way.
 *     They no longer cost the same thing: `threshold === null` means the
 *     outgoing request never carried a predicate at all, so the page
 *     genuinely IS every row. `unreadable` is a fact about the WIRE
 *     PROJECTION of an already-(possibly-)filtered page, discovered only
 *     after the fetch, and says nothing about whether the predicate ran — a
 *     page can be genuinely low-stock-filtered by real `on_hand` values while
 *     its OWN on-hand DISPLAY column is unreadable. So `filterUnavailable`
 *     reports the first cause alone; `unreadable` travels ALONGSIDE it, never
 *     folded in, and the banner (`stockDegradation`) already composes the two
 *     as independently-true facts.
 *  2. **`total` inherits the truth `filterUnavailable` states.** Once the
 *     predicate is server-side, the service's count is of the SAME set the
 *     page is drawn from whenever the predicate actually ran, because
 *     `listProducts` and `countProducts` share one predicate builder — so the
 *     count now DESCRIBES the rows on screen and must be shown, the inverse of
 *     the client-side-narrowing days this replaces (that count described a
 *     DIFFERENT, unnarrowed set and had to be withheld). It reverts to
 *     withheld on exactly the one case where nothing was filtered: a `total`
 *     shown there would caption an unfiltered page as though the operator's
 *     request had been honoured. `unreadable` alone never touches `total` —
 *     an unreadable on-hand COLUMN says nothing about whether the COUNT is
 *     right.
 */
export function resolveStockContext(
	products: readonly ProductSummaryWire[],
	opts: { wantsLowStock: boolean; threshold: number | null; total: number | undefined },
): StockPageResult {
	const unreadable = products.length > 0 && products.every((p) => readOnHand(p) === undefined);
	const filterUnavailable = opts.wantsLowStock && opts.threshold === null;
	return {
		stock: { threshold: opts.threshold, unreadable, filterUnavailable },
		total: filterUnavailable ? undefined : opts.total,
	};
}
