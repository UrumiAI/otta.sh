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
	ABSENT,
	ADD_STOCK_PLACEHOLDER,
	COMPARE_AT_PLACEHOLDER,
	CURRENCY_FIELD_LABEL,
	CURRENCY_PLACEHOLDER,
	DISCARD_LABEL,
	NO_CHANGES_TO_SAVE,
	NO_TAX_CLASS,
	PRICE_FORM_CONTEXT,
	PRICE_PENDING_CONTEXT,
	PRICE_PLACEHOLDER,
	PRODUCTS_BACK_LABEL,
	PRODUCT_FIELD_LABELS,
	PRODUCT_KIND_LABELS,
	PRODUCT_MEASUREMENT_LABELS,
	PRODUCT_TAB_LABELS,
	REMOVE_STOCK_BANNER,
	REMOVE_STOCK_CONTEXT,
	REMOVE_STOCK_FIELD_LABEL,
	REMOVE_STOCK_GROUP_LABEL,
	REMOVE_STOCK_INVALID_QTY,
	REMOVE_STOCK_PLACEHOLDER,
	RETRYING_LABEL,
	RETRY_LABEL,
	SAVE_IDENTITY_LABEL,
	SAVE_PRICE_LABEL,
	SAVE_SHIPPING_LABEL,
	SAVING_LABEL,
	SHIPPING_FORM_CONTEXT,
	SPLIT_DISCARD_CONTEXT,
	STATUS_FIELD_LABEL,
	STOCK_ON_HAND_CONTEXT,
	TOMBSTONE_BANNER_TITLE,
	TOMBSTONE_CONTEXT,
	UNIT_COST_PLACEHOLDER,
	addStockConfirm,
	canonicalMoneyInput,
	compareAtFieldLabel,
	dimensionsSummary,
	dirtyGroupLabel,
	dirtySectionLabels,
	formatMinorUnitsInput,
	formatOptionalAmount,
	formatTimestamp,
	identityGroupLabel,
	inventoryPolicyLabel,
	leaveWithoutSavingConfirm,
	onHandCell,
	parseMinorUnitsInput,
	parseStockQty,
	priceChangeSummary,
	priceFieldLabel,
	priceGroupLabel,
	pricePendingLine,
	priceSavedNotice,
	removeStockConfirm,
	shippingGroupLabel,
	statusLabel,
	statusTone,
	stockTone,
	tabUnsavedLabel,
	taxClassLabel,
	taxClassOptions,
	unitCostFieldLabel,
	type ProductSection,
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
	WARN_ACCENT,
	buttonStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";
import { UNTITLED, toned } from "./products-list.js";

const TAB_LABELS = PRODUCT_TAB_LABELS;

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
	/** Where this write's RECEIPT belongs. A write that names a slot reports
	 *  inside the group that caused it instead of at page top — see
	 *  {@link ReceiptSlot}. Absent for the two saves increment 3 owns, which keep
	 *  reporting at the top for now. */
	readonly slot?: ReceiptSlot;
	/** An AUTHORED receipt, composed at submit time. Only the price save has one:
	 *  its receipt names the before and the after, and the re-read that follows a
	 *  save replaces the before — so the sentence cannot be composed on arrival.
	 *  Everything else keeps the receipt the handler served. */
	readonly receipt?: Receipt;
}

/**
 * A group that reports its own outcome, in place.
 *
 * WHY NOT PAGE TOP. The operator who just clicked `Save price` is looking at the
 * price field, several hundred pixels below a banner that says `Saved` in grey
 * and would say exactly the same thing for a weight edit. A receipt has to land
 * where the eye already is, and it has to say which of the five writes on this
 * screen it is reporting.
 */
type ReceiptSlot = "price" | "stock-add" | "stock-remove";

interface Receipt {
	readonly title: string;
	readonly description: string;
}

/**
 * Which fields differ from what was last committed.
 *
 * COMPARED, NEVER LATCHED. A `touched` boolean would call a form dirty forever
 * once a character was typed — including after the operator typed one and
 * deleted it, which leaves the record exactly as it was and must offer nothing
 * to save. The committed side is re-derived from the product on every render, so
 * a re-read that moves a value the operator has not touched correctly makes the
 * form dirty against the NEW truth.
 *
 * Keyed by field so a changed input can carry the warn border on its own; the
 * caller decides which section it is asking about, which is what makes this
 * reusable per section rather than per screen.
 */
export function changedFields(
	committed: Readonly<Record<string, string>>,
	current: Readonly<Record<string, string>>,
): readonly string[] {
	return Object.keys(committed).filter((key) => committed[key] !== current[key]);
}

/**
 * The same question for the Price group, asked about AMOUNTS rather than about
 * keystrokes.
 *
 * WHY THIS EXISTS AT ALL. The committed side is always the money formatter's
 * spelling (`99.90`); the typed side is whatever the operator typed (`99.9`).
 * Those are one amount, and a save does not rewrite the field the operator is
 * looking at — it re-reads the product. Compared as raw strings, a save of
 * `99.9` therefore SUCCEEDS and leaves the group still marked ` · unsaved`,
 * still bordered, with `Save` re-armed for a write that would change nothing
 * and still bump `updatedAt` — sitting beside its own receipt saying the price
 * was updated. That is the exact no-op write F4 disables, re-armed by the
 * feature meant to prevent it.
 *
 * STILL COMPARED, STILL NOT LATCHED: typing a character and deleting it returns
 * the field to its committed amount and so returns the form to clean, and an
 * entry that does not parse is compared as itself, so it still reads as a
 * change and the write's own refusal is what the operator sees. Currency is
 * case- and space-insensitive for the same reason: it is stored in one case,
 * and `usd` is not a different currency from `USD`.
 */
export function changedPriceFields(
	committed: Readonly<Record<string, string>>,
	current: Readonly<Record<string, string>>,
): readonly string[] {
	return changedFields(canonicalPriceValues(committed), canonicalPriceValues(current));
}

/** One spelling per field, so the comparison above is about amounts. Money goes
 *  through the shared canonicaliser; a currency code is stored in one case, so
 *  `usd` is not a different currency from `USD`. */
