/**
 * The product editor's Pricing & stock section (ADR-0014, amendment 2026-10-01).
 *
 * It sits in the MAIN column of the product editor, under the content fields,
 * as three cards — Pricing, Inventory, Shipping & tax — the way the large
 * commerce admins lay a product out. EmDash renders it as the custom editor
 * (`fields.pricing`) of the products collection's `pricing` field; that field is
 * a placeholder that only says WHERE the cards go and never holds data: the
 * section never calls the field's `onChange`, and everything it edits lives in
 * the commerce store through the `otta` admin route, as before.
 *
 * ONE SAVE for every field, and stock moves on its own buttons, as a shop owner
 * expects: a price is a setting you edit and save, a stock count is something
 * you add to or take from. Removing stock asks first; adding does not.
 *
 * READ, MERGE, WRITE. A field editor is not told when the CMS saves the entry —
 * which moves the commerce row's watermark — so a save first re-reads the
 * product and keeps only the merchant's own edits on top of it (`mergeDraft`).
 *
 * Every decision about a value lives in `./pricing-model.ts`; this file wires
 * them up.
 */
import * as React from "react";
import {
	fetchProductDetail,
	isFailure,
	performAction,
	PRODUCTS_ACT_SUBJECT,
	type ActPayload,
	type ProductRecord,
	type Result,
	type TaxClass,
} from "../console-api.js";
import { ConfirmDialog, ConsoleStyles } from "../ui.js";
import { forgetSummaries } from "./pricing-columns.js";
import { usePricingStyles } from "./pricing-styles.js";
import {
	CURRENCY_CHOICES,
	draftFromRecord,
	isDraftDirty,
	marginSummary,
	mergeDraft,
	SIZE_FIELDS,
	salePreview,
	savePayload,
	stockStatus,
	validateDraft,
	type DraftField,
	type DraftProblems,
	type PricingDraft,
} from "./pricing-model.js";
import { parseStockQty } from "@otta-sh/admin-presentation";

/** What EmDash hands a plugin field editor. Declared structurally: this
 *  package does not depend on `@emdash-cms/admin`. `onChange` is never called —
 *  the field holds no data (see the module doc). */
export interface PricingFieldProps {
	readonly id?: string;
	readonly label?: string;
	readonly value?: unknown;
	readonly onChange?: (value: unknown) => void;
}

/**
 * The product id of the entry the editor has open, read from the editor's own
 * address (`…/content/<collection>/<id>`), because EmDash gives a field editor
 * the field's value and nothing about the entry. `null` for a new, unsaved
 * product (`…/new`) and for any address that is not a product editor.
 */
export function productIdFromPath(pathname: string): string | null {
	const match = /\/content\/products\/([^/?#]+)\/?$/.exec(pathname);
	if (match === null) return null;
	const id = decodeURIComponent(match[1] ?? "");
	return id === "new" || id.length === 0 ? null : id;
}

/** The field editor EmDash mounts in the product editor's main column. */
export function PricingStockField(_props: PricingFieldProps): React.ReactElement {
	usePricingStyles();
	const productId = productIdFromPath(globalThis.location?.pathname ?? "");
	if (productId === null) {
		return (
			<section className="otta-pricing otta-pricing-card" aria-label="Pricing & stock">
				<h3 className="otta-pricing-card-title">Pricing &amp; stock</h3>
				<p className="otta-pricing-hint">
					Save this product first, then set its price and stock here.
				</p>
			</section>
		);
	}
	return <PricingStockEditor key={productId} productId={productId} />;
}

type Loaded = {
	readonly record: ProductRecord;
	readonly taxClasses: readonly TaxClass[];
	readonly threshold: number | null;
};

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "failed"; readonly title: string; readonly description: string }
	| ({ readonly status: "ready" } & Loaded);

type Status = { readonly tone: "ok" | "fail" | "muted"; readonly text: string } | null;

function Chevron(): React.ReactElement {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M4 6l4 4 4-4" />
		</svg>
	);
}

