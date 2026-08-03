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
 * re-expressed as a function returning an {@link OrdersActionResult}: the
 * applied/refused flag and the notice. No page handler, no synthesized
 * interaction, no notice-scraping.
 *
 * THE STALE-WATERMARK REFUSAL IS CARRIED VERBATIM (ADR-0015 Decision 3, as
 * amended). A reworded check is a failed port, not a port. **DA-3a:** the
 * watermark the operator SAW — `refundedSoFarCents` on the money path, the order
 * `state` on every other — is re-read against live truth and the write REFUSES on
 * a mismatch. Every site holding a watermark also refuses an ABSENT one, with no
 * re-read and no exemption: see {@link readWatermark}.
 *
 * MONEY IS INTEGER MINOR UNITS. Nothing here parses money with a float:
 * {@link parseCents} reads an untrusted payload's integer minor-units string, and
 * rejects anything that is not a plain non-negative integer.
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
 * THE `-review` PAIR IS GONE, DELETED AS UNREACHED SURFACE. `orders:refund-review`
 * and `orders:cancel-review` — with the staged/draft state that existed only for
 * them — were carried across by the extraction and then found to have NO CALLER:
 * the React order detail stages its own confirm client-side and posts
 * `orders:refund` / `orders:cancel` / `orders:cancel-<reason>` directly. Its
 * per-reason controls deliberately omit `other` (the note form's reason picker is
 * the only path that records a detail), so `orders:cancel-other` had no control
 * that could send it either, and it is not derived. See ADR-0015's amendment.
 *
 * WHAT WENT WITH THEM, STATED PLAINLY rather than left for a reader to discover.
 * Two checks lived ONLY on `refund-review`, so neither ever ran for any surface:
 * the **DA-3c live-ceiling bound check**, and the **unparseable-amount refusal**
 * whose draft carried the operator's raw text verbatim. The reachable confirm
 * ({@link refundOrderAction}) is not unguarded: it re-reads the ledger and refuses
 * on a watermark mismatch (DA-3a), and an over-ceiling amount that survives that is
 * refused by the SERVICE as `REFUND_EXCEEDS_TOTAL` / `REFUND_EXCEEDS_CAPTURED`,
 * which {@link refundFailureNotice} renders. Re-introducing a server-side two-step
 * confirm means WRITING these checks against the shape of that new flow — not
 * restoring them, because there is nothing left to restore.
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
	REFUND_TOO_HIGH_TITLE,
	fit,
	formatAmount as formatTotal,
} from "@otta-sh/admin-presentation";
import { AdminOrdersClient, type RefundsSummaryWire } from "./admin-orders-client.js";
import { readString, screenActions, startOfDay, type Notice } from "./scaffold/index.js";
import type { SelectOption } from "../types.js";

/** This screen's namespaced action ids. */
const ORDERS_ACTIONS = screenActions("orders");
const ACTION_ADD_NOTE = ORDERS_ACTIONS.custom("add-note");
const ACTION_RESOLVE = ORDERS_ACTIONS.custom("resolve-reconciliation");
const ACTION_RECORD_FULFILLMENT = ORDERS_ACTIONS.custom("record-fulfillment");
/** The cancellation the surface confirms for itself, carrying a reason and an
 *  optional free-text detail. DA-2b's per-reason verbs have their own ids so a
 *  surface can offer one control per reason. */
const ACTION_CANCEL = ORDERS_ACTIONS.custom("cancel");
/** Both the DA-2b full-remaining refund and the partial refund the surface
 *  confirms for itself. */
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
 * The reasons that get a ONE-CLICK control of their own, and therefore an action
 * id of their own (DA-2b). `other` is deliberately not among them: a one-click
 * "Other" fires immediately and records no detail, so the cancel-with-a-note form
 * — which posts {@link ACTION_CANCEL} with the reason in its payload — is the only
 * path that offers it. Deriving `orders:cancel-other` anyway would register an id
 * no control can send, which is MOD-2 run backwards.
 *
 * THIS LIST IS SHIPPED TO THE CONSOLE, not re-derived there. The exclusion and the
 * dispatch table below are two halves of one rule — a surface that offers `other`
 * as a one-click control now posts an id that does not exist and is refused as
 * unregistered. One source, sent down the wire (DA-6), is the only way the two
 * halves cannot drift apart across the process boundary.
 */
