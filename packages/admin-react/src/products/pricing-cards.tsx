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
 * ONE CLICK, ONE STOCK MOVE. Each Add/Remove click mints a fresh nonce, the
 * move's idempotency key (ADR-0015, amended 2026-10-02). A key derived from what
 * the move looks like made Add 2, Remove 2, Add 2 refuse the third (QA T1-2).
 * The only re-send of a nonce is the explicit Retry ("Retry: add 5") offered
 * after an answer was lost — see {@link HeldMove}.
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
	type ProductDetailPayload,
	type ProductRecord,
	type Result,
	type TaxClass,
} from "../console-api.js";
import { ConfirmDialog, ConsoleStyles } from "../ui.js";
import { DownloadFileCard } from "./download-file-card.js";
import { mintMovementNonce } from "./movement-nonce.js";
import { forgetSummaries } from "./pricing-columns.js";
import { usePricingStyles } from "./pricing-styles.js";
import {
	currencyChoiceLabel,
	draftFromRecord,
	isDraftDirty,
	marginSummary,
	currencyChangeText,
	FIELD_CONFLICT_TEXT,
	mergeDraft,
	SIZE_FIELDS,
	salePreview,
	savePayload,
	stockStatus,
	validateDraft,
	type DraftField,
	type DraftProblems,
	type CurrencyChange,
	type PricingDraft,
} from "./pricing-model.js";
import {
	DEFAULT_STORE_CURRENCY,
	DIGITAL_WITH_FILE,
	currencyChoicesWith,
	parseStockQty,
	checkoutPaymentWarning,
	TAX_STATUS_HINT,
	TAX_STATUS_OPTIONS,
} from "@otta-sh/admin-presentation";

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
	let id: string;
	try {
		id = decodeURIComponent(match[1] ?? "");
	} catch {
		// A malformed escape is not a product address; never throw into the editor.
		return null;
	}
	return id === "new" || id.length === 0 ? null : id;
}

/** The field editor EmDash mounts in the product editor's main column. */
export function PricingStockField(_props: PricingFieldProps): React.ReactElement {
	usePricingStyles();
	const productId = productIdFromPath(globalThis.location?.pathname ?? "");
	if (productId === null) {
		return (
			<Card title="Pricing & stock">
				<p className="otta-pricing-hint">
					Save this product first, then set its price and stock here.
				</p>
			</Card>
		);
	}
	return <PricingStockEditor key={productId} productId={productId} />;
}

type Loaded = {
	readonly record: ProductRecord;
	readonly taxClasses: readonly TaxClass[];
	readonly threshold: number | null;
	/** The store currency an unpriced product's picker starts on. */
	readonly storeCurrency: string;
};

type LoadState =
	| { readonly status: "loading" }
	| {
			readonly status: "failed";
			readonly title: string;
			readonly description: string;
			readonly forbidden: boolean;
	  }
	| ({ readonly status: "ready" } & Loaded);

type Status = {
	readonly tone: "ok" | "fail" | "muted";
	readonly text: string;
	/** A store-default-moved conflict: the currency a "Keep …" button confirms. */
	readonly keep?: string;
} | null;

type StockActionId = "products:restock" | "products:remove-stock";

/** An add above this many units asks first (QA round 2). */
export const LARGE_STOCK_ADD = 10_000;

const STOCK_COUNT = new Intl.NumberFormat("en-US");

/**
 * A STOCK MOVE WHOSE ANSWER WAS LOST (no response, a 5xx, or an unreadable 2xx:
 * `Failure.indeterminate`), held for an explicit Retry — the same design as
 * `HeldRetry` on the retired Products page (ADR-0015, amended 2026-10-02).
 *
 * The write may have landed, so a re-send must carry the SAME nonce for the
 * ledger to answer it once. But a later click that merely looks like the lost
 * one is a new decision — the merchant may have checked the count and meant to
 * add the same amount again — so it gets a fresh nonce, and the only re-send is
 * this Retry.
 *
 * Dropped when a new move is dispatched (opening the remove confirm and
 * pressing Cancel is looking, not deciding, and keeps it), on Retry (a Retry
 * lost again is held again under the ORIGINAL `heldAt`), and
 * {@link HELD_MOVE_TTL_MS} after the original loss. Held in memory only: a
 * reload or a duplicated tab inherits nothing to re-send.
 */
interface HeldMove {
	readonly actionId: StockActionId;
	/** The exact payload sent, nonce included. */
	readonly value: Readonly<Record<string, string>>;
	readonly n: number;
	/** The title of the failure that lost the answer. */
	readonly title: string;
	/** `Date.now()` when the answer was FIRST lost; a Retry never resets it. */
	readonly heldAt: number;
}

/** How long a lost move stays retryable. Past this, the merchant is told to
 *  check the count instead: a re-send is no longer "the same decision". */
const HELD_MOVE_TTL_MS = 10 * 60_000;

/** A lost answer must not say nothing happened: the write may have landed. It
 *  names the held move, so a merchant who has since typed another quantity knows
 *  what Retry will send. */
