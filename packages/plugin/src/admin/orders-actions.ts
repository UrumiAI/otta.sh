/**
 * The Orders WRITE path, as structured actions (ADR-0015 Decision 2).
 *
 * WHAT THIS REPLACES, and why the replacement was a rewrite rather than a
 * deletion. Until this module existed, the React console did not have a write
 * path of its own: it constructed the Block Kit Orders page handler, forwarded
 * every click through it as a synthesized `block_action`, and then SCRAPED the
 * outcome back out of the rendered block tree — the banner off the render, and an
 * empty tree read as "nothing applied". The Block Kit renderer was therefore
 * load-bearing for the screen that replaced it. Each action below is that write,
 * re-expressed as a function returning an {@link OrdersActionResult}: the applied/
 * refused flag, the notice, and the staged or draft state a two-step flow needs.
 * No page handler, no synthesized interaction, no notice-scraping.
 *
 * THE THREE REFUSALS ARE CARRIED VERBATIM (ADR-0015 Decision 3). A reworded bound
 * check is a failed port, not a port:
 *
 *  1. **Stale-watermark refusal (DA-3a).** The watermark the operator SAW —
 *     `refundedSoFarCents` on the money path, the order `state` on every other —
 *     is re-read against live truth and the write REFUSES on a mismatch. Every
 *     site holding a watermark also refuses an ABSENT one, with no re-read and no
 *     `-review` exemption: see {@link readWatermark}.
 *  2. **Refund-ceiling bound check (DA-3c).** The parsed amount is bound-checked
 *     against the ceiling JUST RE-READ, and that check runs AFTER the watermark
 *     compare — so the bound is always one the operator has now been shown, and
 *     the movement refusal (whose copy already names the new remaining balance)
 *     wins when both would fire.
 *  3. **Unparseable-amount refusal.** `parseMinorUnitsInput` returning `null`
 *     refuses, and the draft carries the operator's RAW TEXT verbatim rather than
 *     re-deriving it from cents — on that path there IS no `amountCents`, and a
 *     rejected `19,99` cannot be reconstructed from minor units.
 *
 * MONEY IS INTEGER MINOR UNITS. Nothing here parses money with a float:
 * {@link parseCents} reads an untrusted payload's integer minor-units string, and
 * `parseMinorUnitsInput` does exact integer string math on what an operator typed.
 *
 * NO NONCE, ANYWHERE. Every write derives its idempotency key from its own content
 * plus the watermark the operator saw — for a refund,
 * `admin-refund:${orderId}:${amountCents}:${refundedSoFarCents}` (F-2a). That is
 * what lets two deliberate identical refunds both apply while a double-click
 * dedupes, and a render-time nonce cannot do it safely: the domain resolves a
 * refund by key ALONE with no amount comparison, so a reused key with a different
 * amount renders a success-shaped "Already refunded" for money that never moved.
 *
 * EVERY FIELD ARRIVING HERE IS UNTRUSTED operator-round-tripped input, exactly as
 * a Block Kit `button.value` or a decoded carrier was: closed sets are re-checked,
 * watermarks are re-checked for PRESENCE as well as for equality, and nothing is
 * coerced.
 *
 * THE `-review` PAIR IS RETAINED BUT CURRENTLY UNREACHED, and a reader is owed the
 * plain version of that rather than being left to guess whether it is dead code.
 * `orders:refund-review` and `orders:cancel-review` — with {@link OrdersStaged},
 * {@link OrdersDraft} and the `staged`/`draft` members of
 * {@link OrdersActionResult} that exist for them — have no caller today: the React
 * order detail stages its own confirm client-side and posts `orders:refund` /
 * `orders:cancel` directly. They are kept because the two-step flow is the ported
 * shape and one refusal lives ONLY on this path: the unparseable-amount refusal,
 * whose draft carries the operator's raw text verbatim.
 *
 * The consequence, stated without spin: **the DA-3c live-ceiling bound check never
 * runs for the React console**, because it sits in {@link refundReviewAction}. That
 * is PRE-EXISTING and not introduced by the extraction — the Block Kit screen
 * reached `-review` from its own form, the React screen never has. The reachable
 * confirm ({@link refundOrderAction}) is not unguarded: it re-reads the ledger and
 * refuses on a watermark mismatch (DA-3a), and an over-ceiling amount that survives
 * that is refused by the service itself as `REFUND_EXCEEDS_TOTAL` /
 * `REFUND_EXCEEDS_CAPTURED`, which {@link refundFailureNotice} renders. What is
 * lost is the EARLIER, better-worded refusal that names the real remaining balance,
 * not the ceiling itself. Wiring `-review` into the React flow, or moving the bound
 * check onto the confirm, is a change with its own increment — not this one.
 *
 * KNOWN FOLLOW-UP, ported verbatim and deliberately left alone here:
 * {@link resolveReconciliationAction} derives its idempotency key as
 * `admin-resolve-reconciliation:${orderId}` with no `expectedFlag` component, so two
 * different resolutions of two different anomalies on the SAME order derive the same
 * key; the second is answered from the idempotency store as already-resolved and the
 * new flag is never cleared. Pre-existing behaviour of the deleted handler, carried
 * across unchanged so this module is a port and not a rewrite. Fixing it changes a
 * key and therefore needs its own increment.
 */
import {
	BANNER_BUDGET,
	ORDER_STATES,
	REFUND_AMOUNT_INVALID,
	REFUND_BY_REQUIRED,
	REFUND_TOO_HIGH_TITLE,
	fit,
	formatAmount as formatTotal,
	formatMinorUnitsInput,
	parseMinorUnitsInput,
	refundTooHighText,
} from "@otta-sh/admin-presentation";
import { AdminOrdersClient, type RefundsSummaryWire } from "./admin-orders-client.js";
import { readString, screenActions, startOfDay, type Notice } from "./scaffold/index.js";
import type { SelectOption } from "../types.js";

