/**
 * The React product detail (INC-21).
 *
 * THE INFORMATION ARCHITECTURE IS THE BLOCK KIT ONE, to the block: an H1
 * carrying the product's title, a back control, the notice, the tombstone
 * alert, a four-entry identity strip, then two constant tabs — `Product` and
 * `Stock`. An operator moving between the two screens during the migration must
 * not have to relearn where anything is, and §4's skeleton was argued out once
 * already.
 *
 * WRITES GO BACK TO THE BLOCK KIT HANDLERS, UNCHANGED. Every control here posts
 * the same `action_id` and the same payload its Block Kit counterpart posts;
 * the plugin re-assembles the `form_submit` carrier those handlers read and
 * forwards it. So `expectedUpdatedAt` still rides with a save and is still
 * enforced by the service's optimistic concurrency, the `onHand` watermark
 * still rides with a stock movement and is still re-read against live truth,
 * the idempotency keys are still content-derived and not nonces, and every
 * refusal message an operator can see here was authored, budgeted and
 * suite-covered for the Block Kit screen. This file decides nothing about stock
 * and nothing about money.
 *
 * G2 / ADR-0013 IS ASSERTED HERE, NOT ONLY INHERITED. There is no Title field
 * and no Status field on this screen, on EITHER surface: `product_commerce.title`
 * is a CMS-owned single-writer cache and `active` is the CMS's publish gate, so
 * both render as text and neither is editable. The Block Kit screen enforces
 * that structurally — `ProductEditWire` has no `title` or `active` member, so a
 * form field for one does not compile. The React screen sends a payload of
 * plain strings and gets no such compile error, which is exactly why a
 * Playwright spec asserts the absence directly (`products-console.spec.ts`)
 * rather than trusting this comment.
 *
 * WHAT REPLACES THE STAGED "REVIEW" STEP for a stock removal: the same collapse
 * INC-20 made for refunds. Block Kit stages the typed quantity server-side and
 * renders a confirm button on a second render, because a Block Kit form cannot
 * show a dialog over the values the operator just typed. React can, so the
 * operator reads the SAME sentence — composed by the SAME shared
 * `removeStockConfirm` — before anything is sent. Nothing is lost, because
 * every check the review step performed is performed again, server-side against
 * live truth, by the write handler: the watermark comparison, and then the
 * service's own guarded decrement, which refuses an over-removal cleanly rather
 * than going negative.
 */