function canonicalPriceValues(
	values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return {
		price: canonicalMoneyInput(values["price"] ?? ""),
		currency: (values["currency"] ?? "").trim().toUpperCase(),
		compareAt: canonicalMoneyInput(values["compareAt"] ?? ""),
		unitCost: canonicalMoneyInput(values["unitCost"] ?? ""),
	};
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

/**
 * WHERE A WRITE HAS GOT TO — the whole lifecycle as one value, so that when the
 * controls are released is a decision this module states once and can be read
 * back, rather than a pair of `setBusy(false)` calls whose placement is the
 * entire behaviour.
 *
 * A write is two round trips, not one. The POST answers, and only then does the
 * re-read that follows it move `updatedAt` — and therefore every form's
 * `expectedUpdatedAt` watermark. A button re-armed in the gap between them is
 * armed against a watermark the service has already superseded: the second
 * click is refused by optimistic concurrency and reports an error for a save
 * that in fact succeeded. So `accepted` does not end the write; it moves it to
 * its second leg, and `read-settled` is the only event that returns the screen
 * to idle.
 *
 * `refused` is the exception, and it is not an asymmetry: a refused write moved
 * nothing, so there is no re-read to wait for and nothing to be stale against.
 */
export type WritePhase =
	| { readonly step: "idle" }
	| { readonly step: "writing"; readonly actionId: string }
	| { readonly step: "rereading"; readonly actionId: string };

export type WriteEvent =
	| { readonly type: "dispatched"; readonly actionId: string }
	| { readonly type: "refused"; readonly actionId: string }
	| { readonly type: "accepted" }
	| { readonly type: "read-settled" };

/** Pure. The one place a write's progress is decided; the component only
 *  reports what happened. */
export function nextWritePhase(phase: WritePhase, event: WriteEvent): WritePhase {
	switch (event.type) {
		case "dispatched":
			// GUARDED THE WAY `accepted` IS, and for the same reason. One write at a
			// time is the screen's contract, enforced today by every submit being
			// `busy`-gated — so a second dispatch is unreachable and this branch
			// changes nothing now. It is here because the failure it prevents is
			// silent if the gate ever loosens: a second dispatch would overwrite the
			// outstanding write's `actionId`, and the answer to the FIRST write would
			// then release the second.
			return phase.step === "idle" ? { step: "writing", actionId: event.actionId } : phase;
		case "refused":
			// A refusal releases only the write it refers to. Unguarded, a refusal
			// arriving for a superseded write would release one that is still in
			// flight — re-arming every control mid-write, which is the exact race
			// `accepted` is guarded against, inverted.
			return phase.step === "writing" && phase.actionId === event.actionId
				? { step: "idle" }
				: phase;
		case "accepted":
			// NOT A RELEASE. The write answered; the screen has not caught up with
			// it yet. Ignored unless a write is actually outstanding, so a late or
			// duplicated answer cannot re-arm a leg that has already settled.
			return phase.step === "writing" ? { step: "rereading", actionId: phase.actionId } : phase;
		case "read-settled":
			// Every read settles the screen, the failed one included: a re-read that
			// could not be made would otherwise strand the controls disabled.
			return { step: "idle" };
	}
}

/** Pure. Both guards the screen needs from a phase: `busy` disables every
 *  control (one write at a time is the existing contract) while `acting` names
 *  the single button allowed to say `Saving…` — a screen where three buttons
 *  claim to be saving reports two writes that are not happening. */
export function writeControls(phase: WritePhase): {
	readonly busy: boolean;
	readonly acting: string | null;
} {
	return phase.step === "idle"
		? { busy: false, acting: null }
		: { busy: true, acting: phase.actionId };
}

/**
 * Which section a successful write re-seeds — and `null` for the writes that
 * re-seed none of them.
 *
 * F7's whole content is this map. Every write on this screen is followed by a
 * re-read, and the re-read is what moves each form's `expectedUpdatedAt`; what
 * must NOT follow it is a remount of a form the operator has typed into. So the
 * saving section's `key` changes and the other two keep their drafts — which
 * means a stock movement, which owns no form on the Product tab, must bump
 * nothing at all.
 */
export function sectionForAction(actionId: string): ProductSection | null {
	switch (actionId) {
		case "products:save-identity":
			return "identity";
		case "products:save-price":
			return "price";
		case "products:save-shipping":
			return "shipping";
		default:
			return null;
	}
}

/**
 * The `key` bump itself, as a decision rather than as a line inside an effect:
 * given the keys the three forms are mounted under and the section whose own
 * save has just been re-read, return the keys they should be mounted under next.
 *
 * ONE section moves. Bumping a sibling remounts a form the operator has typed
 * into and destroys the draft F6 exists to protect — the defect inverted — so
 * "the other two are untouched" is the assertion that matters here, not "the
 * saved one changed". `null` (a stock movement, a refusal, a re-read with no
 * save behind it) returns the SAME OBJECT, so React bails out of the re-render
 * rather than reconciling three forms for nothing.
 */
export function nextFormKeys(
	keys: Readonly<Record<ProductSection, number>>,
	saved: ProductSection | null,
): Readonly<Record<ProductSection, number>> {
	if (saved === null) return keys;
	return { ...keys, [saved]: keys[saved] + 1 };
}

/**
 * Whether Back has to ask before it discards (F8).
 *
 * Back is the one control left on this screen that can still lose typed work —
 * a tab switch keeps it and a save re-seeds one section — so this predicate is
 * the whole of when the dialog appears. It reads the same `dirty` record the tab
 * dot and the confirm's sentence read, so the three cannot disagree.
 */
export function leaveNeedsConfirm(dirty: Readonly<Record<ProductSection, boolean>>): boolean {
	return dirty.identity || dirty.price || dirty.shipping;
}

/** How a section tells the screen it is holding work, so that the two places
 *  that cannot see inside a form — the tab button's dot, and the leave confirm's
 *  sentence — can name it. The values themselves stay in the form: nothing is
 *  lifted, because lifting them is what a re-render of the parent would then
 *  have to preserve. */
type DirtyReporter = (section: ProductSection, dirty: boolean) => void;

/** Stable, so a form rendered without a reporter (a static render, a test)
 *  neither crashes nor re-runs its effect every render. */
const NO_REPORT: DirtyReporter = () => undefined;

/** The cleanup matters: a form that unmounts — a tombstoned product, a tab that
 *  is not there, a `key` bump after its own save — must stop claiming to hold
 *  work, or the dot and the leave confirm outlive the draft they describe. */
function useReportDirty(section: ProductSection, dirty: boolean, report: DirtyReporter): void {
	React.useEffect(() => {
		report(section, dirty);
		return () => {
			report(section, false);
		};
	}, [section, dirty, report]);
}

/** The warn accent, applied as a BORDER on the one input that changed (never as
 *  a text colour — rule: accents must be legible on a ground this file does not
 *  control, in both themes). Stated as the same `border` SHORTHAND `inputStyle`
 *  uses rather than as longhands over it: React warns about mixing the two on
 *  one element, and the warning is right — the shorthand wins on a re-render and
 *  the accent would disappear exactly when the field became clean again. */
const dirtyInputStyle: React.CSSProperties = {
	...inputStyle,
	border: `2px solid ${WARN_ACCENT}`,
};

function fieldStyle(changed: readonly string[], key: string): React.CSSProperties {
	return changed.includes(key) ? dirtyInputStyle : inputStyle;
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
	// WHICH write is outstanding and HOW FAR ALONG, not merely THAT one is: the
	// screen reports events into `nextWritePhase` and reads both its guards back
	// out of `writeControls`, so neither is set at a call site.
	const [writePhase, setWritePhase] = React.useState<WritePhase>({ step: "idle" });
	const { busy, acting } = writeControls(writePhase);
	// Receipts persist until the same group is written again. No timer, no fade:
	// a receipt the operator has to catch is the defect, not the feature.
	const [receipts, setReceipts] = React.useState<Readonly<Record<ReceiptSlot, Receipt | null>>>({
		price: null,
		"stock-add": null,
		"stock-remove": null,
	});
	const [generation, setGeneration] = React.useState(0);
	// WHICH SECTIONS HOLD UNSAVED WORK — reported up by the forms, never read out
	// of them. The screen needs it in two places no form can reach: the tab
	// button's dot, and the sentence the leave confirm has to compose.
	const [dirty, setDirty] = React.useState<Record<ProductSection, boolean>>({
		identity: false,
		price: false,
		shipping: false,
	});
	const reportDirty = React.useCallback<DirtyReporter>((section, value) => {
		setDirty((prev) => (prev[section] === value ? prev : { ...prev, [section]: value }));
	}, []);
	// F7: one key per section, bumped ONLY by that section's own successful save.
	// A form whose key changes remounts and re-seeds from the record; the other
	// two keep exactly what the operator typed.
	const [formKeys, setFormKeys] = React.useState<Record<ProductSection, number>>({
		identity: 0,
		price: 0,
		shipping: 0,
	});
	// The section whose save is being re-read. A REF, not state: the bump belongs
	// to the moment the fresh record lands, and bumping on the write's answer
	// instead would remount the form against the record it just replaced.
	const savedSection = React.useRef<ProductSection | null>(null);
	// F8: Back is the one remaining way to lose typed work, so it is the one
	// place that asks.
	const [leaving, setLeaving] = React.useState(false);
	// Confined to the failure branch: the re-read a save triggers has the whole
	// screen to show for itself, but a Retry on a screen that is nothing but an
	// error card has to say that the click landed.
	const [retrying, setRetrying] = React.useState(false);

	React.useEffect(() => {
		let cancelled = false;
		void fetchProductDetail(productId).then((result) => {
			if (cancelled) return;
			setRetrying(false);
			// A WRITE'S BUSY STATE ENDS HERE, not when the write answered — see
			// `nextWritePhase`, which is where that is argued and tested. Reported
			// before the failure check, so a failed re-read releases the controls too.
			setWritePhase((phase) => nextWritePhase(phase, { type: "read-settled" }));
			if (isFailure(result)) {
				setFailure({ title: result.title, description: result.description });
				return;
			}
			setFailure(null);
			setDetail(result);
			// HERE, not when the write answered: this is the render that first has
			// the saved values, so this is the only moment a remount re-seeds the
			// form with them rather than with the record the save replaced. A
			// re-read that FAILED leaves the section pending, so a later Retry that
			// succeeds still re-seeds it.
			const saved = savedSection.current;
			savedSection.current = null;
			setFormKeys((prev) => nextFormKeys(prev, saved));
		});
		return () => {
			cancelled = true;
		};
	}, [productId, generation]);

	const dispatch = React.useCallback((action: PendingAction) => {
		setPending(null);
		setWritePhase((phase) =>
			nextWritePhase(phase, { type: "dispatched", actionId: action.actionId }),
		);
		const slot = action.slot;
		// The previous receipt describes a state this write is about to replace, so
		// it goes on the click rather than on the answer.
		if (slot !== undefined) setReceipts((prev) => ({ ...prev, [slot]: null }));
		void performAction(action.actionId, action.value, PRODUCTS_ACT_SUBJECT).then((result) => {
			if (isFailure(result)) {
				// A REFUSAL still reports at page top, for both surfaces' reasons: it is
				// not a receipt, and the group it came from may be shut. Nothing moved,
				// so there is no re-read to wait for and the controls are released here.
				setWritePhase((phase) =>
					nextWritePhase(phase, { type: "refused", actionId: action.actionId }),
				);
				setNotice({ variant: "error", title: result.title, description: result.description });
				return;
			}
			// ACCEPTED IS NOT SETTLED — the re-read below is the second leg, and the
			// controls stay disabled across it. Deliberately not a release.
			setWritePhase((phase) => nextWritePhase(phase, { type: "accepted" }));
			// F7: claimed on the ACCEPTED write, applied when its re-read lands. A
			// stock movement names no section and so bumps nothing.
			savedSection.current = sectionForAction(action.actionId);
			const served = result.notice;
			const outcome: { variant: "default" | "error"; title: string; description: string } | null =
				served === null
					? null
					: {
							variant: served.variant === "error" ? "error" : "default",
							title: served.title,
							description: served.description,
						};
			if (slot === undefined) {
				setNotice(outcome);
			} else {
				// One outcome, one place: a receipt that lands in the group does not
				// also stand at the top saying the same thing in greyer words.
				setNotice(null);
				setReceipts((prev) => ({
					...prev,
					[slot]:
						action.receipt ??
						(outcome === null ? null : { title: outcome.title, description: outcome.description }),
				}));
			}
			// Re-read: a save moves `updatedAt` (and therefore every form's
			// watermark) and a stock movement moves `onHand`, so every value
			// rendered below has to come from what the operator can now see. It
			// re-seeds ONLY the section claimed on the line above — the other two
			// forms keep what the operator typed, which is exactly what
			// `SPLIT_DISCARD_CONTEXT` now promises. The controls stay disabled
			// until it lands.
			setGeneration((n) => n + 1);
		});
	}, []);

	if (failure !== null) {
		return (
			<div>
				{/*
				  BESIDE BACK, not instead of it. A failed read leaves two useful
				  moves — ask again, or leave — and the one that costs nothing is the
				  one an operator should not have to reload the page to make. Same
				  generation counter as the two list screens, and the same refusal to
				  clear the failure on the click: the response clears it.
				*/}
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
					<Button label={PRODUCTS_BACK_LABEL} onClick={onBack} testId="products-back" />
					<Button
						label={retrying ? RETRYING_LABEL : RETRY_LABEL}
						onClick={() => {
							setRetrying(true);
							setGeneration((n) => n + 1);
						}}
						disabled={retrying}
						busy={retrying}
						testId="detail-retry"
					/>
				</div>
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
	// The confirm's sentence and the tab's accessible name are the same fact said
	// twice, so both read this one predicate rather than each deciding.
	const holdsWork = leaveNeedsConfirm(dirty);

	return (
		<div>
			{/* M-10: the human handle stands in for the uuid when one exists. */}
			<h1 style={{ fontSize: 22, fontWeight: 700, marginBlockEnd: 8 }} data-testid="detail-heading">
				{p.title ?? p.productId}
			</h1>
			<div style={{ marginBlockEnd: 16 }}>
				{/* F8: the ONLY control on this screen that still discards typed work,
				    now that a tab switch keeps it and a save re-seeds one section. It
				    asks only when there is something to lose. */}
				<Button
					label={PRODUCTS_BACK_LABEL}
					onClick={() => {
						if (holdsWork) setLeaving(true);
						else onBack();
					}}
					testId="products-back"
				/>
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
							PRODUCT_FIELD_LABELS.sku,
							p.sku === null ? (
								ABSENT
							) : (
								<span key="sku" style={{ display: "inline-flex", alignItems: "center" }}>
									<code data-testid="detail-sku">{p.sku}</code>
									<CopyIdButton id={p.sku} testId="detail-copy-sku" what="SKU" />
								</span>
							),
						],
						[PRODUCT_FIELD_LABELS.price, formatOptionalAmount(p.priceCents, p.currency)],
						// D1, and the SAME two cells the list rings, from the same
						// derivations — a product that wears a ring in the table must not
						// lose it on the way to its own record. Nothing else on this
						// screen is pilled, and an unknown count is not an exception: it
						// stays the bare em dash `onHandCell` returns.
						[STATUS_FIELD_LABEL, toned(statusTone(p), statusLabel(p), "detail-status-pill")],
						[
							PRODUCT_FIELD_LABELS.stockOnHand,
							toned(
								stockTone(p.onHand, threshold),
								onHandCell(p.onHand, threshold),
								"detail-stock-pill",
							),
						],
					]}
				/>
			</section>

			<ProductTabs
				labels={TAB_LABELS}
				tab={tab}
				onSelect={setTab}
				// Only the Product tab holds editable sections; the Stock tab's forms
				// are movements, not drafts, and settle on their own confirm.
				unsaved={[holdsWork, false]}
				panels={[
					<ProductPanel
						key="product"
						product={p}
						taxClasses={detail.taxClasses}
						busy={busy}
						savingPrice={acting === "products:save-price"}
						priceReceipt={receipts.price}
						formKeys={formKeys}
						onDirtyChange={reportDirty}
						onSubmit={(actionId, value, report) =>
							dispatch({
								actionId,
								value,
								title: "",
								text: "",
								confirmLabel: "",
								denyLabel: "",
								...(report === undefined ? {} : { slot: report.slot, receipt: report.receipt }),
							})
						}
					/>,
					<StockPanel
						key="stock"
						product={p}
						threshold={threshold}
						busy={busy}
						addReceipt={receipts["stock-add"]}
						removeReceipt={receipts["stock-remove"]}
						onRestock={(qty, sku, onHand) => {
							// F5: the addition gets the gate the removal already had, and the
							// dialog's job is restating the PARSED quantity — `qty` is what
							// `parseStockQty` returned, never the raw field, so `100` typed for
							// `10` is stated as 100 and the projection is built from 100.
							//
							// THE SKU AND THE WATERMARK RIDE WITH THE CLICK rather than being
							// re-derived and null-checked here. The panel renders this form
							// only once it has both (no SKU is D-7's own state, no inventory
							// record is its own line), so the absent case is not a branch to
							// default to `0` — absent is not zero — nor one to swallow the
							// click over. It is unrepresentable.
							const confirm = addStockConfirm(qty, sku, onHand);
							setPending({
								actionId: "products:restock",
								value: {
									productId: p.productId,
									onHand: String(onHand),
									qty: String(qty),
								},
								title: confirm.title,
								text: confirm.text,
								confirmLabel: confirm.confirm,
								denyLabel: confirm.deny,
								slot: "stock-add",
							});
						}}
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
								slot: "stock-remove",
							});
						}}
					/>,
				]}
			/>

			{/* Two dialogs, never both open: the confirm below is modal, which makes
			    the Back button behind it inert, and this one is reachable only from
			    that button. The wrapper is how a test tells them apart — the dialog
			    itself is shared and carries one testId for every caller. */}
			<LeaveConfirm
				open={leaving}
				dirty={dirty}
				onStay={() => setLeaving(false)}
				onLeave={() => {
					setLeaving(false);
					onBack();
				}}
			/>

			<ConfirmDialog
				open={pending !== null}
				title={pending?.title ?? ""}
				text={pending?.text ?? ""}
				confirmLabel={pending?.confirmLabel ?? ""}
				denyLabel={pending?.denyLabel ?? ""}
				confirmTone={pending?.slot === "stock-add" ? "neutral" : "danger"}
				onDeny={() => setPending(null)}
				onConfirm={() => {
					if (pending !== null) dispatch(pending);
				}}
			/>
		</div>
	);
}