/** This screen's namespaced action ids. */
const ORDERS_ACTIONS = screenActions("orders");
const ACTION_ADD_NOTE = ORDERS_ACTIONS.custom("add-note");
const ACTION_RESOLVE = ORDERS_ACTIONS.custom("resolve-reconciliation");
const ACTION_RECORD_FULFILLMENT = ORDERS_ACTIONS.custom("record-fulfillment");
/** DA-3 state 1 → state 2 (stage a cancellation with free-text detail). */
const ACTION_CANCEL_REVIEW = ORDERS_ACTIONS.custom("cancel-review");
/** The DA-3 state-2 confirm for a cancellation. DA-2b's per-reason verbs have
 *  their own ids so a surface can offer one control per reason. */
const ACTION_CANCEL = ORDERS_ACTIONS.custom("cancel");
/** DA-3 state 1 → state 2 (stage a partial refund). */
const ACTION_REFUND_REVIEW = ORDERS_ACTIONS.custom("refund-review");
/** Both the DA-2b full-remaining refund and the DA-3 state-2 confirm. */
const ACTION_REFUND = ORDERS_ACTIONS.custom("refund");

/** `transition-<state>` — one DISTINCT verb per state, derived. */
const transitionVerb = (state: string): string => `transition-${state}`;
/** `cancel-<reason>` — one DISTINCT verb per cancellation reason (DA-2b). */
const cancelReasonVerb = (reason: string): string => `cancel-${reason}`;

/**
 * The five structured cancellation reasons — the WIRE values the domain accepts
 * (mirroring `CancellationReason`; the service re-validates), each with the human
 * label an operator reads. This list is the source of the per-reason action ids.
 */
export const CANCELLATION_REASONS: readonly SelectOption[] = [
	{ value: "customer_request", label: "Customer requested it" },
	{ value: "fraud_suspected", label: "Fraud suspected" },
	{ value: "out_of_stock", label: "Out of stock" },
	{ value: "pricing_error", label: "Pricing error" },
	{ value: "other", label: "Other" },
];

const CANCEL_REASON_LABELS: ReadonlyMap<string, string> = new Map(
	CANCELLATION_REASONS.map((r) => [r.value, r.label]),
);

/**
 * The inverse map. The two-step cancel flow's `-review` step takes the reason in
 * OPTION-VALUE space — which on this screen IS the human label — and maps it back
 * to the wire value here. Untrusted input: an unmapped value is refused, never
 * forwarded, and every mapped value is re-checked against
 * {@link CANCEL_REASON_LABELS} before it reaches the service.
 */
const CANCEL_REASON_BY_LABEL: ReadonlyMap<string, string> = new Map(
	CANCELLATION_REASONS.map((r) => [r.label, r.value]),
);

/** The three admin dispositions. The labels spell out that a disposition is a
 *  RECORD, not an action — "refunded" must never read as "this issues a refund". */
export const RECONCILIATION_OUTCOMES: readonly SelectOption[] = [
	{
		value: "refunded",
		label: "refunded (records the disposition — issue the refund in Refunds below)",
	},
	{ value: "fulfilled", label: "fulfilled (order honored as-is; e.g. stock re-sourced)" },
	{ value: "written_off", label: "written_off (loss/false-alarm accepted)" },
];

/**
 * THE TWO-STEP FLOWS' STATE, and the pairing is the point:
 *
 *  - `*-staged` is DA-3 **state 2**: the operator's input has passed every check,
 *    so it is carried in PARSED form together with THE WATERMARK THEY SAW, which
 *    the confirm echoes back so the write can re-read and refuse on a mismatch.
 *  - `*-draft` is a **refusal**: state 1 handed back with the submitted values so
 *    the operator can correct them, and NO confirm control.
 *
 * TWO PROPERTIES OF THE DRAFT MEMBERS THAT ARE FORCED, NOT STYLISTIC:
 *
 *  1. **A DRAFT CARRIES RAW OPERATOR TEXT** (`amountInput`, `reasonInput`), never
 *     minor units. {@link refundReview} refuses precisely when
 *     `parseMinorUnitsInput` returns `null` — the most frequent refusal on this
 *     screen, a typo in the amount field — so on that path there IS no
 *     `amountCents` to re-derive a prefill from, and a rejected `19,99` cannot be
 *     reconstructed from cents.
 *  2. **A DRAFT CARRIES NO WATERMARK.** The next review re-reads it from live
 *     truth, so the operator's next attempt stages against current truth BY
 *     CONSTRUCTION rather than by anyone remembering to re-stamp it.
 */
export type OrdersStaged =
	| {
			readonly kind: "refund-staged";
			/** Integer minor units (M-3) — parsed, bound-checked and ≤ the live ceiling. */
			readonly amountCents: number;
			/** The watermark: `refundedTotalCents` AS THE OPERATOR SAW IT. */
			readonly refundedSoFarCents: number;
			readonly currency: string;
			readonly reason: string;
			readonly refundedBy: string;
	  }
	| {
			readonly kind: "cancel-staged";
			/** The WIRE reason (`out_of_stock`), mapped back from the option label. */
			readonly reason: string;
			readonly detail: string;
			readonly cancelledBy: string;
			/** The watermark: the order `state` AS THE OPERATOR SAW IT. */
			readonly state: string;
	  };

export type OrdersDraft =
	| {
			readonly kind: "refund-draft";
			/** VERBATIM operator text, unparsed — see the note above. */
			readonly amountInput: string;
			readonly reason: string;
			readonly refundedBy: string;
	  }
	| {
			readonly kind: "cancel-draft";
			/** The submitted option value, which on this flow IS the human label —
			 *  handed back verbatim when it is a known option, and dropped to `""`
			 *  when it is not, because a surface must not prefill an option it does
			 *  not offer. */
			readonly reasonInput: string;
			readonly detail: string;
			readonly cancelledBy: string;
	  };