export const ONE_CLICK_CANCEL_REASONS: readonly SelectOption[] = CANCELLATION_REASONS.filter(
	(r) => r.value !== "other",
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
 * What a write returns instead of a block tree.
 *
 * `ok: true` means the request was UNDERSTOOD and dispatched, not that anything
 * was written — a refusal is a `notice` with `variant: "error"`, which is the
 * shape the operator reads either way. `notice: null` is the quiet success the
 * Block Kit screen expressed as "re-render with no banner".
 *
 * THERE IS NO STAGED OR DRAFT MEMBER. Both existed for the deleted `-review` pair:
 * a staged outcome carried the parsed input plus the watermark the operator saw
 * into a server-rendered state 2, and a draft carried their raw text back into a
 * server-rendered refusal. A surface that composes its own confirm holds the
 * operator's input the whole time and never needs either handed back. Adding one
 * again belongs with the flow that would need it.
 */
export interface OrdersActionResult {
	readonly ok: true;
	readonly notice: Notice | null;
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
 * transitions and {@link cancelOrderAction} through this helper, and
 * {@link refundOrderAction} through {@link parseCents} — the refund watermark is a
 * MINOR-UNITS LEDGER TOTAL rather than a state name, so it cannot route through
 * here, but `observedSoFar === null` is the same check and gets the same answer.
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

/** The one outcome constructor. A refusal is an `error`-variant notice, not a
 *  different shape — see {@link OrdersActionResult}. */
const applied = (notice: Notice | null): OrdersActionResult => ({ ok: true, notice });

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
 * Shared by DA-2b's four per-reason controls AND the cancel-with-a-note write —
 * one handler, because both carry the same `{orderId, reason, state}` (the note
 * one adds `detail`). `other` reaches this handler only through the note form,
 * which is why it has no per-reason id of its own
 * ({@link ONE_CLICK_CANCEL_REASONS}).
 *
 * DA-3a, MANDATORY: re-read the order and refuse on a watermark mismatch. The
 * `state` in the payload is what the operator saw; if the order moved under them,
 * apply NOTHING and name both states.
 *
 * NO REFUSAL HERE HANDS ANYTHING BACK, because there is nowhere to hand it: the
 * surface composed its own confirm and still holds every value the operator typed
 * (see {@link OrdersActionResult}). What each refusal owes them is a notice that
 * names WHAT happened and WHY, which is what every branch below returns.
 */
const cancelOrderAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const reason = readString(payload["reason"]) ?? "";
	const detail = (readString(payload["detail"]) ?? "").trim();
	const cancelledBy = (readString(payload["cancelledBy"]) ?? "").trim();
	const observedState = readWatermark(payload["state"]);
	// Every decoded value is UNTRUSTED operator-round-tripped input (B-1), so the
	// closed set and the watermark's PRESENCE are both re-checked here.
	if (!CANCEL_REASON_LABELS.has(reason) || observedState === undefined) {
		return applied(UNREADABLE);
	}
	// DA-3a: re-read before writing.
	const live = await client.getOrder(orderId).catch(() => null);
	if (live === null) {
		return applied({
			variant: "error",
			title: "Nothing was cancelled",
			description:
				"This order could not be re-checked before cancelling, so nothing was applied. Reload and try again.",
		});
	}
	if (live.order.state !== observedState) {
		return applied({
			variant: "error",
			title: "The order changed — nothing was cancelled",
			description: `It was ${observedState} when you started and is now ${live.order.state} — someone else moved it since you started. Check the order below, then cancel again if you still want to.`,
		});
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
	// The write was ATTEMPTED past this point, so every branch below is an outcome
	// to read rather than an input to correct — `NOT_CANCELLABLE` above all, which
	// means the order cannot be cancelled at all now.
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
 * The DA-3a stale-watermark refusal. It is a named function rather than an inline
 * literal because its wording is the whole point of it, and a wording argued out
 * once should have one place to be wrong.
 *
 * THE CAUSAL CLAUSE IS NOT OPTIONAL. §8's normative example includes *"someone else
 * refunded this order"*, and an earlier version of this copy dropped it. "The ledger
 * changed" states an EFFECT and leaves the operator to guess whether they hit a bug;
 * the causal clause is the fact, it is what stops them retrying identically, and at
 * 76 characters it is nowhere near the 240 budget — so this was never length-driven.
 */
function staleLedgerNotice(
	submittedAmountCents: number,
	live: RefundsSummaryWire,
	cur: string,
): Notice {
	return {
		variant: "error",
		title: "The refund ledger changed — nothing was refunded",
		description: fit(
			`${formatTotal(submittedAmountCents, cur)} was staged and was not recorded — someone else refunded this order since you started. ${formatTotal(live.remainingCents, cur)} now remains refundable; re-enter an amount below to try again.`,
			BANNER_BUDGET,
		),
	};
}

/**
 * The money-moving write — DA-2b's full-remaining control and the partial refund
 * the surface confirmed for itself both land here. It is the ONLY refund handler:
 * the `-review` step that used to precede it is deleted, so every guard a refund
 * gets is in this function or in the service behind it.
 *
 * TWO RULES APPLY TOGETHER, and neither is sufficient alone:
 *  - DA-3a: RE-READ the refund ledger and refuse on a watermark mismatch, so a
 *    stale amount is never applied. Operator A opens a confirm for $99.00;
 *    operator B refunds $99.00; A's dialog still says "Refund $99.00" — a false
 *    statement.
 *  - F-2a: derive the key from `${orderId}:${amountCents}:${refundedSoFarCents}`.
 *    The watermark makes two DELIBERATE identical refunds differ (so both apply)
 *    while a double-click of the same control dedupes.
 *
 * They compose: DA-3a rejects the stale submit before the key is ever derived,
 * which matters because `refundOrder` resolves a duplicate by KEY ALONE with no
 * amount comparison.
 *
 * THERE IS NO CLIENT-SIDE CEILING CHECK HERE, and that is a deliberate, recorded
 * gap rather than an omission: the live-ceiling bound check lived only on the
 * deleted `-review` step. An over-ceiling amount that clears the watermark compare
 * is refused by the SERVICE as `REFUND_EXCEEDS_TOTAL` / `REFUND_EXCEEDS_CAPTURED`
 * and rendered by {@link refundFailureNotice}. See ADR-0015's amendment.
 *
 * NOR IS THERE A `Refunded by` GUARD, for the same reason: the `REFUND_BY_REQUIRED`
 * refusal also lived only on that step. A blank one is recorded as `admin` below.
 * Attribution is therefore enforced by the surface alone — recorded, with its known
 * gap, in the same amendment.
 */
const refundOrderAction: OrdersAction = async (client, payload) => {
	const orderId = readString(payload["orderId"]);
	if (orderId === undefined) return applied(UNREADABLE);
	const amountCents = parseCents(payload["amountCents"]);
	const observedSoFar = parseCents(payload["refundedSoFarCents"]);
	const currency = (readString(payload["currency"]) ?? "").trim();
	const reason = (readString(payload["reason"]) ?? "").trim();
	const refundedBy = (readString(payload["refundedBy"]) ?? "").trim();
	// DA-3b. FOUR DISJUNCTS, AND THEY ARE ONE BRANCH ON PURPOSE. A payload can carry
	// a perfectly good `amountCents: "1000"` and still be unreadable because the
	// WATERMARK or the CURRENCY is missing — but none of the four is fixable by
	// re-typing the amount, so all four get the same payload-level refusal rather
	// than one that points at a field. M-3/B-2 rides here too: `amountCents` must be
	// a plain integer minor-units string, so no float is ever laundered into cents.
	if (amountCents === null || amountCents <= 0 || observedSoFar === null || currency.length === 0) {
		return applied(UNREADABLE);
	}
	// DA-3a: re-read, then compare against the watermark the operator SAW.
	const live = await client.getRefunds(orderId).catch(() => null);
	if (live === null) {
		return applied({
			variant: "error",
			title: "Nothing was refunded",
			description:
				"The refund ledger could not be re-checked, so nothing was applied. Reload and try again.",
		});
	}
	const liveCur = live.currency.length > 0 ? live.currency : currency;
	if (live.refundedTotalCents !== observedSoFar) {
		// The genuinely CONCURRENT case: the ledger moved between the confirm being
		// drawn and this click. This is the ONLY window now checked server-side, and
		// the surface's own pre-dialog validation cannot see it.
		return applied(staleLedgerNotice(amountCents, live, liveCur));
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
	// The write was ATTEMPTED past this point, so every branch below is an outcome
	// to read rather than an input to correct — and on `GATEWAY_UNVERIFIED` the
	// outcome is UNKNOWN, which is why its copy says not to retry.
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
 * {@link ONE_CLICK_CANCEL_REASONS} rather than hand-listed (DA-6), so a surface
 * can never offer a control for an id this table does not hold. The rule runs the
 * other way too: an id here that NO control can send is dead surface, which is why
 * `orders:cancel-other` is not derived and why the `-review` pair is gone.
 */
const ORDERS_ACTIONS_BY_ID: Readonly<Record<string, OrdersAction>> = {
	[ACTION_ADD_NOTE]: addNoteAction,
	[ACTION_RESOLVE]: resolveReconciliationAction,
	[ACTION_RECORD_FULFILLMENT]: recordFulfillmentAction,
	[ACTION_CANCEL]: cancelOrderAction,
	[ACTION_REFUND]: refundOrderAction,
	// One handler per state, keyed by the SAME derived id the control uses.
	...Object.fromEntries(
		ORDER_STATES.map((state) => [
			ORDERS_ACTIONS.custom(transitionVerb(state)),
			transitionAction(state),
		]),
	),
	// Likewise one per ONE-CLICK cancellation reason (DA-2b).
	...Object.fromEntries(
		ONE_CLICK_CANCEL_REASONS.map((r) => [
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
