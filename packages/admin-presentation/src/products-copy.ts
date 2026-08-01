/**
 * The Pricing & inventory screen's authored copy — the strings BOTH Pricing &
 * inventory screens put on screen (INC-21).
 *
 * WHY A SCREEN'S COPY IS IN A SHARED PACKAGE AT ALL. The same reason
 * `orders-copy.ts` gives, and it is a migration artefact in exactly the same
 * way: for the length of this migration there are TWO Pricing & inventory
 * screens rendering the same products side by side in the same sidebar, and
 * ADR-0014 requires both to keep working until the replacement is proven. That
 * makes every string here a cross-surface contract rather than a screen's
 * private business — an operator comparing the two, which is the entire point
 * of shipping them together, must not have to work out whether two different
 * sentences describe the same state.
 *
 * WHAT IS *NOT* HERE, AND WHY — the list is short on purpose, because after
 * INC-21's review the default is that a rendered string belongs here.
 *
 *  1. **Every outcome banner a WRITE produces** ("Stock added", "SKU already in
 *     use", "This product changed since you opened it", …). Those stay in
 *     `products-page.ts`, because the React screen does not author them — it
 *     forwards the click to the Block Kit handler and renders the notice that
 *     handler returned (ADR-0014's "no second implementation of a path that
 *     moves stock"). Copy only one surface can PRODUCE is not a cross-surface
 *     contract, and moving it here would suggest the React tier decides
 *     something about a stock movement. It decides nothing.
 *  2. **Strings only one surface has a place for.** The Block Kit screen's
 *     `Open product` picker label and its `Review removal` submit describe
 *     controls the React screen deleted (the picker) or collapsed (the staged
 *     review step); the React screen's `Loading product…` / `Loading products…`
 *     describe a state Block Kit cannot be in, since it re-renders the whole
 *     block tree per interaction. Sharing a string for a control the other
 *     surface does not have would assert a parity that does not exist.
 *  3. **Generic console chrome** — `Apply filters`, `Load more`, `Clear
 *     filters`. These are not this SCREEN's vocabulary; `Clear filters` already
 *     lives in `list-outcome.ts` with the ladder that offers it, and the other
 *     two belong beside it in whichever increment gives the console a shared
 *     list-chrome module. Duplicated across six screens today, so pulling two of
 *     them here would make this file the accidental home of a console-wide
 *     concern.
 *  4. **Wire values that happen to read as words** — `physical`, `digital`,
 *     `archived`, `any`. Those travel as DATA from the plugin
 *     (`PRODUCTS_STATUS_OPTIONS`, `PRODUCTS_KIND_OPTIONS`), which is the
 *     stronger guarantee: the console cannot offer an option the screen it is
 *     migrating from does not have, because it holds no copy of the list.
 *
 * WHEN THE BLOCK KIT SCREEN IS RETIRED, this module goes back to
 * `@otta-sh/admin-react` and stops being shared.
 */
import { LABEL_BUDGET, fit, unitWord, valueLabel } from "./copy.js";
import { UNFORMATTABLE, formatOptionalAmount } from "./format-money.js";
import type { RowNoun, ZeroStateCopy } from "./list-outcome.js";

/** How the Pricing & inventory list names one row and many. */
export const PRODUCTS_NOUN: RowNoun = { one: "product", other: "products" };

/**
 * The standing half of the list's intro line — the row count goes in front of
 * it.
 *
 * 97 chars; the longest count line this screen can produce
 * (`25 products on this page`) puts the whole line at 124 ≤ 140 (X-11). The
 * "Archived" explanation lives in the filter panel; stock is a COLUMN, so this
 * line says what the count means instead of pointing at the detail.
 */
export const PRODUCTS_LIST_INTRO =
	"Filter and open a product. Money in each product's own currency; On hand is what can be sold now.";

/** Zero rows, no filter, first page: the catalog itself is empty. Offers no way
 *  IN, because products originate in the CMS (E-2). */
export const PRODUCTS_EMPTY: ZeroStateCopy = {
	title: "No products yet",
	description:
		"Products appear here as soon as a product document is saved in the CMS — pricing them is the next step, not a precondition.",
};

/** Zero rows with a filter on and NO low-stock narrowing: the operator narrowed
 *  to nothing, so the way out is the filter. */