function MoneyInput({
	id,
	label,
	optional,
	currency,
	value,
	problem,
	describedBy,
	onChange,
}: {
	id: string;
	label: string;
	optional?: boolean;
	currency: string;
	value: string;
	problem: string | undefined;
	describedBy?: string;
	onChange: (next: string) => void;
}): React.ReactElement {
	const errorId = `${id}-error`;
	return (
		<div className="otta-pricing-field">
			<label className="otta-pricing-label" htmlFor={id}>
				{label}
				{optional === true && <span className="otta-pricing-optional"> · optional</span>}
			</label>
			<div className="otta-pricing-input" data-invalid={problem !== undefined}>
				<span className="otta-pricing-affix" aria-hidden="true">
					{currency}
				</span>
				<input
					id={id}
					className="otta-pricing-num"
					inputMode="decimal"
					autoComplete="off"
					placeholder="0.00"
					value={value}
					aria-invalid={problem !== undefined}
					aria-describedby={
						[problem !== undefined ? errorId : null, describedBy ?? null]
							.filter((v) => v !== null)
							.join(" ") || undefined
					}
					onChange={(event) => {
						onChange(event.target.value);
					}}
				/>
			</div>
			{problem !== undefined && (
				<span id={errorId} className="otta-pricing-error">
					{problem}
				</span>
			)}
		</div>
	);
}