/**
 * Back's confirm (F8), as its own component so the markup it produces can be
 * asserted at a dirty state the screen cannot be driven into without a DOM.
 *
 * The sentence is COMPOSED, never stored: the sections are named in screen order
 * by the copy module from the same `dirty` record the tab dot reads, so a
 * confirm can never name a section that has since gone clean. Closed, it
 * composes nothing at all — the shared dialog stays mounted (its `showModal`
 * lives in an effect keyed on `open`), and holding a stale sentence inside a
 * hidden dialog is how one gets shown to the next operator who opens it.
 */
export function LeaveConfirm({
	open,
	dirty,
	onStay,
	onLeave,
}: {
	open: boolean;
	dirty: Readonly<Record<ProductSection, boolean>>;
	onStay: () => void;
	onLeave: () => void;
}): React.ReactElement {
	const confirm = open ? leaveWithoutSavingConfirm(dirtySectionLabels(dirty)) : null;
	return (
		<div data-testid="detail-leave-confirm">
			<ConfirmDialog
				open={open}
				title={confirm?.title ?? ""}
				text={confirm?.text ?? ""}
				confirmLabel={confirm?.confirm ?? ""}
				denyLabel={confirm?.deny ?? ""}
				onDeny={onStay}
				onConfirm={onLeave}
			/>
		</div>
	);
}

