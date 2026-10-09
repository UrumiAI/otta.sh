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
	refundIncrementText,
} from "@otta-sh/admin-presentation";
import type {
	AdminOrdersSurface,
	InlineEmailStatus,
	RefundsSummaryWire,
	ResolveFollowUpWire,
	TransitionRefusal,
} from "./admin-orders-surface.js";
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
/** A person's answer to a refund whose provider outcome is unknown (review round 2). */
const ACTION_RESOLVE_REFUND_CONFIRMED = ORDERS_ACTIONS.custom("resolve-refund-confirmed");
const ACTION_RESOLVE_REFUND_VOIDED = ORDERS_ACTIONS.custom("resolve-refund-voided");

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

/** `operator`: the signed-in admin the host named on the route (`routeCtx.user`,
 *  via `operatorName`) — who a write records as having made it when the form named
 *  nobody. Absent when the host named nobody. */
type OrdersAction = (
	client: AdminOrdersSurface,
	payload: OrdersActionPayload,
	operator?: string,
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

/** A paid order's cancel that carries no Return-to-stock choice: a tab opened
 *  before the box existed (issue #364). Refused, never guessed. */
const STALE_CANCEL_PAGE: Notice = {
	variant: "error",
	title: "Nothing was cancelled — this page is out of date",
	description:
		"This page was opened before the Return to stock choice was added, so it can’t say whether the items should go back on sale. Nothing was refunded or restocked. Reload the order and cancel again.",
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

/**
 * What became of the buyer's email, as a sentence led by a space (QA T1-6). Every
 * write that enqueues one now sends it inline and reports the result, so this says
 * "emailed" only when it went out — never on the strength of a queued row.
 * `undefined` (the write enqueued none) says nothing.
 */
function emailSentence(email: InlineEmailStatus | undefined): string {
	switch (email) {
		case "sent":
			return " The buyer has been emailed.";
		case "queued":
			// No time promise: the cron's retry can be backed off after a failure.
			return " The buyer’s email is queued and will be retried automatically.";
		case "unconfigured":
			return " No email was sent — this store has no email provider set up.";
		case "no-recipient":
			// A buyerRef that is not an email address (a hand-seeded or legacy buyerRef without `@`) — and nothing queued.
			return " No email was sent — this order has no email address.";
		default:
			return "";
	}
}

// -- transitions --------------------------------------------------------------

/**
 * A manual mark-paid (QA T1-3). Otta marks an order paid only when its payment
 * provider confirms the charge; a person marking it paid would tell the buyer their
 * payment arrived and count revenue nobody captured. No payment method is declared
 * offline today, so this is every manual mark-paid — including an order with no
 * method on file, which nothing will ever settle (so no "it becomes paid by itself").
 */
const PAID_BY_PROVIDER_ONLY: Notice = {
	variant: "error",
	title: "Only the payment provider can mark this order paid",
	description:
		"Nothing was changed. Otta marks an order paid only when its payment provider confirms the charge. Otta can’t record a payment taken outside it yet.",
};

/**
 * A bare `cancelled` move (QA T1-4), from any state — keyed on the state the
 * operator SAW. It records no reason and releases no stock hold, so Cancel order is
 * the one way to cancel. An unpaid order's advice is about its held stock. A paid
 * order's says what Cancel order does with the money and the stock: it refunds what
 * the buyer paid and restocks unless the operator unticks it
 * (`cancelOrderWithRefund`, ADR-0026's cancel-with-refund amendment).
 */
function useCancelOrder(observedState: string): Notice {
	return {
		variant: "error",
		title: "Use Cancel order to cancel an order",
		description:
			observedState === "pending"
				? "Nothing was changed. Cancel an order with Cancel order below, which records why and returns its held stock."
				: "Nothing was changed. Cancel an order with Cancel order below, which records why, refunds what the buyer paid and returns the items to stock unless you untick it.",
	};
}

/**
 * Mark refunded on an order whose captured money the ledger has not returned (QA2
 * M4, ADR-0026 amended 2026-10-03). Marking it would close the order and tell the
 * buyer's page "refunded" while the shop still held the money. The way is Money →
 * Refunds; a refund already made in the provider's dashboard is found there too —
 * its check against the provider then lets Mark refunded close the order.
 */
const REFUND_THROUGH_MONEY: Notice = {
	variant: "error",
	title: "Refund it in Money → Refunds",
	description:
		"Nothing was changed. This order still has captured money that Otta hasn’t refunded, so marking it refunded would tell the buyer it was. Refund it in Money → Refunds — that returns the money and emails the buyer. If you already refunded it in your payment provider’s dashboard, start the refund in Money → Refunds anyway: Otta checks with the provider first, issues nothing, and then lets you mark the order refunded.",
};

/** Mark refunded while a refund is reserved or unverified (review round 1): its
 *  outcome decides whether money is still held — the cancel path's rule. */
const REFUND_IN_FLIGHT: Notice = {
	variant: "error",
	title: "Not marked refunded — a refund is unresolved",
	description:
		"Nothing was changed. A refund on this order is still unresolved — check Money → Refunds first, and your payment provider, before marking the order refunded.",
};

/** The generic refusal: the move is not in the state machine, or the order vanished. */
const STATUS_CHANGE_FAILED: Notice = {
	variant: "error",
	title: "Status change failed",
	description:
		"That status change could not be applied — check the order state, then retry in a moment.",
};

/**
 * Every refusal mapped to its notice — EXHAUSTIVELY: a refusal added to
 * `TransitionRefusal` without copy is a compile error here, never a silent fall
 * into the generic notice. `undefined` (a refused input with no domain reason) is
 * the generic one.
 */
function transitionRefusalNotice(
	reason: TransitionRefusal | undefined,
	observedState: string,
): Notice {
	if (reason === undefined) return STATUS_CHANGE_FAILED;
	switch (reason) {
		// Neither button is offered for such an order, so these two are hand-made or
		// stale payloads. Say WHY, because the operator's next step is not "retry".
		case "MANUAL_PAYMENT_NOT_ALLOWED":
			return PAID_BY_PROVIDER_ONLY; // T1-3
		case "USE_CANCEL":
			return useCancelOrder(observedState); // T1-4
		case "REFUND_THROUGH_MONEY":
			return REFUND_THROUGH_MONEY; // QA2 M4
		case "REFUND_IN_FLIGHT":
			return REFUND_IN_FLIGHT;
		case "ORDER_NOT_FOUND":
		case "INVALID_TRANSITION":
			return STATUS_CHANGE_FAILED;
		default:
			return assertNever(reason);
	}
}

function assertNever(value: never): never {
	throw new Error(`unhandled transition refusal: ${String(value)}`);
}

/** A Mark refunded that applied (ADR-0026 Decision 3): bookkeeping for a refund
 *  made outside Otta — it says so, because nothing else on the screen will. */
const MARKED_REFUNDED: Notice = {
	variant: "default",
	title: "Marked refunded",
	description: "No money moved and the buyer was not emailed.",
};

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
	return async (client, payload, operator) => {
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
		// Who made the move — the signed-in operator the host named — for History,
		// which showed "—" for every hand-made status move (QA2).
		const result = await client.transitionOrder(orderId, toState, {
			idempotencyKey: key,
			...(operator !== undefined ? { actor: operator } : {}),
		});
		if (!result.ok) return applied(transitionRefusalNotice(result.reason, observedState));
		if (!result.transitioned) {
			// The guarded flip matched 0 rows — already in that state, or a lost race.
			// Not a failure: surface a non-error notice rather than a silent success.
			return applied({
				variant: "default",
				title: "No change",
				description: "The order is already in that state.",
			});
		}
		// Mark refunded emails nobody, and says so (A's notice, ADR-0026 Decision 3);
		// every other applied move says what became of the buyer's email (T1-6).
		if (toState === "refunded" && result.email === undefined) return applied(MARKED_REFUNDED);
		const email = emailSentence(result.email).trim();
		return applied(
			email.length === 0
				? null
				: { variant: "default", title: `Order marked ${toState}`, description: email },
		);
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
			description: "That note could not be saved — check the order, then retry in a moment.",
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
							"That reconciliation could not be resolved — check the order, then retry in a moment.",
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
							"That fulfilment could not be recorded — check the order, then retry in a moment.",
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
		description:
			result.email === "sent"
				? "Fulfilment recorded. The buyer has been emailed their tracking."
				: `Fulfilment recorded.${emailSentence(result.email)}`,
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
const cancelOrderAction: OrdersAction = async (client, payload, operator) => {
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
	// "Return the items to stock" — the operator's explicit choice, sent with every
	// cancel of a paid order. A PENDING order's cancel releases its held stock
	// whatever the box says, so the page sends none. On any other order an ABSENT
	// (or unreadable) value is not defaulted either way (issue #364): it comes from
	// a tab rendered before the box existed, whose operator was never asked, and
	// both guesses are wrong for someone (restocking damaged goods, or keeping
	// returned ones off sale). Refuse it and ask for a reload.
	const restockField = readString(payload["restock"]);
	if (observedState !== "pending" && restockField !== "true" && restockField !== "false") {
		return applied(STALE_CANCEL_PAGE);
	}
	const restock = restockField !== "false";
	// The key is the CANCELLATION's, and the refund and restock legs derive theirs
	// from it (`<key>:refund`, `<key>:restock:<line>`), so a double-click or a retry
	// after a failure replays one cancellation rather than refunding twice.
	const key = `admin-cancel:${orderId}`;
	const result = await client.cancelOrder(
		orderId,
		{
			reason,
			...(detail.length > 0 ? { detail } : {}),
			// The typed name, else the signed-in operator (QA2: a cancel's refund was
			// recorded BY "admin"), else "admin".
			cancelledBy: cancelledBy.length > 0 ? cancelledBy : (operator ?? "admin"),
			restock,
		},
		{ idempotencyKey: key },
	);
	// The write was ATTEMPTED past this point, so every branch below is an outcome
	// to read rather than an input to correct — `NOT_CANCELLABLE` above all, which
	// means the order cannot be cancelled at all now.
	if (!result.ok && result.reason === "CANCEL_LOST_AFTER_REFUND") {
		return applied(
			cancelLostNotice(
				result.refund ?? null,
				result.restockedUnits ?? 0,
				result.movedTo ?? null,
				result.email,
			),
		);
	}
	if (!result.ok && result.reason === "CANCEL_INCOMPLETE_AFTER_REFUND" && result.refund) {
		return applied(cancelIncompleteNotice(result.refund, result.retryable === true));
	}
	if (!result.ok) return applied(cancelFailureNotice(result.reason, result.refundFailure));
	if (!result.cancelled) {
		return applied({
			variant: "default",
			title: "Already cancelled",
			description: "This order was already cancelled; its recorded reason is shown above.",
		});
	}
	const refund = result.refund ?? null;
	// The email sentence comes BEFORE the not-restocked list, and the list is capped,
	// so fitting the banner can only ever trim SKUs — never what became of the email.
	const head =
		(refund !== null
			? `Refunded ${formatTotal(refund.amountCents, refund.currency)} to the buyer’s original payment method.`
			: "The cancellation was recorded.") +
		restockSentence(restock, result.restockedUnits ?? 0, result.restockPending === true) +
		emailSentence(result.email);
	const description =
		head + skippedSentence(result.restockSkipped ?? [], BANNER_BUDGET - head.length);
	return applied({
		variant: "default",
		title: refund !== null ? "Order cancelled and refunded" : "Order cancelled",
		description: fit(description, BANNER_BUDGET),
	});
};

/** What a cancellation did with the order's units, as a sentence led by a space —
 *  or nothing, when it had none to return (an unpaid or digital-only order). A
 *  restock still pending after the flip (issue #364) says so: the units are not
 *  back, and the sweep returns them. */
function restockSentence(restock: boolean, units: number, pending: boolean): string {
	if (pending) {
		// Part-way: the lines before the failure ARE back. Say how many, not "none".
		if (units > 0) {
			return ` ${units === 1 ? "1 item" : `${String(units)} items`} returned to stock so far; the rest are not back yet and Otta will return them automatically.`;
		}
		return " The items are not back in stock yet; Otta will return them automatically.";
	}
	// The units the cancellation REPORTS, not the checkbox: a retry keeps the first
	// attempt's restock choice (ADR-0026), so units may be back although the box was
	// unticked on the retry.
	if (units > 0) {
		return units === 1
			? " 1 item returned to stock."
			: ` ${String(units)} items returned to stock.`;
	}
	return restock ? "" : " Nothing was returned to stock.";
}

/** Lines the restock could not return, as a sentence led by a space — so the
 *  operator knows which stock to check by hand. Empty when every line went back. */
function skippedSentence(
	skipped: ReadonlyArray<{ sku: string; quantity: number }>,
	room: number,
): string {
	if (skipped.length === 0) return "";
	// As many lines as fit in `room`, then "and N more" — capped so the notice's
	// earlier sentences (the email status above all) are never what gets cut.
	const sentence = (shown: number): string => {
		const more = skipped.length - shown;
		const lines = skipped
			.slice(0, shown)
			.map((s) => `${s.sku} ×${String(s.quantity)}`)
			.join(", ");
		const tail = more > 0 ? `${shown > 0 ? " and " : ""}${String(more)} more` : "";
		return ` Not returned to stock (check by hand): ${lines}${tail}.`;
	};
	let shown = skipped.length;
	while (shown > 0 && sentence(shown).length > room) shown--;
	return sentence(shown);
}

/** The lost race's own refund email (a `refund-issued` notice, sent inline): whether
 *  the buyer heard about their money. Nothing when no refund was made. */
function lostEmailSentence(email: InlineEmailStatus | undefined): string {
	switch (email) {
		case "sent":
			return " Buyer emailed about the refund.";
		case "queued":
			return " Refund email queued; retried automatically.";
		case "unconfigured":
			return " No email sent: no email provider set up.";
		case "no-recipient":
			return " No email sent: the order has no email address.";
		default:
			return "";
	}
}

/**
 * The refund went through, then closing a commit bracket or the cancel flip FAILED. The order is
 * still paid and flagged; clicking Cancel order again finishes it, and its refund
 * replays under its key rather than repeating.
 */
function cancelIncompleteNotice(
	refund: { amountCents: number; currency: string },
	busy: boolean,
): Notice {
	const money = formatTotal(refund.amountCents, refund.currency);
	return {
		variant: "error",
		title: "Refunded, but the cancel didn’t finish",
		description: busy
			? `Refunded ${money}; the store was busy — click Cancel order again (it will not refund twice).`
			: `Refunded ${money}, but the cancel didn’t finish — click Cancel order again (it will not refund twice).`,
	};
}

/**
 * The cancel outcome where money MOVED but the order did not close: it left every
 * cancellable state (`movedTo`, usually shipped) between the refund and the cancel.
 * The order is flagged; this says what moved, where the order went, and what to do.
 */
function cancelLostNotice(
	refund: { amountCents: number; currency: string } | null,
	restockedUnits: number,
	movedTo: string | null,
	email: InlineEmailStatus | undefined,
): Notice {
	// Terse on purpose: what moved, where the order went, the WARNING, then the email
	// status — in that order and short enough that fitting the banner never cuts the
	// warning (it is the operator's next step).
	const money =
		refund === null
			? `The order moved to ${movedTo ?? "another state"} first and was not cancelled;`
			: `Refunded ${formatTotal(refund.amountCents, refund.currency)}, but the order moved to ${movedTo ?? "another state"} first and was not cancelled;`;
	const stock =
		restockedUnits === 0
			? " nothing restocked."
			: ` ${String(restockedUnits)} item${restockedUnits === 1 ? "" : "s"} restocked.`;
	return {
		variant: "error",
		// The title says what DID move: a refund, else a restock, else nothing.
		title:
			refund !== null
				? "Refunded, but the order was not cancelled"
				: restockedUnits > 0
					? "Restocked, but the order was not cancelled"
					: "Not cancelled — the order moved first",
		description: fit(
			`${money}${stock} Flagged — contact the buyer; don’t ship or refund it again unchecked.${lostEmailSentence(email)}`,
			BANNER_BUDGET,
		),
	};
}

/**
 * A refused cancellation, keyed off the typed reason (and, for a failed refund, the
 * refund leg's own). Every one of them says what the ORDER is now, because the rule
 * (QA T1-4) is that a cancel whose refund did not happen changes nothing — the copy
 * must never leave the operator believing the buyer was refunded or the order closed.
 */
function cancelFailureNotice(
	reason: string | undefined,
	refundFailure: string | undefined,
): Notice {
	switch (reason) {
		case "NOT_CANCELLABLE":
			return {
				variant: "error",
				title: "Order can’t be cancelled right now",
				description:
					"This order can no longer be cancelled — it may have shipped, or been cancelled without a reason on file. Reload and check its status.",
			};
		case "REFUND_NOT_AUTOMATIC":
			return {
				variant: "error",
				title: "Not cancelled — the refund can’t be issued from here",
				description:
					"Nothing was changed. Otta can’t return this order’s payment automatically. Send the buyer their money yourself and record it as a manual refund in Money → Refunds — a full refund closes the order as refunded, so restock the items by hand if they came back.",
			};
		case "MULTIPLE_CAPTURES":
			return {
				variant: "error",
				title: "Not cancelled — paid in more than one payment",
				description:
					"Nothing was changed. This order was paid in more than one payment, and Otta can’t refund them in one step yet. Refund each payment in your provider’s dashboard, then use Mark refunded.",
			};
		case "REFUND_IN_FLIGHT":
			return {
				variant: "error",
				title: "Not cancelled — another refund is unresolved",
				description:
					"Nothing was changed. A refund on this order is still pending or its outcome is unknown. Check Money → Refunds and your payment provider, then cancel again.",
			};
		case "REFUND_FAILED":
			return cancelRefundFailureNotice(refundFailure);
		default:
			return {
				variant: "error",
				title: "Not cancelled",
				description:
					"That cancellation could not be recorded — check the order, then retry in a moment.",
			};
	}
}

/** The cancel's refund leg failed, so nothing was cancelled and nothing restocked. */
function cancelRefundFailureNotice(refundFailure: string | undefined): Notice {
	switch (refundFailure) {
		case "GATEWAY_RETRYABLE":
			return {
				variant: "error",
				title: "Not cancelled — temporary problem",
				description:
					"Nothing was changed: the payment provider could not be reached, so no refund was made. Try again in a moment — the retry continues the same refund.",
			};
		case "GATEWAY_UNVERIFIED":
			return {
				variant: "error",
				title: "Not cancelled — refund status unknown",
				description:
					"The order was not cancelled. The refund request timed out and its outcome is unknown. Do NOT retry — check your provider dashboard first, then reconcile.",
			};
		case "PROVIDER_ALREADY_REFUNDED":
			return {
				variant: "error",
				title: "Not cancelled — already refunded at the provider",
				description:
					"Nothing was changed. Your payment provider shows this payment already refunded, in full or in part (possibly from its dashboard) — the order's reconciliation flag says which — unless it already had an open flag, which is kept; resolve that one and try the refund again. If refunded in full, Mark refunded is offered — use it before resolving the flag.",
			};
		case "GATEWAY_TERMINAL":
		case "REFUND_NOT_SUPPORTED":
			return {
				variant: "error",
				title: "Not cancelled — the refund was rejected",
				description:
					"Nothing was changed and nothing was restocked: the payment provider rejected the refund. Check the payment in your provider dashboard.",
			};
		default:
			return {
				variant: "error",
				title: "Not cancelled",
				description:
					"The refund could not be completed, so the order was not cancelled. Check Money → Refunds and your payment provider before trying again.",
			};
	}
}

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
/** This refund was already recorded — a double-click, a retry or a resubmitted
 *  page after it went through. Nothing more was refunded. */
const ALREADY_REFUNDED: Notice = {
	variant: "default",
	title: "Already refunded",
	description:
		"This refund was already recorded (a duplicate submission); nothing more was refunded, and the ledger above shows it.",
};

function staleLedgerNotice(
	submittedAmountCents: number,
	live: RefundsSummaryWire,
	cur: string,
): Notice {
	return {
		variant: "error",
		title: "The refund ledger changed — nothing was refunded",
		description: fit(
			`${formatTotal(submittedAmountCents, cur)} was not refunded: a refund was recorded since this page loaded — in another tab or by someone else. ${formatTotal(live.remainingCents, cur)} now remains refundable; re-enter an amount below to try again.`,
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
 * THE WATERMARK IS THE FINALIZED TOTAL (issue #303 review), never the active
 * one. A gateway attempt that ended RETRYABLE or UNVERIFIED leaves a
 * `reserved`/`unverified` row that holds ceiling capacity but moved no money
 * yet. Were it counted, the operator's "try again" would be refused as "someone
 * else refunded this order", the same-key RESUME the domain offers would be
 * unreachable, and a re-entered refund under a new key would leave the orphan
 * reservation holding capacity for good. Counting only finalized money keeps the
 * retry on the SAME key: RETRYABLE resumes and issues once, UNVERIFIED answers
 * "status unknown" again without calling the provider.
 *
 * A VOIDED ATTEMPT SPENDS ITS KEY. The domain replays a voided key's rejection,
 * so the key gains `:v<n>` — the count of THIS refund's voided attempts on the
 * LIVE ledger, i.e. voided rows whose key is the base key or `<base>:v<k>` —
 * once one exists. A deliberate retry after a definite provider rejection is
 * then a new intent. Another refund's rejection on the same order never counts:
 * it would move a retryable refund off the key its reservation is held under,
 * orphaning that reservation and risking a second issue.
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
 * NOR IS THERE A `Refunded by` GUARD: a blank one is recorded as the signed-in
 * operator the host named (`routeCtx.user`, QA2), and only as `admin` when the
 * host named nobody.
 */
const refundOrderAction: OrdersAction = async (client, payload, operator) => {
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
	// The observed watermark is the third key component (F-2a) — NOT a nonce.
	const baseKey = `admin-refund:${orderId}:${amountCents}:${observedSoFar}`;
	if (live.finalizedTotalCents !== observedSoFar) {
		// THIS submission already recorded (a retry or a resubmitted page after it
		// went through): the ledger moved because of it. Saying "someone else
		// refunded this order" blamed a stranger for the operator's own refund (QA
		// round 2).
		const ownRecorded = live.refunds.find(
			(r) =>
				r.status === "recorded" &&
				(r.idempotencyKey === baseKey || r.idempotencyKey.startsWith(`${baseKey}:v`)),
		);
		if (ownRecorded !== undefined) {
			// REPLAY IT, under the key it was recorded with (issue #405, item 3). The
			// refund is recorded before the order's download access is revoked, so a
			// process that died between the two left a `refunded` order whose grants
			// are still active — and THIS re-click is the retry that is meant to
			// finish the job. Answering from the ledger alone never reached the
			// service, so the revoke never ran. The domain resolves a `recorded` key
			// as a benign duplicate with NO provider call, and revokes there when the
			// order is `refunded`; `revokeByOrder` is idempotent, so on the ordinary
			// double-click this costs a read and changes nothing. The row's own
			// amount, currency and name are sent, so the domain's same-request check
			// matches by construction.
			//
			// Whatever the replay answers, the notice stays ALREADY_REFUNDED: the
			// money is on the ledger, and that is the operator's question. A refusal
			// here (the order's gateway unwired since, say) cannot heal the revoke,
			// and the residual is the one `refund-order.ts` names — a `refunded`
			// order, which the download route refuses on. A revoke that THROWS
			// propagates, so the operator sees a failure and clicks again.
			await client.refundOrder(
				orderId,
				{
					amountCents: ownRecorded.amountCents,
					currency: ownRecorded.currency,
					refundedBy: ownRecorded.refundedBy,
				},
				{ idempotencyKey: ownRecorded.idempotencyKey },
			);
			return applied(ALREADY_REFUNDED);
		}
		// The genuinely CONCURRENT case: the ledger moved between the confirm being
		// drawn and this click. This is the ONLY window now checked server-side, and
		// the surface's own pre-dialog validation cannot see it.
		return applied(staleLedgerNotice(amountCents, live, liveCur));
	}
	const voidedAttempts = live.refunds.filter(
		(r) =>
			r.status === "voided" &&
			(r.idempotencyKey === baseKey || r.idempotencyKey.startsWith(`${baseKey}:v`)),
	).length;
	const key = voidedAttempts > 0 ? `${baseKey}:v${String(voidedAttempts)}` : baseKey;
	const result = await client.refundOrder(
		orderId,
		{
			amountCents,
			currency,
			...(reason.length > 0 ? { reason } : {}),
			// The typed name, else the signed-in operator — "full remaining" carries no
			// name, and "a different amount" no longer requires one (QA2) — else "admin".
			refundedBy: refundedBy.length > 0 ? refundedBy : (operator ?? "admin"),
		},
		{ idempotencyKey: key },
	);
	// The write was ATTEMPTED past this point, so every branch below is an outcome
	// to read rather than an input to correct — and on `GATEWAY_UNVERIFIED` the
	// outcome is UNKNOWN, which is why its copy says not to retry.
	if (!result.ok) return applied(refundFailureNotice(result.reason, liveCur));
	if (result.duplicate) {
		// A benign replay: the SAME amount against the SAME watermark, i.e. a
		// double-click. A different amount would have produced a different key.
		return applied(ALREADY_REFUNDED);
	}
	if (result.fullyRefunded) {
		return applied({
			variant: "default",
			title: "Refund complete",
			description: `The refund was recorded and the order is now fully refunded.${emailSentence(result.email)}`,
		});
	}
	return applied({
		variant: "default",
		title: "Refund recorded",
		description: fit(
			`The refund was recorded; the order stays in its current status and Money → Refunds shows what remains.${emailSentence(result.email)}`,
			BANNER_BUDGET,
		),
	});
};

/**
 * Resolve a refund whose provider outcome is UNKNOWN (review round 2): the
 * operator checked the provider. `confirmed` records it as refunded (the provider
 * refund id is optional), `voided` releases it. The surface confirms first; the
 * domain refuses any row that is not `unverified`, and a replay changes nothing.
 * The operator the host named is recorded on the row.
 */
function resolveUnverifiedRefundAction(outcome: "confirmed" | "voided"): OrdersAction {
	return async (client, payload, operator) => {
		const orderId = readString(payload["orderId"]);
		const refundKey = (readString(payload["refundKey"]) ?? "").trim();
		if (orderId === undefined || refundKey.length === 0) return applied(UNREADABLE);
		const refundRef = (readString(payload["refundRef"]) ?? "").trim();
		const result = await client.resolveUnverifiedRefund(orderId, {
			refundKey,
			outcome,
			...(outcome === "confirmed" && refundRef.length > 0 ? { refundRef } : {}),
			resolvedBy: operator ?? "admin",
		});
		if (!result.ok) {
			return applied({
				variant: "error",
				title: "Refund not resolved",
				description:
					result.reason === "NOT_UNVERIFIED"
						? "Nothing was changed — this refund is no longer waiting on a check. Reload Money → Refunds to see its status."
						: "Nothing was changed — that refund could not be found on this order. Reload and try again.",
			});
		}
		// What the refund was FOR, finished or not (#364): a cancellation, a late payment.
		const followUp =
			result.followUp === undefined
				? null
				: followUpNotice(outcome, result.changed, result.followUp, result.email);
		if (followUp !== null) return applied(followUp);
		if (!result.changed) {
			return applied({
				variant: "default",
				title: "Already resolved",
				description: "This refund was already resolved that way; nothing changed.",
			});
		}
		if (outcome === "voided") {
			return applied({
				variant: "default",
				title: "Marked as not refunded",
				description:
					"The refund is recorded as never issued, and that amount can be refunded again from Money → Refunds. No money moved and the buyer was not emailed.",
			});
		}
		return applied({
			variant: "default",
			title: "Refund confirmed",
			description: `The refund is recorded as issued by your payment provider${
				result.fullyRefunded ? ", and the order is now fully refunded" : ""
			}.${emailSentence(result.email)}`,
		});
	};
}

/**
 * The notice for a resolved refund that belonged to something larger (#364) — a
 * cancellation or a late payment — saying what became of THAT. `null` falls back
 * to the plain refund copy (a replay with nothing new to say).
 */
function followUpNotice(
	outcome: "confirmed" | "voided",
	changed: boolean,
	followUp: ResolveFollowUpWire,
	email: InlineEmailStatus | undefined,
): Notice | null {
	if (followUp.purpose === "late-payment") {
		if (!changed) return null;
		if (followUp.outcome === "finished") {
			return {
				variant: "default",
				title: "Refund confirmed",
				description: `The late payment is recorded as refunded by your payment provider, and its flag is resolved.${emailSentence(email)}`,
			};
		}
		return {
			variant: "default",
			title: "Marked as not refunded",
			description: followUp.flagged
				? "The automatic refund is recorded as never issued, so the late payment is still held. The order is flagged: refund it from Money → Refunds."
				: "The automatic refund is recorded as never issued, so the late payment is still held: refund it from Money → Refunds. The order already had another open flag, which was left as it is.",
		};
	}
	switch (followUp.outcome) {
		case "cancelled": {
			if (!changed && !followUp.cancelledNow) return null;
			const head =
				"The refund is recorded as issued by your payment provider, and the cancellation it was for is finished." +
				restockSentence(followUp.restock, followUp.restockedUnits, followUp.restockPending) +
				emailSentence(email);
			return {
				variant: "default",
				title: "Refund confirmed and order cancelled",
				description: fit(
					head + skippedSentence(followUp.restockSkipped, BANNER_BUDGET - head.length),
					BANNER_BUDGET,
				),
			};
		}
		case "already_cancelled":
			return {
				variant: "default",
				title: "Refund confirmed — order was already cancelled",
				description: `The refund is recorded as issued by your payment provider. The order had already been cancelled another way, without this refund on its record, so the buyer gets a separate refund email.${followUp.refundEmailQueued ? emailSentence(email) : " That email was already sent."}`,
			};
		case "not_cancelled": {
			const state = followUp.state ?? "past cancelling";
			const gone =
				followUp.state === "shipped" ||
				followUp.state === "delivered" ||
				followUp.state === "completed";
			const next = gone
				? "Contact the buyer; do not refund it again unchecked."
				: "Contact the buyer before it ships or is refunded again.";
			const flag = followUp.flagged
				? ` The order is flagged. ${next}`
				: ` The order could not be flagged. ${next}`;
			return {
				variant: "error",
				title: "Refund confirmed — order not cancelled",
				description: fit(
					`The refund is recorded, but the order is ${state}, so the cancellation it was for could not finish.${flag}${followUp.refundEmailQueued ? lostEmailSentence(email) : ""}`,
					BANNER_BUDGET,
				),
			};
		}
		case "cancel_again":
			if (outcome === "voided") {
				if (!changed) return null;
				return {
					variant: "default",
					title: "Marked as not refunded",
					description:
						"The refund is recorded as never issued; no money moved and the buyer was not emailed. The order is still paid: click Cancel order again to refund and cancel it.",
				};
			}
			// Whatever `changed` says: a replay whose cancel still did not finish has
			// the same next step.
			return {
				variant: "default",
				title: "Refund confirmed — finish the cancellation",
				description:
					"The refund is recorded as issued by your payment provider, but the cancellation it was for has not finished. Click Cancel order again to finish it; it will not refund twice.",
			};
	}
}

/** GENERIC, em-dash-correct notices for a refund failure — keyed off the service's
 *  typed reason, NEVER the raw status/URL. The ambiguous-timeout case is explicit:
 *  do NOT retry, re-check the provider first (ADR-0008 error taxonomy). */
function refundFailureNotice(reason: string | undefined, currency: string): Notice {
	switch (reason) {
		// ADR-0033 amendment: the DOMAIN's refusal of an amount the order's currency
		// cannot be paid back in (KWD, BHD, OMR, JOD: not in steps of 0.010, and not
		// the whole remainder). The console checks the same rule before sending.
		case "AMOUNT_NOT_PAYMENT_INCREMENT":
			return {
				variant: "error",
				title: "Not refunded",
				description: refundIncrementText(currency),
			};
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
					"Your payment provider shows this order already refunded, or this amount would refund more than it still holds (possibly after a dashboard refund). Nothing was issued — the order's reconciliation flag says which — unless it already had an open flag, which is kept; resolve that one and try the refund again. If refunded in full, Mark refunded is offered — use it before resolving the flag.",
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
		case "IDEMPOTENCY_KEY_REUSED":
			return {
				variant: "error",
				title: "Not refunded",
				description:
					"This request's key was already used for a different refund, so nothing was refunded. Reload to see the current ledger, then try again.",
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
					"That refund could not be processed — check the order, then retry in a moment.",
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
	[ACTION_RESOLVE_REFUND_CONFIRMED]: resolveUnverifiedRefundAction("confirmed"),
	[ACTION_RESOLVE_REFUND_VOIDED]: resolveUnverifiedRefundAction("voided"),
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
	client: AdminOrdersSurface,
	operator?: string,
): Promise<OrdersActionResult | undefined> {
	const action = ORDERS_ACTIONS_BY_ID[actionId];
	if (action === undefined) return undefined;
	return await action(client, payload, operator);
}