export const PRODUCTS_NO_MATCH: ZeroStateCopy & { readonly emptyText: string } = {
	title: "No products match these filters",
	description:
		"Nothing came back for the filters you set. Clear them to go back to the whole catalog, or widen one and apply again.",
	emptyText: "No products match these filters.",
};

/**
 * Zero rows with "Low stock only" ON — and every sentence in it is PAGE-SCOPED,
 * because the filter is.
 *
 * "Low stock only" narrows the rows this page FETCHED rather than the query
 * (the service's products list has no stock predicate, and INC-03 measured one
 * unconditional join as cheaper than a gated one that walked ~9x the rows). So
 * page 1 holding no low-stock rows is the ordinary case on a real catalog, and
 * a whole-catalog claim here would be one the screen cannot keep. The
 * `scanNote` is what a zero-row page with another page behind it renders
 * instead of an empty state, so `Load more` survives and says what it is for.
 */
export const PRODUCTS_LOW_STOCK_NO_MATCH: ZeroStateCopy & {
	readonly emptyText: string;
	readonly scanNote: string;
} = {
	title: "No low-stock products on this page",
	description:
		"Every product on this page is above the low-stock threshold. Clear the filters to see them all, or set the threshold on Settings.",
	emptyText: "No low-stock products on this page.",
	scanNote: "No low-stock products on this page — Load more scans further.",
};

/** The "Low stock only" control's own description. PAGE-SCOPED WORDING, for the
 *  reason above: a description promising "every low-stock product" would be a
 *  claim the screen cannot keep. It states WHERE the threshold lives rather
 *  than its value — the number is a service read, and a filter control that
 *  sometimes carries a number and sometimes does not is worse than one that
 *  never does. */
export const LOW_STOCK_FILTER_DESCRIPTION =
	"Show only products at or below the low-stock threshold (applies per page; set the threshold on Settings).";

/** The `Low stock only` control's label, on both surfaces. */
export const LOW_STOCK_FILTER_LABEL = "Low stock only";

// ── the stock-degradation banner ─────────────────────────────────────────────

/** The three independently-true facts the degradation banner reports on. */
export interface StockDegradation {
	/** The page came back carrying no stock figure on ANY row — a degraded read
	 *  rather than a catalog fact. */
	readonly unreadable: boolean;
	/** The store's low-stock threshold could not be read, so nothing can read
	 *  `Low`. */
	readonly thresholdUnreadable: boolean;
	/** "Low stock only" was asked for and could not be honoured, so the page is
	 *  UNFILTERED. */
	readonly filterUnavailable: boolean;
}

/**
 * The ONE stock-degradation banner, composed once for both surfaces.
 *
 * EVERY CASE SHARES A SINGLE SLOT because X-31 caps a response at two top-level
 * banners and the notice may already hold one — so when two things are degraded
 * at once the banner carries BOTH, rather than one silently outranking the
 * other. `alert`, never `error`: the list rendered, and E-1/E-6 keep the error
 * variant for a fail-close or a refusal.
 *
 * The threshold case is worth saying even when nothing was filtered, because
 * the missing band is otherwise invisible: an under-stocked product just looks
 * like an ordinary one, and nothing else on the screen would give that away.
 *
 * `undefined` when nothing is degraded — the ordinary case, and the caller
 * renders no banner at all rather than an empty one.
 */