import {
	ADD_STOCK_FIELD_LABEL,
	ADD_STOCK_INVALID_QTY,
	ADD_STOCK_LABEL,
	BACKORDERS_CONTEXT,
	IDENTITY_FORM_CONTEXT,
	LOW_STOCK_BAND_UNAVAILABLE_CONTEXT,
	NO_INVENTORY_RECORD_CONTEXT,
	NO_SKU_CONTEXT,
	NO_TAX_CLASS,
	ON_HAND_UNKNOWN,
	PRICE_FORM_CONTEXT,
	REMOVE_STOCK_BANNER,
	REMOVE_STOCK_CONTEXT,
	REMOVE_STOCK_FIELD_LABEL,
	REMOVE_STOCK_GROUP_LABEL,
	REMOVE_STOCK_INVALID_QTY,
	SHIPPING_FORM_CONTEXT,
	SPLIT_DISCARD_CONTEXT,
	STATUS_FIELD_LABEL,
	STOCK_ON_HAND_CONTEXT,
	TOMBSTONE_BANNER_TITLE,
	TOMBSTONE_CONTEXT,
	dimensionsSummary,
	formatMinorUnitsInput,
	formatOptionalAmount,
	formatTimestamp,
	identityGroupLabel,
	inventoryPolicyLabel,
	onHandCell,
	parseStockQty,
	priceGroupLabel,
	removeStockConfirm,
	shippingGroupLabel,
	statusLabel,
	taxClassLabel,
	taxClassOptions,
} from "@otta-sh/admin-presentation";
import * as React from "react";
import {
	PRODUCTS_ACT_SUBJECT,
	fetchProductDetail,
	isFailure,
	performAction,
	type ProductDetailPayload,
	type ProductRecord,
} from "../console-api.js";
import {
	Button,
	ConfirmDialog,
	CopyIdButton,
	Field,
	Fields,
	Group,
	Notice,
	buttonStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";
import { UNTITLED } from "./products-list.js";

const TAB_LABELS = ["Product", "Stock"] as const;

/** A pending confirm: what the operator is about to do, and the sentence they
 *  must read first. ONE piece of state, so two dialogs can never be open at once
 *  and a confirmed click cannot dispatch a different action than the one the
 *  dialog described. */
interface PendingAction {
	readonly actionId: string;
	readonly value: Record<string, string>;
	readonly title: string;
	readonly text: string;
	readonly confirmLabel: string;
	readonly denyLabel: string;
}

/** A text input's initial value for an optional money field. `null` is BLANK,
 *  never `0.00` — the blank-vs-zero distinction is load-bearing on this screen,
 *  because a blank compare-at CLEARS it and `0.00` would be a price of zero the
 *  domain refuses. */
function moneyInput(minorUnits: number | null): string {
	return minorUnits === null ? "" : formatMinorUnitsInput(minorUnits);
}

/** The same, for a non-money integer (weight, dimensions), where blank means
 *  "leave unchanged". */
function numberInput(value: number | null): string {
	return value === null ? "" : String(value);
}

export function ProductDetail({
	productId,
	onBack,
}: {
	productId: string;
	onBack: () => void;
}): React.ReactElement {
	const [detail, setDetail] = React.useState<ProductDetailPayload | null>(null);
	const [failure, setFailure] = React.useState<{ title: string; description: string } | null>(null);
	const [notice, setNotice] = React.useState<{
		variant: "default" | "error";
		title: string;
		description: string;
	} | null>(null);
	const [tab, setTab] = React.useState(0);
	const [pending, setPending] = React.useState<PendingAction | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [generation, setGeneration] = React.useState(0);

	React.useEffect(() => {
		let cancelled = false;
		void fetchProductDetail(productId).then((result) => {
			if (cancelled) return;
			if (isFailure(result)) {
				setFailure({ title: result.title, description: result.description });
				return;
			}
			setFailure(null);
			setDetail(result);
		});
		return () => {
			cancelled = true;
		};
	}, [productId, generation]);

	const dispatch = React.useCallback((action: PendingAction) => {
		setPending(null);
		setBusy(true);
		void performAction(action.actionId, action.value, PRODUCTS_ACT_SUBJECT).then((result) => {
			setBusy(false);
			if (isFailure(result)) {
				setNotice({ variant: "error", title: result.title, description: result.description });
				return;
			}
			const served = result.notice;
			setNotice(
				served === null
					? null
					: {
							variant: served.variant === "error" ? "error" : "default",
							title: served.title,
							description: served.description,
						},
			);
			// Re-read: a save moves `updatedAt` (and therefore every form's
			// watermark) and a stock movement moves `onHand`, so every value
			// rendered below has to come from what the operator can now see. This is
			// also the sibling-discard `SPLIT_DISCARD_CONTEXT` warns about, and it is
			// the same behaviour the Block Kit screen has.
			setGeneration((n) => n + 1);
		});
	}, []);

	if (failure !== null) {
		return (
			<div>
				<Button label="← Back to pricing & inventory" onClick={onBack} testId="products-back" />
				<div style={{ marginBlockStart: 16 }}>
					<Notice
						variant="error"
						title={failure.title}
						description={failure.description}
						testId="detail-failure"
					/>
				</div>
			</div>
		);
	}

	if (detail === null) {
		return (
			<p style={{ fontSize: 13, opacity: 0.7 }} aria-live="polite">
				Loading product…
			</p>
		);
	}

	const p = detail.product;
	const threshold = detail.threshold;
	const tombstoned = p.deletedAt !== null;

	return (
		<div>
			{/* M-10: the human handle stands in for the uuid when one exists. */}
			<h1 style={{ fontSize: 22, fontWeight: 700, marginBlockEnd: 8 }} data-testid="detail-heading">
				{p.title ?? p.productId}
			</h1>
			<div style={{ marginBlockEnd: 16 }}>
				<Button label="← Back to pricing & inventory" onClick={onBack} testId="products-back" />
			</div>

			{notice !== null && (
				<Notice
					variant={notice.variant}
					title={notice.title}
					description={notice.description}
					testId="detail-notice"
				/>
			)}

			{tombstoned && (
				<Notice
					variant="alert"
					title={TOMBSTONE_BANNER_TITLE}
					description={`Deleted on ${formatTimestamp(p.deletedAt ?? "")}. It cannot be edited or restocked from here; existing orders that included it are unaffected.`}
					testId="detail-tombstone"
				/>
			)}

			{/*
			  THE IDENTITY STRIP: "what am I looking at, and is it healthy" without a
			  click. The same four operational facts the Block Kit strip carries —
			  identity, money, sellability, stock — in the same order. `Status` is
			  CMS-owned (G2), so its LABEL names the owner and its value is text.
			  There is no Title row: the H1 above IS the title, and INC-15 deleted the
			  row that restated it verbatim one block below.
			*/}
			<section style={panelStyle}>
				<Fields
					testId="detail-identity"
					entries={[
						[
							"SKU",
							p.sku === null ? (
								ON_HAND_UNKNOWN
							) : (
								<span key="sku" style={{ display: "inline-flex", alignItems: "center" }}>
									<code data-testid="detail-sku">{p.sku}</code>
									<CopyIdButton id={p.sku} testId="detail-copy-sku" what="SKU" />
								</span>
							),
						],
						["Price", formatOptionalAmount(p.priceCents, p.currency)],
						[STATUS_FIELD_LABEL, statusLabel(p)],
						["Stock on hand", onHandCell(p.onHand, threshold)],
					]}
				/>
			</section>

			<div
				role="tablist"
				aria-label="Product sections"
				style={{ display: "flex", gap: 4, marginBlockEnd: 12 }}
			>
				{TAB_LABELS.map((label, index) => (
					<button
						key={label}
						type="button"
						role="tab"
						id={`otta-tab-${String(index)}`}
						aria-selected={tab === index}
						aria-controls={`otta-panel-${String(index)}`}
						className="otta-focusable"
						data-testid={`tab-${label.toLowerCase()}`}
						onClick={() => setTab(index)}
						style={{
							...buttonStyle,
							borderBlockEndWidth: tab === index ? 2 : 1,
							fontWeight: tab === index ? 650 : 400,
							opacity: tab === index ? 1 : 0.7,
						}}
					>
						{label}
					</button>
				))}
			</div>

			<div
				role="tabpanel"
				id={`otta-panel-${String(tab)}`}
				aria-labelledby={`otta-tab-${String(tab)}`}
			>
				{tab === 0 && (
					<ProductPanel
						product={p}
						taxClasses={detail.taxClasses}
						busy={busy}
						onSubmit={(actionId, value) =>
							dispatch({
								actionId,
								value,
								title: "",
								text: "",
								confirmLabel: "",
								denyLabel: "",
							})
						}
					/>
				)}

				{tab === 1 && (
					<StockPanel
						product={p}
						threshold={threshold}
						busy={busy}
						onRestock={(qty) =>
							dispatch({
								actionId: "products:restock",
								value: {
									productId: p.productId,
									onHand: String(p.onHand ?? 0),
									qty: String(qty),
								},
								title: "",
								text: "",
								confirmLabel: "",
								denyLabel: "",
							})
						}
						onRemove={(qty) => {
							const confirm = removeStockConfirm(qty);
							setPending({
								actionId: "products:remove-stock",
								value: {
									productId: p.productId,
									qty: String(qty),
									// THE WATERMARK AS THE OPERATOR SAW IT — the on-hand this
									// render was built from. The handler re-reads live stock and
									// refuses on a mismatch, and this is the third component of
									// the idempotency key (F-2a).
									onHand: String(p.onHand ?? 0),
								},
								title: confirm.title,
								text: confirm.text,
								confirmLabel: confirm.confirm,
								denyLabel: confirm.deny,
							});
						}}
					/>
				)}
			</div>

			<ConfirmDialog
				open={pending !== null}
				title={pending?.title ?? ""}
				text={pending?.text ?? ""}
				confirmLabel={pending?.confirmLabel ?? ""}
				denyLabel={pending?.denyLabel ?? ""}
				onDeny={() => setPending(null)}
				onConfirm={() => {
					if (pending !== null) dispatch(pending);
				}}
			/>
		</div>
	);
}

// ── panel "Product" ──────────────────────────────────────────────────────────

function ProductPanel({
	product: p,
	taxClasses,
	busy,
	onSubmit,
}: {
	product: ProductRecord;
	taxClasses: readonly { id: string; name: string }[];
	busy: boolean;
	onSubmit: (actionId: string, value: Record<string, string>) => void;
}): React.ReactElement {
	const carrier = { productId: p.productId, expectedUpdatedAt: p.updatedAt };
	return (
		<>
			<section style={panelStyle}>
				<Fields
					testId="detail-more"
					entries={[
						["Compare-at", formatOptionalAmount(p.compareAtCents, p.compareAtCurrency)],
						["Unit cost", formatOptionalAmount(p.unitCostCents, p.unitCostCurrency)],
						["Tax class", taxClassLabel(p.taxClass, taxClasses)],
						["Kind", p.productKind],
						["Weight (g)", p.weightGrams === null ? ON_HAND_UNKNOWN : String(p.weightGrams)],
						["Dimensions (mm, LxWxH)", dimensionsSummary(p.lengthMm, p.widthMm, p.heightMm)],
						["Created", formatTimestamp(p.createdAt)],
						["Updated", formatTimestamp(p.updatedAt)],
					]}
				/>
			</section>

			{/* DA-7: a tombstoned product's forms are OMITTED entirely rather than
			    rendered and then refused. The panel itself keeps rendering (D-3). */}
			{p.deletedAt !== null ? (
				<p style={{ fontSize: 13, opacity: 0.8 }} data-testid="detail-tombstone-context">
					{TOMBSTONE_CONTEXT}
				</p>
			) : (
				<>
					{/*
					  F-5a-i: ONE sibling-discard line, above the three groups, never
					  repeated inside them. It is as true here as on Block Kit — a save
					  re-reads the product, which moves every other form's
					  `expectedUpdatedAt`.
					*/}
					<p style={{ fontSize: 12, opacity: 0.75 }} data-testid="detail-split-discard">
						{SPLIT_DISCARD_CONTEXT}
					</p>

					{/*
					  D-5 rank 3: `Identity` is this screen's named primary edit group and
					  is open on arrival whenever the record is editable.
					*/}
					<Group testId="edit-identity" defaultOpen label={identityGroupLabel(p.sku)}>
						<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>
							{IDENTITY_FORM_CONTEXT}
						</p>
						<IdentityForm
							product={p}
							busy={busy}
							onSubmit={(values) => onSubmit("products:save-identity", { ...carrier, ...values })}
						/>
					</Group>

					<Group testId="edit-price" label={priceGroupLabel(p.priceCents, p.currency)}>
						<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>{PRICE_FORM_CONTEXT}</p>
						<PriceForm
							product={p}
							busy={busy}
							onSubmit={(values) => onSubmit("products:save-price", { ...carrier, ...values })}
						/>
					</Group>

					<Group testId="edit-shipping" label={shippingGroupLabel(p.taxClass, p.weightGrams)}>
						<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>
							{SHIPPING_FORM_CONTEXT}
						</p>
						<ShippingForm
							product={p}
							taxClasses={taxClasses}
							busy={busy}
							onSubmit={(values) => onSubmit("products:save-shipping", { ...carrier, ...values })}
						/>
					</Group>

					{/* X-20-safe: the mechanism sentence, in place of the deleted
					    single-option "When out of stock" select. */}
					<p style={{ fontSize: 12, opacity: 0.7 }} data-testid="detail-backorders">
						{BACKORDERS_CONTEXT}
					</p>
				</>
			)}
		</>
	);
}

/**
 * The Identity group's form — SKU only.
 *
 * NO TITLE FIELD (G2 / ADR-0013). `product_commerce.title` is a CMS-owned
 * single-writer cache: the sync upserts it on every publish, so an admin edit
 * would be reverted by the next one and the two homes would disagree in
 * between. The title renders as this screen's H1 and nowhere else, and the
 * context line above says who owns it.
 */
function IdentityForm({
	product: p,
	busy,
	onSubmit,
}: {
	product: ProductRecord;
	busy: boolean;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const [sku, setSku] = React.useState(p.sku ?? "");
	return (
		<div style={{ display: "grid", gap: 10, maxInlineSize: 420 }}>
			<Field label="SKU">
				<input
					className="otta-focusable"
					data-testid="edit-sku"
					style={inputStyle}
					value={sku}
					onChange={(event) => setSku(event.target.value)}
				/>
			</Field>
			<div>
				<Button
					label="Save identity"
					testId="save-identity"
					disabled={busy}
					onClick={() => onSubmit({ sku })}
				/>
			</div>
		</div>
	);
}

/**
 * The Price group's form: price, an optional currency, compare-at and unit cost
 * — the four fields that must co-reside because they all read the product's one
 * currency.
 *
 * CURRENCY IS NEVER A FIXED SINGLE-OPTION SELECT (F-3). For an ALREADY-PRICED
 * product the currency cannot change here, so it is submitted invisibly and no
 * control is rendered for it; only a first-time pricing renders a real input.
 *
 * BLANK IS PRESERVED AS BLANK, and the distinction is the whole of what these
 * fields mean. A blank PRICE leaves the price unchanged; a blank COMPARE-AT or
 * UNIT COST CLEARS it. Both are the Block Kit screen's behaviour, both are
 * implemented by the same `buildEditWire` on the other side, and neither is
 * decided here — this form's only job is not to turn a null into `"0.00"` on
 * the way in.
 */
function PriceForm({
	product: p,
	busy,
	onSubmit,
}: {
	product: ProductRecord;
	busy: boolean;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const priced = p.priceCents !== null && p.currency !== null;
	const [price, setPrice] = React.useState(moneyInput(p.priceCents));
	const [currency, setCurrency] = React.useState(p.currency ?? "");
	const [compareAt, setCompareAt] = React.useState(moneyInput(p.compareAtCents));
	const [unitCost, setUnitCost] = React.useState(moneyInput(p.unitCostCents));
	return (
		<div style={{ display: "grid", gap: 10, maxInlineSize: 460 }}>
			<Field label={`Price (${p.currency ?? "set currency below"}, e.g. 19.99)`}>
				<input
					className="otta-focusable"
					data-testid="edit-price"
					style={inputStyle}
					placeholder="19.99"
					value={price}
					onChange={(event) => setPrice(event.target.value)}
				/>
			</Field>
			{!priced && (
				<Field label="Currency (ISO-4217, e.g. USD) — set once when first pricing">
					<input
						className="otta-focusable"
						data-testid="edit-currency"
						style={inputStyle}
						placeholder="USD"
						value={currency}
						onChange={(event) => setCurrency(event.target.value)}
					/>
				</Field>
			)}
			<Field
				label={`Compare-at / was price (${p.currency ?? "same as price"}, e.g. 29.99) — blank to clear`}
			>
				<input
					className="otta-focusable"
					data-testid="edit-compare-at"
					style={inputStyle}
					placeholder="29.99"
					value={compareAt}
					onChange={(event) => setCompareAt(event.target.value)}
				/>
			</Field>
			<Field
				label={`Unit cost — admin only, never shown to buyers (${p.currency ?? "same as price"}) — blank to clear`}
			>
				<input
					className="otta-focusable"
					data-testid="edit-unit-cost"
					style={inputStyle}
					placeholder="8.50"
					value={unitCost}
					onChange={(event) => setUnitCost(event.target.value)}
				/>
			</Field>
			<div>
				<Button
					label="Save price"
					testId="save-price"
					disabled={busy}
					onClick={() => onSubmit({ price, currency, compareAt, unitCost })}
				/>
			</div>
		</div>
	);
}

/** The Classification & shipping group's form: exactly the six fields the Block
 *  Kit form carries. `Kind` and `Tax class` are closed sets; the four
 *  measurements are non-money integers, validated server-side by the same
 *  `buildEditWire` (`/^\d+$/`) that validates the Block Kit submit. */
function ShippingForm({
	product: p,
	taxClasses,
	busy,
	onSubmit,
}: {
	product: ProductRecord;
	taxClasses: readonly { id: string; name: string }[];
	busy: boolean;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const [productKind, setProductKind] = React.useState(p.productKind);
	const [taxClass, setTaxClass] = React.useState(p.taxClass ?? NO_TAX_CLASS);
	const [weightGrams, setWeightGrams] = React.useState(numberInput(p.weightGrams));
	const [lengthMm, setLengthMm] = React.useState(numberInput(p.lengthMm));
	const [widthMm, setWidthMm] = React.useState(numberInput(p.widthMm));
	const [heightMm, setHeightMm] = React.useState(numberInput(p.heightMm));
	return (
		<div style={{ display: "grid", gap: 10, maxInlineSize: 460 }}>
			<Field label="Kind">
				<select
					className="otta-focusable"
					data-testid="edit-kind"
					style={inputStyle}
					value={productKind}
					onChange={(event) => setProductKind(event.target.value)}
				>
					<option value="physical">physical</option>
					<option value="digital">digital</option>
				</select>
			</Field>
			<Field label="Tax class">
				<select
					className="otta-focusable"
					data-testid="edit-tax-class"
					style={inputStyle}
					value={taxClass}
					onChange={(event) => setTaxClass(event.target.value)}
				>
					{taxClassOptions(p.taxClass, taxClasses).map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</Field>
			{(
				[
					["Weight (g)", "edit-weight", weightGrams, setWeightGrams],
					["Length (mm)", "edit-length", lengthMm, setLengthMm],
					["Width (mm)", "edit-width", widthMm, setWidthMm],
					["Height (mm)", "edit-height", heightMm, setHeightMm],
				] as const
			).map(([label, testId, value, set]) => (
				<Field key={testId} label={label}>
					<input
						className="otta-focusable"
						data-testid={testId}
						style={inputStyle}
						value={value}
						onChange={(event) => set(event.target.value)}
					/>
				</Field>
			))}
			<div>
				<Button
					label="Save classification"
					testId="save-shipping"
					disabled={busy}
					onClick={() =>
						onSubmit({ productKind, taxClass, weightGrams, lengthMm, widthMm, heightMm })
					}
				/>
			</div>
		</div>
	);
}

// ── panel "Stock" ────────────────────────────────────────────────────────────

/**
 * The two adjacent stock forms (PM §E2) — one recoverable, one not.
 *
 * `Add stock` is DA-4: one-shot, no confirm, no danger styling. `Remove stock`
 * is the screen's ONE destructive act (DA-5's second exception: a removal is
 * reversible only by a separate, forgettable manual operation), so it is the one
 * that carries an alert banner, danger styling and a confirm dialog. The
 * difference between them has to be legible at a glance, because they sit one
 * above the other and take the same input.
 */
function StockPanel({
	product: p,
	threshold,
	busy,
	onRestock,
	onRemove,
}: {
	product: ProductRecord;
	threshold: number | null;
	busy: boolean;
	onRestock: (qty: number) => void;
	onRemove: (qty: number) => void;
}): React.ReactElement {
	return (
		<>
			<section style={panelStyle}>
				<Fields
					testId="detail-stock"
					entries={[
						["On hand", onHandCell(p.onHand, threshold)],
						["Inventory policy", inventoryPolicyLabel(p.inventoryPolicy)],
					]}
				/>
			</section>

			{threshold === null && (
				<p style={{ fontSize: 12, opacity: 0.75 }} data-testid="stock-no-threshold">
					{LOW_STOCK_BAND_UNAVAILABLE_CONTEXT}
				</p>
			)}

			{p.deletedAt !== null ? (
				<p style={{ fontSize: 13, opacity: 0.8 }} data-testid="stock-tombstone-context">
					{TOMBSTONE_CONTEXT}
				</p>
			) : (
				<>
					<p style={{ fontSize: 12, opacity: 0.75 }} data-testid="stock-context">
						{STOCK_ON_HAND_CONTEXT}
					</p>
					{p.sku === null ? (
						// D-7: nothing to move stock against, so no forms at all.
						<p style={{ fontSize: 13, opacity: 0.8 }} data-testid="stock-no-sku">
							{NO_SKU_CONTEXT}
						</p>
					) : p.onHand === null ? (
						// The sku exists but carries NO inventory record: both movements
						// would 409, and their idempotency keys derive from a watermark
						// that does not exist. One line naming the state and the way out.
						<p style={{ fontSize: 13, opacity: 0.8 }} data-testid="stock-no-record">
							{NO_INVENTORY_RECORD_CONTEXT}
						</p>
					) : (
						<>
							<Group testId="stock-add" label={ADD_STOCK_LABEL}>
								<QuantityForm
									fieldLabel={ADD_STOCK_FIELD_LABEL}
									placeholder="e.g. 12"
									submitLabel={ADD_STOCK_LABEL}
									testIdPrefix="restock"
									invalid={ADD_STOCK_INVALID_QTY}
									busy={busy}
									onSubmit={onRestock}
								/>
							</Group>

							<Group testId="stock-remove" label={REMOVE_STOCK_GROUP_LABEL}>
								<Notice
									variant="alert"
									title={REMOVE_STOCK_BANNER.title}
									description={REMOVE_STOCK_BANNER.description}
									testId="remove-stock-banner"
								/>
								<p style={{ fontSize: 12, opacity: 0.75 }}>{REMOVE_STOCK_CONTEXT}</p>
								<QuantityForm
									fieldLabel={REMOVE_STOCK_FIELD_LABEL}
									placeholder="e.g. 3"
									submitLabel="Remove stock"
									testIdPrefix="remove"
									invalid={REMOVE_STOCK_INVALID_QTY}
									danger
									busy={busy}
									onSubmit={onRemove}
								/>
							</Group>
						</>
					)}
				</>
			)}
		</>
	);
}

/**
 * A whole-units quantity field with its own refusal line.
 *
 * PARSED WITH THE SHARED `parseStockQty`, in the browser, BEFORE anything is
 * sent — the same discipline the React refund field follows. It buys two things
 * a server round trip cannot: the remove-stock dialog can name the concrete
 * quantity (`Remove 3 units?`), and a typo produces an inline message instead of
 * a page-level banner. It replaces no server check: the handler on the other
 * side re-parses the same string with the same function, and the service's
 * guarded decrement is what actually bounds a removal.
 */
function QuantityForm({
	fieldLabel,
	placeholder,
	submitLabel,
	testIdPrefix,
	invalid,
	danger,
	busy,
	onSubmit,
}: {
	fieldLabel: string;
	placeholder: string;
	submitLabel: string;
	testIdPrefix: string;
	invalid: { readonly title: string; readonly description: string };
	danger?: boolean;
	busy: boolean;
	onSubmit: (qty: number) => void;
}): React.ReactElement {
	const [qty, setQty] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	return (
		<div style={{ display: "grid", gap: 10, maxInlineSize: 420 }}>
			<Field label={fieldLabel}>
				<input
					className="otta-focusable"
					data-testid={`${testIdPrefix}-qty`}
					style={inputStyle}
					placeholder={placeholder}
					value={qty}
					onChange={(event) => {
						setQty(event.target.value);
						setError(null);
					}}
				/>
			</Field>
			{error !== null && (
				<p
					role="status"
					aria-live="polite"
					data-testid={`${testIdPrefix}-qty-error`}
					style={{ fontSize: 12, margin: 0 }}
				>
					{error}
				</p>
			)}
			<div>
				<Button
					label={submitLabel}
					testId={`${testIdPrefix}-submit`}
					danger={danger === true}
					disabled={busy}
					onClick={() => {
						const parsed = parseStockQty(qty);
						if (parsed === null) {
							setError(invalid.description);
							return;
						}
						setError(null);
						onSubmit(parsed);
					}}
				/>
			</div>
		</div>
	);
}

/** Re-exported so the screen's own module can name the fallback the table uses
 *  for a product with no title, without importing the list for one string. */
export { UNTITLED };
