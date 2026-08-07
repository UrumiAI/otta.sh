/**
 * The React order detail.
 *
 * THE INFORMATION ARCHITECTURE IS THE BLOCK KIT ONE, deliberately and to the
 * block: an H1 naming the customer and the day, a back control, the notice, the
 * reconciliation alert, a six-entry identity strip, then four constant tabs —
 * `Order`, `Fulfilment`, `Money`, `History`. An operator moving between the two
 * screens during the migration must not have to relearn where anything is, and
 * §4's skeleton was argued out once already.
 *
 * WRITES GO BACK TO THE BLOCK KIT HANDLER, UNCHANGED. Every button here posts
 * the same `action_id` and the same `value` its Block Kit counterpart posts, and
 * the plugin forwards both to `orders-page.ts`'s action for that id. So the
 * watermark (`state`, `refundedSoFarCents`) the operator OBSERVED still rides
 * with the click and is still re-checked against live truth before anything is
 * written; the idempotency key is still content-derived and not a nonce; and
 * every refusal message an operator can see here was authored, budgeted and
 * suite-covered for the Block Kit screen. This file decides nothing about money.
 *
 * WHAT REPLACES THE STAGED "REVIEW" STEP. Block Kit's refund and cancel flows
 * are two-step (`…-review` stages the input server-side, then a confirm button
 * appears) because a Block Kit form cannot show a confirm dialog over the values
 * the operator just typed — the only way to put a reviewable summary in front of
 * them is a server round trip that re-renders the group. React can show the
 * dialog directly, so the review step collapses into the confirm: the operator
 * reads the SAME sentence, composed by the SAME shared
 * `refundConfirmText`, before anything is sent. Nothing is lost by the collapse,
 * because every validation the review step performed is performed again — server
 * side, against live truth — by the write handler itself. That is what makes the
 * shorter path safe rather than merely faster.
 *
 * EVERY AUTHORED STRING ON THIS SCREEN IS SHARED (INC-21). The first cut copied
 * roughly a dozen of them by hand from `orders-page.ts` and recorded a rider
 * saying so; closing it found FOUR places the two surfaces had already drifted
 * in the weeks between — typographic quotes, a shortened reconciliation note
 * that dropped its next step, an over-refund refusal that stated the fact but
 * not the instruction, and an additive-refunds warning whose "next step" clause
 * is true only on the surface that has one. `@otta-sh/admin-presentation`'s
 * `orders-copy.ts` records each. Nothing here authors copy any more; a string
 * that has to change changes once.
 */
