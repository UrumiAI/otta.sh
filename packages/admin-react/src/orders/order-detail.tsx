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
	cancelConfirmText,
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
	type DetailPayload,
	type TimelineEntry,
} from "../console-api.js";
import {
	Button,
	CopyIdButton,
	ConfirmDialog,
	Field,
	Fields,
	Group,
	Notice,
	Table,
	buttonStyle,
	inputStyle,
	panelStyle,
} from "../ui.js";

/** The states whose transition button is destructive enough to confirm — the
 *  same single-member set the Block Kit screen uses. */
const DANGER_TRANSITIONS: ReadonlySet<string> = new Set(["refunded"]);

const TAB_LABELS = ["Order", "Fulfilment", "Money", "History"] as const;

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

export function OrderDetail({
	orderId,
	onBack,
}: {
	orderId: string;
	onBack: () => void;
}): React.ReactElement {
	const [detail, setDetail] = React.useState<DetailPayload | null>(null);
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
	const [amountError, setAmountError] = React.useState<string | null>(null);

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
	const recipient = order.customerId ?? order.buyerRef;
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
			text: refundConfirmText(order.id, amount, recipient, refunds.refundable),
			confirmLabel: `Yes, refund ${amount}`,
			denyLabel: "Keep as is",
		});
	};

	return (
		<div>
			<h1 style={{ fontSize: 22, fontWeight: 700, marginBlockEnd: 8 }} data-testid="detail-heading">
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
						["Status", orderStateCell(order.state)],
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
					<>
						<h2 style={{ fontSize: 16, fontWeight: 650, marginBlockEnd: 8 }}>Line items</h2>
						<Table
							testId="detail-lines"
							caption="Line items"
							headers={["SKU", "Title", "Qty", "Unit price", "Line total"]}
						>
							{order.lines.map((line, index) => (
								<tr key={`${line.sku}:${String(index)}`}>
									<td className="otta-td">
										<code>{line.sku}</code>
									</td>
									<td className="otta-td">{line.title}</td>
									<td className="otta-td otta-num">{line.quantity}</td>
									<td className="otta-td otta-num">
										{formatAmount(line.unitPriceCents, line.currency)}
									</td>
									<td className="otta-td otta-num">
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
							<Table testId="detail-totals" caption="Totals" headers={["Line", "Amount"]}>
								{ladder.map(([label, amount]) => (
									<tr key={label}>
										<td className="otta-td">{label}</td>
										<td className="otta-td otta-num">
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
							<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBlockEnd: 12 }}>
								{detail.vocabulary.cancellationReasons
									.filter((reason) => reason.value !== "other")
									.map((reason) => (
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
									refunds.ceilingCents === 0
										? REFUNDS_GROUP_EMPTY_LABEL
										: refundsGroupLabel(
												formatAmount(refunds.refundedTotalCents, cur),
												formatAmount(refunds.ceilingCents, cur),
											)
								}
							>
								<p style={{ fontSize: 12, opacity: 0.8 }} data-testid="refund-capability">
									{refundCapabilityText(refunds.refundable, refunds.paymentMethod)}
								</p>

								{refunds.refunds.length > 0 && (
									<Table
										testId="detail-refund-ledger"
										caption="Refunds recorded"
										headers={["Amount", "Provider ref", "By", "When"]}
									>
										{refunds.refunds.map((refund, index) => (
											<tr key={`${refund.providerRef ?? "ref"}:${String(index)}`}>
												<td className="otta-td otta-num">
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

								{refunds.remainingCents <= 0 ? (
									<p style={{ fontSize: 13, marginBlockStart: 12 }}>{FULLY_REFUNDED_NOTE}</p>
								) : (
									<div
										style={{ marginBlockStart: 12, display: "grid", gap: 12, maxInlineSize: 420 }}
									>
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
														style={inputStyle}
														placeholder="e.g. 19.99"
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
														style={inputStyle}
														value={refundedBy}
														onChange={(event) => setRefundedBy(event.target.value)}
													/>
												</Field>
												{amountError !== null && (
													<p
														role="status"
														aria-live="polite"
														data-testid="refund-amount-error"
														style={{ fontSize: 12, margin: 0 }}
													>
														{amountError}
													</p>
												)}
												<div>
													<Button
														testId="refund-partial-submit"
														danger
														disabled={busy}
														label="Refund this amount"
														onClick={() => {
															// Parsed with the SHARED input parser — exact integer
															// string math, never `parseFloat(...) * 100`. The
															// refusal copy is the write handler's own, restated
															// here only because this check happens before the
															// dialog rather than after the click.
															const parsed = parseMinorUnitsInput(amountInput, {
																allowZero: false,
															});
															if (parsed === null) {
																setAmountError(REFUND_AMOUNT_INVALID);
																return;
															}
															if (refundedBy.trim().length === 0) {
																setAmountError(REFUND_BY_REQUIRED);
																return;
															}
															if (parsed > refunds.remainingCents) {
																setAmountError(
																	refundTooHighInline(
																		formatAmount(parsed, cur),
																		formatAmount(refunds.remainingCents, cur),
																	),
																);
																return;
															}
															setAmountError(null);
															askRefund(parsed);
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