/**
 * What a write returns instead of a block tree.
 *
 * `ok: true` means the request was UNDERSTOOD and dispatched, not that anything
 * was written — a refusal is a `notice` with `variant: "error"`, which is the
 * shape the operator reads either way. `notice: null` is the quiet success the
 * Block Kit screen expressed as "re-render with no banner".
 */
export interface OrdersActionResult {
	readonly ok: true;
	readonly notice: Notice | null;
	/** Present on a two-step flow's `-review` when every check passed. */
	readonly staged?: OrdersStaged;
	/** Present on a refusal that the operator can correct by re-submitting. */
	readonly draft?: OrdersDraft;
}

/** A write's payload: the flat string record the caller carried. Untrusted,
 *  exactly as a Block Kit `button.value` or a decoded carrier was. */
export type OrdersActionPayload = Readonly<Record<string, string>>;

type OrdersAction = (
	client: AdminOrdersClient,
	payload: OrdersActionPayload,
) => Promise<OrdersActionResult>;

/**
 * DA-3b: a payload that fails to decode gets an `error` notice, never a silent
 * success and never a redirect with no explanation.
 */
const UNREADABLE: Notice = {
	variant: "error",
	title: "That action could not be read",
	description: "Nothing was changed. Reload the order and try again.",
};

/**
 * A MISSING WATERMARK IS AN UNREADABLE PAYLOAD, NOT A REASON TO SKIP DA-3a.
 *
 * Every destructive control carries the watermark the operator saw, so an absent
 * one has exactly two sources, and refusing is right for both: a payload edited in
 * devtools (it is operator-alterable), or a browser tab rendered before the
 * watermark existed, which is precisely the stale view DA-3a is for. A
 * `value.state.length > 0` guard around the comparison would let either write with
 * no staleness check at all, which is the X-38 hole dressed as tolerance.
 *
 * `""` is folded into `undefined` deliberately: a whitespace-only or empty state is
 * not a state, and no comparison against it can be meaningful.
 *
 * THE RULE IS ABSOLUTE ON THIS SCREEN, and that is checkable. Every site holding a
 * watermark answers an absent one with {@link UNREADABLE} and NO re-read: the ten
 * transitions and {@link cancelReview}/{@link cancelOrder} through this helper, and
 * the two refund handlers through {@link parseCents} — the refund watermark is a
 * MINOR-UNITS LEDGER TOTAL rather than a state name, so it cannot route through
 * here, but `observedSoFar === null` is the same check and gets the same answer.
 *
 * They differ only in whether a draft rides along, which is decided by whether the
 * refused payload came from a form the operator can correct.
 *
 * A `-review` is NOT an exception on the grounds that it writes nothing; see
 * {@link cancelReview}'s header for why re-stamping a fresh watermark onto the
 * confirm it stages makes the tolerance worse than the refusal, not better.
 */
function readWatermark(value: unknown): string | undefined {
	const raw = readString(value)?.trim();
	return raw === undefined || raw.length === 0 ? undefined : raw;
}

/** Read integer minor units out of an untrusted payload. Rejects anything that is
 *  not a plain non-negative integer string — money never crosses this boundary as
 *  a float (B-2). */
function parseCents(value: unknown): number | null {
	const raw = readString(value);
	if (raw === undefined || !/^\d+$/.test(raw)) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The fulfilment form's `shippedAt`: a date field yields `YYYY-MM-DD` and the
 *  service wants a full ISO datetime, and a day given as a shipping moment is the
 *  start of that day. */
function normalizeBound(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	return startOfDay(value);
}

const applied = (notice: Notice | null): OrdersActionResult => ({ ok: true, notice });
const refused = (notice: Notice, draft?: OrdersDraft): OrdersActionResult =>
	draft === undefined ? { ok: true, notice } : { ok: true, notice, draft };

// -- transitions --------------------------------------------------------------

/**
 * One handler per state, closed over the target from {@link ORDER_STATES} — so
 * the state a transition writes comes from the ACTION ID (which only exists
 * because it was derived from that list) and never from the operator-alterable
 * `toState` (DA-6 item 4).
 *
 * DA-2a / DA-3a, MANDATORY AND WITH NO EXEMPTION FOR STATUS MOVES: take the
 * watermark out of the payload, RE-READ the order, and refuse on a mismatch.
 * `shipped → refunded` is legal, so the domain's guarded flip is no defence
 * against a decision made while looking at `paid`, and transitions are the write
 * most likely to race because the state being moved FROM is the thing another
 * operator is most likely to have changed.
 *
 * NO DRAFT IS RETURNED ON THE REFUSAL, and that is not an omission: a transition
 * is a bare control with no form and no operator-typed input to preserve, so there
 * is nothing to hand back.
 */
function transitionAction(toState: string): OrdersAction {
	return async (client, payload) => {
		const orderId = readString(payload["orderId"]);
		if (orderId === undefined) return applied(UNREADABLE);
		const observedState = readWatermark(payload["state"]);
		if (observedState === undefined) return applied(UNREADABLE);
		const live = await client.getOrder(orderId).catch(() => null);
		if (live === null) {
			return applied({
				variant: "error",
				title: "Nothing was changed",
				description:
					"This order could not be re-checked before the status change, so nothing was applied. Reload and try again.",
			});
		}
		if (live.order.state !== observedState) {
			return applied({
				variant: "error",
				title: "The order changed — nothing was applied",
				description: `It was ${observedState} when you started and is now ${live.order.state}. Check the order below before changing its status.`,
			});
		}
		const key = `admin-transition:${orderId}:${toState}`;
		const result = await client.transitionOrder(orderId, toState, { idempotencyKey: key });
		if (!result.ok) {
			return applied({
				variant: "error",
				title: "Status change failed",
				description:
					"That status change could not be applied — check the order state and the admin token in Settings.",
			});
		}
		if (!result.transitioned) {
			// The guarded flip matched 0 rows — already in that state, or a lost race.
			// Not a failure: surface a non-error notice rather than a silent success.
			return applied({
				variant: "default",
				title: "No change",
				description: "The order is already in that state.",
			});
		}
		return applied(null);
	};
}

// -- notes --------------------------------------------------------------------

const addNoteAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const author = (readString(payload["author"]) ?? "").trim();
	const body = (readString(payload["body"]) ?? "").trim();
	// Local guard: a blank note never leaves the plugin (the domain rejects it
	// too, but this gives inline feedback without a round trip).
	if (author.length === 0 || body.length === 0) {
		return applied({
			variant: "error",
			title: "Note not added",
			description: "Enter both an author and a note body.",
		});
	}
	// Content-derived key (F-2a): a double-submit of the same note is a no-op,
	// a genuinely new note still appends.
	const key = `admin-note:${orderId}:${author}:${body}`;
	const result = await client.addNote(orderId, { author, body }, { idempotencyKey: key });
	if (!result.ok) {
		return applied({
			variant: "error",
			title: "Note not added",
			description:
				"That note could not be saved — check the order and the admin token in Settings.",
		});
	}
	if (!result.appended) {
		return applied({
			variant: "default",
			title: "Already added",
			description: "That exact note is already on this order.",
		});
	}
	return applied(null);
};

