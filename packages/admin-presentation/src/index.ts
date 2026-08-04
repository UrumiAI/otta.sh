/**
 * `@otta-sh/admin-presentation` — the admin console's presentation primitives,
 * and the answer to a question INC-19 recorded and deliberately did not answer:
 * where does the React tier's `formatMoney` come from?
 *
 * THE PROBLEM THIS SOLVES. There are now two admin surfaces — the Block Kit
 * screens in `@otta-sh/plugin` and the React console in `@otta-sh/admin-react`
 * — and the console may not import the plugin. ADR-0014 Decision 3 gives it
 * exactly one data path (HTTP to `otta`'s existing authenticated admin routes),
 * and `.dependency-cruiser.cjs`'s `console-imports-no-workspace-package` makes
 * that mechanical: a static import of `@otta-sh/plugin` would be a second data
 * path, compiled in and invisible to the empty capability set the console is
 * pinned on. That rule's own comment names the bill this package pays:
 *
 *   > INC-20 owes the React tier a formatMoney, and G1 says it must come from
 *   > SHARING the existing function (a new presentation package both sides
 *   > import), never from writing a second one.
 *
 * `format-money.ts` had already named the trigger from the other side — extract
 * "only when a second real consumer package exists". INC-20 is the increment
 * where one does.
 *
 * WHAT IS IN IT, AND WHY EXACTLY THIS. Everything the two surfaces must AGREE
 * on when rendering the same record, and nothing else:
 *
 *  - **Money** (`money.ts`, `format-money.ts`) — G1. One renderer, one set of
 *    brands, integer minor units throughout. Two implementations of currency
 *    formatting is the failure mode the rule exists to prevent.
 *  - **Dates** (`datetime.ts`) — the console's ONE date dialect, `8 Jul 2026,
 *    10:30 UTC`. INC-13 spent an increment collapsing three answers to "what
 *    time did this happen?" into one; a React screen with its own
 *    `Intl.DateTimeFormat` would make it three again, and the operator would
 *    meet the disagreement one click apart, exactly as before.
 *  - **Short ids** (`short-id.ts`) — D4/§1.3. The rule is cross-surface by
 *    construction: the picker's computed prefix must be a `startsWith` prefix
 *    of the confirm dialog's fixed 8, and now the React row's prefix must line
 *    up with the Block Kit row's for the same page of orders. Two
 *    implementations could not be checked against each other; one cannot
 *    disagree.
 *  - **Order status** (`order-status.ts`) — the `cancelled · closed` vocabulary
 *    and the state-machine-derived exception set it is computed from.
 *  - **The list outcome ladder** (`list-outcome.ts`) — five outcomes, of which
 *    "zero rows but another page behind them" is the one both surfaces got
 *    wrong independently. The DECISION is shared; the rendering is not.
 *  - **The Orders screen's authored copy** (`orders-copy.ts`) — a migration
 *    artefact, and the module doc there says so: two Orders screens render the
 *    same records side by side for the length of INC-20/21, which makes their
 *    strings a cross-surface contract rather than a screen's private business.
 *  - **Product status and stock** (`product-status.ts`, `stock-input.ts`) —
 *    INC-21. `statusLabel` and `onHandCell` were already shared across three
 *    Block Kit surfaces so a product could not read `low` in one place and
 *    plain in another; the React screen is a fourth. `parseStockQty` follows
 *    the money parser for the same reason it did: the React screen checks a
 *    quantity before opening a confirm dialog, and the Block Kit screen checks
 *    the same string server-side.
 *  - **The Pricing & inventory screen's authored copy** (`products-copy.ts`) —
 *    the same migration artefact as `orders-copy.ts`, one screen along,
 *    including the shared composition of the stock-degradation banner and the
 *    remove-stock confirm.
 *  - **Copy budgets and trimmers** (`copy.ts`) — §1's banner and label budgets
 *    and the `fit` they are applied with, which both screens' copy needs.
 *
 * WHAT IS NOT IN IT. Anything with IO, anything React, anything EmDash, and any
 * wire type. Both consumers are hostile environments for a dependency: the
 * plugin's half is bundled into workerd by a harness that copies `src/` to a
 * bare scratch directory, and the console's half ships to a browser. So this
 * package depends on NOTHING, imports NOTHING, and is pure `Intl` and string
 * work — the same discipline `datetime.ts` already carried for the sandbox (G7)
 * and `short-id.ts` for allocation cost.
 *
 * DRIFT IS PROVEN, NOT TRUSTED, and by the suites that already existed:
 * `@otta-sh/plugin` re-exports these modules from their original paths, so
 * `packages/plugin/test/{format-money,money-parity,format-money.type-test}.ts`
 * and all 18 workerd sandbox suites now exercise THIS code through the plugin's
 * public surface. `test/` here covers the package on its own terms.
 */