import {
	CANCEL_BANNER,
	CANCEL_CONFIRM,
	CANCEL_GROUP_LABEL,
	CANCEL_PICK_REASON,
	CUSTOMER_CONTEXT_UNAVAILABLE,
	FULFILMENT_LABELS,
	FULLY_REFUNDED_NOTE,
	MARK_REFUNDED_CONFIRM,
	ORDERS_BACK_LABEL,
	ORDER_LINES_EMPTY,
	ORDER_LINES_SNAPSHOT_NOTE,
	REFUNDS_GROUP_EMPTY_LABEL,
	REFUNDS_UNAVAILABLE,
	REFUND_ADDITIVE_NOTE,
	REFUND_AMOUNT_INVALID,
	REFUND_BY_REQUIRED,
	REFUND_PARTIAL_GROUP_LABEL,
	RESOLVE_RECONCILIATION_NOTE,
	SHIPPING_ADDRESS_ABSENT,
	TIMELINE_EMPTY,
	TIMELINE_UNAVAILABLE,
	UNNAMED_REFUND_RECIPIENT,
	buyerReferenceText,
	cancelConfirmText,
	fit,
	formatAmount,
	formatDate,
	formatMinorUnitsInput,
	formatTimestamp,
	orderStateCell,
	parseMinorUnitsInput,
	reconciliationAlertSentence,
	reconciliationSummary,
	refundCapabilityText,
	refundConfirmText,
	refundTooHighInline,
	refundsGroupLabel,
} from "@otta-sh/admin-presentation";
import * as React from "react";
import {
	fetchOrderDetail,
	isFailure,
	performAction,
	type CustomerContext,
	type DetailPayload,
	type RefundsSummary,
	type TimelineEntry,
} from "../console-api.js";
import {
	Button,
	CopyIdButton,
	ConfirmDialog,
	EndHeader,
	FAIL_ACCENT,
	Field,
	Fields,
	Group,
	Notice,
	StatusPill,
	Table,
	buttonStyle,
	endCellStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";

/** The states whose transition button is destructive enough to confirm — the
 *  same single-member set the Block Kit screen uses. */
const DANGER_TRANSITIONS: ReadonlySet<string> = new Set(["refunded"]);

const TAB_LABELS = ["Order", "Fulfilment", "Money", "History"] as const;

/** The id the refusal message carries so the input it is about can point at it
 *  with `aria-describedby`. The message renders only while a refusal stands, and
 *  the association is written only then, so it can never dangle. */
const REFUND_ERROR_ID = "otta-refund-refusal";

/** Which of the refund form's two inputs a refusal is about. Two of the three
 *  refusals are about the amount and one is about who is issuing the refund; a
 *  refusal that did not carry this could only ever focus one of them. */
export type RefundRefusalField = "amount" | "refundedBy";

export interface RefundRefusal {
	readonly message: string;
	readonly field: RefundRefusalField;
}

export type RefundCheck =
	| { readonly ok: true; readonly amountCents: number }
	| { readonly ok: false; readonly refusal: RefundRefusal };

/**
 * The refund form's three refusals, in the order the operator meets them.
 *
 * Parsed with the SHARED input parser — exact integer string math, never
 * `parseFloat(...) * 100`. The refusal copy is the write handler's own, restated
 * here only because this check happens before the dialog rather than after the
 * click.
 */
export function checkRefundInput(
	amountInput: string,
	refundedBy: string,
	remainingCents: number,
	currency: string,
): RefundCheck {
	const parsed = parseMinorUnitsInput(amountInput, { allowZero: false });
	if (parsed === null) {
		return { ok: false, refusal: { message: REFUND_AMOUNT_INVALID, field: "amount" } };
	}
	if (refundedBy.trim().length === 0) {
		return { ok: false, refusal: { message: REFUND_BY_REQUIRED, field: "refundedBy" } };
	}
	if (parsed > remainingCents) {
		return {
			ok: false,
			refusal: {
				message: refundTooHighInline(
					formatAmount(parsed, currency),
					formatAmount(remainingCents, currency),
				),
				field: "amount",
			},
		};
	}
	return { ok: true, amountCents: parsed };
}

/**
 * What the refunds group shows beneath its ledger.
 *
 * THE CEILING IS THE TEST, NOT THE REMAINDER. An order that was never captured
 * has a ceiling of zero and therefore a remainder of zero, and reading that
 * remainder as "everything has been refunded" told an operator an order was
 * fully refunded one line under a heading saying nothing was ever captured.
 * Absent is not zero, and zero is not all of it. This is the same condition the
 * group's own label uses, which is why the two can no longer disagree.
 */
export type RefundPanelMode = "empty" | "fully-refunded" | "form";

export function refundPanelMode(summary: {
	readonly ceilingCents: number;
	readonly remainingCents: number;
}): RefundPanelMode {
	if (summary.ceilingCents === 0) return "empty";
	return summary.remainingCents <= 0 ? "fully-refunded" : "form";
}

/** A pending confirm: what the operator is about to do, and the sentence they
 *  must read first. Held as ONE piece of state so two dialogs can never be open
 *  at once and so a confirmed click cannot dispatch a different action than the
 *  one the dialog described. */
interface PendingAction {
	readonly actionId: string;
	readonly value: Record<string, string>;
	readonly title: string;
	readonly text: string;
	readonly confirmLabel: string;
	readonly denyLabel: string;
}

/** The timeline's event label — the same mapping as the Block Kit screen's
 *  `timelineWhat`, including reading the state through `orderStateCell` so a
 *  `Status → cancelled` line says `cancelled · closed` here too. */
function timelineWhat(entry: TimelineEntry): string {
	switch (entry.kind) {
		case "created":
			return "Order created";
		case "state_change":
			return `Status → ${orderStateCell(entry.toState ?? "")}`;
		case "note":
			return "Note added";
		case "fulfillment":
			return "Fulfilment recorded";
		case "cancellation":
			return "Cancelled";
		case "reconciliation_resolved":
			return "Reconciliation resolved";
		default:
			return entry.kind;
	}
}

function timelineWho(entry: TimelineEntry): string {
	return (
		entry.actor ?? entry.author ?? entry.recordedBy ?? entry.cancelledBy ?? entry.resolvedBy ?? "—"
	);
}

function timelineDetail(entry: TimelineEntry): string {
	if (entry.kind === "note") return entry.body ?? "—";
	if (entry.kind === "fulfillment") {
		const parts = [entry.carrier, entry.trackingNumber].filter((p) => p != null && p.length > 0);
		return parts.length > 0 ? parts.join(" ") : "—";
	}
	if (entry.kind === "cancellation") {
		const reason = entry.reason ?? "";
		const detail = entry.detail ?? "";
		if (reason.length > 0 && detail.length > 0) return `${reason}: ${detail}`;
		return reason.length > 0 ? reason : detail.length > 0 ? detail : "—";
	}
	if (entry.kind === "reconciliation_resolved") return entry.outcome ?? "—";
	return "—";
}

/** A secondary surface that could not be loaded. E-1: it degrades to one line
 *  inside its own panel and never blanks the detail or fails the screen. */
function Unavailable({ text }: { text: string }): React.ReactElement {
	return <p style={{ fontSize: 13, opacity: 0.75, margin: "0 0 12px" }}>{text}</p>;
}

/**
 * The one order state that earns a ring (D1) — the same single exception the
 * list marks, so the two surfaces cannot disagree about which status is loud.
 * Every other state renders as the bare phrase.
 */
const PILLED_ORDER_STATE = "failed";

/**
 * How far a refund confirm's recipient token may reach before it is cut,
 * with a visible ellipsis so an operator can SEE that it was cut.
 *
 * `buyerRef` is unverified free text up to 320 characters
 * (`min(1).max(320)`, format unchecked — `packages/service/src/schemas.ts`,
 * `packages/plugin/src/storefront/checkout-route-input.ts`) landing inside a
 * ~200-character sentence (`order-refund-copy.ts`'s `CONFIRM_BUDGET`). That
 * function already refuses to overflow the budget, but its own answer to
 * overflow is to DROP the recipient silently and say "this order's buyer" —
 * fine for an honestly long value, and no defence at all against a short,
 * deliberately crafted one that stays under budget while reshaping the
 * sentence around it. 60 leaves ~140 characters of headroom under the
 * budget even with the longer of the two consequence clauses and the widest
 * realistic amount/id. THE TRADE-OFF IS NAMED, NOT HIDDEN: RFC 5321 allows
 * email addresses past 60 characters, so a legitimately long address is
 * visibly truncated here too (`refundConfirmText`'s own quoting marks where
 * it was cut) — accepted because the alternative is a number generous
 * enough to stop bounding the untrusted, reshaping case this clamp exists
 * for at all.
 */
export const REFUND_RECIPIENT_MAX_LEN = 60;

/**
 * Escape a literal `"` so it cannot close `refundConfirmText`'s own `"…"`
 * delimiter early (review round 3, finding 1). Backslash-escaping rather
 * than stripping: the character stays visible — an operator can still see
 * that the original text had a quote in it — while ceasing to be able to
 * act as ONE. Only the recipient token needs this; the order id and the
 * amount are never caller-supplied free text.
 */
function escapeQuoteForRecipient(value: string): string {
	return value.replaceAll('"', '\\"');
}

/**
 * WHO A REFUND CONFIRM NAMES — review-mandated, and a DIFFERENT, STRICTER
 * question than {@link buyerReferenceText} answers for the heading and the
 * list cell. A destructive action's confirm text must name the most
 * TRUSTWORTHY identity available, not the most readable one:
 *
 *  1. The account email, but ONLY when it is PROVEN — `linkage === "claimed"`
 *     AND `emailVerifiedAt` is set. `identity.email` being PRESENT proves
 *     nothing by itself: on `linkage: "unclaimed"` the account is resolved by
 *     looking up the caller-supplied `buyerRef` itself
 *     (`domain/src/orders/customer-context.ts`), so an "email" reached that
 *     way is the SAME untrusted value laundered through a lookup, not a
 *     second, independent source — the earlier cut of this function called
 *     that branch "verified" and skipped the clamp on it, which was the
 *     defect (review finding N2). `detail.customer` is `null` whenever
 *     customer context could not be loaded, which is a NORMAL state (see
 *     `CUSTOMER_CONTEXT_UNAVAILABLE` elsewhere on this screen), not an
 *     error — so a missing customer falls through the chain below rather
 *     than rendering a placeholder account.
 *  2. `buyerRef` — caller-supplied, unverified free text, and now also where
 *     an UNPROVEN email lands — ESCAPED then CLAMPED (see
 *     {@link escapeQuoteForRecipient}, {@link REFUND_RECIPIENT_MAX_LEN})
 *     precisely because it is untrusted: `refundConfirmText` quotes this
 *     branch's return value, and an unescaped `"` inside it would close
 *     that quote early.
 *  3. {@link UNNAMED_REFUND_RECIPIENT} (`@otta-sh/admin-presentation`) — no
 *     rendering of `ABSENT` (the em dash) here. THE EM DASH IS NEVER A NOUN
 *     IN A SENTENCE: it is correct on the table cell and the heading, where
 *     it marks an empty FIELD, and wrong inside prose ("refund $42 to
 *     '—'?"), which reads as though "—" were the buyer's name rather than a
 *     marker for nothing being there. Keep this distinction — it is the
 *     kind of thing a later "simplification" merges back into one helper
 *     and reintroduces the em-dash-as-noun defect.
 */
function resolveRefundRecipient(
	identity: CustomerContext["identity"] | null | undefined,
	buyerRef: string | null | undefined,
): string {
	if (
		identity != null &&
		identity.linkage === "claimed" &&
		typeof identity.emailVerifiedAt === "string" &&
		identity.emailVerifiedAt.trim().length > 0 &&
		typeof identity.email === "string" &&
		identity.email.trim().length > 0
	) {
		return identity.email.trim();
	}
	if (typeof buyerRef === "string" && buyerRef.trim().length > 0) {
		// ESCAPE BEFORE THE CLAMP (review round 3): `refundConfirmText` wraps
		// this value in a straight `"…"` delimiter, and a raw `"` inside
		// caller-supplied text closes that delimiter early — a quote the
		// untrusted value can itself close is worse than no delimiter, because
		// it implies a guarantee it does not provide. Escaping first, THEN
		// clamping, means a truncation that lands mid-escape can only ever
		// strand a bare backslash before the ellipsis, never a live,
		// unescaped `"`.
		return fit(escapeQuoteForRecipient(buyerRef.trim()), REFUND_RECIPIENT_MAX_LEN);
	}
	return UNNAMED_REFUND_RECIPIENT;
}

/**
 * The Money tab's refunds panel: a pure view over ONE loaded refunds summary and
 * the refund form's drafts. It holds no state — the drafts, the standing refusal
 * and the two focus refs belong to `OrderDetail`, which owns the write.
 *
 * ONE PREDICATE FEEDS BOTH THE GROUP'S HEADING AND ITS BODY. They are a line
 * apart on screen and used to be computed independently, which is exactly how a
 * heading saying "nothing captured" ended up over a sentence saying "fully
 * refunded". Derived once here, they cannot drift again — and because the panel
 * takes its summary as a prop, all three states can be rendered and asserted
 * directly rather than inferred from the screen around them.
 */
export function RefundsPanel({
	refunds,
	currency: cur,
	busy,
	askRefund,
	amountInput,
	setAmountInput,
	refundReason,
	setRefundReason,
	refundedBy,
	setRefundedBy,
	amountError,
	setAmountError,
	amountRef,
	refundedByRef,
}: {
	readonly refunds: RefundsSummary;
	readonly currency: string;
	readonly busy: boolean;
	readonly askRefund: (amountCents: number) => void;
	readonly amountInput: string;
	readonly setAmountInput: (value: string) => void;
	readonly refundReason: string;
	readonly setRefundReason: (value: string) => void;
	readonly refundedBy: string;
	readonly setRefundedBy: (value: string) => void;
	readonly amountError: RefundRefusal | null;
	readonly setAmountError: (refusal: RefundRefusal | null) => void;
	readonly amountRef: React.RefObject<HTMLInputElement | null>;
	readonly refundedByRef: React.RefObject<HTMLInputElement | null>;
}): React.ReactElement {
	const refundMode = refundPanelMode(refunds);
	return (
		<>
			<section style={panelStyle}>
				<Fields
					testId="detail-money"
					entries={[
						["Captured", formatAmount(refunds.capturedTotalCents, cur)],
						["Refunded", formatAmount(refunds.refundedTotalCents, cur)],
						["Remaining refundable", formatAmount(refunds.remainingCents, cur)],
						["Refunds recorded", String(refunds.refunds.length)],
					]}
				/>
			</section>

			<Group
				testId="detail-refunds"
				defaultOpen
				label={
					refundMode === "empty"
						? REFUNDS_GROUP_EMPTY_LABEL
						: refundsGroupLabel(
								formatAmount(refunds.refundedTotalCents, cur),
								formatAmount(refunds.ceilingCents, cur),
							)
				}
			>
				{/*
				  THE CAPABILITY LINE IS ABOUT A REFUND THAT COULD HAPPEN, so it is
				  withdrawn when there is none to make. On an order that was never
				  captured it warned that refunding here issues a REAL refund through
				  Stripe and money moves back to the buyer, directly beside a heading
				  saying nothing was ever captured — a warning about an action the
				  panel is simultaneously refusing to offer.

				  IT IS GATED ON `refundMode`, NOT ON A SECOND CONDITION OF ITS OWN.
				  A separate predicate here is exactly how the heading and the body
				  drifted apart the first time; and it must not be re-derived from the
				  REMAINDER, because a never-captured order and a fully-refunded one
				  both have a remainder of zero and only one of them has nothing to
				  say. The ceiling is the test, once, for all three.
				*/}
				{refundMode !== "empty" && (
					<p style={{ fontSize: 12, opacity: 0.8 }} data-testid="refund-capability">
						{refundCapabilityText(refunds.refundable, refunds.paymentMethod)}
					</p>
				)}

				{refunds.refunds.length > 0 && (
					<Table
						testId="detail-refund-ledger"
						caption="Refunds recorded"
						headers={[<EndHeader label="Amount" />, "Provider ref", "By", "When"]}
					>
						{refunds.refunds.map((refund, index) => (
							<tr key={`${refund.providerRef ?? "ref"}:${String(index)}`}>
								<td className="otta-td otta-num" style={endCellStyle}>
									{formatAmount(refund.amountCents, refund.currency ?? cur)}
								</td>
								<td className="otta-td">
									<code>{refund.providerRef ?? "—"}</code>
								</td>
								<td className="otta-td">{refund.refundedBy ?? "—"}</td>
								<td className="otta-td otta-num">
									{refund.createdAt != null ? formatTimestamp(refund.createdAt) : "—"}
								</td>
							</tr>
						))}
					</Table>
				)}

				{/* The empty state says its piece once, in the heading. Repeating the
				    same sentence in the body read as a rendering fault, and the defect
				    this guards was a FALSE claim under that heading — not the absence
				    of a second true one. */}
				{refundMode === "empty" ? null : refundMode === "fully-refunded" ? (
					<p style={{ fontSize: 13, marginBlockStart: 12 }} data-testid="refunds-full-note">
						{FULLY_REFUNDED_NOTE}
					</p>
				) : (
					<div style={{ marginBlockStart: 12, display: "grid", gap: 12, maxInlineSize: 420 }}>
						<div>
							<Button
								testId="refund-full"
								danger
								disabled={busy}
								label={`Refund ${formatAmount(refunds.remainingCents, cur)} (full remaining)`}
								onClick={() => askRefund(refunds.remainingCents)}
							/>
						</div>
						<Group testId="refund-partial" label={REFUND_PARTIAL_GROUP_LABEL}>
							<div style={{ display: "grid", gap: 10 }}>
								<Field label={`Refund amount (${cur})`}>
									<input
										className="otta-focusable"
										data-testid="refund-amount"
										ref={amountRef}
										style={
											amountError?.field === "amount"
												? { ...inputStyle, borderColor: FAIL_ACCENT }
												: inputStyle
										}
										placeholder="e.g. 19.99"
										{...(amountError?.field === "amount"
											? { "aria-invalid": true, "aria-describedby": REFUND_ERROR_ID }
											: {})}
										value={amountInput}
										onChange={(event) => {
											setAmountInput(event.target.value);
											setAmountError(null);
										}}
									/>
								</Field>
								<Field label="Reason (optional)">
									<input
										className="otta-focusable"
										data-testid="refund-reason"
										style={inputStyle}
										value={refundReason}
										onChange={(event) => setRefundReason(event.target.value)}
									/>
								</Field>
								<Field label="Refunded by">
									<input
										className="otta-focusable"
										data-testid="refund-by"
										ref={refundedByRef}
										style={
											amountError?.field === "refundedBy"
												? { ...inputStyle, borderColor: FAIL_ACCENT }
												: inputStyle
										}
										{...(amountError?.field === "refundedBy"
											? { "aria-invalid": true, "aria-describedby": REFUND_ERROR_ID }
											: {})}
										value={refundedBy}
										onChange={(event) => {
											setRefundedBy(event.target.value);
											setAmountError(null);
										}}
									/>
								</Field>
								{amountError !== null && (
									<p
										role="status"
										aria-live="polite"
										id={REFUND_ERROR_ID}
										data-testid="refund-amount-error"
										style={{
											fontSize: 12,
											margin: 0,
											fontWeight: 600,
											borderInlineStart: `3px solid ${FAIL_ACCENT}`,
											paddingInlineStart: 8,
											paddingBlock: 2,
										}}
									>
										{amountError.message}
									</p>
								)}
								<div>
									<Button
										testId="refund-partial-submit"
										danger
										disabled={busy}
										label="Refund this amount"
										onClick={() => {
											const checked = checkRefundInput(
												amountInput,
												refundedBy,
												refunds.remainingCents,
												cur,
											);
											if (!checked.ok) {
												// A refusal that leaves focus where it was makes the
												// operator hunt for the field it is about.
												setAmountError(checked.refusal);
												const target =
													checked.refusal.field === "amount"
														? amountRef.current
														: refundedByRef.current;
												target?.focus();
												return;
											}
											setAmountError(null);
											askRefund(checked.amountCents);
										}}
									/>
								</div>
								<p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>
									{REFUND_ADDITIVE_NOTE} The remaining refundable amount is{" "}
									{formatMinorUnitsInput(refunds.remainingCents)}.
								</p>
							</div>
						</Group>
					</div>
				)}
			</Group>
		</>
	);
}

export function OrderDetail({
	orderId,
	onBack,
	initialTab = 0,
	onTabChange,
}: {
	orderId: string;
	onBack: () => void;
	/** The tab a shared link named (F23), already resolved from its slug — the
	 *  first tab whenever the link named none, or named one that no longer
	 *  exists. */
	initialTab?: number;
	/** Announced on every tab change, for the screen to write to the URL. The
	 *  detail never touches history itself: one writer. */
	onTabChange?: (index: number) => void;
}): React.ReactElement {
	const [detail, setDetail] = React.useState<DetailPayload | null>(null);
	const [failure, setFailure] = React.useState<{ title: string; description: string } | null>(null);
	const [notice, setNotice] = React.useState<{
		variant: "default" | "error";
		title: string;
		description: string;
	} | null>(null);
	const [tab, setTab] = React.useState(initialTab);
	const [pending, setPending] = React.useState<PendingAction | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [generation, setGeneration] = React.useState(0);

	// Form drafts. They live beside the record rather than inside it because a
	// re-fetch after a write must not blank a field the operator is still typing
	// in — the Block Kit screen had to solve the same problem with a render-state
	// channel and prefills, precisely because its re-render remounts everything.
	const [amountInput, setAmountInput] = React.useState("");
	const [refundReason, setRefundReason] = React.useState("");
	const [refundedBy, setRefundedBy] = React.useState("");
	const [cancelReason, setCancelReason] = React.useState("");
	const [cancelDetail, setCancelDetail] = React.useState("");
	const [cancelledBy, setCancelledBy] = React.useState("");
	const [noteAuthor, setNoteAuthor] = React.useState("");
	const [noteBody, setNoteBody] = React.useState("");
	const [amountError, setAmountError] = React.useState<RefundRefusal | null>(null);
	// A refusal moves focus to the field it is about, so the two inputs it can
	// name are addressable from the submit handler.
	const amountRef = React.useRef<HTMLInputElement>(null);
	const refundedByRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		let cancelled = false;
		void fetchOrderDetail(orderId).then((result) => {
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
	}, [orderId, generation]);

	const dispatch = React.useCallback((action: PendingAction) => {
		setPending(null);
		setBusy(true);
		void performAction(action.actionId, action.value).then((result) => {
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
			// Re-read: the write may have moved the state, the ledger, the
			// timeline and the notes, and every watermark rendered below has to
			// come from what the operator can now see.
			setGeneration((n) => n + 1);
		});
	}, []);

	if (failure !== null) {
		return (
			<div>
				<Button label={ORDERS_BACK_LABEL} onClick={onBack} testId="orders-back" />
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
				Loading order…
			</p>
		);
	}

	const order = detail.order;
	// The HEADING'S OWN QUESTION — "what to print" — answered by the same
	// shared helper the list's Customer cell uses. NOT what a refund confirm
	// uses: see `resolveRefundRecipient` below for why that is a stricter,
	// separate question.
	const recipient = buyerReferenceText(order.buyerRef);
	const refunds = detail.refunds;
	const cur =
		refunds?.currency !== undefined && refunds.currency.length > 0
			? refunds.currency
			: order.totals.currency;

	const ladder: ReadonlyArray<readonly [string, number]> = [
		["Subtotal", order.totals.subtotalCents],
		["Discount", order.totals.discountCents],
		["Shipping", order.totals.shippingCents],
		["Tax", order.totals.taxCents],
		["Total", order.totals.totalCents],
	];

	const askRefund = (amountCents: number) => {
		if (refunds === null) return;
		const amount = formatAmount(amountCents, cur);
		// THE DESTRUCTIVE ACTION'S OWN, STRICTER RECIPIENT — see
		// `resolveRefundRecipient`. A PROVEN email first (claimed + verified),
		// then the clamped buyerRef, then the shared "this order's buyer"
		// fallback; never the heading's `recipient` (readable but unverified)
		// and never `ABSENT`.
		const refundRecipient = resolveRefundRecipient(detail.customer?.identity, order.buyerRef);
		setPending({
			actionId: "orders:refund",
			value: {
				orderId: order.id,
				amountCents: String(amountCents),
				refundedSoFarCents: String(refunds.refundedTotalCents),
				currency: cur,
				reason: refundReason,
				refundedBy,
			},
			title: `Refund ${amount}?`,
			// THE SHARED SENTENCE. Id first, 8 characters, the same helper the
			// Block Kit confirm calls — see `@otta-sh/admin-presentation`.
			text: refundConfirmText(order.id, amount, refundRecipient, refunds.refundable),
			confirmLabel: `Yes, refund ${amount}`,
			denyLabel: "Keep as is",
		});
	};

	return (
		<div>
			<h1
				style={{
					fontSize: 22,
					fontWeight: 700,
					marginBlockEnd: 8,
					// LAYOUT CONTAINMENT, NOT STRING CLAMPING (review finding N1,
					// director ruling). `recipient` carries no length bound — unlike
					// the refund confirm's `resolveRefundRecipient`, this text is
					// meant to stay fully selectable and copy-pasteable, which a
					// clamp inside the DOM cannot honestly promise. `buyerRef` is
					// caller-supplied free text up to 320 characters with no format
					// check (`packages/service/src/schemas.ts`), so the heading's ONE
					// unbroken token has to be able to WRAP rather than push the rest
					// of the line — including the date — off the viewport. THE
					// PRINCIPLE: layout containment via CSS wherever the full value
					// must remain copyable; string clamping only in prose, where a
					// value cannot wrap its way out of reshaping the sentence around
					// it (`resolveRefundRecipient`'s own comment). A block heading
					// under a plain `<div>`, not a flex/grid item, needs no companion
					// `min-width: 0` to honour this — there is no flex-basis/min-
					// content floor here to override.
					overflowWrap: "anywhere",
					maxInlineSize: "100%",
				}}
				data-testid="detail-heading"
				// The uuid is reachable from the heading without being printed on the
				// page — the same non-focusable attribute the list's Customer cell
				// carries it in (`data-customer-id`, `orders-list.tsx`). React omits a
				// `data-*` attribute whose value is `null` OR `undefined`; the
				// `?? undefined` here is only to satisfy the attribute's TypeScript
				// type (`customerId` is `string | null`), not what makes the omission
				// happen. Covered by the guest/unclaimed-order case in
				// `order-detail-dom.test.tsx`.
				data-customer-id={order.customerId ?? undefined}
			>
				Order · {recipient} · {formatDate(order.createdAt)}
			</h1>
			<div style={{ marginBlockEnd: 16 }}>
				<Button label={ORDERS_BACK_LABEL} onClick={onBack} testId="orders-back" />
			</div>

			{notice !== null && (
				<Notice
					variant={notice.variant}
					title={notice.title}
					description={notice.description}
					testId="detail-notice"
				/>
			)}

			{order.reconciliationFlag !== null && (
				<Notice
					variant="alert"
					title="Needs reconciliation"
					// SHARED, and the trim is the reason it has to be. The sentence
					// quotes a flag the SERVICE produced, so its length is service data
					// — the one banner on this screen that can blow §1's 240-char
					// budget through no fault of the copy. `reconciliationAlertSentence`
					// applies `fitBanner` inside itself precisely so neither surface can
					// render the untrimmed version; a hand-copied template here had the
					// same words and none of the budget.
					description={reconciliationAlertSentence(order.reconciliationFlag)}
					testId="detail-reconciliation"
				/>
			)}

			<section style={panelStyle}>
				<Fields
					testId="detail-identity"
					entries={[
						[
							// D1: `failed` is the one status that gets a ring, here and on the
							// list. Nothing else on this screen is pilled.
							"Status",
							order.state === PILLED_ORDER_STATE ? (
								<StatusPill key="state" tone="fail" testId="detail-state-pill">
									{orderStateCell(order.state)}
								</StatusPill>
							) : (
								orderStateCell(order.state)
							),
						],
						["Total", formatAmount(order.totals.totalCents, order.totals.currency)],
						["Placed", formatTimestamp(order.createdAt)],
						["Payment", order.paymentMethod ?? "—"],
						[
							// §1.3: the full id remains obtainable, and on the React tier it
							// is also COPYABLE — the affordance the Block Kit surface could
							// not offer at all.
							"Order ID",
							<span key="id" style={{ display: "inline-flex", alignItems: "center" }}>
								<code data-testid="detail-full-id">{order.id}</code>
								<CopyIdButton id={order.id} testId="detail-copy-id" />
							</span>,
						],
						[
							"Reconciliation",
							reconciliationSummary(
								order.reconciliationFlag,
								order.reconciliationResolution?.outcome ?? null,
							),
						],
					]}
				/>
			</section>

			<div
				role="tablist"
				aria-label="Order sections"
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
						className="otta-focusable otta-btn"
						data-testid={`tab-${label.toLowerCase()}`}
						onClick={() => {
							setTab(index);
							onTabChange?.(index);
						}}
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
					<>
						<h2 style={{ fontSize: 16, fontWeight: 650, marginBlockEnd: 8 }}>Line items</h2>
						<Table
							testId="detail-lines"
							caption="Line items"
							headers={[
								"SKU",
								"Title",
								<EndHeader label="Qty" />,
								<EndHeader label="Unit price" />,
								<EndHeader label="Line total" />,
							]}
						>
							{order.lines.map((line, index) => (
								<tr key={`${line.sku}:${String(index)}`}>
									<td className="otta-td">
										<code>{line.sku}</code>
									</td>
									<td className="otta-td">{line.title}</td>
									<td className="otta-td otta-num" style={endCellStyle}>
										{line.quantity}
									</td>
									<td className="otta-td otta-num" style={endCellStyle}>
										{formatAmount(line.unitPriceCents, line.currency)}
									</td>
									<td className="otta-td otta-num" style={endCellStyle}>
										{formatAmount(line.unitPriceCents * line.quantity, line.currency)}
									</td>
								</tr>
							))}
						</Table>
						{order.lines.length === 0 && (
							<p style={{ fontSize: 13, opacity: 0.75 }}>{ORDER_LINES_EMPTY}</p>
						)}
						<p style={{ fontSize: 12, opacity: 0.7, marginBlockStart: 10 }}>
							{ORDER_LINES_SNAPSHOT_NOTE}
						</p>

						<div style={{ marginBlockStart: 16, maxInlineSize: 360 }}>
							<Table
								testId="detail-totals"
								caption="Totals"
								headers={["Line", <EndHeader label="Amount" />]}
							>
								{ladder.map(([label, amount]) => (
									<tr key={label}>
										<td className="otta-td">{label}</td>
										<td className="otta-td otta-num" style={endCellStyle}>
											{formatAmount(amount, order.totals.currency)}
										</td>
									</tr>
								))}
							</Table>
						</div>

						<div style={{ marginBlockStart: 16 }}>
							{detail.customer === null ? (
								<Unavailable text={CUSTOMER_CONTEXT_UNAVAILABLE} />
							) : (
								<Group
									testId="detail-customer"
									label={`Customer — ${detail.customer.identity.email ?? detail.customer.identity.buyerRef}${
										detail.customer.identity.linkage === "claimed"
											? ""
											: ` (${detail.customer.identity.linkage})`
									}`}
								>
									<Fields
										entries={[
											["Contact email", detail.customer.identity.buyerRef],
											["Orders placed", String(detail.customer.orderCount)],
											["Name", detail.customer.identity.name ?? "—"],
											[
												"Email verified",
												detail.customer.identity.emailVerifiedAt != null
													? formatTimestamp(detail.customer.identity.emailVerifiedAt)
													: "not verified",
											],
										]}
									/>
								</Group>
							)}
						</div>
					</>
				)}

				{tab === 1 && (
					<>
						{order.reconciliationFlag !== null && (
							<Group testId="detail-resolve" label="Resolve reconciliation" defaultOpen>
								<p style={{ fontSize: 12, opacity: 0.75, marginBlockStart: 0 }}>
									{RESOLVE_RECONCILIATION_NOTE}
								</p>
								<ResolveForm
									outcomes={detail.vocabulary.reconciliationOutcomes}
									busy={busy}
									onSubmit={(values) => {
										dispatch({
											actionId: "orders:resolve-reconciliation",
											value: {
												orderId: order.id,
												expectedFlag: order.reconciliationFlag ?? "",
												...values,
											},
											title: "",
											text: "",
											confirmLabel: "",
											denyLabel: "",
										});
									}}
								/>
							</Group>
						)}

						{order.shippingAddress === null ? (
							<Unavailable text={SHIPPING_ADDRESS_ABSENT} />
						) : (
							<Group
								testId="detail-shipping"
								label={`Shipping address — ${order.shippingAddress.country ?? "—"}`}
							>
								<Fields
									entries={[
										["Name", order.shippingAddress.name ?? "—"],
										["Country", order.shippingAddress.country ?? "—"],
										["Address line 1", order.shippingAddress.line1 ?? "—"],
										["Address line 2", order.shippingAddress.line2 ?? "—"],
										["City", order.shippingAddress.city ?? "—"],
										["Region", order.shippingAddress.region ?? "—"],
										["Postal code", order.shippingAddress.postalCode ?? "—"],
										["Email", order.shippingAddress.email ?? "—"],
									]}
								/>
							</Group>
						)}

						{order.fulfillment !== null && (
							<Group testId="detail-fulfilment" label="Fulfilment — recorded">
								<Fields
									entries={[
										["Carrier", order.fulfillment.carrier ?? "—"],
										["Tracking number", order.fulfillment.trackingNumber ?? "—"],
										[
											"Shipped",
											order.fulfillment.shippedAt != null
												? formatTimestamp(order.fulfillment.shippedAt)
												: "—",
										],
										["Recorded by", order.fulfillment.recordedBy ?? "—"],
									]}
								/>
							</Group>
						)}

						{order.fulfillment === null && order.state === "processing" && (
							<Group testId="detail-record-fulfilment" label={FULFILMENT_LABELS.submit} defaultOpen>
								<FulfilmentForm
									busy={busy}
									onSubmit={(values) => {
										dispatch({
											actionId: "orders:record-fulfillment",
											value: { orderId: order.id, state: order.state, ...values },
											title: "",
											text: "",
											confirmLabel: "",
											denyLabel: "",
										});
									}}
								/>
							</Group>
						)}

						{detail.transitions.length > 0 && (
							<section style={panelStyle}>
								<h3 style={{ fontSize: 14, fontWeight: 650, marginBlockStart: 0 }}>Status</h3>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									{detail.transitions.map((toState) => (
										<Button
											key={toState}
											testId={`transition-${toState}`}
											label={`Mark ${toState}`}
											danger={DANGER_TRANSITIONS.has(toState)}
											disabled={busy}
											onClick={() => {
												const value = { orderId: order.id, toState, state: order.state };
												if (!DANGER_TRANSITIONS.has(toState)) {
													dispatch({
														actionId: `orders:transition-${toState}`,
														value,
														title: "",
														text: "",
														confirmLabel: "",
														denyLabel: "",
													});
													return;
												}
												setPending({
													actionId: `orders:transition-${toState}`,
													value,
													title: MARK_REFUNDED_CONFIRM.title,
													text: MARK_REFUNDED_CONFIRM.text,
													confirmLabel: MARK_REFUNDED_CONFIRM.confirm,
													denyLabel: MARK_REFUNDED_CONFIRM.deny,
												});
											}}
										/>
									))}
								</div>
							</section>
						)}

						<Group testId="detail-cancel" label={CANCEL_GROUP_LABEL}>
							<Notice
								variant="alert"
								title={CANCEL_BANNER.title}
								description={CANCEL_BANNER.description}
							/>
							<p style={{ fontSize: 12, opacity: 0.75 }}>{CANCEL_PICK_REASON}</p>
							{/* One button per reason the plugin says has an id, taken from the list
							    it SHIPS rather than filtered out of `cancellationReasons` here. The
							    ids are derived on that side from the same constant; a second copy
							    of the exclusion on this side would post `orders:cancel-other` the
							    day the two disagreed, and that id is not registered — the console
							    would show an unknown-action refusal, not a cancel. */}
							<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBlockEnd: 12 }}>
								{detail.vocabulary.oneClickCancellationReasons.map((reason) => (
									<Button
										key={reason.value}
										testId={`cancel-${reason.value}`}
										label={reason.label}
										danger
										disabled={busy}
										onClick={() => {
											setPending({
												actionId: `orders:cancel-${reason.value}`,
												value: { orderId: order.id, reason: reason.value, state: order.state },
												title: CANCEL_CONFIRM.title,
												text: cancelConfirmText(reason.label),
												confirmLabel: CANCEL_CONFIRM.confirm,
												denyLabel: CANCEL_CONFIRM.deny,
											});
										}}
									/>
								))}
							</div>
							<Group testId="detail-cancel-note" label="Cancel with a note">
								<div style={{ display: "grid", gap: 10, maxInlineSize: 420 }}>
									<Field label="Reason">
										<select
											className="otta-focusable"
											data-testid="cancel-note-reason"
											style={inputStyle}
											value={cancelReason}
											onChange={(event) => setCancelReason(event.target.value)}
										>
											<option value="">Choose a reason…</option>
											{detail.vocabulary.cancellationReasons.map((reason) => (
												<option key={reason.value} value={reason.value}>
													{reason.label}
												</option>
											))}
										</select>
									</Field>
									<Field label="Detail (optional)">
										<input
											className="otta-focusable"
											data-testid="cancel-note-detail"
											style={inputStyle}
											value={cancelDetail}
											onChange={(event) => setCancelDetail(event.target.value)}
										/>
									</Field>
									<Field label="Cancelled by">
										<input
											className="otta-focusable"
											data-testid="cancel-note-by"
											style={inputStyle}
											value={cancelledBy}
											onChange={(event) => setCancelledBy(event.target.value)}
										/>
									</Field>
									<div>
										<Button
											label="Cancel the order"
											testId="cancel-with-note"
											danger
											disabled={busy || cancelReason.length === 0}
											onClick={() => {
												const label =
													detail.vocabulary.cancellationReasons.find(
														(reason) => reason.value === cancelReason,
													)?.label ?? cancelReason;
												setPending({
													actionId: "orders:cancel",
													value: {
														orderId: order.id,
														reason: cancelReason,
														detail: cancelDetail,
														cancelledBy,
														state: order.state,
													},
													title: CANCEL_CONFIRM.title,
													text: cancelConfirmText(label),
													confirmLabel: CANCEL_CONFIRM.confirm,
													denyLabel: CANCEL_CONFIRM.deny,
												});
											}}
										/>
									</div>
								</div>
							</Group>
						</Group>
					</>
				)}

				{tab === 2 &&
					(refunds === null ? (
						<Unavailable text={REFUNDS_UNAVAILABLE} />
					) : (
						<RefundsPanel
							refunds={refunds}
							currency={cur}
							busy={busy}
							askRefund={askRefund}
							amountInput={amountInput}
							setAmountInput={setAmountInput}
							refundReason={refundReason}
							setRefundReason={setRefundReason}
							refundedBy={refundedBy}
							setRefundedBy={setRefundedBy}
							amountError={amountError}
							setAmountError={setAmountError}
							amountRef={amountRef}
							refundedByRef={refundedByRef}
						/>
					))}

				{tab === 3 && (
					<>
						{detail.timeline === null ? (
							<Unavailable text={TIMELINE_UNAVAILABLE} />
						) : (
							<Table
								testId="detail-timeline"
								caption="Timeline"
								headers={["When", "Event", "Who", "Detail"]}
							>
								{detail.timeline.entries.map((entry, index) => (
									<tr key={`${entry.kind}:${entry.at}:${String(index)}`}>
										<td className="otta-td otta-num">{formatTimestamp(entry.at)}</td>
										<td className="otta-td">{timelineWhat(entry)}</td>
										<td className="otta-td">{timelineWho(entry)}</td>
										<td className="otta-td">{timelineDetail(entry)}</td>
									</tr>
								))}
							</Table>
						)}
						{detail.timeline !== null && detail.timeline.entries.length === 0 && (
							<p style={{ fontSize: 13, opacity: 0.75 }}>{TIMELINE_EMPTY}</p>
						)}

						<div style={{ marginBlockStart: 16 }}>
							<Group testId="detail-notes" label={`Notes (${String(detail.notes.length)})`}>
								<div style={{ display: "grid", gap: 10, maxInlineSize: 420 }}>
									<Field label="Note">
										<textarea
											className="otta-focusable"
											data-testid="note-body"
											rows={3}
											style={inputStyle}
											value={noteBody}
											onChange={(event) => setNoteBody(event.target.value)}
										/>
									</Field>
									<Field label="Author">
										<input
											className="otta-focusable"
											data-testid="note-author"
											style={inputStyle}
											value={noteAuthor}
											onChange={(event) => setNoteAuthor(event.target.value)}
										/>
									</Field>
									<div>
										<Button
											testId="note-add"
											label="Add note"
											disabled={busy || noteBody.trim().length === 0}
											onClick={() => {
												dispatch({
													actionId: "orders:add-note",
													value: { orderId: order.id, author: noteAuthor, body: noteBody },
													title: "",
													text: "",
													confirmLabel: "",
													denyLabel: "",
												});
												setNoteBody("");
											}}
										/>
									</div>
								</div>
							</Group>
						</div>
					</>
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

function ResolveForm({
	outcomes,
	busy,
	onSubmit,
}: {
	outcomes: readonly { value: string; label: string }[];
	busy: boolean;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const [outcome, setOutcome] = React.useState(outcomes[0]?.value ?? "");
	const [reason, setReason] = React.useState("");
	const [resolvedBy, setResolvedBy] = React.useState("");
	return (
		<div style={{ display: "grid", gap: 10, maxInlineSize: 460 }}>
			<Field label="Outcome">
				<select
					className="otta-focusable"
					data-testid="resolve-outcome"
					style={inputStyle}
					value={outcome}
					onChange={(event) => setOutcome(event.target.value)}
				>
					{outcomes.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</Field>
			<Field label="Reason">
				<input
					className="otta-focusable"
					data-testid="resolve-reason"
					style={inputStyle}
					value={reason}
					onChange={(event) => setReason(event.target.value)}
				/>
			</Field>
			<Field label="Resolved by">
				<input
					className="otta-focusable"
					data-testid="resolve-by"
					style={inputStyle}
					value={resolvedBy}
					onChange={(event) => setResolvedBy(event.target.value)}
				/>
			</Field>
			<div>
				<Button
					testId="resolve-submit"
					label="Record resolution"
					disabled={busy}
					onClick={() => onSubmit({ outcome, reason, resolvedBy })}
				/>
			</div>
		</div>
	);
}

function FulfilmentForm({
	busy,
	onSubmit,
}: {
	busy: boolean;
	onSubmit: (values: Record<string, string>) => void;
}): React.ReactElement {
	const [carrier, setCarrier] = React.useState("");
	const [trackingNumber, setTrackingNumber] = React.useState("");
	const [trackingUrl, setTrackingUrl] = React.useState("");
	const [shippedAt, setShippedAt] = React.useState("");
	const [recordedBy, setRecordedBy] = React.useState("");
	return (
		<div style={{ display: "grid", gap: 10, maxInlineSize: 460 }}>
			<Field label={FULFILMENT_LABELS.carrier}>
				<input
					className="otta-focusable"
					data-testid="fulfil-carrier"
					style={inputStyle}
					placeholder="e.g. UPS"
					value={carrier}
					onChange={(event) => setCarrier(event.target.value)}
				/>
			</Field>
			<Field label={FULFILMENT_LABELS.trackingNumber}>
				<input
					className="otta-focusable"
					data-testid="fulfil-tracking"
					style={inputStyle}
					value={trackingNumber}
					onChange={(event) => setTrackingNumber(event.target.value)}
				/>
			</Field>
			<Field label={FULFILMENT_LABELS.trackingUrl}>
				<input
					className="otta-focusable"
					data-testid="fulfil-url"
					style={inputStyle}
					placeholder="https://…"
					value={trackingUrl}
					onChange={(event) => setTrackingUrl(event.target.value)}
				/>
			</Field>
			<Field label={FULFILMENT_LABELS.shippedAt}>
				<input
					type="date"
					className="otta-focusable"
					data-testid="fulfil-date"
					style={inputStyle}
					value={shippedAt}
					onChange={(event) => setShippedAt(event.target.value)}
				/>
			</Field>
			<Field label={FULFILMENT_LABELS.recordedBy}>
				<input
					className="otta-focusable"
					data-testid="fulfil-by"
					style={inputStyle}
					placeholder="your name"
					value={recordedBy}
					onChange={(event) => setRecordedBy(event.target.value)}
				/>
			</Field>
			<div>
				<Button
					testId="fulfil-submit"
					label={FULFILMENT_LABELS.submit}
					disabled={busy}
					onClick={() => onSubmit({ carrier, trackingNumber, trackingUrl, shippedAt, recordedBy })}
				/>
			</div>
		</div>
	);
}