// -- reconciliation -----------------------------------------------------------

const resolveReconciliationAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	// The flag AS DISPLAYED when the form rendered — the compare-and-clear key.
	const expectedFlag = readString(payload["expectedFlag"]) ?? "";
	const outcome = readString(payload["outcome"]) ?? "";
	const reason = (readString(payload["reason"]) ?? "").trim();
	const resolvedBy = (readString(payload["resolvedBy"]) ?? "").trim();
	if (reason.length === 0 || resolvedBy.length === 0) {
		return applied({
			variant: "error",
			title: "Not resolved",
			description: "Enter both a reason and who is resolving it.",
		});
	}
	const key = `admin-resolve-reconciliation:${orderId}`;
	const result = await client.resolveReconciliation(
		orderId,
		{ expectedFlag, outcome, reason, resolvedBy },
		{ idempotencyKey: key },
	);
	if (!result.ok) {
		// A stale review gets its own copy: the flag changed under the admin, and a
		// re-read shows the NEW flag.
		return applied(
			result.reason === "RECONCILIATION_FLAG_CHANGED"
				? {
						variant: "error",
						title: "The reconciliation state changed — reload",
						description:
							"A new anomaly was flagged on this order after you opened it. Nothing was cleared. Review the flag shown below and resolve again.",
					}
				: {
						variant: "error",
						title: "Not resolved",
						description:
							"That reconciliation could not be resolved — check the order and the admin token in Settings.",
					},
		);
	}
	if (!result.resolved) {
		return applied({
			variant: "default",
			title: "Already resolved",
			description: "This order's reconciliation flag was already cleared.",
		});
	}
	return applied({
		variant: "default",
		title: "Reconciliation resolved",
		description: "The flag is cleared and your disposition was recorded.",
	});
};

// -- fulfilment ---------------------------------------------------------------

const recordFulfillmentAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const carrier = (readString(payload["carrier"]) ?? "").trim();
	const trackingNumber = (readString(payload["trackingNumber"]) ?? "").trim();
	const recordedBy = (readString(payload["recordedBy"]) ?? "").trim();
	if (carrier.length === 0 || trackingNumber.length === 0 || recordedBy.length === 0) {
		return applied({
			variant: "error",
			title: "Not shipped",
			description: "Enter the carrier, tracking number, and who is recording it.",
		});
	}
	const trackingUrl = (readString(payload["trackingUrl"]) ?? "").trim();
	// The tracking URL, when given, must be http(s) — the SAME bound the service
	// schema enforces. Defense in depth: this value is emailed to the buyer, so a
	// `javascript:`/`data:` URI is rejected here with inline feedback.
	if (trackingUrl.length > 0 && !/^https?:\/\/\S+$/i.test(trackingUrl)) {
		return applied({
			variant: "error",
			title: "Not shipped",
			description: "The tracking URL must be a web link starting with http:// or https://.",
		});
	}
	// A date field yields YYYY-MM-DD; the service wants a full ISO datetime.
	const shippedAt = normalizeBound(readString(payload["shippedAt"]));
	const key = `admin-record-fulfillment:${orderId}`;
	const result = await client.recordFulfillment(
		orderId,
		{
			carrier,
			trackingNumber,
			...(trackingUrl.length > 0 ? { trackingUrl } : {}),
			...(shippedAt !== undefined ? { shippedAt } : {}),
			recordedBy,
		},
		{ idempotencyKey: key },
	);
	if (!result.ok) {
		return applied(
			result.reason === "NOT_FULFILLABLE"
				? {
						variant: "error",
						title: "Order can’t be shipped right now",
						description:
							"This order is no longer “processing” — it may have shipped or been cancelled. Reload and check its status.",
					}
				: {
						variant: "error",
						title: "Not shipped",
						description:
							"That fulfilment could not be recorded — check the order and the admin token in Settings.",
					},
		);
	}
	if (!result.recorded) {
		return applied({
			variant: "default",
			title: "Already shipped",
			description: "This order was already shipped; its recorded tracking is shown above.",
		});
	}
	return applied({
		variant: "default",
		title: "Order shipped",
		description: "Fulfilment recorded — the buyer has been emailed their tracking.",
	});
};

// -- cancellation -------------------------------------------------------------