export { canonicalMoneyInput, formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
export {
	MONEY_LOCALE,
	UNFORMATTABLE,
	formatAmount,
	formatMoney,
	formatOptionalAmount,
	majorUnits,
} from "./format-money.js";
export { cents, currency, type Cents, type Currency } from "./money.js";
export {
	DATE_LOCALE,
	DAY_MS,
	DAY_PATTERN,
	dayOf,
	endOfDay,
	formatDate,
	formatDay,
	formatTimestamp,
	startOfDay,
} from "./datetime.js";
export { SHORT_ID_CONFIRM_LEN, SHORT_ID_MIN, shortIdFixed, shortIdsFor } from "./short-id.js";
export {
	ORDER_STATE_SET,
	ORDER_STATES,
	TERMINAL_ORDER_STATES,
	orderStateCell,
	reconciliationSummary,
	type OrderState,
} from "./order-status.js";
export { refundCapabilityText, refundConfirmText } from "./order-refund-copy.js";
export {
	APPLY_FILTERS_LABEL,
	CLEAR_FILTERS_LABEL,
	LOAD_MORE_LABEL,
	NOTHING_ON_PAGE,
	PAGE_SCOPED_SUFFIX,
	PAGE_ZERO,
	SCAN_FURTHER,
	listOutcome,
	rowCountLine,
	type ListOutcome,
	type ListOutcomeOptions,
	type RowNoun,
	type ZeroStateCopy,
	type ZeroStateOffer,
} from "./list-outcome.js";
export {
	ABSENT,
	BANNER_BUDGET,
	LABEL_BUDGET,
	RETRYING_LABEL,
	RETRY_LABEL,
	VALUE_SEPARATOR,
	fit,
	fitBanner,
	fitLabel,
	unitWord,
	valueLabel,
} from "./copy.js";
export {
	CANCEL_BANNER,
	CANCEL_CONFIRM,
	CANCEL_GROUP_LABEL,
	CANCEL_PICK_REASON,
	CUSTOMER_CONTEXT_UNAVAILABLE,
	FULFILMENT_LABELS,
	FULLY_REFUNDED_NOTE,
	MARK_REFUNDED_CONFIRM,
	ORDERS_BACK_LABEL,
	ORDERS_EMPTY,
	ORDERS_LIST_INTRO,
	ORDERS_LOAD_MORE_FAILED_TITLE,
	ORDERS_NO_MATCH,
	ORDERS_NOUN,
	ORDERS_SEARCH_LABEL,
	ORDERS_STALE_CLEARED_NOTE,
	ORDER_LINES_EMPTY,
	ORDER_LINES_SNAPSHOT_NOTE,
	REFUNDS_GROUP_EMPTY_LABEL,
	REFUNDS_UNAVAILABLE,
	REFUND_ADDITIVE_NOTE,
	REFUND_AMOUNT_INVALID,
	REFUND_BY_REQUIRED,
	REFUND_PARTIAL_BANNER_TITLE,
	REFUND_PARTIAL_GROUP_LABEL,
	REFUND_REVIEW_STEP_PREFIX,
	REFUND_TOO_HIGH_TITLE,
	RESOLVE_RECONCILIATION_NOTE,
	SHIPPING_ADDRESS_ABSENT,
	TIMELINE_EMPTY,
	TIMELINE_UNAVAILABLE,
	cancelConfirmText,
	reconciliationAlertSentence,
	refundTooHighInline,
	refundTooHighText,
	refundsGroupLabel,
} from "./orders-copy.js";
export {
	LOW_STOCK_SUFFIX,
	ON_HAND_UNKNOWN,
	OUT_OF_STOCK_SUFFIX,
	inventoryPolicyLabel,
	onHandCell,
	statusLabel,
	type ProductLifecycle,
} from "./product-status.js";
export { parseOnHandWatermark, parseStockQty } from "./stock-input.js";
export {
	ADD_STOCK_FIELD_LABEL,
	ADD_STOCK_INVALID_QTY,
	ADD_STOCK_LABEL,
	ADD_STOCK_PLACEHOLDER,
	BACKORDERS_CONTEXT,
	COMPARE_AT_PLACEHOLDER,
	CURRENCY_FIELD_LABEL,
	CURRENCY_PLACEHOLDER,
	IDENTITY_FORM_CONTEXT,
	LOW_STOCK_BAND_UNAVAILABLE_CONTEXT,
	LOW_STOCK_FILTER_DESCRIPTION,
	LOW_STOCK_FILTER_LABEL,
	NO_INVENTORY_RECORD_CONTEXT,
	NO_SKU_CONTEXT,
	NO_CHANGES_TO_SAVE,
	PRICE_FORM_CONTEXT,
	PRICE_PENDING_CONTEXT,
	PRICE_PLACEHOLDER,
	PRODUCTS_BACK_LABEL,
	PRODUCTS_EMPTY,
	PRODUCTS_LIST_INTRO,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	PRODUCTS_NOUN,
	PRODUCTS_NO_MATCH,
	PRODUCTS_SCREEN_TITLE,
	PRODUCTS_UNAVAILABLE_DESCRIPTION,
	PRODUCTS_UNAVAILABLE_TITLE,
	PRODUCT_COLUMN_LABELS,
	PRODUCT_DELETED_SINCE_LOADED,
	PRODUCT_FIELD_LABELS,
	PRODUCT_FILTER_LABELS,
	PRODUCT_KIND_LABELS,
	PRODUCT_MEASUREMENT_LABELS,
	PRODUCT_NOT_FOUND_TITLE,
	PRODUCT_SECTION_LABELS,
	PRODUCT_SECTION_ORDER,
	PRODUCT_TAB_LABELS,
	REMOVE_STOCK_BANNER,
	REMOVE_STOCK_CONTEXT,
	REMOVE_STOCK_FIELD_LABEL,
	REMOVE_STOCK_GROUP_LABEL,
	REMOVE_STOCK_INVALID_QTY,
	REMOVE_STOCK_PLACEHOLDER,
	SAVE_IDENTITY_LABEL,
	SAVE_PRICE_LABEL,
	SAVING_LABEL,
	DISCARD_LABEL,
	UNSAVED_SUFFIX,
	SAVE_SHIPPING_LABEL,
	SHIPPING_FORM_CONTEXT,
	SPLIT_DISCARD_CONTEXT,
	STATUS_FIELD_LABEL,
	STOCK_ON_HAND_CONTEXT,
	TOMBSTONE_BANNER_TITLE,
	UNIT_COST_PLACEHOLDER,
	UNTITLED,
	TOMBSTONE_CONTEXT,
	NO_TAX_CLASS,
	addStockConfirm,
	compareAtFieldLabel,
	dimensionsSummary,
	dirtyGroupLabel,
	dirtySectionLabels,
	identityGroupLabel,
	leaveWithoutSavingConfirm,
	tabUnsavedLabel,
	priceChangeSummary,
	priceFieldLabel,
	priceGroupLabel,
	pricePendingLine,
	priceSavedNotice,
	productFilterParts,
	removeStockConfirm,
	shippingGroupLabel,
	stockDegradation,
	taxClassLabel,
	taxClassOptions,
	unitCostFieldLabel,
	type ProductSection,
	type StockDegradation,
	type TaxClassRef,
} from "./products-copy.js";