export function stockDegradation(
	facts: StockDegradation,
): { readonly title: string; readonly description: string } | undefined {
	const symptoms: string[] = [];
	const remedies: string[] = [];
	if (facts.unreadable) {
		symptoms.push("Stock levels are unavailable");
		remedies.push("On hand reads — for every row here; open a product to read its stock.");
	}
	if (facts.thresholdUnreadable) {
		symptoms.push("low-stock highlighting is unavailable");
		remedies.push(
			"The store's low-stock threshold could not be read — set it under Checkout & holds on Settings.",
		);
	}
	if (facts.filterUnavailable) {
		symptoms.push("the Low stock only filter was not applied");
		remedies.push("Every product on this page is listed.");
	}
	if (symptoms.length === 0) return undefined;
	const joined = symptoms.join("; ");
	return {
		title: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`,
		description: remedies.join(" "),
	};
}

// ── the detail ───────────────────────────────────────────────────────────────

/** G2 / ADR-0013, stated in the LABEL: `active` is CMS-owned, so the field
 *  names its owner and renders as text. There is no Status form control on
 *  either surface, and `ProductEditWire` has no `active` member, so one would
 *  not compile. */
export const STATUS_FIELD_LABEL = "Status (set in the CMS)";

/** One line naming both what happened and what to do, for a tombstoned product
 *  — shown in place of the edit and stock-movement forms (DA-7). */
export const TOMBSTONE_CONTEXT =
	"This product was deleted in the CMS — editing and stock moves are unavailable. Restore the document to re-enable them.";

/** The tombstone alert's title. Its description names a timestamp and is
 *  composed at the call site through the shared date dialect. */
export const TOMBSTONE_BANNER_TITLE = "This product was deleted in the CMS";

/** F-5a-i's normative sibling-discard line — ONE line, above the three split
 *  groups, never repeated inside them (X-45). */
export const SPLIT_DISCARD_CONTEXT =
	"Each section saves on its own. Save the section you are editing before you open another — saving one reloads the product and clears unsaved edits in the others.";

/** The Identity group's helper line. Names the CMS as the title's owner without
 *  offering a control for it (G2). */
export const IDENTITY_FORM_CONTEXT =
	"SKU is the stock-keeping code the store sells against. The title is set in the CMS.";

/** The Price group's helper line. */
export const PRICE_FORM_CONTEXT =
	"Price, compare-at and unit cost all use the product's one currency. A blank compare-at or unit cost clears it.";

/** The Classification & shipping group's helper line. */
export const SHIPPING_FORM_CONTEXT =
	"Weight and dimensions feed shipping quotes; blank leaves them unchanged. A blank tax class clears it.";

/** X-20-safe: says what the banned "no overselling" phrasing used to, in terms
 *  of the count itself. */
export const STOCK_ON_HAND_CONTEXT =
	"On hand is what can be sold right now — open cart holds are already subtracted. Whole units only.";

/** Replaces the deleted single-option "When out of stock" select (F-3) and the
 *  banned phrasing (X-20) with the mechanism sentence, which is the whole of
 *  what the operator needs. */
export const BACKORDERS_CONTEXT =
	"The store stops selling at zero stock; backorders are a future capability.";

/** D-7: a skuless "create then price" product has nothing to move stock
 *  against (the service would 409 NO_SKU anyway) — one line, no forms. */
export const NO_SKU_CONTEXT =
	"Stock movements need a SKU first — set one under Identity on the Product tab.";

/** The sku exists but carries NO inventory record. Both movements would 409
 *  UNKNOWN_SKU, and their idempotency keys derive from an on-hand watermark
 *  that does not exist — so neither form renders, and this says why. */
export const NO_INVENTORY_RECORD_CONTEXT =
	"This SKU has no inventory record yet. Saving any section on the Product tab creates one, and stock can be added here after that.";

/** Said on the DETAIL when the threshold could not be read, in the register
 *  that panel already uses — the same fact the list's banner carries. */
export const LOW_STOCK_BAND_UNAVAILABLE_CONTEXT =
	"Low-stock highlighting is unavailable — the threshold could not be read. Set it under Checkout & holds on Settings.";

// ── the two adjacent stock forms (PM §E2) ────────────────────────────────────

/** The `Add stock` group's label. DA-4: one-shot, no confirm, no danger —
 *  restocking is not the destructive act on this screen. */
export const ADD_STOCK_LABEL = "Add stock";

/** The `Add stock` field's label. */
export const ADD_STOCK_FIELD_LABEL = "Units to add";

/** The `Remove stock` field's label — it names the reason a merchant removes
 *  stock, which is what distinguishes the two adjacent forms at a glance. */
export const REMOVE_STOCK_FIELD_LABEL = "Units to remove (damaged / shrinkage)";

/** D-6a: the group label carries the CONSEQUENCE, not just the verb (X-35). */
export const REMOVE_STOCK_GROUP_LABEL = "Remove stock — permanent, cannot be undone by restocking";

/** DA-3 state 1's required alert. */
export const REMOVE_STOCK_BANNER = {
	title: "Removing stock cannot be undone by restocking",
	description: "This records a stock removal — the store treats it as a separate ledger entry.",
} as const;

/** The explanatory line beneath it. */
export const REMOVE_STOCK_CONTEXT =
	"Restocking appends a second movement — it does not correct this one. Check the number before confirming.";

/** The restock refusal an unparseable quantity earns. */
export const ADD_STOCK_INVALID_QTY = {
	title: "Enter a whole number of units",
	description: "Units to add must be a positive whole number, like 12.",
} as const;

/** The removal refusal an unparseable quantity earns. Its own copy, not the
 *  restock one: "nothing was changed" is the half an operator most needs to
 *  read on the destructive form. */
export const REMOVE_STOCK_INVALID_QTY = {
	title: "Not removed",
	description: "Enter a whole number of units greater than zero, like 3. Nothing was changed.",
} as const;

/**
 * The remove-stock confirm dialog, composed from the quantity.
 *
 * ONE COMPOSITION, TWO SURFACES, and it is the load-bearing half of this
 * module. The Block Kit screen shows this as a `confirm` on its DA-3 state-2
 * button; the React screen shows it in a native `<dialog>` in place of the
 * staged step — the same collapse INC-20 made for refunds, and safe for the
 * same reason: every check the review step performed is performed again,
 * server-side against live truth, by the write handler. What must not collapse
 * is the SENTENCE the operator reads before the stock moves.
 *
 * The title is trimmed to the label budget for the same reason a group label
 * is (X-11); at any realistic quantity it is nowhere near it.
 */
export function removeStockConfirm(qty: number): {
	readonly title: string;
	readonly text: string;
	readonly confirm: string;
	readonly deny: string;
} {
	const unit = unitWord(qty);
	return {
		title: fit(`Remove ${String(qty)} ${unit}?`, LABEL_BUDGET),
		text: `Remove ${String(qty)} ${unit} from stock? This records a removal and cannot be undone by restocking.`,
		confirm: `Yes, remove ${String(qty)}`,
		deny: "Keep as is",
	};
}

// ── composed labels and cells ────────────────────────────────────────────────
//
// D-6: a group's label carries its ANSWER, so the group can be skipped
// unopened. Composed here rather than on each surface for the ordinary reason —
// two screens showing the same product must not label the same group two ways —
// and kept inside the label budget by `valueLabel`, which shortens the LONGEST
// value rather than the tail (a 40-character tax-class slug would otherwise
// silently delete the weight and leave a label that looks complete).

/** The Identity group holds exactly one value — the SKU. A product created in
 *  the CMS before anyone set one has none yet; that is a real state with a real
 *  consequence (no stock movements, D-7), so it is NAMED rather than rendered
 *  as an empty tail. */
export function identityGroupLabel(sku: string | null): string {
	return valueLabel("Identity", [sku ?? "no SKU"]);
}

/** The Price group's answer. An unpriced product says so; it never reads
 *  `$0.00`, which is a price nobody set. */
export function priceGroupLabel(priceCents: number | null, currencyCode: string | null): string {
	if (priceCents === null || currencyCode === null) return valueLabel("Price", ["not priced yet"]);
	return valueLabel("Price", [`${formatOptionalAmount(priceCents, currencyCode)} ${currencyCode}`]);
}

/** The two values an operator opens `Classification & shipping` to check.
 *
 *  The tax class renders as its ID, not the `name (id)` pair the summary row and
 *  the select use: these ids are readable natural-key slugs (`standard`,
 *  `eu-standard-vat`), never uuids, so §1.3 leaves them in full — and the full
 *  pair would consume the whole label budget on its own, leaving no room for the
 *  weight. Neither value is invented when absent: an unset one says so. */
export function shippingGroupLabel(taxClass: string | null, weightGrams: number | null): string {
	return valueLabel("Classification & shipping", [
		taxClass ?? "no tax class",
		weightGrams === null ? "no weight" : `${String(weightGrams)} g`,
	]);
}

/** A tax-class registry entry, structurally — both surfaces hold their own wire
 *  type and this names only what a label needs. */
export interface TaxClassRef {
	readonly id: string;
	readonly name: string;
}

/** The `Tax class` summary cell: the registry entry's name when known, else the
 *  raw id (a class the registry read did not include), else `—` (unset ⇒ the
 *  checkout treats it as standard). */
export function taxClassLabel(taxClass: string | null, taxClasses: readonly TaxClassRef[]): string {
	if (taxClass === null) return UNFORMATTABLE;
	const match = taxClasses.find((c) => c.id === taxClass);
	return match !== undefined ? `${match.name} (${match.id})` : taxClass;
}

/** The tax-class select's "clear it" sentinel — never `""`, which the pinned
 *  Block Kit renderer treats as "no value" and draws as a blank trigger (F-6a).
 *  The React tier has no such quirk and uses the same token anyway: the value
 *  round-trips to a handler that reads exactly one sentinel. */
export const NO_TAX_CLASS = "none";

/** The tax-class select's options: the clear-it sentinel, every registry entry,
 *  and — if the product currently references a class the registry read did not
 *  include — that id too, so an existing value is never silently dropped from
 *  the picker. */
export function taxClassOptions(
	current: string | null,
	taxClasses: readonly TaxClassRef[],
): Array<{ value: string; label: string }> {
	const options = [{ value: NO_TAX_CLASS, label: "— None (standard) —" }];
	for (const c of taxClasses) options.push({ value: c.id, label: `${c.name} (${c.id})` });
	if (current !== null && !taxClasses.some((c) => c.id === current)) {
		options.push({ value: current, label: current });
	}
	return options;
}

/** The `Dimensions (mm, LxWxH)` cell. A partially-measured product shows which
 *  axis is missing (`120 x ? x 40`) rather than a single dash that would hide
 *  the two figures somebody did record. */
export function dimensionsSummary(
	lengthMm: number | null,
	widthMm: number | null,
	heightMm: number | null,
): string {
	if (lengthMm === null && widthMm === null && heightMm === null) return UNFORMATTABLE;
	return [lengthMm, widthMm, heightMm].map((d) => (d === null ? "?" : String(d))).join(" x ");
}

// ── the fields an operator reads and fills ───────────────────────────────────
//
// WHY LABELS AND PLACEHOLDERS ARE HERE TOO (INC-21 review). The first cut
// shared the PROSE and left the labels hand-copied, on the reasoning that a
// label is structure rather than copy. Two screens rendering the same product
// side by side make that distinction meaningless: `Weight (g)` and `Weight (g)`
// are the same promise about the same column of the same table, and the moment
// one becomes `Weight (grams)` an operator comparing them has to work out
// whether they are looking at one field or two. The reviewers found ~20 of
// these already duplicated by hand; they are mechanical, so they are shared.

/** What a product with no title reads as — in the list table, in the Block Kit
 *  picker label, and nowhere near the product id, which is an opaque uuid §1.3
 *  keeps off a list row. The parenthesis and the lower case are deliberate: it
 *  has to be unmistakably a placeholder rather than a product somebody named. */
export const UNTITLED = "(untitled)";

/** The screen's own name — its H1 on React, its `header` block on Block Kit. */
export const PRODUCTS_SCREEN_TITLE = "Pricing & inventory";

/** The back control, on both surfaces and on both of each surface's paths (the
 *  detail and the not-found/failure state) — four hand-copies before this. */
export const PRODUCTS_BACK_LABEL = "← Back to pricing & inventory";

/** E-7's fail-closed banner. THREE copies before this: the Block Kit screen's
 *  `failClosed()`, the console route's own, and the React transport's HTTP
 *  refusal title. An operator paging someone must read one sentence, not three
 *  spellings of it. */
export const PRODUCTS_UNAVAILABLE_TITLE = "Pricing & inventory is unavailable";
export const PRODUCTS_UNAVAILABLE_DESCRIPTION =
	"Pricing & inventory could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.";

/** The identity strip and the two `fields` blocks, in render order. */
export const PRODUCT_FIELD_LABELS = {
	sku: "SKU",
	price: "Price",
	stockOnHand: "Stock on hand",
	compareAt: "Compare-at",
	unitCost: "Unit cost",
	taxClass: "Tax class",
	kind: "Kind",
	weight: "Weight (g)",
	dimensions: "Dimensions (mm, LxWxH)",
	created: "Created",
	updated: "Updated",
	onHand: "On hand",
	inventoryPolicy: "Inventory policy",
} as const;

/** The list table's columns, in render order. Money LAST (T-2). */
export const PRODUCT_COLUMN_LABELS = {
	title: "Title",
	sku: "SKU",
	status: "Status",
	onHand: "On hand",
	price: "Price",
} as const;

/** The list filter's three labelled controls (the fourth, `Low stock only`, has
 *  its own constants above because its DESCRIPTION carries the page-scoped
 *  promise). */
export const PRODUCT_FILTER_LABELS = {
	status: "Status",
	kind: "Kind",
	search: "Search (SKU exact, or title contains)",
} as const;

/** The detail's two constant panels (D-2). */
export const PRODUCT_TAB_LABELS = ["Product", "Stock"] as const;

/** The three split saves (F-5a). Each names its own SECTION, because the whole
 *  point of the split is that an operator knows which one they just saved. */
export const SAVE_IDENTITY_LABEL = "Save identity";
export const SAVE_PRICE_LABEL = "Save price";
export const SAVE_SHIPPING_LABEL = "Save classification";

/** The four measurement fields. Non-money integers, `/^\d+$/`-parsed on the
 *  other side; blank leaves them unchanged. */
export const PRODUCT_MEASUREMENT_LABELS = {
	weightGrams: "Weight (g)",
	lengthMm: "Length (mm)",
	widthMm: "Width (mm)",
	heightMm: "Height (mm)",
} as const;

/** The two `productKind` options. Lower-case on purpose: they are the WIRE
 *  values, and a `Physical` that submits `physical` is a label an operator
 *  cannot check against anything. */
export const PRODUCT_KIND_LABELS = { physical: "physical", digital: "digital" } as const;

/** Every money field's example amount. Placeholders, never initial values — an
 *  initial value here would be a price nobody set. */
export const PRICE_PLACEHOLDER = "19.99";
export const COMPARE_AT_PLACEHOLDER = "29.99";
export const UNIT_COST_PLACEHOLDER = "8.50";
export const CURRENCY_PLACEHOLDER = "USD";
export const ADD_STOCK_PLACEHOLDER = "e.g. 12";
export const REMOVE_STOCK_PLACEHOLDER = "e.g. 3";

/**
 * The price form's four labels, each composed from the product's ONE currency.
 *
 * THE CURRENCY IS IN THE LABEL AND NOT IN THE VALUE, which is the whole shape
 * of this form: `formatMinorUnitsInput` deliberately renders no symbol, so the
 * field holds `19.99` and the label says what 19.99 means. A product that has
 * never been priced has no currency to name, so each label says where the
 * currency is coming from instead of leaving a gap.
 */
export function priceFieldLabel(currencyCode: string | null): string {
	return `Price (${currencyCode ?? "set currency below"}, e.g. ${PRICE_PLACEHOLDER})`;
}

/** Rendered ONLY on a first pricing — for an already-priced product the
 *  currency cannot change here, so it is submitted invisibly and no control is
 *  offered (F-3: never a fixed single-option select). */
export const CURRENCY_FIELD_LABEL = "Currency (ISO-4217, e.g. USD) — set once when first pricing";

export function compareAtFieldLabel(currencyCode: string | null): string {
	return `Compare-at / was price (${currencyCode ?? "same as price"}, e.g. ${COMPARE_AT_PLACEHOLDER}) — blank to clear`;
}

/** "admin only, never shown to buyers" is load-bearing: unit cost is the one
 *  number on this screen a merchant would be alarmed to see on a product page. */
export function unitCostFieldLabel(currencyCode: string | null): string {
	return `Unit cost — admin only, never shown to buyers (${currencyCode ?? "same as price"}) — blank to clear`;
}

/**
 * The active-filter summary's parts — the strings the panel counts as
 * `(N active)` and lists beneath itself.
 *
 * ONE PART PER AUTHORED FIELD (L-3), and the combined Status select is ONE
 * field: `active` and `archived` share a control because a soft-deleted row is
 * always inactive, so they contribute one string between them. The caller
 * flattens its own filter shape into `status` first — the Block Kit form stores
 * the two axes separately and the React form stores one token — which is
 * exactly why the FLATTENING stays per-surface and the WORDING does not.
 *
 * The values are the raw tokens (`true` / `false` / `archived`), not prettied:
 * the summary sits directly beneath the control that produced them, and a
 * summary that renamed them would be unmatchable against it.
 */
export function productFilterParts(filter: {
	readonly status?: string | undefined;
	readonly kind?: string | undefined;
	readonly lowStock?: boolean | undefined;
	readonly search?: string | undefined;
}): string[] {
	const parts: string[] = [];
	if (filter.status !== undefined) parts.push(`status: ${filter.status}`);
	if (filter.kind !== undefined) parts.push(`kind: ${filter.kind}`);
	if (filter.lowStock === true) parts.push("stock: low only");
	if (filter.search !== undefined && filter.search.length > 0) {
		parts.push(`search: ${filter.search}`);
	}
	return parts;
}