function heldMoveText(held: HeldMove): string {
	return `${held.actionId === "products:restock" ? "Add" : "Remove"} ${String(held.n)} — the change may have been applied; check the count before trying again.`;
}

function heldMoveRetryLabel(held: HeldMove): string {
	return `Retry: ${held.actionId === "products:restock" ? "add" : "remove"} ${String(held.n)}`;
}

/** One stroke icon set, drawn here: 16px box, 1.6 stroke, round caps. */
function Icon({ d }: { d: string }): React.ReactElement {
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
			<path d={d} />
		</svg>
	);
}
const CHEVRON = "M4 6l4 4 4-4";
const PLUS = "M8 3.5v9M3.5 8h9";
const MINUS = "M3.5 8h9";
const CHECK = "M3.5 8.5l3 3 6-7";

/** The card frame every state sits in, so loading, refusal and trash keep the
 *  shape of the cards they stand in for. */
function Card({
	title,
	children,
	busy,
	alert,
}: {
	title: string;
	children: React.ReactNode;
	busy?: boolean;
	alert?: boolean;
}): React.ReactElement {
	return (
		<section
			className="otta-pricing otta-pricing-card"
			aria-label={title}
			aria-busy={busy === true ? true : undefined}
			role={alert === true ? "alert" : undefined}
		>
			<h3 className="otta-pricing-card-title">{title}</h3>
			{children}
		</section>
	);
}