/**
 * DA-3 state 1 → 2 for a cancellation: validate, RE-READ, then hand back the
 * staged values. NOTHING is written here.
 *
 * IT RE-READS BECAUSE `-review` PRODUCES THE STATEMENTS THE SHAPE EXISTS TO MAKE
 * TRUE (DA-3c: "not only the confirm handler"). The confirm it stages says *"Cancel
 * this order as 'out of stock'? This is permanent…"* over a payload carrying the
 * watermark. If the order moved between state 1 and this submit, that confirm is
 * dead on arrival — {@link cancelOrder}'s own DA-3a check will refuse it — and the
 * operator would be shown a coherent current panel beside a control that cannot
 * succeed, with nothing saying why. So the movement is caught HERE, at the step
 * whose only purpose is letting them check.
 *
 * AN ABSENT WATERMARK IS REFUSED HERE TOO, with no `-review` exemption —
 * {@link readWatermark}'s doc states that rule absolutely and this handler is not
 * outside it. Tolerating it (`observedState !== undefined && …`) looked safe, because
 * the confirm this handler stages could re-stamp `state` from its own fresh read and
 * {@link cancelOrder} would then check against that. It is not safe, for two reasons:
 *
 *  1. **The re-stamp launders the window it skipped.** The operator chose a reason
 *     while looking at some state; a fresh stamp asserts a state they never saw, and
 *     the confirm's check then passes trivially. The window from that page rendering
 *     to this submit goes unchecked while the payload claims otherwise — the X-38
 *     hole one step removed. {@link refundReview} names the identical move as wrong
 *     for the refund path ("re-stamping it fresh … would assert a decision the
 *     operator never made"); the same asymmetry cannot be a defect there and a
 *     tolerance here.
 *  2. **A `-review` has less standing to skip it, not more.** Its whole purpose is
 *     catching movement before a confirm is drawn. With no watermark it has nothing
 *     to compare, so the one step that exists to let an operator check silently
 *     checks nothing.
 *
 * So every DA-3a site on this screen refuses an absent watermark identically, and a
 * reviewer checks one boolean per site instead of judging each one. The cost is a
 * reload on a payload that was hand-edited or came from a pre-watermark tab.
 *
 * EVERY REFUSAL CARRIES A DRAFT: the operator's typed values, handed straight back.
 */
const cancelReviewAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const observedState = readWatermark(payload["state"]);
	// The review step takes the reason in OPTION-VALUE space — the human label —
	// so map back to the wire reason. Untrusted input: an unmapped value is
	// refused, never forwarded.
	const reasonInput = readString(payload["reason"]) ?? "";
	const reason = CANCEL_REASON_BY_LABEL.get(reasonInput);
	const detail = (readString(payload["detail"]) ?? "").trim();
	const cancelledBy = (readString(payload["cancelledBy"]) ?? "").trim();
	const draft = (): OrdersDraft => ({
		kind: "cancel-draft",
		reasonInput,
		detail,
		cancelledBy,
	});
	// DA-3a with NO `-review` EXEMPTION (see this function's header). Refused before
	// the read, because no re-read can supply a watermark the operator never sent and
	// the outcome cannot depend on what it would return.
	if (observedState === undefined) {
		return refused(UNREADABLE, draft());
	}
	if (reason === undefined || cancelledBy.length === 0) {
		return refused(
			{
				variant: "error",
				title: "Not cancelled",
				description: "Choose a reason and enter who is cancelling it. Nothing was changed.",
			},
			draft(),
		);
	}
	const live = await client.getOrder(orderId).catch(() => null);
	if (live === null) {
		return refused(
			{
				variant: "error",
				title: "Could not check the order",
				description:
					"This order could not be re-read, so nothing was staged and nothing was changed. Reload and try again.",
			},
			draft(),
		);
	}
	if (live.order.state !== observedState) {
		return refused(
			{
				variant: "error",
				title: "The order changed — nothing was staged",
				description: `It was ${observedState} when you started and is now ${live.order.state} — someone else moved it since you opened this form. Check the order below, then review again.`,
			},
			draft(),
		);
	}
	return {
		ok: true,
		notice: null,
		staged: {
			kind: "cancel-staged",
			reason,
			detail,
			cancelledBy,
			// The watermark FRESHLY CONFIRMED equal to the observed one, so the confirm
			// this stages is one the write can actually accept.
			state: live.order.state,
		},
	};
};

/**
 * Shared by DA-2b's four per-reason controls AND DA-3's state-2 confirm — one
 * handler, because both carry the same `{orderId, reason, state}` (the DA-3 one
 * adds `detail`).
 *
 * DA-3a, MANDATORY: re-read the order and refuse on a watermark mismatch. The
 * staged `state` is what the operator saw; if the order moved under them, apply
 * NOTHING and name both states.
 *
 * EVERY REFUSAL HERE CARRIES A DRAFT, including the two that read like plumbing
 * failures. Nothing was written on any of them and the operator's typed detail is
 * in hand, so discarding it to tell them to try again makes the safe path the
 * expensive one — and the next thing they reach for is a one-click reason control,
 * which records no detail at all.
 */
const cancelOrderAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const reason = readString(payload["reason"]) ?? "";
	const detail = (readString(payload["detail"]) ?? "").trim();
	const cancelledBy = (readString(payload["cancelledBy"]) ?? "").trim();
	const observedState = readWatermark(payload["state"]);
	// The draft is in OPTION-VALUE space (the human label), and an unrecognized
	// reason simply has no label to put back — the operator's detail and name
	// survive, which is the part they typed.
	const draft = (): OrdersDraft => ({
		kind: "cancel-draft",
		reasonInput: CANCEL_REASON_LABELS.get(reason) ?? "",
		detail,
		cancelledBy,
	});
	// Every decoded value is UNTRUSTED operator-round-tripped input (B-1), so the
	// closed set and the watermark's PRESENCE are both re-checked here.
	if (!CANCEL_REASON_LABELS.has(reason) || observedState === undefined) {
		return refused(UNREADABLE, draft());
	}
	// DA-3a: re-read before writing.
	const live = await client.getOrder(orderId).catch(() => null);
	if (live === null) {
		return refused(
			{
				variant: "error",
				title: "Nothing was cancelled",
				description:
					"This order could not be re-checked before cancelling, so nothing was applied. Reload and try again.",
			},
			draft(),
		);
	}
	if (live.order.state !== observedState) {
		return refused(
			{
				variant: "error",
				title: "The order changed — nothing was cancelled",
				description: `It was ${observedState} when you started and is now ${live.order.state} — someone else moved it since you started. Check the order below, then cancel again if you still want to.`,
			},
			draft(),
		);
	}
	const key = `admin-cancel:${orderId}`;
	const result = await client.cancelOrder(
		orderId,
		{
			reason,
			...(detail.length > 0 ? { detail } : {}),
			cancelledBy: cancelledBy.length > 0 ? cancelledBy : "admin",
		},
		{ idempotencyKey: key },
	);
	// NO DRAFT ON THESE: the write was attempted. `NOT_CANCELLABLE` means the
	// order cannot be cancelled AT ALL now, so a prefilled retry would promise
	// something that is no longer possible; the other branches are outcomes to
	// read, not inputs to correct.
	if (!result.ok) {
		return applied(
			result.reason === "NOT_CANCELLABLE"
				? {
						variant: "error",
						title: "Order can’t be cancelled right now",
						description:
							"This order can no longer be cancelled — it may have shipped, or been cancelled without a reason on file. Reload and check its status.",
					}
				: {
						variant: "error",
						title: "Not cancelled",
						description:
							"That cancellation could not be recorded — check the order and the admin token in Settings.",
					},
		);
	}
	if (!result.cancelled) {
		return applied({
			variant: "default",
			title: "Already cancelled",
			description: "This order was already cancelled; its recorded reason is shown above.",
		});
	}
	return applied({
		variant: "default",
		title: "Order cancelled",
		description: "The cancellation was recorded and the buyer has been emailed.",
	});
};

// -- refunds ------------------------------------------------------------------

/**
 * DA-3 state 1 → 2 for a refund. NOTHING is written here — and yet this handler
 * runs FIVE checks around one read, because `-review` produces the two statements
 * the whole shape exists to make true: the confirm's label and its text.
 *
 * | Check | Rule | Refusal names |
 * |---|---|---|
 * | the payload decodes: watermark AND currency both present | DA-3b | the payload, NOT the amount |
 * | parses to a positive integer of minor units | M-3 | what was typed |
 * | required attribution present | DA-3c | the missing field |
 * | the ledger has not moved since state 1 | DA-3a | both figures AND the cause |
 * | `amountCents <= remainingRefundableCents` **live** | DA-3c | the real ceiling |
 *
 * THE FIRST ROW IS ITS OWN BRANCH, and folding it into the second is a real defect.
 * `refundedSoFar` and `currency` come off the PAYLOAD's carrier half; `amount` comes
 * off the operator's keyboard. Fold them together and a missing watermark answers
 * `5.00` with *"Enter a valid refund amount greater than zero (e.g. 19.99)"* over a
 * field reading `5.00` — the console naming a cause that is demonstrably not the
 * cause and sending the operator to re-type the one thing that was already right. A
 * missing watermark is an unreadable payload ({@link readWatermark}), so it gets
 * {@link UNREADABLE}, exactly as {@link refundOrder} gives it. It is checked FIRST
 * because a broken payload is not fixable by re-typing: no amount the operator
 * enters can make it decode, so no refusal that points at the amount field is
 * honest.
 *
 * WHY IT RE-READS THE LEDGER, given the payload already holds a watermark. Two
 * defects, one read:
 *
 *  1. **DA-3c wants the LIVE ceiling.** The payload holds `refundedSoFar`, not the
 *     remaining balance, and even a carried remaining would be the figure the
 *     operator SAW rather than the one the write will be judged against.
 *  2. **State 2 must not exist once the ledger has moved.** Everything else state 2
 *     shows is rebuilt from the FRESH read, while the confirm alone carries the
 *     state-1 watermark (correctly: re-stamping it fresh while leaving `amountCents`
 *     alone would assert a decision the operator never made). So a moved ledger
 *     produces a coherent current panel beside a control that CANNOT succeed, with
 *     nothing saying why. Refusing here is what removes that state from existence.
 *
 * THE ORDER MATTERS. The watermark comparison runs BEFORE the bound check, so the
 * bound check is always against a ceiling the operator has now been shown — and the
 * movement refusal, whose copy already names the new remaining balance, wins when
 * both would fire.
 *
 * EVERY REFUSAL CARRIES A DRAFT WITH THE RAW AMOUNT STRING — including the
 * unreadable-payload one, where nothing was written and the operator's typing is
 * still in hand. The parse check refuses precisely when the amount did NOT parse, so
 * there is no `amountCents` on that path and `19,99` cannot be re-derived from
 * cents: `amountInput` is the only thing that can put it back.
 */
const refundReviewAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const currency = (readString(payload["currency"]) ?? "").trim();
	const observedSoFar = parseCents(payload["refundedSoFar"]);
	const amountStr = (readString(payload["amount"]) ?? "").trim();
	const reason = (readString(payload["reason"]) ?? "").trim();
	const refundedBy = (readString(payload["refundedBy"]) ?? "").trim();
	// The operator's input, VERBATIM, ready for any refusal below.
	const draft = (): OrdersDraft => ({
		kind: "refund-draft",
		amountInput: amountStr,
		reason,
		refundedBy,
	});
	// DA-3b, BEFORE anything about the amount: these two come off the payload's
	// carrier half, not the operator's keyboard, so their absence is an unreadable
	// payload (`readWatermark`) and no refusal naming the amount field could be true.
	// Blaming the amount here told the operator to fix a field that already held
	// `5.00`.
	if (observedSoFar === null || currency.length === 0) {
		return refused(UNREADABLE, draft());
	}
	// Money parsed to integer MINOR UNITS with exact integer string math (no
	// float). `allowZero:false` — a refund of nothing is meaningless.
	const amountCents = parseMinorUnitsInput(amountStr, { allowZero: false });
	if (amountCents === null) {
		return refused(
			{
				variant: "error",
				title: "Not refunded",
				description: REFUND_AMOUNT_INVALID,
			},
			draft(),
		);
	}
	if (refundedBy.length === 0) {
		return refused(
			{
				variant: "error",
				title: "Not refunded",
				description: REFUND_BY_REQUIRED,
			},
			draft(),
		);
	}
	const live = await client.getRefunds(orderId).catch(() => null);
	if (live === null) {
		return refused(
			{
				variant: "error",
				title: "Could not check the refund ledger",
				description:
					"The refund ledger could not be re-read, so nothing was staged and nothing was changed. Reload and try again.",
			},
			draft(),
		);
	}
	const liveCur = live.currency.length > 0 ? live.currency : currency;
	// DA-3a at the REVIEW step: the ledger moved between state 1 and this submit,
	// so state 2 would draw a confirm the write will refuse.
	if (live.refundedTotalCents !== observedSoFar) {
		return refused(staleLedgerNotice(amountCents, live, liveCur), draft());
	}
	// DA-3c: the bound check, against a ceiling just confirmed current. Without
	// it, `900.00` on a $50 order stages a red `Refund $900.00` and a dialog reading
	// "Refund $900.00 to …?" — both false at the exact moment they are shown, on the
	// one step that exists to let an operator check exactly that.
	if (amountCents > live.remainingCents) {
		return refused(
			{
				variant: "error",
				title: REFUND_TOO_HIGH_TITLE,
				description: refundTooHighText(
					formatTotal(amountCents, liveCur),
					formatTotal(live.remainingCents, liveCur),
				),
			},
			draft(),
		);
	}
	return {
		ok: true,
		notice: null,
		staged: {
			kind: "refund-staged",
			amountCents,
			refundedSoFarCents: observedSoFar,
			currency,
			reason,
			refundedBy,
		},
	};
};

/**
 * The DA-3a stale-watermark refusal, shared by the `-review` and the confirm
 * handlers so the two cannot drift.
 *
 * THE CAUSAL CLAUSE IS NOT OPTIONAL. §8's normative example includes *"someone else
 * refunded this order"*, and an earlier version of this copy dropped it. "The ledger
 * changed" states an EFFECT and leaves the operator to guess whether they hit a bug;
 * the causal clause is the fact, it is what stops them retrying identically, and at
 * 76 characters it is nowhere near the 240 budget — so this was never length-driven.
 */
function staleLedgerNotice(
	stagedAmountCents: number,
	live: RefundsSummaryWire,
	cur: string,
): Notice {
	return {
		variant: "error",
		title: "The refund ledger changed — nothing was refunded",
		description: fit(
			`${formatTotal(stagedAmountCents, cur)} was staged and was not recorded — someone else refunded this order since you started. ${formatTotal(live.remainingCents, cur)} now remains refundable; re-enter an amount below to try again.`,
			BANNER_BUDGET,
		),
	};
}

/**
 * The money-moving confirm — DA-2b's full-remaining control and DA-3's state-2
 * confirm both land here.
 *
 * TWO RULES APPLY TOGETHER, and neither is sufficient alone:
 *  - DA-3a: RE-READ the refund ledger and refuse on a watermark mismatch, so a
 *    stale staged amount is never applied. Operator A stages $99.00; operator B
 *    refunds $99.00; A's dialog still says "Refund $99.00" — a false statement.
 *  - F-2a: derive the key from `${orderId}:${amountCents}:${refundedSoFarCents}`.
 *    The watermark makes two DELIBERATE identical refunds differ (so both apply)
 *    while a double-click of the same control dedupes.
 *
 * They compose: DA-3a rejects the stale submit before the key is ever derived,
 * which matters because `refundOrder` resolves a duplicate by KEY ALONE with no
 * amount comparison.
 */
const refundOrderAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const amountCents = parseCents(payload["amountCents"]);
	const observedSoFar = parseCents(payload["refundedSoFarCents"]);
	const currency = (readString(payload["currency"]) ?? "").trim();
	const reason = (readString(payload["reason"]) ?? "").trim();
	const refundedBy = (readString(payload["refundedBy"]) ?? "").trim();
	// The refusal draft, in RAW STRING space — the only channel that can put the
	// operator's figure back, since a `refund-draft` carries `amountInput` and
	// nothing else. Where the amount parsed, formatting it back is what the field
	// showed them.
	const draft = (amountInput: string): OrdersDraft => ({
		kind: "refund-draft",
		amountInput,
		reason,
		refundedBy,
	});
	// DA-3b. FOUR DISJUNCTS, AND ONLY ONE OF THEM LACKS AN AMOUNT. A payload can
	// carry a perfectly good `amountCents: "1000"` and still be unreadable because
	// the WATERMARK or the CURRENCY is missing — and on that arrival the operator
	// typed `10.00`, it parsed, nothing was written, and blanking the field
	// discards a figure we are holding while `reason` survives beside it. So the
	// draft is conditional on the amount, not on the branch: `$10.00` goes back,
	// and only a genuinely unparseable or non-positive amount yields `""`.
	if (amountCents === null || amountCents <= 0 || observedSoFar === null || currency.length === 0) {
		return refused(
			UNREADABLE,
			draft(amountCents !== null && amountCents > 0 ? formatMinorUnitsInput(amountCents) : ""),
		);
	}
	// DA-3a: re-read, then compare against the watermark the operator SAW.
	const live = await client.getRefunds(orderId).catch(() => null);
	if (live === null) {
		return refused(
			{
				variant: "error",
				title: "Nothing was refunded",
				description:
					"The refund ledger could not be re-checked, so nothing was applied. Reload and try again.",
			},
			draft(formatMinorUnitsInput(amountCents)),
		);
	}
	const liveCur = live.currency.length > 0 ? live.currency : currency;
	if (live.refundedTotalCents !== observedSoFar) {
		// The genuinely CONCURRENT case: the ledger moved between state 2 (or the
		// DA-2b control's render) and this click. {@link refundReviewAction} catches
		// movement one step earlier; both are required, and they catch different
		// windows.
		return refused(
			staleLedgerNotice(amountCents, live, liveCur),
			draft(formatMinorUnitsInput(amountCents)),
		);
	}
	// The observed watermark is the third key component (F-2a) — NOT a nonce.
	const key = `admin-refund:${orderId}:${amountCents}:${observedSoFar}`;
	const result = await client.refundOrder(
		orderId,
		{
			amountCents,
			currency,
			...(reason.length > 0 ? { reason } : {}),
			refundedBy: refundedBy.length > 0 ? refundedBy : "admin",
		},
		{ idempotencyKey: key },
	);
	// NO DRAFT ON THESE: the write was attempted, so every branch below is an
	// outcome to read rather than an input to correct — and on `GATEWAY_UNVERIFIED`
	// the outcome is unknown, where a form inviting a retry is the worst possible
	// affordance.
	if (!result.ok) return applied(refundFailureNotice(result.reason));
	if (result.duplicate) {
		// A benign replay: the SAME amount against the SAME watermark, i.e. a
		// double-click. A different amount would have produced a different key.
		return applied({
			variant: "default",
			title: "Already refunded",
			description:
				"This refund was already recorded (a duplicate submission); the ledger above is unchanged.",
		});
	}
	if (result.fullyRefunded) {
		return applied({
			variant: "default",
			title: "Refund complete",
			description:
				"The refund was recorded and the order is now fully refunded — the buyer has been emailed.",
		});
	}
	return applied({
		variant: "default",
		title: "Refund recorded",
		description:
			"The refund was recorded. The order stays in its current status; Money → Refunds shows what remains.",
	});
};