/**
 * The two tabs and BOTH of their panels — the inactive one hidden, never
 * unmounted.
 *
 * F6, AND THE WHOLE OF IT. The panel used to be rendered conditionally on the
 * active tab, so switching tabs unmounted it: React discarded three forms'
 * state, and an operator who typed a price, glanced at Stock and came back
 * found the field as it was on arrival. Nothing warned them, and nothing
 * restored it. Rendering both and putting `hidden` on the inactive one costs
 * one extra subtree and fixes it outright — no lifted state, no prompt, no
 * draft store, because the state never leaves the form that owns it.
 *
 * `hidden` IS LOAD-BEARING, AND IS NOT `display: none` BY ANOTHER ROUTE. The
 * attribute takes the node out of the accessibility tree and out of the tab
 * order, so a keyboard user cannot land in an invisible form — while leaving it
 * mounted, which is the entire point. Anything that unmounts the subtree
 * (a conditional, a remount-driven style swap) reimplements the defect.
 *
 * IT ALSO REPAIRS `aria-controls`, which is not a side quest: each button
 * pointed at `otta-panel-<its own index>` while only the ACTIVE panel existed,
 * so the inactive tab's control reference resolved to nothing. Both ids exist
 * in both states now.
 */
export function ProductTabs({
	labels,
	tab,
	unsaved,
	onSelect,
	panels,
}: {
	labels: readonly string[];
	tab: number;
	/** Per tab: does anything behind it hold unsaved work. */
	unsaved: readonly boolean[];
	onSelect: (index: number) => void;
	/** One node per label, all of them rendered. */
	panels: readonly React.ReactNode[];
}): React.ReactElement {
	return (
		<>
			<div
				role="tablist"
				aria-label="Product sections"
				style={{ display: "flex", gap: 4, marginBlockEnd: 12 }}
			>
				{labels.map((label, index) => {
					const holdsWork = unsaved[index] === true;
					return (
						<button
							key={label}
							type="button"
							role="tab"
							id={`otta-tab-${String(index)}`}
							aria-selected={tab === index}
							aria-controls={`otta-panel-${String(index)}`}
							// The dot is a shape, and "bullet" is not a fact. The name it
							// stands for is the accessible name, composed by the copy module.
							aria-label={holdsWork ? tabUnsavedLabel(label) : undefined}
							className="otta-focusable otta-btn"
							data-testid={`tab-${label.toLowerCase()}`}
							onClick={() => {
								onSelect(index);
							}}
							style={{
								...buttonStyle,
								borderBlockEndWidth: tab === index ? 2 : 1,
								fontWeight: tab === index ? 650 : 400,
								opacity: tab === index ? 1 : 0.7,
							}}
						>
							{label}
							{holdsWork && (
								<span
									aria-hidden="true"
									data-testid={`tab-${label.toLowerCase()}-unsaved`}
									style={{
										display: "inline-block",
										inlineSize: 8,
										blockSize: 8,
										marginInlineStart: 6,
										borderRadius: 999,
										border: `2px solid ${WARN_ACCENT}`,
										verticalAlign: "middle",
									}}
								/>
							)}
						</button>
					);
				})}
			</div>

			{labels.map((label, index) => (
				<div
					key={label}
					role="tabpanel"
					id={`otta-panel-${String(index)}`}
					aria-labelledby={`otta-tab-${String(index)}`}
					hidden={tab !== index}
				>
					{panels[index]}
				</div>
			))}
		</>
	);
}