export function PricingStockEditor({ productId }: { productId: string }): React.ReactElement {
	usePricingStyles();
	const idBase = React.useId();
	const [load, setLoad] = React.useState<LoadState>({ status: "loading" });
	const [draft, setDraft] = React.useState<PricingDraft | null>(null);
	const [touched, setTouched] = React.useState<ReadonlySet<DraftField>>(new Set());
	const [saving, setSaving] = React.useState(false);
	const [saveStatus, setSaveStatus] = React.useState<Status>(null);
	const [skuRefusal, setSkuRefusal] = React.useState<string | null>(null);
	const [qty, setQty] = React.useState("1");
	const [moving, setMoving] = React.useState(false);
	const [stockMsg, setStockMsg] = React.useState<Status>(null);
	const [confirmRemove, setConfirmRemove] = React.useState<number | null>(null);
	const [reload, setReload] = React.useState(0);
	const [shippingOpen, setShippingOpen] = React.useState(false);
	/** Whether the next read REPLACES what the merchant typed — after their own
	 *  save, or after a refusal that means the record moved under them. */
	const reseed = React.useRef(false);
	const draftRef = React.useRef<PricingDraft | null>(null);
	draftRef.current = draft;
	const recordRef = React.useRef<ProductRecord | null>(null);
	recordRef.current = load.status === "ready" ? load.record : null;
	/** A stock movement the server accepted, waiting for the re-read that states
	 *  the count it actually landed on. */
	const stockReceipt = React.useRef<
		{ verb: "Added" | "Removed"; n: number } | { refused: true } | null
	>(null);
	const panelRef = React.useRef<HTMLDivElement | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		void fetchProductDetail(productId).then((result) => {
			if (cancelled) return;
			if (isFailure(result)) {
				setLoad({ status: "failed", title: result.title, description: result.description });
				stockReceipt.current = null;
				setMoving(false);
				return;
			}
			const record = result.product;
			setLoad({
				status: "ready",
				record,
				taxClasses: result.taxClasses,
				threshold: result.threshold,
			});
			// The merchant's own save, and a refusal that means the record moved,
			// re-seed the form. Any other re-read (a CMS save, a stock movement, a
			// declined value) keeps ONLY the fields they changed (`mergeDraft`).
			const current = draftRef.current;
			const previous = recordRef.current;
			if (reseed.current || current === null || previous === null) {
				setDraft(draftFromRecord(record));
				setTouched(new Set());
			} else {
				const merged = mergeDraft(previous, record, current);
				setDraft(merged.draft);
				if (merged.conflict) {
					setTouched(new Set());
					setSaveStatus({
						tone: "fail",
						text: "Someone else changed this product while you were editing. The latest values are shown — check them and save again.",
					});
				}
			}
			reseed.current = false;
			const receipt = stockReceipt.current;
			if (receipt !== null && "refused" in receipt) {
				stockReceipt.current = null;
				setMoving(false);
			} else if (receipt !== null) {
				stockReceipt.current = null;
				setStockMsg({
					tone: "ok",
					text: `${receipt.verb} ${String(receipt.n)} — now ${String(record.onHand ?? 0)} in stock`,
				});
				setQty("1");
				setMoving(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [productId, reload]);

	if (load.status === "loading" || (load.status === "ready" && draft === null)) {
		return (
			<div className="otta-pricing" aria-busy="true">
				<p className="otta-pricing-hint">Loading price and stock…</p>
			</div>
		);
	}
	if (load.status === "failed") {
		return (
			<div className="otta-pricing" role="alert">
				<div className="otta-pricing-callout">
					<strong>{load.title}</strong>
					<span>{load.description}</span>
				</div>
				<div>
					<button
						type="button"
						className="otta-pricing-btn"
						onClick={() => {
							setLoad({ status: "loading" });
							setReload((n) => n + 1);
						}}
					>
						Try again
					</button>
				</div>
			</div>
		);
	}

	const { record: p, taxClasses, threshold } = load;
	if (p.deletedAt !== null) {
		return (
			<div className="otta-pricing">
				<div className="otta-pricing-callout">
					<strong>This product is in the trash</strong>
					<span>Its price and stock can't be changed. Orders that included it are unaffected.</span>
				</div>
			</div>
		);
	}

	const d = draft as PricingDraft;
	const saved = draftFromRecord(p);
	const dirty = isDraftDirty(saved, d);
	const allProblems = validateDraft(d, p);
	/** A problem is shown once the merchant has edited that field, or tried to
	 *  save — never on a value they have not touched. */
	const shown: DraftProblems = Object.fromEntries(
		Object.entries(allProblems).filter(([field]) => touched.has(field as DraftField)),
	);
	const currency = p.currency ?? d.currency;
	const priced = p.priceCents !== null;
	const sale = salePreview(d.price, d.compareAt, currency);
	const margin = marginSummary(d.price, d.unitCost, currency);
	const stock = stockStatus(p.onHand, threshold);
	const hasSku = p.sku !== null;
	const id = (name: string): string => `${idBase}-${name}`;
	/** The store's refusal of a typed SKU, else the panel's own objection. */
	const skuProblem = skuRefusal ?? shown.sku ?? null;

	const set = (field: DraftField) => (next: string) => {
		setDraft((prev) => (prev === null ? prev : { ...prev, [field]: next }));
		setTouched((prev) => new Set(prev).add(field));
		setSaveStatus(null);
		if (field === "sku") setSkuRefusal(null);
	};

	const save = (): void => {
		if (Object.keys(allProblems).length > 0) {
			setTouched(new Set(Object.keys(allProblems) as DraftField[]));
			setSaveStatus({ tone: "fail", text: "Fix the highlighted fields to save" });
			// A problem inside the folded Shipping & tax section must be seen.
			if ([...SIZE_FIELDS].some((field) => allProblems[field] !== undefined)) setShippingOpen(true);
			// Take the merchant to the first problem rather than leaving them to hunt
			// for it in a column they may have scrolled.
			requestAnimationFrame(() => {
				panelRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
			});
			return;
		}
		setSaving(true);
		setSaveStatus(null);
		// READ, MERGE, THEN WRITE. In the editor's main column nothing tells this
		// section that the CMS just saved the entry (which moves the commerce
		// watermark), so the save fetches the latest record first, keeps only the
		// merchant's own edits on top of it (`mergeDraft`), and writes against that
		// fresh watermark. A field changed on both sides stops the save and says so.
		void fetchProductDetail(productId)
			.then((fresh): Result<ActPayload> | "conflict" | Promise<Result<ActPayload>> => {
				if (isFailure(fresh)) return fresh;
				const latest = fresh.product;
				const merged = mergeDraft(p, latest, d);
				setLoad({
					status: "ready",
					record: latest,
					taxClasses: fresh.taxClasses,
					threshold: fresh.threshold,
				});
				setDraft(merged.draft);
				if (merged.conflict) return "conflict" as const;
				return performAction(
					"products:save",
					savePayload(latest, merged.draft),
					PRODUCTS_ACT_SUBJECT,
				);
			})
			.then((result) => {
				setSaving(false);
				if (result === "conflict") {
					setTouched(new Set());
					setSaveStatus({
						tone: "fail",
						text: "Someone else changed this product while you were editing. The latest values are shown — check them and save again.",
					});
					return;
				}
				if (isFailure(result)) {
					setSaveStatus({ tone: "fail", text: `${result.title}. ${result.description}` });
					return;
				}
				const notice = result.notice;
				if (notice !== null && notice.variant === "error") {
					// SOMEONE ELSE SAVED FIRST: the record moved and the notice promises the
					// latest values, so the form re-seeds. Every other refusal declined a
					// VALUE and nothing moved: the merchant's typing stays — beside the SKU
					// when it is about the SKU.
					if (result.recordMoved === true) {
						setSaveStatus({ tone: "fail", text: `${notice.title}. ${notice.description}` });
						reseed.current = true;
						setReload((n) => n + 1);
						return;
					}
					if (result.field === "sku") {
						setSkuRefusal(notice.description);
						setSaveStatus({ tone: "fail", text: notice.title });
						return;
					}
					setSaveStatus({ tone: "fail", text: `${notice.title}. ${notice.description}` });
					return;
				}
				setSaveStatus({ tone: "ok", text: "Saved" });
				forgetSummaries();
				reseed.current = true;
				setReload((n) => n + 1);
			});
	};

	const move = (actionId: "products:restock" | "products:remove-stock", n: number): void => {
		const onHand = p.onHand ?? 0;
		setMoving(true);
		setStockMsg(null);
		void performAction(
			actionId,
			{ productId: p.productId, onHand: String(onHand), qty: String(n) },
			PRODUCTS_ACT_SUBJECT,
		).then((result) => {
			if (isFailure(result)) {
				setMoving(false);
				setStockMsg({ tone: "fail", text: `${result.title}. ${result.description}` });
				return;
			}
			const notice = result.notice;
			if (notice !== null && notice.variant === "error") {
				// The count it refused against may be stale: the re-read shows the real
				// one, and the buttons wait for it, as they do after a success.
				setStockMsg({ tone: "fail", text: notice.description || notice.title });
				stockReceipt.current = { refused: true };
				setReload((k) => k + 1);
				return;
			}
			// The buttons stay disabled until the re-read lands, so a second click is
			// never sent against the count this one just changed, and the receipt
			// states the count the SERVER now holds rather than one worked out here.
			forgetSummaries();
			stockReceipt.current = { verb: actionId === "products:restock" ? "Added" : "Removed", n };
			setReload((k) => k + 1);
		});
	};

	const qtyValue = parseStockQty(qty);
	const startMove = (direction: "add" | "remove"): void => {
		if (qtyValue === null) {
			setStockMsg({ tone: "fail", text: `Enter how many to ${direction}, like 5` });
			return;
		}
		if (direction === "add") {
			move("products:restock", qtyValue);
			return;
		}
		const onHand = p.onHand ?? 0;
		if (qtyValue > onHand) {
			setStockMsg({ tone: "fail", text: `You only have ${String(onHand)} in stock` });
			return;
		}
		setConfirmRemove(qtyValue);
	};

	const kindLabel = d.productKind === "digital" ? "Digital — nothing to ship" : "Physical product";
	const weightNote =
		d.productKind === "digital"
			? ""
			: d.weightGrams.trim()
				? ` · ${d.weightGrams.trim()} g`
				: " · no weight yet";
	const taxName =
		d.taxClass === ""
			? "No tax class"
			: (taxClasses.find((t) => t.id === d.taxClass)?.name ?? d.taxClass);

	return (
		<div
			className="otta-pricing"
			data-testid="otta-pricing-panel"
			ref={panelRef}
			onKeyDown={(event) => {
				// These inputs sit inside the CMS editor's own <form>: Enter would
				// submit THAT form and save the content instead of this section.
				if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
					event.preventDefault();
					if (dirty && !saving) save();
				}
			}}
		>
			<ConsoleStyles />

			<section className="otta-pricing-card" aria-labelledby={id("h-pricing")}>
				<h3 id={id("h-pricing")} className="otta-pricing-card-title">
					Pricing
				</h3>
				{!priced && (
					<div className="otta-pricing-callout" data-tone="warn">
						<span>Add a price so customers can buy this product.</span>
					</div>
				)}
				<div className="otta-pricing-grid">
					<MoneyInput
						id={id("price")}
						label="Price"
						currency={currency}
						value={d.price}
						problem={shown.price}
						onChange={set("price")}
					/>
					{!priced && (
						<div className="otta-pricing-field">
							<label className="otta-pricing-label" htmlFor={id("currency")}>
								Currency
							</label>
							<div className="otta-pricing-input">
								<select
									id={id("currency")}
									value={d.currency}
									onChange={(event) => {
										set("currency")(event.target.value);
									}}
								>
									{CURRENCY_CHOICES.map((code) => (
										<option key={code} value={code}>
											{code}
										</option>
									))}
								</select>
							</div>
							<span className="otta-pricing-hint">
								Can't be changed once the product is priced.
							</span>
						</div>
					)}
					<div className="otta-pricing-field">
						<MoneyInput
							id={id("compare")}
							label="Compare-at price"
							optional
							currency={currency}
							value={d.compareAt}
							problem={shown.compareAt}
							describedBy={id("compare-note")}
							onChange={set("compareAt")}
						/>
						{shown.compareAt === undefined && (
							<span id={id("compare-note")} className="otta-pricing-hint otta-pricing-sale">
								{sale === null ? (
									"Set a higher “was” price to show this product on sale."
								) : (
									<>
										Shown as a sale: <s>{sale.was}</s> <strong>{sale.now}</strong>
									</>
								)}
							</span>
						)}
					</div>
					<div className="otta-pricing-field">
						<MoneyInput
							id={id("cost")}
							label="Cost per item"
							optional
							currency={currency}
							value={d.unitCost}
							problem={shown.unitCost}
							describedBy={id("cost-note")}
							onChange={set("unitCost")}
						/>
						{shown.unitCost === undefined &&
							(margin === null ? (
								<span id={id("cost-note")} className="otta-pricing-hint">
									Customers won't see this.
								</span>
							) : (
								<div id={id("cost-note")} className="otta-pricing-margin">
									<span>
										Profit <strong>{margin.profit}</strong>
									</span>
									<span>
										Margin <strong>{margin.margin}</strong>
									</span>
								</div>
							))}
					</div>
				</div>
			</section>

			<section className="otta-pricing-card" aria-labelledby={id("h-inventory")}>
				<div className="otta-pricing-head">
					<h3 id={id("h-inventory")} className="otta-pricing-card-title">
						Inventory
					</h3>
					{hasSku && (
						<span
							className="otta-pricing-badge"
							data-tone={stock.tone}
							data-testid="otta-stock-badge"
						>
							<span className="otta-pricing-dot" aria-hidden="true" />
							{stock.label}
						</span>
					)}
				</div>

				<div className="otta-pricing-grid">
					<div className="otta-pricing-field">
						{hasSku && p.onHand !== null && (
							<>
								<p className="otta-pricing-count">
									<strong data-testid="otta-on-hand">{p.onHand}</strong>
									<span>in stock</span>
								</p>
								<div className="otta-pricing-field">
									<label className="otta-pricing-hint" htmlFor={id("qty")}>
										Add or remove stock
									</label>
									<div className="otta-pricing-stockrow">
										<input
											id={id("qty")}
											className="otta-pricing-qty"
											inputMode="numeric"
											autoComplete="off"
											value={qty}
											aria-describedby={id("stock-msg")}
											onChange={(event) => {
												setQty(event.target.value);
												setStockMsg(null);
											}}
										/>
										<button
											type="button"
											className="otta-pricing-btn"
											data-grow="true"
											disabled={moving}
											onClick={() => {
												startMove("add");
											}}
										>
											+ Add
										</button>
										<button
											type="button"
											className="otta-pricing-btn"
											data-grow="true"
											disabled={moving}
											onClick={() => {
												startMove("remove");
											}}
										>
											− Remove
										</button>
									</div>
									<span
										id={id("stock-msg")}
										className="otta-pricing-status"
										role="status"
										data-tone={stockMsg?.tone}
									>
										{stockMsg?.text ?? ""}
									</span>
								</div>
							</>
						)}
						{hasSku && p.onHand === null && (
							<p className="otta-pricing-hint">
								Stock isn't tracked for this SKU yet. Contact your developer to set it up.
							</p>
						)}
					</div>
					<div className="otta-pricing-field">
						<label className="otta-pricing-label" htmlFor={id("sku")}>
							SKU <span className="otta-pricing-optional">· your code for this product</span>
						</label>
						<div className="otta-pricing-input" data-invalid={skuProblem !== null}>
							<input
								id={id("sku")}
								autoComplete="off"
								placeholder="e.g. TEE-BLACK-M"
								value={d.sku}
								aria-invalid={skuProblem !== null}
								aria-describedby={id("sku-note")}
								onChange={(event) => {
									set("sku")(event.target.value);
								}}
							/>
						</div>
						{skuProblem !== null ? (
							<span id={id("sku-note")} className="otta-pricing-error">
								{skuProblem}
							</span>
						) : (
							!hasSku && (
								<span id={id("sku-note")} className="otta-pricing-hint">
									Add a SKU and save to start tracking stock.
								</span>
							)
						)}
					</div>
				</div>
			</section>

			<details
				className="otta-pricing-card"
				open={shippingOpen}
				onToggle={(event) => {
					setShippingOpen(event.currentTarget.open);
				}}
			>
				<summary>
					<span className="otta-pricing-summary">
						<h3 className="otta-pricing-card-title">Shipping &amp; tax</h3>
						<span>
							{kindLabel}
							{weightNote} · {taxName}
						</span>
					</span>
					<Chevron />
				</summary>
				<div className="otta-pricing-details">
					<fieldset style={{ border: 0, margin: 0, padding: 0, minInlineSize: 0 }}>
						<legend className="otta-pricing-label" style={{ padding: 0, marginBlockEnd: 6 }}>
							Product type
						</legend>
						<div className="otta-pricing-segment">
							{(["physical", "digital"] as const).map((kind) => (
								<label key={kind} data-checked={d.productKind === kind}>
									<input
										type="radio"
										className="otta-sr-only"
										name={id("kind")}
										value={kind}
										checked={d.productKind === kind}
										onChange={() => {
											set("productKind")(kind);
										}}
									/>
									{kind === "physical" ? "Physical" : "Digital"}
								</label>
							))}
						</div>
					</fieldset>
					{d.productKind !== "digital" && (
						<>
							<div className="otta-pricing-field">
								<label className="otta-pricing-label" htmlFor={id("weight")}>
									Weight
								</label>
								<div className="otta-pricing-input" data-invalid={shown.weightGrams !== undefined}>
									<input
										id={id("weight")}
										aria-invalid={shown.weightGrams !== undefined}
										aria-describedby={id("weight-note")}
										className="otta-pricing-num"
										inputMode="numeric"
										autoComplete="off"
										value={d.weightGrams}
										onChange={(event) => {
											set("weightGrams")(event.target.value);
										}}
									/>
									<span className="otta-pricing-affix">g</span>
								</div>
								{shown.weightGrams !== undefined ? (
									<span id={id("weight-note")} className="otta-pricing-error">
										{shown.weightGrams}
									</span>
								) : (
									<span id={id("weight-note")} className="otta-pricing-hint">
										Used to work out shipping costs.
									</span>
								)}
							</div>
							<div className="otta-pricing-field">
								<span className="otta-pricing-label" id={id("size")}>
									Size <span className="otta-pricing-optional">· length × width × height, mm</span>
								</span>
								<div className="otta-pricing-sizes" role="group" aria-labelledby={id("size")}>
									{(
										[
											["lengthMm", "Length"],
											["widthMm", "Width"],
											["heightMm", "Height"],
										] as const
									).map(([field, name]) => (
										<div
											key={field}
											className="otta-pricing-input"
											data-invalid={shown[field] !== undefined}
										>
											<input
												aria-label={`${name} in millimetres`}
												aria-invalid={shown[field] !== undefined}
												aria-describedby={shown[field] !== undefined ? id("size-error") : undefined}
												className="otta-pricing-num"
												inputMode="numeric"
												autoComplete="off"
												placeholder={name}
												value={d[field]}
												onChange={(event) => {
													set(field)(event.target.value);
												}}
											/>
										</div>
									))}
								</div>
								{(shown.lengthMm ?? shown.widthMm ?? shown.heightMm) !== undefined && (
									<span id={id("size-error")} className="otta-pricing-error">
										{shown.lengthMm ?? shown.widthMm ?? shown.heightMm}
									</span>
								)}
							</div>
						</>
					)}
					<div className="otta-pricing-field">
						<label className="otta-pricing-label" htmlFor={id("tax")}>
							Tax class
						</label>
						<div className="otta-pricing-input">
							<select
								id={id("tax")}
								value={d.taxClass}
								onChange={(event) => {
									set("taxClass")(event.target.value);
								}}
							>
								<option value="">No tax class</option>
								{taxClasses.map((t) => (
									<option key={t.id} value={t.id}>
										{t.name}
									</option>
								))}
								{d.taxClass !== "" && !taxClasses.some((t) => t.id === d.taxClass) && (
									<option value={d.taxClass}>{d.taxClass}</option>
								)}
							</select>
						</div>
					</div>
				</div>
			</details>

			<div className="otta-pricing-footer">
				<button
					type="button"
					className="otta-pricing-btn"
					data-primary="true"
					disabled={!dirty || saving}
					aria-busy={saving}
					onClick={save}
				>
					{saving ? "Saving…" : "Save pricing & stock"}
				</button>
				<span className="otta-pricing-status" role="status" data-tone={saveStatus?.tone ?? "muted"}>
					{saveStatus?.text ?? (dirty ? "Not saved yet — use this Save button" : "")}
				</span>
			</div>

			<ConfirmDialog
				open={confirmRemove !== null}
				title={`Remove ${String(confirmRemove ?? 0)} from stock?`}
				text={`You'll have ${String((p.onHand ?? 0) - (confirmRemove ?? 0))} left. To undo this, you'd add them back by hand.`}
				confirmLabel="Remove"
				denyLabel="Cancel"
				onConfirm={() => {
					const n = confirmRemove;
					setConfirmRemove(null);
					if (n !== null) move("products:remove-stock", n);
				}}
				onDeny={() => {
					setConfirmRemove(null);
				}}
			/>
		</div>
	);
}

/** The field editor EmDash discovers on the admin module (`fields`), named by a
 *  field's `widget: "otta-console:pricing"`. */
export const PRICING_FIELD_WIDGET = "pricing";