/** A field's label row: the label, and "Optional" set apart at the far end. */
function LabelRow({
	htmlFor,
	children,
	optional,
}: {
	htmlFor: string;
	children: React.ReactNode;
	optional?: boolean;
}): React.ReactElement {
	return (
		<div className="otta-pricing-labelrow">
			<label className="otta-pricing-label" htmlFor={htmlFor}>
				{children}
			</label>
			{optional === true && <span className="otta-pricing-optional">Optional</span>}
		</div>
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
			<LabelRow htmlFor={id} optional={optional}>
				{label}
			</LabelRow>
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
	/** The move awaiting confirmation — every removal, and an add over
	 *  {@link LARGE_STOCK_ADD} (QA round 2) — with the count the dialog showed:
	 *  that count is what the merchant approved, and it is the watermark sent. */
	const [confirmRemove, setConfirmRemove] = React.useState<{
		readonly n: number;
		readonly onHand: number;
		readonly direction: "add" | "remove";
	} | null>(null);
	const [held, setHeld] = React.useState<HeldMove | null>(null);
	/** Set synchronously on dispatch, so a second click in the same task — before
	 *  the buttons re-render disabled — is not a second move under a new nonce. */
	const movingNow = React.useRef(false);
	const qtyInput = React.useRef<HTMLInputElement | null>(null);
	const [reload, setReload] = React.useState(0);
	const [shippingOpen, setShippingOpen] = React.useState(false);
	/** Whether the next read REPLACES what the merchant typed — after their own
	 *  save, or after a refusal that means the record moved under them. */
	const reseed = React.useRef(false);
	const draftRef = React.useRef<PricingDraft | null>(null);
	draftRef.current = draft;
	const recordRef = React.useRef<ProductRecord | null>(null);
	recordRef.current = load.status === "ready" ? load.record : null;
	/** The last store currency a read DID carry. A later read whose settings read
	 *  failed must not wipe it: only a first load with no known value is
	 *  "unknown". */
	const knownStoreCurrency = React.useRef<string>("");
	/** The merchant picked the currency in the select — set ONLY by that pick,
	 *  cleared when the form is re-seeded. Rule 1 of `resolveDraftCurrency`. */
	const currencyPicked = React.useRef(false);
	/** A stock movement the server accepted, waiting for the re-read that states
	 *  the count it actually landed on. TAGGED WITH THAT RE-READ'S GENERATION: an
	 *  earlier re-read still in flight (the one after a lost answer, say) may
	 *  resolve after this move's answer and before its own re-read runs, and must
	 *  neither print this receipt with its older count nor release the buttons. */
	const stockReceipt = React.useRef<
		| ({ readonly gen: number } & (
				| { verb: "Added" | "Removed"; n: number }
				| { replayed: true }
				| { refused: true }
		  ))
		| null
	>(null);
	/** The last generation asked for; `reload` catches up on the next render. */
	const generation = React.useRef(0);
	/** Ask for a re-read, and return its generation. */
	const rereadNow = (): number => {
		generation.current += 1;
		setReload(generation.current);
		return generation.current;
	};
	/** The open remove confirm, for the re-read to check against. */
	const confirmRef = React.useRef<{ readonly n: number; readonly onHand: number } | null>(null);
	confirmRef.current = confirmRemove;
	const panelRef = React.useRef<HTMLDivElement | null>(null);
	/** Whether the cards hold edits their own Save has not written — read by the
	 *  leave-page guard below, which is registered once. */
	const unsaved = React.useRef(false);
	/** Whether the Download file card is uploading or attaching a file — leaving
	 *  the page would throw that upload away, so the same guard asks first. */
	const downloadBusy = React.useRef(false);
	const onDownloadBusy = React.useCallback((busy: boolean) => {
		downloadBusy.current = busy;
	}, []);
	const saveButton = React.useRef<HTMLButtonElement | null>(null);
	React.useEffect(() => {
		// The CMS's own Save and Publish do not save these cards, and the editor's
		// unsaved-changes guard cannot see them, so leaving the page with a typed
		// price would lose it without a word.
		const warn = (event: BeforeUnloadEvent): void => {
			if (!unsaved.current && !downloadBusy.current) return;
			event.preventDefault();
			event.returnValue = "";
		};
		// The admin is a single-page app: its sidebar and links change the page
		// without unloading it, so `beforeunload` never fires for them. A click on
		// an in-app link outside the cards asks first. (The browser's own Back
		// button is not covered; nothing a page can do intercepts it reliably.)
		const leave = (event: MouseEvent): void => {
			if (
				(!unsaved.current && !downloadBusy.current) ||
				event.defaultPrevented ||
				event.button !== 0
			)
				return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const link = (event.target as Element | null)?.closest?.("a[href]");
			if (!(link instanceof HTMLAnchorElement) || link.target === "_blank") return;
			if (panelRef.current?.contains(link) === true) return;
			if (new URL(link.href, window.location.href).origin !== window.location.origin) return;
			const question = downloadBusy.current
				? "A download file is still uploading. Leave and cancel the upload?"
				: "You have unsaved price or stock changes. Leave without saving them?";
			if (window.confirm(question)) return;
			event.preventDefault();
			event.stopPropagation();
		};
		window.addEventListener("beforeunload", warn);
		document.addEventListener("click", leave, true);
		return () => {
			window.removeEventListener("beforeunload", warn);
			document.removeEventListener("click", leave, true);
		};
	}, []);

	React.useEffect(() => {
		let cancelled = false;
		const gen = reload;
		void fetchProductDetail(productId).then((result) => {
			if (cancelled) return;
			/** The receipt this read settles: its own, or an older one — a read at
			 *  least as new as the move's own re-read was asked for after the move was
			 *  answered, so it includes the move (and the move's own read may have
			 *  been cancelled or batched away by it). A receipt for a LATER read is
			 *  left for that read. */
			const pendingReceipt = stockReceipt.current;
			const receipt = pendingReceipt !== null && pendingReceipt.gen <= gen ? pendingReceipt : null;
			const awaited = pendingReceipt !== null && receipt === null;
			if (isFailure(result)) {
				setLoad({
					status: "failed",
					title: result.title,
					description: result.description,
					forbidden: result.status === 403,
				});
				if (!awaited) {
					stockReceipt.current = null;
					movingNow.current = false;
					setMoving(false);
				}
				return;
			}
			const record = result.product;
			const read = storeCurrencyOf(result);
			// What the current draft was seeded against, then what this read knows.
			const seededStoreCurrency = knownStoreCurrency.current;
			if (read !== "") knownStoreCurrency.current = read;
			const storeCurrency = knownStoreCurrency.current;
			setLoad({
				status: "ready",
				record,
				taxClasses: result.taxClasses,
				threshold: result.threshold,
				storeCurrency,
			});
			// The merchant's own save, and a refusal that means the record moved,
			// re-seed the form. Any other re-read (a CMS save, a stock movement, a
			// declined value) keeps ONLY the fields they changed (`mergeDraft`).
			const current = draftRef.current;
			const previous = recordRef.current;
			if (reseed.current || current === null || previous === null) {
				setDraft(draftFromRecord(record, storeCurrency));
				setTouched(new Set());
				currencyPicked.current = false;
			} else {
				// The currency follows `resolveDraftCurrency`'s table.
				const merged = mergeDraft(previous, record, current, {
					storeCurrency: seededStoreCurrency,
					freshStoreCurrency: storeCurrency,
					currencyPicked: currencyPicked.current,
				});
				setDraft(merged.draft);
				if (merged.conflict) {
					setTouched(new Set());
					setSaveStatus(conflictStatus(merged));
				}
			}
			reseed.current = false;
			// A REMOVE CONFIRM STILL OPEN ON A COUNT THAT MOVED says "You'll have N
			// left" about a number that is no longer true: it is closed, and the
			// merchant is told nothing was removed.
			const confirm = confirmRef.current;
			const staleConfirm =
				confirm === null || confirm.onHand === record.onHand
					? null
					: record.onHand === null
						? "Stock could not be read — nothing was removed; check and try again."
						: `Stock changed to ${String(record.onHand)} while you were deciding — nothing was removed; check and try again.`;
			if (staleConfirm !== null) {
				setConfirmRemove(null);
				setStockMsg((prev) => ({
					tone: "fail",
					text: prev === null || prev.text === "" ? staleConfirm : `${prev.text} ${staleConfirm}`,
				}));
			}
			if (receipt !== null && "refused" in receipt) {
				stockReceipt.current = null;
				movingNow.current = false;
				setMoving(false);
			} else if (receipt !== null) {
				stockReceipt.current = null;
				const now = `now ${String(record.onHand ?? 0)} in stock`;
				// A ledger answer moved nothing: it is never reported as a fresh move.
				const text =
					"replayed" in receipt
						? `Already applied — ${now}`
						: `${receipt.verb} ${String(receipt.n)} — ${now}`;
				setStockMsg({
					tone: staleConfirm === null ? "ok" : "fail",
					text: staleConfirm === null ? text : `${text}. ${staleConfirm}`,
				});
				setQty("1");
				movingNow.current = false;
				setMoving(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [productId, reload]);

	/** Send one stock move. `heldSince` is set only by a Retry: the original loss
	 *  time, so a Retry lost again is held under it (see {@link HeldMove}). */
	const send = (
		actionId: StockActionId,
		value: Readonly<Record<string, string>>,
		n: number,
		heldSince?: number,
	): void => {
		movingNow.current = true;
		setMoving(true);
		setStockMsg(null);
		// Dispatching a move supersedes any lost move still offered for Retry.
		setHeld(null);
		void performAction(actionId, value, PRODUCTS_ACT_SUBJECT).then((result) => {
			if (isFailure(result)) {
				movingNow.current = false;
				setMoving(false);
				if (result.indeterminate === true) {
					setHeld({ actionId, value, n, title: result.title, heldAt: heldSince ?? Date.now() });
					// The move may have landed: re-read so the count on screen — and the
					// next removal's watermark — is the server's, not the one before it.
					// No receipt: the held notice is the outcome.
					forgetSummaries();
					rereadNow();
					return;
				}
				setStockMsg({ tone: "fail", text: `${result.title}. ${result.description}` });
				return;
			}
			const notice = result.notice;
			if (notice !== null && notice.variant === "error") {
				// The count it refused against may be stale: the re-read shows the real
				// one, and the buttons wait for it, as they do after a success.
				setStockMsg({ tone: "fail", text: notice.description || notice.title });
				stockReceipt.current = { refused: true, gen: generation.current + 1 };
				rereadNow();
				return;
			}
			// The buttons stay disabled until the re-read lands, so a second click is
			// never sent against the count this one just changed, and the receipt
			// states the count the SERVER now holds rather than one worked out here.
			forgetSummaries();
			const gen = generation.current + 1;
			stockReceipt.current =
				result.replayed === true
					? { replayed: true, gen }
					: { verb: actionId === "products:restock" ? "Added" : "Removed", n, gen };
			rereadNow();
		});
	};

	/** THE ONLY RE-SEND of a nonce: the held move, once per Retry click. */
	const retryHeld = (): void => {
		if (held === null || movingNow.current) return;
		// The Retry button goes on the click; hand keyboard focus to the quantity
		// rather than dropping it to the page.
		requestAnimationFrame(() => {
			if (document.activeElement === null || document.activeElement === document.body) {
				qtyInput.current?.focus();
			}
		});
		if (Date.now() - held.heldAt > HELD_MOVE_TTL_MS) {
			setHeld(null);
			setStockMsg({
				tone: "fail",
				text: "This change is too old to retry safely — check the count before trying again.",
			});
			return;
		}
		send(held.actionId, held.value, held.n, held.heldAt);
	};

	/** The held move, its sentence and its Retry — shown in the Inventory card,
	 *  and on the failure view when the re-read after the loss itself failed:
	 *  the move may still have landed, and Retry is still the safe way on. */
	const heldCallout =
		held === null ? null : (
			<div className="otta-pricing-callout" data-tone="warn" data-testid="otta-stock-held">
				{/* Announced; the Retry button stays outside the live region. */}
				<span role="alert">
					<strong>{held.title}.</strong> {heldMoveText(held)}
				</span>
				<div>
					<button
						type="button"
						className="otta-pricing-btn"
						data-testid="otta-stock-retry"
						disabled={moving}
						onClick={retryHeld}
					>
						{heldMoveRetryLabel(held)}
					</button>
				</div>
			</div>
		);

	if (load.status === "loading" || (load.status === "ready" && draft === null)) {
		return (
			<Card title="Pricing & stock" busy>
				<p className="otta-pricing-hint">Loading price and stock…</p>
			</Card>
		);
	}
	if (load.status === "failed" && load.forbidden) {
		// A user who can edit products but is not a store admin: the route behind
		// these cards answers 403 every time, so this is a quiet fact, not an alarm.
		return (
			<Card title="Pricing & stock">
				<p className="otta-pricing-hint">Only store admins can change price and stock.</p>
			</Card>
		);
	}
	if (load.status === "failed") {
		return (
			<Card title="Pricing & stock" alert>
				<div className="otta-pricing-callout">
					<strong>{load.title}</strong>
					<span>{load.description}</span>
				</div>
				{heldCallout}
				<div>
					<button
						type="button"
						className="otta-pricing-btn"
						onClick={() => {
							setLoad({ status: "loading" });
							rereadNow();
						}}
					>
						Try again
					</button>
				</div>
			</Card>
		);
	}

	const { record: p, taxClasses, threshold, storeCurrency } = load;
	if (p.deletedAt !== null) {
		return (
			<Card title="Pricing & stock">
				<div className="otta-pricing-callout">
					<strong>This product is in the trash</strong>
					<span>Its price and stock can't be changed. Orders that included it are unaffected.</span>
				</div>
			</Card>
		);
	}

	const d = draft as PricingDraft;
	const saved = draftFromRecord(p, storeCurrency);
	const dirty = isDraftDirty(saved, d);
	unsaved.current = dirty;
	const allProblems = validateDraft(d, p);
	/** A problem is shown once the merchant has edited that field, or tried to
	 *  save — never on a value they have not touched. */
	const shown: DraftProblems = Object.fromEntries(
		Object.entries(allProblems).filter(([field]) => touched.has(field as DraftField)),
	);
	const currency = p.currency ?? d.currency;
	const paymentWarning = checkoutPaymentWarning(currency);
	const priced = p.priceCents !== null;
	const sale = salePreview(d.price, d.compareAt, currency);
	const margin = marginSummary(d.price, d.unitCost, currency);
	const stock = stockStatus(p.onHand, threshold);
	const hasSku = p.sku !== null;
	/** The SAVED product has a download file: it stays Digital. */
	const hasDownloadFile = (p.downloadAsset ?? null) !== null;
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
		let latestRecord: ProductRecord = p;
		/** The currency move a conflicting read reported, if that was the conflict. */
		let saveConflict: ConflictFacts = {};
		void fetchProductDetail(productId)
			.then((fresh): Result<ActPayload> | "conflict" | "invalid" | Promise<Result<ActPayload>> => {
				if (isFailure(fresh)) return fresh;
				const latest = fresh.product;
				latestRecord = latest;
				// The FRESH store currency (or the last known one, if this read could
				// not say): the currency rule runs again here, against what is true
				// at save time — a store switch since the form loaded blocks the save.
				const read = storeCurrencyOf(fresh);
				if (read !== "") knownStoreCurrency.current = read;
				const freshStoreCurrency = knownStoreCurrency.current;
				const merged = mergeDraft(p, latest, draftRef.current ?? d, {
					storeCurrency,
					freshStoreCurrency,
					currencyPicked: currencyPicked.current,
				});
				setLoad({
					status: "ready",
					record: latest,
					taxClasses: fresh.taxClasses,
					threshold: fresh.threshold,
					storeCurrency: freshStoreCurrency,
				});
				setDraft(merged.draft);
				if (merged.conflict) {
					saveConflict = merged;
					return "conflict" as const;
				}
				// The merge can bring in another writer's values; check the result
				// as a whole before it goes anywhere (the plugin re-checks it too).
				if (Object.keys(validateDraft(merged.draft, latest)).length > 0) return "invalid" as const;
				return performAction(
					"products:save",
					savePayload(latest, merged.draft),
					PRODUCTS_ACT_SUBJECT,
				);
			})
			.then((result) => {
				setSaving(false);
				// The cards were locked while saving, which drops keyboard focus to the
				// page; hand it back to the Save button so a keyboard user is not lost.
				requestAnimationFrame(() => {
					if (document.activeElement === null || document.activeElement === document.body) {
						saveButton.current?.focus();
					}
				});
				if (result === "invalid") {
					setTouched(
						new Set(
							Object.keys(validateDraft(draftRef.current ?? d, latestRecord)) as DraftField[],
						),
					);
					setSaveStatus({ tone: "fail", text: "Fix the highlighted fields to save" });
					return;
				}
				if (result === "conflict") {
					setTouched(new Set());
					setSaveStatus(conflictStatus(saveConflict));
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
						rereadNow();
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
				rereadNow();
			})
			.catch((error: unknown) => {
				// Never leave the button stuck on "Saving…", nor keyboard focus on the page.
				setSaving(false);
				requestAnimationFrame(() => {
					if (document.activeElement === null || document.activeElement === document.body) {
						saveButton.current?.focus();
					}
				});
				setSaveStatus({
					tone: "fail",
					text: `The save did not finish${error instanceof Error ? ` — ${error.message}` : ""}. Try again.`,
				});
			});
	};

	/** A NEW move: one click, one fresh nonce, never reused after it is answered.
	 *  `onHand` is the count this render showed — the removal's watermark (the
	 *  store refuses a stale one), and on a restock only the legacy key's part. */
	const move = (actionId: StockActionId, n: number, onHand: number): void => {
		if (movingNow.current) return;
		send(
			actionId,
			{
				productId: p.productId,
				onHand: String(onHand),
				qty: String(n),
				nonce: mintMovementNonce(),
			},
			n,
		);
	};

	const qtyValue = parseStockQty(qty);
	const startMove = (direction: "add" | "remove"): void => {
		if (movingNow.current) return;
		// The stock controls render only with a count; absent is not zero, so a
		// move is never sent against a `0` stood in for "no record".
		const onHand = p.onHand;
		if (onHand === null) return;
		if (qtyValue === null) {
			setStockMsg({ tone: "fail", text: `Enter how many to ${direction}, like 5` });
			return;
		}
		if (direction === "add") {
			// A very large add asks first (QA round 2: 100,000,000 applied in one
			// click while Remove always confirms) — the count is a typo away.
			if (qtyValue > LARGE_STOCK_ADD) {
				setConfirmRemove({ n: qtyValue, onHand, direction: "add" });
				return;
			}
			move("products:restock", qtyValue, onHand);
			return;
		}
		if (qtyValue > onHand) {
			setStockMsg({ tone: "fail", text: `You only have ${String(onHand)} in stock` });
			return;
		}
		setConfirmRemove({ n: qtyValue, onHand, direction: "remove" });
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
			data-testid="otta-pricing-cards"
			role="group"
			aria-labelledby={id("h-group")}
			ref={panelRef}
			onKeyDown={(event) => {
				// These inputs sit inside the CMS editor's own <form>: Enter would
				// submit THAT form and save the content instead of these cards. In the
				// stock quantity it means "Add"; anywhere else, "Save pricing & stock".
				if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
				event.preventDefault();
				if (event.target.id === id("qty")) {
					if (!moving) startMove("add");
					return;
				}
				if (dirty && !saving) save();
			}}
		>
			<ConsoleStyles />
			<h2 id={id("h-group")} className="otta-sr-only">
				Pricing &amp; stock
			</h2>

			<fieldset className="otta-pricing-cardset" disabled={saving}>
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
								<LabelRow htmlFor={id("currency")}>Currency</LabelRow>
								<div className="otta-pricing-input" data-invalid={shown.currency !== undefined}>
									<select
										id={id("currency")}
										value={d.currency}
										aria-invalid={shown.currency !== undefined}
										onChange={(event) => {
											currencyPicked.current = true;
											set("currency")(event.target.value);
										}}
									>
										{/* The store currency could not be read: nothing is preselected
										    — a guess here would be saved for good. */}
										{d.currency === "" && (
											<option value="" disabled>
												Choose a currency
											</option>
										)}
										{currencyChoicesWith(d.currency).map((code) => (
											<option key={code} value={code}>
												{currencyChoiceLabel(code)}
											</option>
										))}
									</select>
								</div>
								{/* Whenever no currency is chosen; the load-failure wording only while it is still unknown. */}
								{d.currency === "" && (
									<span className="otta-pricing-hint" data-testid="store-currency-unknown">
										{storeCurrency === ""
											? "Couldn't load your store currency — choose one."
											: "Choose a currency."}
									</span>
								)}
								{shown.currency !== undefined && (
									<span className="otta-pricing-error">{shown.currency}</span>
								)}
								<span className="otta-pricing-hint">
									Can't be changed once the product is priced.
								</span>
							</div>
						)}
						{paymentWarning !== null && (
							<p className="otta-pricing-hint" data-testid="currency-payment-warning">
								{paymentWarning}
							</p>
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
					</div>
					<hr className="otta-pricing-rule" />
					<div className="otta-pricing-grid">
						<div className="otta-pricing-field">
							<MoneyInput
								id={id("cost")}
								label="Cost per item"
								optional
								currency={currency}
								value={d.unitCost}
								problem={shown.unitCost}
								describedBy={`${id("cost-note")} ${id("cost-margin")}`}
								onChange={set("unitCost")}
							/>
							{shown.unitCost === undefined && (
								<span id={id("cost-note")} className="otta-pricing-hint">
									Customers won't see this.
								</span>
							)}
						</div>
						<div
							id={id("cost-margin")}
							className="otta-pricing-readout"
							data-empty={margin === null}
						>
							{margin === null ? (
								<span className="otta-pricing-hint">
									Add a cost to see your profit and margin on each sale.
								</span>
							) : (
								<>
									<div className="otta-pricing-stat">
										<span>Profit</span> <strong>{margin.profit}</strong>
									</div>
									<div className="otta-pricing-stat">
										<span>Margin</span> <strong>{margin.margin}</strong>
									</div>
								</>
							)}
						</div>
					</div>
				</section>

				<section className="otta-pricing-card" aria-labelledby={id("h-inventory")}>
					<div className="otta-pricing-card-head">
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

					{hasSku && p.onHand !== null && (
						<div className="otta-pricing-field">
							<div className="otta-pricing-stock">
								<p className="otta-pricing-count">
									<strong data-testid="otta-on-hand">{p.onHand}</strong>
									<span>in stock</span>
								</p>
								<div className="otta-pricing-adjust">
									<label htmlFor={id("qty")}>Add or remove stock</label>
									<div className="otta-pricing-stepper">
										<button
											type="button"
											disabled={moving}
											onClick={() => {
												startMove("remove");
											}}
										>
											<Icon d={MINUS} />
											Remove
										</button>
										<input
											id={id("qty")}
											ref={qtyInput}
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
											disabled={moving}
											onClick={() => {
												startMove("add");
											}}
										>
											<Icon d={PLUS} />
											Add
										</button>
									</div>
								</div>
							</div>
							<span
								id={id("stock-msg")}
								className="otta-pricing-status"
								role="status"
								data-tone={stockMsg?.tone}
							>
								{stockMsg?.text ?? ""}
							</span>
							{heldCallout}
						</div>
					)}
					{hasSku && p.onHand === null && (
						<div className="otta-pricing-callout">
							<span>
								Stock isn't tracked for this SKU yet. Contact your developer to set it up.
							</span>
						</div>
					)}
					{/* The last stock outcome survives the count going away under it — a
					    remove confirm closed by that very change must still say why. */}
					{hasSku && p.onHand === null && stockMsg !== null && (
						<span className="otta-pricing-status" role="status" data-tone={stockMsg.tone}>
							{stockMsg.text}
						</span>
					)}

					<div className="otta-pricing-grid">
						<div className="otta-pricing-field">
							<LabelRow htmlFor={id("sku")}>SKU</LabelRow>
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
								<span id={id("sku-note")} className="otta-pricing-hint">
									{hasSku
										? "Your own code for this product."
										: "Add a SKU and save to start tracking stock."}
								</span>
							)}
						</div>
					</div>
				</section>

				{/* The file a buyer of a DIGITAL product downloads (issue #376). Only on
				    a product SAVED as digital: the plugin refuses a file on a physical
				    one, so a kind switched here but not yet saved asks for the save. */}
				{p.productKind === "digital" ? (
					<DownloadFileCard
						record={p}
						titleId={id("h-download")}
						onAttached={() => {
							// A product with a file stays Digital (ADR-0029 Decision 6). An
							// UNSAVED switch to Physical made before the upload can no longer
							// be saved, so the choice goes back to Digital — where the now
							// disabled Physical radio and its reason say why.
							setDraft((prev) =>
								prev === null || prev.productKind === "digital"
									? prev
									: { ...prev, productKind: "digital" },
							);
							rereadNow();
						}}
						onBusyChange={onDownloadBusy}
					/>
				) : d.productKind === "digital" ? (
					<section className="otta-pricing-card" aria-labelledby={id("h-download")}>
						<h3 id={id("h-download")} className="otta-pricing-card-title">
							Download file
						</h3>
						<p className="otta-pricing-hint">
							Save this product as Digital first, then upload the file buyers get.
						</p>
					</section>
				) : null}

				<details
					className="otta-pricing-card"
					open={shippingOpen}
					onToggle={(event) => {
						setShippingOpen(event.currentTarget.open);
					}}
				>
					<summary>
						<span className="otta-pricing-summary">
							<span className="otta-pricing-card-title">Shipping &amp; tax</span>
							<span>
								{kindLabel}
								{weightNote} · {taxName}
							</span>
						</span>
						<span className="otta-pricing-chevron">
							<Icon d={CHEVRON} />
						</span>
					</summary>
					<div className="otta-pricing-details otta-pricing-grid">
						<fieldset className="otta-pricing-fieldset">
							<legend className="otta-pricing-label">Product type</legend>
							<div className="otta-pricing-segment">
								{(["physical", "digital"] as const).map((kind) => {
									// REPLACE ONLY (ADR-0029): a product with a download file stays
									// Digital, so past buyers never lose it. Physical is offered as
									// disabled, with the reason, rather than refused after a save.
									const locked = kind === "physical" && hasDownloadFile;
									return (
										<label key={kind} data-checked={d.productKind === kind} data-disabled={locked}>
											<input
												type="radio"
												className="otta-sr-only"
												name={id("kind")}
												value={kind}
												checked={d.productKind === kind}
												disabled={locked}
												aria-describedby={locked ? id("kind-locked") : undefined}
												onChange={() => {
													set("productKind")(kind);
												}}
											/>
											{kind === "physical" ? "Physical" : "Digital"}
										</label>
									);
								})}
							</div>
							{hasDownloadFile && (
								<span
									id={id("kind-locked")}
									className="otta-pricing-hint"
									data-testid="otta-kind-locked"
								>
									{DIGITAL_WITH_FILE}
								</span>
							)}
						</fieldset>
						<div className="otta-pricing-field">
							<LabelRow htmlFor={id("tax")}>Tax class</LabelRow>
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
						<div className="otta-pricing-field">
							<LabelRow htmlFor={id("tax-status")}>Tax status</LabelRow>
							<div className="otta-pricing-input">
								<select
									id={id("tax-status")}
									data-testid="otta-tax-status"
									aria-describedby={id("tax-status-hint")}
									value={d.taxStatus}
									onChange={(event) => {
										set("taxStatus")(event.target.value);
									}}
								>
									{TAX_STATUS_OPTIONS.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							</div>
							<span id={id("tax-status-hint")} className="otta-pricing-hint">
								{TAX_STATUS_HINT}
							</span>
						</div>
						{d.productKind !== "digital" && (
							<>
								<div className="otta-pricing-field">
									<LabelRow htmlFor={id("weight")}>Weight</LabelRow>
									<div
										className="otta-pricing-input"
										data-invalid={shown.weightGrams !== undefined}
									>
										<input
											id={id("weight")}
											aria-invalid={shown.weightGrams !== undefined}
											aria-describedby={id("weight-note")}
											className="otta-pricing-num"
											inputMode="numeric"
											autoComplete="off"
											placeholder="0"
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
										Size
									</span>
									<div
										className="otta-pricing-input otta-pricing-dims"
										role="group"
										aria-labelledby={id("size")}
										data-invalid={(shown.lengthMm ?? shown.widthMm ?? shown.heightMm) !== undefined}
									>
										{(
											[
												["lengthMm", "Length"],
												["widthMm", "Width"],
												["heightMm", "Height"],
											] as const
										).map(([field, name], index) => (
											<React.Fragment key={field}>
												{index > 0 && (
													<span className="otta-pricing-times" aria-hidden="true">
														×
													</span>
												)}
												<input
													aria-label={`${name} in millimetres`}
													aria-invalid={shown[field] !== undefined}
													aria-describedby={
														shown[field] !== undefined ? id("size-error") : undefined
													}
													className="otta-pricing-num"
													inputMode="numeric"
													autoComplete="off"
													placeholder={name}
													value={d[field]}
													onChange={(event) => {
														set(field)(event.target.value);
													}}
												/>
											</React.Fragment>
										))}
										<span className="otta-pricing-affix">mm</span>
									</div>
									{(shown.lengthMm ?? shown.widthMm ?? shown.heightMm) !== undefined && (
										<span id={id("size-error")} className="otta-pricing-error">
											{shown.lengthMm ?? shown.widthMm ?? shown.heightMm}
										</span>
									)}
								</div>
							</>
						)}
					</div>
				</details>
			</fieldset>

			<div className="otta-pricing-footer" data-dirty={dirty || saving}>
				<span className="otta-pricing-status" role="status" data-tone={saveStatus?.tone ?? "muted"}>
					{saveStatus !== null ? (
						<>
							{saveStatus.tone === "ok" && <Icon d={CHECK} />}
							{saveStatus.text}
							{saveStatus.keep !== undefined && (
								<>
									{" "}
									<button
										type="button"
										className="otta-pricing-btn"
										onClick={() => {
											// Confirms the shown currency, exactly as a pick would.
											currencyPicked.current = true;
											setSaveStatus(null);
										}}
									>
										Keep {saveStatus.keep}
									</button>
								</>
							)}
						</>
					) : dirty ? (
						<>
							<span className="otta-pricing-pending" aria-hidden="true" />
							Price and stock changes are saved separately from the rest of the product
						</>
					) : null}
				</span>
				<button
					ref={saveButton}
					type="button"
					className="otta-pricing-btn"
					data-primary="true"
					disabled={!dirty || saving}
					aria-busy={saving}
					onClick={save}
				>
					{saving ? "Saving…" : "Save pricing & stock"}
				</button>
			</div>

			<ConfirmDialog
				open={confirmRemove !== null}
				title={
					confirmRemove?.direction === "add"
						? `Add ${STOCK_COUNT.format(confirmRemove.n)} to stock?`
						: `Remove ${String(confirmRemove?.n ?? 0)} from stock?`
				}
				text={
					confirmRemove?.direction === "add"
						? `That's far more than a usual delivery. You'll have ${STOCK_COUNT.format(confirmRemove.onHand + confirmRemove.n)} in stock — check the number before adding.`
						: `You'll have ${String((confirmRemove?.onHand ?? 0) - (confirmRemove?.n ?? 0))} left. To undo this, you'd add them back by hand.`
				}
				status={moving ? "Another stock change is still running — wait for it to finish." : ""}
				confirmLabel={confirmRemove?.direction === "add" ? "Add" : "Remove"}
				denyLabel="Cancel"
				// A confirm pressed while a move is in flight would be dropped by the
				// in-flight guard; it waits instead, and says why.
				confirmDisabled={moving}
				onConfirm={() => {
					const pending = confirmRemove;
					if (pending === null || movingNow.current) return;
					setConfirmRemove(null);
					move(
						pending.direction === "add" ? "products:restock" : "products:remove-stock",
						pending.n,
						pending.onHand,
					);
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

/**
 * What an unpriced product's picker starts on, from the detail read:
 *  - a code — the effective store currency (USD for a store that never saved one);
 *  - `""` — the read FAILED (`storeCurrency: null`): nothing is preselected, and
 *    the merchant must choose, because a guessed currency would be saved for good;
 *  - USD when the field is absent (an older plugin), what the picker always did.
 */
function storeCurrencyOf(result: ProductDetailPayload): string {
	if (result.storeCurrency === null) return "";
	return result.storeCurrency ?? DEFAULT_STORE_CURRENCY;
}

/** The conflict status, with a "Keep …" offer when the store default moved
 *  under a currency the merchant can keep. */
function conflictStatus(facts: ConflictFacts): NonNullable<Status> {
	const change = facts.currencyChange;
	const keep =
		change?.kind === "store_default_moved" && change.from !== "" ? change.from : undefined;
	return { tone: "fail", text: conflictText(facts), ...(keep !== undefined ? { keep } : {}) };
}

/** What a conflicting merge reported. */
type ConflictFacts = { readonly currencyChange?: CurrencyChange; readonly fieldClash?: boolean };

/** The conflict banner: the currency message when the currency moved, the
 *  general field-clash one when fields clashed — BOTH when both happened. */
function conflictText(facts: ConflictFacts): string {
	if (facts.currencyChange === undefined) return FIELD_CONFLICT_TEXT;
	const currency = currencyChangeText(facts.currencyChange);
	return facts.fieldClash === true ? `${FIELD_CONFLICT_TEXT} ${currency}` : currency;
}