// ── panel "Product" ──────────────────────────────────────────────────────────

function ProductPanel({
	product: p,
	taxClasses,
	busy,
	savingPrice,
	priceReceipt,
	formKeys,
	onDirtyChange,
	onSubmit,
}: {
	product: ProductRecord;
	taxClasses: readonly { id: string; name: string }[];
	busy: boolean;
	/** Only the price save reports in place so far; increment 3 extends the same
	 *  treatment to identity and classification. */
	savingPrice: boolean;
	priceReceipt: Receipt | null;
	/** F7: one per section, bumped by that section's own successful save and by
	 *  nothing else. Applied as the form's React `key`, so the saved section
	 *  re-seeds from the fresh record and the other two keep their drafts. */
	formKeys: Readonly<Record<ProductSection, number>>;
	onDirtyChange: DirtyReporter;
	onSubmit: (
		actionId: string,
		value: Record<string, string>,
		report?: { slot: ReceiptSlot; receipt: Receipt },
	) => void;
}): React.ReactElement {
	const carrier = { productId: p.productId, expectedUpdatedAt: p.updatedAt };
	return (
		<>
			<section style={panelStyle}>
				<Fields
					testId="detail-more"
					entries={[
						[
							PRODUCT_FIELD_LABELS.compareAt,
							formatOptionalAmount(p.compareAtCents, p.compareAtCurrency),
						],
						[
							PRODUCT_FIELD_LABELS.unitCost,
							formatOptionalAmount(p.unitCostCents, p.unitCostCurrency),
						],
						[PRODUCT_FIELD_LABELS.taxClass, taxClassLabel(p.taxClass, taxClasses)],
						[PRODUCT_FIELD_LABELS.kind, p.productKind],
						[PRODUCT_FIELD_LABELS.weight, p.weightGrams === null ? ABSENT : String(p.weightGrams)],
						[PRODUCT_FIELD_LABELS.dimensions, dimensionsSummary(p.lengthMm, p.widthMm, p.heightMm)],
						[PRODUCT_FIELD_LABELS.created, formatTimestamp(p.createdAt)],
						[PRODUCT_FIELD_LABELS.updated, formatTimestamp(p.updatedAt)],
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
					<IdentityGroup
						key={`identity-${String(formKeys.identity)}`}
						product={p}
						busy={busy}
						onDirtyChange={onDirtyChange}
						onSubmit={(values) => onSubmit("products:save-identity", { ...carrier, ...values })}
					/>

					<PriceGroup
						key={`price-${String(formKeys.price)}`}
						product={p}
						busy={busy}
						saving={savingPrice}
						receipt={priceReceipt}
						onDirtyChange={onDirtyChange}
						onSubmit={(values, change) =>
							onSubmit(
								"products:save-price",
								{ ...carrier, ...values },
								// COMPOSED AT SUBMIT TIME, on purpose: the save is followed by a
								// re-read that replaces the BEFORE amount, so a receipt composed
								// on arrival could only ever state the after.
								{ slot: "price", receipt: priceSavedNotice(change) },
							)
						}
					/>

					<ShippingGroup
						key={`shipping-${String(formKeys.shipping)}`}
						product={p}
						taxClasses={taxClasses}
						busy={busy}
						onDirtyChange={onDirtyChange}
						onSubmit={(values) => onSubmit("products:save-shipping", { ...carrier, ...values })}
					/>

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
export function IdentityGroup({
	product: p,
	busy,
	onDirtyChange,
	onSubmit,
}: {
	product: ProductRecord;
	busy: boolean;
	onDirtyChange?: DirtyReporter;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	// Re-derived from the product on every render, exactly as the Price group's
	// is: a save is followed by a re-read, and that is what returns this form to
	// clean without anything resetting it. COMPARED, NEVER LATCHED — type a
	// character into the SKU and delete it and there is nothing unsaved here.
	const committed = React.useMemo(() => ({ sku: p.sku ?? "" }), [p.sku]);
	// THE DRAFT LIVES HERE AND NOWHERE ELSE, which is the whole of F6. The split
	// below is a container/view split and nothing more: this half owns the state,
	// the half below is pure in it — so the dirty treatment can be rendered, and
	// asserted, at a draft state a static render could not otherwise reach.
	const [values, setValues] = React.useState<Record<string, string>>(committed);
	return (
		<IdentityFields
			product={p}
			committed={committed}
			values={values}
			busy={busy}
			report={onDirtyChange ?? NO_REPORT}
			onChange={setValues}
			onSubmit={onSubmit}
		/>
	);
}

/** The Identity form itself. `committed` is what the record says, `values` is
 *  what the operator has typed, and every mark this group makes about unsaved
 *  work — the warn border, the ` · unsaved` summary — is the difference. */
export function IdentityFields({
	product: p,
	committed,
	values,
	busy,
	report,
	onChange,
	onSubmit,
}: {
	product: ProductRecord;
	committed: Record<string, string>;
	values: Record<string, string>;
	busy: boolean;
	report: DirtyReporter;
	onChange: (next: (prev: Record<string, string>) => Record<string, string>) => void;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const changed = changedFields(committed, values);
	const dirty = changed.length > 0;
	useReportDirty("identity", dirty, report);
	return (
		<Group testId="edit-identity" label={dirtyGroupLabel(identityGroupLabel(p.sku), dirty)}>
			<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>{IDENTITY_FORM_CONTEXT}</p>
			<div style={{ display: "grid", gap: 10, maxInlineSize: 420 }}>
				<Field label={PRODUCT_FIELD_LABELS.sku}>
					<input
						className="otta-focusable"
						data-testid="edit-sku"
						style={fieldStyle(changed, "sku")}
						value={values["sku"] ?? ""}
						onChange={(event) => {
							const next = event.target.value;
							onChange((prev) => ({ ...prev, sku: next }));
						}}
					/>
				</Field>
				<div>
					<Button
						label={SAVE_IDENTITY_LABEL}
						testId="save-identity"
						disabled={busy}
						onClick={() => onSubmit(values)}
					/>
				</div>
			</div>
		</Group>
	);
}

/**
 * The Price group: price, an optional currency, compare-at and unit cost — the
 * four fields that must co-reside because they all read the product's one
 * currency — and the four states a save can be in.
 *
 * IT OWNS ITS OWN `Group`, which is what lets a SHUT group say it is holding
 * work: the ` · unsaved` marker belongs on the summary line, and the dirty state
 * that decides it lives with the fields. Nothing is lifted out of this component
 * and nothing is stored for it.
 *
 * FOUR STATES, NO MODAL. An ordinary price edit is still one click — routing
 * every save through a confirm dialog taxes the correct edits to guard the rare
 * one, and answers nothing about what happened afterwards. What the save gains
 * instead is a BEFORE (the pending block naming both amounts, a warn border on
 * what changed, and a way to discard) and an AFTER (a receipt that names the
 * amounts and does not fade). `Save` is disabled while clean, because a clean
 * save is a no-op that still bumps `updatedAt` — a silent write that will make
 * the next operator's optimistic-concurrency check fail for no reason.
 *
 * NO AMOUNT IS ASSEMBLED HERE. The after-amount goes through the same
 * `parseMinorUnitsInput` the write itself does, and both ends of the arrow are
 * rendered by the shared money formatter; the component holds integer minor
 * units and strings, and never a float.
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
export function PriceGroup({
	product: p,
	busy,
	saving,
	receipt,
	onDirtyChange,
	onSubmit,
}: {
	product: ProductRecord;
	busy: boolean;
	/** THIS save is the one in flight — not merely that some write is. */
	saving: boolean;
	receipt: Receipt | null;
	onDirtyChange?: DirtyReporter;
	onSubmit: (values: Record<string, string>, change: string | null) => void;
}): React.ReactElement {
	const priced = p.priceCents !== null && p.currency !== null;
	// The last-committed values, re-derived from the product on every render. A
	// save is followed by a re-read, so this is what makes the form clean again
	// afterwards without anything resetting it.
	const committed = React.useMemo(
		() => ({
			price: moneyInput(p.priceCents),
			currency: p.currency ?? "",
			compareAt: moneyInput(p.compareAtCents),
			unitCost: moneyInput(p.unitCostCents),
		}),
		[p.priceCents, p.currency, p.compareAtCents, p.unitCostCents],
	);
	const [values, setValues] = React.useState<Record<string, string>>(committed);
	const changed = changedPriceFields(committed, values);
	const dirty = changed.length > 0;
	useReportDirty("price", dirty, onDirtyChange ?? NO_REPORT);

	// The pending AFTER, through the same exact-integer parse the write uses.
	// `null` for a blank field (which leaves the price unchanged) and for
	// anything unparseable — neither has an amount to name.
	const change = priceChangeSummary(
		p.priceCents,
		parseMinorUnitsInput(values["price"] ?? "", { allowZero: false }),
		p.currency,
	);
	const pendingLine = pricePendingLine(change);

	const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
		const next = event.target.value;
		setValues((prev) => ({ ...prev, [key]: next }));
	};
	return (
		// F19: THE NAMESAKE GROUP IS THE ONE THAT OPENS, on the screen called
		// Pricing & inventory. Exactly one is open on arrival, and it used to be
		// Identity — whose summary already answers itself with the sku, while the
		// price a merchant came here to change sat behind a click.
		<Group
			testId="edit-price"
			defaultOpen
			label={dirtyGroupLabel(priceGroupLabel(p.priceCents, p.currency), dirty)}
		>
			<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>{PRICE_FORM_CONTEXT}</p>
			<div style={{ display: "grid", gap: 10, maxInlineSize: 460 }}>
				<Field label={priceFieldLabel(p.currency)}>
					<input
						className="otta-focusable"
						data-testid="edit-price"
						style={fieldStyle(changed, "price")}
						placeholder={PRICE_PLACEHOLDER}
						value={values["price"] ?? ""}
						onChange={set("price")}
					/>
				</Field>
				{!priced && (
					<Field label={CURRENCY_FIELD_LABEL}>
						<input
							className="otta-focusable"
							data-testid="edit-currency"
							style={fieldStyle(changed, "currency")}
							placeholder={CURRENCY_PLACEHOLDER}
							value={values["currency"] ?? ""}
							onChange={set("currency")}
						/>
					</Field>
				)}
				<Field label={compareAtFieldLabel(p.currency)}>
					<input
						className="otta-focusable"
						data-testid="edit-compare-at"
						style={fieldStyle(changed, "compareAt")}
						placeholder={COMPARE_AT_PLACEHOLDER}
						value={values["compareAt"] ?? ""}
						onChange={set("compareAt")}
					/>
				</Field>
				<Field label={unitCostFieldLabel(p.currency)}>
					<input
						className="otta-focusable"
						data-testid="edit-unit-cost"
						style={fieldStyle(changed, "unitCost")}
						placeholder={UNIT_COST_PLACEHOLDER}
						value={values["unitCost"] ?? ""}
						onChange={set("unitCost")}
					/>
				</Field>

				{dirty && (
					<div
						data-testid="price-pending"
						style={{
							borderInlineStartWidth: 3,
							borderInlineStartStyle: "solid",
							borderInlineStartColor: WARN_ACCENT,
							paddingInlineStart: 10,
						}}
					>
						{pendingLine !== null && (
							<p className="otta-num" style={{ fontSize: 13, fontWeight: 650, margin: 0 }}>
								{pendingLine}
							</p>
						)}
						<p style={{ fontSize: 12, opacity: 0.8, margin: "4px 0 0" }}>{PRICE_PENDING_CONTEXT}</p>
					</div>
				)}

				<div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
					<Button
						label={saving ? SAVING_LABEL : SAVE_PRICE_LABEL}
						testId="save-price"
						disabled={busy || !dirty}
						busy={saving}
						onClick={() => onSubmit(values, change)}
					/>
					{dirty && (
						<Button
							label={DISCARD_LABEL}
							testId="discard-price"
							disabled={busy}
							onClick={() => setValues(committed)}
						/>
					)}
					{!dirty && (
						<span data-testid="price-clean-hint" style={{ fontSize: 12, opacity: 0.75 }}>
							{NO_CHANGES_TO_SAVE}
						</span>
					)}
				</div>

				{/* UNDER THE BUTTON, and it stays there. */}
				{receipt !== null && (
					<Notice
						variant="default"
						title={receipt.title}
						description={receipt.description}
						testId="price-receipt"
					/>
				)}
			</div>
		</Group>
	);
}

/** The Classification & shipping group's form: exactly the six fields the Block
 *  Kit form carries. `Kind` and `Tax class` are closed sets; the four
 *  measurements are non-money integers, validated server-side by the same
 *  `buildEditWire` (`/^\d+$/`) that validates the Block Kit submit. */
export function ShippingGroup({
	product: p,
	taxClasses,
	busy,
	onDirtyChange,
	onSubmit,
}: {
	product: ProductRecord;
	taxClasses: readonly { id: string; name: string }[];
	busy: boolean;
	onDirtyChange?: DirtyReporter;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	// ONE record rather than six `useState`s, for one reason: dirty is a
	// COMPARISON against what was last committed, and six independent values have
	// nothing to compare against. The wire shape is unchanged — the same six keys
	// in the same order reach `onSubmit`.
	const committed = React.useMemo(
		() => ({
			productKind: p.productKind,
			taxClass: p.taxClass ?? NO_TAX_CLASS,
			weightGrams: numberInput(p.weightGrams),
			lengthMm: numberInput(p.lengthMm),
			widthMm: numberInput(p.widthMm),
			heightMm: numberInput(p.heightMm),
		}),
		[p.productKind, p.taxClass, p.weightGrams, p.lengthMm, p.widthMm, p.heightMm],
	);
	// Owned here for the same reason Identity's is — see that group's note on the
	// container/view split; the six values never leave the form that holds them.
	const [values, setValues] = React.useState<Record<string, string>>(committed);
	return (
		<ShippingFields
			product={p}
			taxClasses={taxClasses}
			committed={committed}
			values={values}
			busy={busy}
			report={onDirtyChange ?? NO_REPORT}
			onChange={setValues}
			onSubmit={onSubmit}
		/>
	);
}

/** The Classification & shipping form itself, pure in its draft so the dirty
 *  treatment can be rendered at any state. */
export function ShippingFields({
	product: p,
	taxClasses,
	committed,
	values,
	busy,
	report,
	onChange,
	onSubmit,
}: {
	product: ProductRecord;
	taxClasses: readonly { id: string; name: string }[];
	committed: Record<string, string>;
	values: Record<string, string>;
	busy: boolean;
	report: DirtyReporter;
	onChange: (next: (prev: Record<string, string>) => Record<string, string>) => void;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const changed = changedFields(committed, values);
	const dirty = changed.length > 0;
	useReportDirty("shipping", dirty, report);
	const set = (key: string) => (next: string) => {
		onChange((prev) => ({ ...prev, [key]: next }));
	};
	return (
		<Group
			testId="edit-shipping"
			label={dirtyGroupLabel(shippingGroupLabel(p.taxClass, p.weightGrams), dirty)}
		>
			<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>{SHIPPING_FORM_CONTEXT}</p>
			<div style={{ display: "grid", gap: 10, maxInlineSize: 460 }}>
				<Field label={PRODUCT_FIELD_LABELS.kind}>
					<select
						className="otta-focusable"
						data-testid="edit-kind"
						style={fieldStyle(changed, "productKind")}
						value={values["productKind"] ?? ""}
						onChange={(event) => {
							set("productKind")(event.target.value);
						}}
					>
						<option value="physical">{PRODUCT_KIND_LABELS.physical}</option>
						<option value="digital">{PRODUCT_KIND_LABELS.digital}</option>
					</select>
				</Field>
				<Field label={PRODUCT_FIELD_LABELS.taxClass}>
					<select
						className="otta-focusable"
						data-testid="edit-tax-class"
						style={fieldStyle(changed, "taxClass")}
						value={values["taxClass"] ?? ""}
						onChange={(event) => {
							set("taxClass")(event.target.value);
						}}
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
						[PRODUCT_MEASUREMENT_LABELS.weightGrams, "edit-weight", "weightGrams"],
						[PRODUCT_MEASUREMENT_LABELS.lengthMm, "edit-length", "lengthMm"],
						[PRODUCT_MEASUREMENT_LABELS.widthMm, "edit-width", "widthMm"],
						[PRODUCT_MEASUREMENT_LABELS.heightMm, "edit-height", "heightMm"],
					] as const
				).map(([label, testId, key]) => (
					<Field key={testId} label={label}>
						<input
							className="otta-focusable"
							data-testid={testId}
							style={fieldStyle(changed, key)}
							value={values[key] ?? ""}
							onChange={(event) => {
								set(key)(event.target.value);
							}}
						/>
					</Field>
				))}
				<div>
					<Button
						label={SAVE_SHIPPING_LABEL}
						testId="save-shipping"
						disabled={busy}
						onClick={() => onSubmit(values)}
					/>
				</div>
			</div>
		</Group>
	);
}

// ── panel "Stock" ────────────────────────────────────────────────────────────

/**
 * The two adjacent stock forms (PM §E2) — one recoverable, one not.
 *
 * BOTH MOVEMENTS NOW CONFIRM (F5), and the reconciliation went upward on
 * purpose. They sat one above the other, took the same input, and had opposite
 * gates for no stated reason; levelling DOWN would have deleted the only
 * safeguard on the screen's one destructive act, and the addition is in fact the
 * more dangerous typo — an over-add lets the store sell units it does not have,
 * where an over-remove only costs sales. What each dialog is FOR is restating
 * the parsed quantity, which is the one failure the field cannot catch.
 *
 * WHAT STILL DISTINGUISHES THEM, because a shared gate must not make two
 * different acts look alike: `Remove stock` is the screen's ONE destructive act
 * (DA-5's second exception — a removal is reversible only by a separate,
 * forgettable manual operation), so it keeps its alert banner, its danger
 * styling and the consequence in its group label. `Add stock` has none of those
 * — with ONE exception this panel does not control: the shared confirm dialog
 * styles its confirm button as destructive for every caller, so `Yes, add …`
 * currently reads in the same ink as `Yes, remove …`. That is the dialog's to
 * fix, not this panel's, and until it is fixed the distinction above holds
 * everywhere except on that one button.
 */
function StockPanel({
	product: p,
	threshold,
	busy,
	addReceipt,
	removeReceipt,
	onRestock,
	onRemove,
}: {
	product: ProductRecord;
	threshold: number | null;
	busy: boolean;
	/** Each movement's receipt, rendered in the group that caused it. The two
	 *  forms are adjacent and take the same input, so a receipt at page top
	 *  leaves the operator to work out which one it is reporting. */
	addReceipt: Receipt | null;
	removeReceipt: Receipt | null;
	/** The SKU and the on-hand watermark travel WITH the quantity, because this
	 *  panel is the only place that knows the form was rendered at all — and it
	 *  renders it only once both exist. The caller therefore has no absent case
	 *  to default or to swallow. */
	onRestock: (qty: number, sku: string, onHand: number) => void;
	onRemove: (qty: number) => void;
}): React.ReactElement {
	const sku = p.sku;
	const onHand = p.onHand;
	return (
		<>
			<section style={panelStyle}>
				<Fields
					testId="detail-stock"
					entries={[
						[PRODUCT_FIELD_LABELS.onHand, onHandCell(p.onHand, threshold)],
						[PRODUCT_FIELD_LABELS.inventoryPolicy, inventoryPolicyLabel(p.inventoryPolicy)],
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
					{sku === null ? (
						// D-7: nothing to move stock against, so no forms at all.
						<p style={{ fontSize: 13, opacity: 0.8 }} data-testid="stock-no-sku">
							{NO_SKU_CONTEXT}
						</p>
					) : onHand === null ? (
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
									placeholder={ADD_STOCK_PLACEHOLDER}
									submitLabel={ADD_STOCK_LABEL}
									testIdPrefix="restock"
									invalid={ADD_STOCK_INVALID_QTY}
									busy={busy}
									onSubmit={(qty) => onRestock(qty, sku, onHand)}
								/>
								{addReceipt !== null && (
									<Notice
										variant="default"
										title={addReceipt.title}
										description={addReceipt.description}
										testId="stock-add-receipt"
									/>
								)}
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
									placeholder={REMOVE_STOCK_PLACEHOLDER}
									submitLabel="Remove stock"
									testIdPrefix="remove"
									invalid={REMOVE_STOCK_INVALID_QTY}
									danger
									busy={busy}
									onSubmit={onRemove}
								/>
								{removeReceipt !== null && (
									<Notice
										variant="default"
										title={removeReceipt.title}
										description={removeReceipt.description}
										testId="stock-remove-receipt"
									/>
								)}
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