/** GENERIC, em-dash-correct notices for a refund failure — keyed off the service's
 *  typed reason, NEVER the raw status/URL. The ambiguous-timeout case is explicit:
 *  do NOT retry, re-check the provider first (ADR-0008 error taxonomy). */
function refundFailureNotice(reason: string | undefined): Notice {
	switch (reason) {
		case "REFUND_EXCEEDS_TOTAL":
		case "REFUND_EXCEEDS_CAPTURED":
			return {
				variant: "error",
				// The SAME title the client-side ceiling check raises — this is the
				// service saying no to the amount that check let through, and an
				// operator reading two titles for one refusal has to work out whether
				// they hit two different limits.
				title: REFUND_TOO_HIGH_TITLE,
				description:
					"That is more than the remaining refundable amount for this order. Reload to see the current remaining total.",
			};
		case "PROVIDER_ALREADY_REFUNDED":
			return {
				variant: "error",
				title: "Provider already refunded",
				description:
					"Your payment provider shows this order already refunded (possibly from its dashboard). Nothing was issued — reconcile the provider before trying again.",
			};
		case "GATEWAY_RETRYABLE":
			return {
				variant: "error",
				title: "Temporary problem",
				description:
					"The payment provider could not be reached. Nothing was refunded — try again in a moment.",
			};
		case "GATEWAY_TERMINAL":
			return {
				variant: "error",
				title: "Refund rejected",
				description:
					"The payment provider rejected this refund. Check the order in your provider dashboard.",
			};
		case "GATEWAY_UNVERIFIED":
			return {
				variant: "error",
				title: "Refund status unknown",
				description:
					"The refund request timed out and its outcome is unknown. Do NOT retry — check your provider dashboard first, then reconcile.",
			};
		case "CURRENCY_MISMATCH":
			return {
				variant: "error",
				title: "Not refunded",
				description: "The refund currency does not match the order. Reload and try again.",
			};
		default:
			return {
				variant: "error",
				title: "Not refunded",
				description:
					"That refund could not be processed — check the order and the admin token in Settings.",
			};
	}
}

// -- dispatch -----------------------------------------------------------------

/**
 * Every Orders write, keyed by the action id that names it.
 *
 * The per-state and per-reason entries are DERIVED from {@link ORDER_STATES} and
 * {@link CANCELLATION_REASONS} rather than hand-listed (DA-6), so a surface can
 * never offer a control for an id this table does not hold.
 */
const ORDERS_ACTIONS_BY_ID: Readonly<Record<string, OrdersAction>> = {
	[ACTION_ADD_NOTE]: addNoteAction,
	[ACTION_RESOLVE]: resolveReconciliationAction,
	[ACTION_RECORD_FULFILLMENT]: recordFulfillmentAction,
	[ACTION_CANCEL_REVIEW]: cancelReviewAction,
	[ACTION_CANCEL]: cancelOrderAction,
	[ACTION_REFUND_REVIEW]: refundReviewAction,
	[ACTION_REFUND]: refundOrderAction,
	// One handler per state, keyed by the SAME derived id the control uses.
	...Object.fromEntries(
		ORDER_STATES.map((state) => [
			ORDERS_ACTIONS.custom(transitionVerb(state)),
			transitionAction(state),
		]),
	),
	// Likewise one per cancellation reason (DA-2b).
	...Object.fromEntries(
		CANCELLATION_REASONS.map((r) => [
			ORDERS_ACTIONS.custom(cancelReasonVerb(r.value)),
			cancelOrderAction,
		]),
	),
};

/**
 * The action ids this screen recognizes (MOD-2), read straight off the dispatch
 * table so the gate and the table cannot disagree about what exists — the
 * combination that used to blank a console.
 */
export const ORDERS_ACTION_IDS: ReadonlySet<string> = new Set(Object.keys(ORDERS_ACTIONS_BY_ID));

/**
 * Run one Orders write.
 *
 * `undefined` means the id is not one this screen offers — a stale tab after a
 * deploy that renamed one, or a caller bug. It is deliberately NOT an outcome:
 * reporting an unknown action as a quiet success is how a refund that never
 * happened gets rendered as done.
 */
export async function dispatchOrdersAction(
	actionId: string,
	payload: OrdersActionPayload,
	client: AdminOrdersClient,
): Promise<OrdersActionResult | undefined> {
	const action = ORDERS_ACTIONS_BY_ID[actionId];
	if (action === undefined) return undefined;
	return await action(client, payload);
}
