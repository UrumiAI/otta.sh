/**
 * The admin Orders console surface — the port the console pages hold, plus the
 * wire-shaped types that cross it (view-only list + detail, the status
 * transition, and the Increment-1 write actions).
 *
 * These types are defined LOCALLY and deliberately: this module NEVER imports
 * `@otta-sh/domain`, which keeps the plugin sandbox-clean (enforced by the
 * dependency-cruiser rule, MOD-4). Money is integer minor units + ISO-4217
 * currency throughout. The "wire" in the names is historical — it was once the
 * JSON shape of a separate commerce service — and it is still exactly the shape
 * the admin route's JSON responses use, so the name stays accurate.
 */

export interface OrderSummaryWire {
	id: string;
	/** The order NUMBER ("#3F9A2", the domain's `orderNumber`) — the same label the
	 *  shopper sees on the order page and in every order email. A DISPLAY label,
	 *  not a key: two orders can share one (ADR-0033), so nothing resolves by it. */
	orderNumber: string;
	state: string;
	currency: string;
	buyerRef: string;
	customerId: string | null;
	paymentMethod: string | null;
	createdAt: string;
	totalCents: number;
	reconciliationFlag: boolean;
}

export interface OrderLineWire {
	sku: string;
	title: string;
	unitPriceCents: number;
	currency: string;
	quantity: number;
	fulfillmentKind: string;
}

export interface OrderTotalsWire {
	currency: string;
	subtotalCents: number;
	discountCents: number;
	shippingCents: number;
	taxCents: number;
	totalCents: number;
	appliedCouponCode: string | null;
	/** The chosen shipping zone id (ADR-0009), or null when none was selected.
	 *  DISPLAY-ONLY: rendered next to the captured ship-to country so a human can
	 *  spot a "domestic zone / foreign country" mismatch — no matching/validation. */
	shippingZoneId?: string | null;
}

/** The immutable shipping-address snapshot captured on an order at checkout
 *  (ADR-0009), or null when none was captured (a historical order predating
 *  capture, or a digital-only order). This IS the authoritative ship-to for the
 *  order — unlike {@link AddressWire} (the mutable profile book), it never changes
 *  after checkout. Optional contact fields are null when the buyer omitted them. */
export interface OrderAddressWire {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	email: string | null;
	phone: string | null;
}

/** The admin disposition recorded when an order's reconciliation flag was
 *  resolved (admin-UX Increment 1); null while unflagged/unresolved. */
export interface ReconciliationResolutionWire {
	outcome: string;
	reason: string;
	resolvedBy: string;
	resolvedAt: string;
}

/** The shipping fulfillment recorded on an order (admin-UX Increment 1); null
 *  until the order ships with tracking. `trackingUrl` is optional (null when the
 *  admin recorded none); `shippedAt` is the ship time, `recordedAt` the server
 *  stamp. */
export interface OrderFulfillmentWire {
	carrier: string;
	trackingNumber: string;
	trackingUrl: string | null;
	shippedAt: string;
	recordedBy: string;
	recordedAt: string;
}

/** The structured cancellation recorded on an order (admin-UX Increment 1,
 *  "cancel with reason"); null while never cancelled OR cancelled via the bare
 *  transition (no reason on file — an honest back-compat state). */
export interface OrderCancellationWire {
	reason: string;
	detail: string | null;
	cancelledBy: string;
	cancelledAt: string;
	/** The refund the cancellation issued (integer minor units), or null when it
	 *  refunded nothing. ABSENT on a cancellation recorded before the field
	 *  existed — read it as null. */
	refund?: { amount: number; currency: string } | null;
	/** Whether the cancellation returned the order's units to stock. ABSENT on an
	 *  older cancellation — read it as false. */
	restocked?: boolean;
}

export interface OrderDetailWire {
	id: string;
	/** The order NUMBER ("#3F9A2", the domain's `orderNumber`) — the same label the
	 *  shopper sees on the order page and in every order email. A DISPLAY label,
	 *  not a key: two orders can share one (ADR-0033), so nothing resolves by it. */
	orderNumber: string;
	state: string;
	currency: string;
	paymentMethod: string | null;
	buyerRef: string;
	customerId: string | null;
	holdExpiresAt: string;
	createdAt: string;
	reconciliationFlag: string | null;
	reconciliationResolution: ReconciliationResolutionWire | null;
	fulfillment: OrderFulfillmentWire | null;
	cancellation: OrderCancellationWire | null;
	/** The immutable ship-to snapshot captured at checkout (ADR-0009); null when
	 *  the order predates capture or is digital-only. Authoritative — never the
	 *  profile book (which is prefill/context, on the customer panel). */
	shippingAddress: OrderAddressWire | null;
	totals: OrderTotalsWire;
	lines: OrderLineWire[];
}

/** The list filter the console builds from its filter form. `states` is an OR set
 *  (serialized to a CSV `states=` param); the window is half-open `[from, to)`. */
export interface OrdersListFilter {
	states?: string[];
	from?: string;
	to?: string;
	search?: string;
}

export interface OrdersListResult {
	orders: OrderSummaryWire[];
	/** Opaque keyset cursor for the next page, or null on the last page. */
	nextCursor: string | null;
	/**
	 * Exact number of orders matching the ACTIVE FILTER — the whole set, not
	 * this page (INC-23).
	 *
	 * OPTIONAL for one reason only: a service older than the field omits it, and
	 * a renderer must then fall back to the page-scoped count it always had
	 * ("25 orders on this page"). Never defaulted to `0` — that would caption a
	 * page of rows with a count of none.
	 */
	total?: number;
	/**
	 * THIS IS PAGE ONE, and it is page one because the cursor the caller asked
	 * with was REFUSED — mismatched against these filters, or undecodable — and
	 * {@link AdminOrdersSurface.listOrders} re-issued the request without it.
	 *
	 * ABSENT ON EVERY ORDINARY PAGE, including an ordinary first page: the flag
	 * means "you asked for a page you did not get", which is a thing a renderer
	 * must be able to say out loud (an address still naming that page has to be
	 * corrected, and an operator who followed a link to it deserves a sentence).
	 * A caller that ignores it renders a correct list, one page from where the
	 * caller meant — the safe direction, and the reason this is optional rather
	 * than a second result type.
	 */
	cursorRejected?: true;
}

export interface OrderDetailResult {
	order: OrderDetailWire;
	/** The legal outbound transitions from the current state — the domain state
	 *  machine, forwarded by the service (never re-derived plugin-side). */
	allowedTransitions: string[];
}

/** A saved profile address on the wire (admin-UX Increment 1). This is the
 *  customer's CURRENT address book — prefill/context only (ADR-0009). The order's
 *  own authoritative ship-to is {@link OrderAddressWire} on the order detail; this
 *  mutable book must never be presented as "where this order shipped". */
export interface AddressWire {
	id: string;
	kind: string;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	isDefault: boolean;
	createdAt: string;
}

/** Token-free session metadata on the wire (admin-UX Increment 1) — the service
 *  never serializes a token or hash into this shape. */
export interface SessionSummaryWire {
	id: string;
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
}

/** Who the order's customer is (admin-UX Increment 1). `linkage` is the honest
 *  story: "claimed" (order linked to the account), "unclaimed" (an account
 *  exists for this email but the order predates its next login — links then),
 *  or "guest" (no account at all). */
export interface CustomerIdentityWire {
	customerId: string | null;
	buyerRef: string;
	email: string | null;
	displayName: string | null;
	emailVerifiedAt: string | null;
	linkage: string;
}

/** The customer-context panel payload (admin-UX Increment 1) — read-only. */
export interface CustomerContextWire {
	identity: CustomerIdentityWire;
	addresses: AddressWire[];
	sessions: SessionSummaryWire[];
	orderCount: number;
	recentOrders: OrderSummaryWire[];
}

/** A refund row on the wire (ADR-0008). `kind` is "gateway" (money moved via the
 *  provider — `refundRef` set) or "manual" (an out-of-band return the admin
 *  recorded — `refundRef` null, x402's honest path). Money is integer minor
 *  units + ISO-4217 currency. */
export interface RefundWire {
	id: string;
	orderId: string;
	amountCents: number;
	currency: string;
	kind: string;
	gateway: string;
	refundRef: string | null;
	reason: string | null;
	refundedBy: string;
	createdAt: string;
	/** The row's reserve-before-issue lifecycle (ADR-0008): `recorded` (money
	 *  came back), `reserved` (an attempt holding ceiling capacity, not yet
	 *  issued or retryable), `unverified` (the provider call's outcome is
	 *  UNKNOWN — check the provider) or `voided` (nothing moved; an audit row
	 *  only). Only `recorded` is a refund that happened. */
	status: string;
	/** The idempotency key the refund was attempted under — Stripe's native
	 *  `Idempotency-Key` for a gateway refund, so it is what an operator searches
	 *  the provider's request log for, and how the console tells ONE refund's
	 *  attempts from another's on the same order. */
	idempotencyKey: string;
}

/** The refunds summary for an order (ADR-0008): the append-only ledger plus the
 *  derived ceiling / remaining-refundable and the gateway's HONEST `refundable`
 *  capability, so the panel shows the right action (a real Stripe refund vs a
 *  recorded manual refund) and never a button that silently no-ops. */
export interface RefundsSummaryWire {
	refunds: RefundWire[];
	currency: string;
	capturedTotalCents: number;
	/** Σ ACTIVE refunds (everything but `voided`) — the capacity the ceiling
	 *  arbitrates against, so `remainingCents` is computed from it. */
	refundedTotalCents: number;
	/** Σ FINALIZED (`recorded`) refunds — money that actually came back, and the
	 *  refund confirm's optimistic watermark: an attempt that failed or is still
	 *  in flight must not read as "someone else refunded this order". */
	finalizedTotalCents: number;
	ceilingCents: number;
	remainingCents: number;
	paymentMethod: string | null;
	refundable: boolean;
}

/**
 * What became of the buyer's email an admin write enqueued (QA T1-6). The write
 * sends it inline (`sendOrderEmailsNow`), so the console can say what is TRUE:
 *  - `sent`         — it went out;
 *  - `queued`       — it did not go yet (the provider failed or was slow); the
 *                     cron retries it automatically;
 *  - `unconfigured` — the store has no email provider, so it will not be sent;
 *  - `no-recipient` — the order has no email address to send to (an x402 buyer's
 *                     `x402:0x…` reference, ADR-0028 Decision 7), so it was not sent
 *                     and never will be — completed as skipped, not queued.
 */
export type InlineEmailStatus = "sent" | "queued" | "unconfigured" | "no-recipient";

/** POST refund returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `recorded:false` on a 2xx ⇒ an idempotent replay (`duplicate`). On a failure,
 *  `reason` carries the service's typed reason when one was returned (e.g.
 *  `REFUND_EXCEEDS_TOTAL`, `PROVIDER_ALREADY_REFUNDED`, `GATEWAY_UNVERIFIED`); the
 *  caller renders GENERIC copy keyed off it, never the raw status/URL. */
export type RefundOrderResult =
	| {
			ok: true;
			recorded: boolean;
			duplicate: boolean;
			fullyRefunded: boolean;
			/** What became of the refund email this write enqueued — see
			 *  {@link InlineEmailStatus}. Absent on a replay. */
			email?: InlineEmailStatus;
	  }
	| { ok: false; status: number; reason?: string };

/** What became of the thing a resolved refund was FOR (#364) — the domain's
 *  `ResolveFollowUp` on the wire. Absent for a plain refund.
 *  - `cancellation`/`cancelled` — the cancellation it belonged to is finished.
 *  - `cancellation`/`already_cancelled` — cancelled elsewhere without this refund
 *    on its record; the buyer gets the refund's own email.
 *  - `cancellation`/`not_cancelled` — the order had moved on (`state`); flagged
 *    unless `flagged` says otherwise.
 *  - `cancellation`/`cancel_again` — Cancel order again finishes it (no second refund).
 *  - `late-payment`/`finished` — the late payment is refunded and its buyer told.
 *  - `late-payment`/`refund_manually` — still held; to refund by hand (`flagged`). */
export type ResolveFollowUpWire =
	| {
			purpose: "cancellation";
			outcome: "cancelled";
			/** True ⇒ THIS answer cancelled it (a replay finds it already cancelled). */
			cancelledNow: boolean;
			/** The cancellation's restock choice. */
			restock: boolean;
			restockedUnits: number;
			restockSkipped: { sku: string; quantity: number; reason: string }[];
			/** The restock after the flip is still owed; the sweep finishes it. */
			restockPending: boolean;
	  }
	| {
			purpose: "cancellation";
			outcome: "already_cancelled";
			/** This answer enqueued the refund's own email (else it was already sent). */
			refundEmailQueued: boolean;
	  }
	| {
			purpose: "cancellation";
			outcome: "not_cancelled";
			state: string | null;
			/** The order carries a flag naming this cancellation. */
			flagged: boolean;
			refundEmailQueued: boolean;
	  }
	| { purpose: "cancellation"; outcome: "cancel_again" }
	| { purpose: "late-payment"; outcome: "finished" }
	| {
			purpose: "late-payment";
			outcome: "refund_manually";
			/** False ⇒ an unrelated open flag kept it from flagging the order. */
			flagged: boolean;
	  };

/** {@link AdminOrdersSurface.resolveUnverifiedRefund}'s answer. */
export type ResolveUnverifiedRefundResult =
	| {
			ok: true;
			/** False ⇒ the same answer was already recorded (a replay). */
			changed: boolean;
			fullyRefunded: boolean;
			/** The email the answer sent: the refund's own, or the one what it was for
			 *  sends (the cancelled email, the late-payment notice). Absent when none. */
			email?: InlineEmailStatus;
			followUp?: ResolveFollowUpWire;
	  }
	| { ok: false; status: number; reason?: string };

/** An append-only order note (admin-UX Increment 0) on the wire. */
export interface OrderNoteWire {
	id: string;
	orderId: string;
	author: string;
	body: string;
	createdAt: string;
}

/**
 * One entry in the order timeline (admin-UX Increment 1, timeline slice) on the
 * wire. A discriminated union keyed by `kind`; every entry carries `at`, and the
 * kind-specific fields are OPTIONAL here (the plugin reads only what a given
 * `kind` populates), so an unknown/future kind degrades to a bare `at` row rather
 * than throwing. Its only money is what an audit needs (QA round 2): each refund
 * on the ledger, and what a cancellation refunded — integer minor units with
 * their currency, never a total.
 */
export interface TimelineEntryWire {
	kind: string;
	at: string;
	/** state_change */
	fromState?: string | null;
	toState?: string | null;
	actor?: string | null;
	/** note */
	author?: string;
	body?: string;
	/** fulfillment */
	carrier?: string;
	trackingNumber?: string;
	trackingUrl?: string | null;
	shippedAt?: string;
	recordedBy?: string;
	/** cancellation (the closed reason); refund (the operator's free text, or null) */
	reason?: string | null;
	detail?: string | null;
	cancelledBy?: string;
	/** reconciliation_resolved */
	outcome?: string;
	resolvedBy?: string;
	/** cancellation: what it refunded (minor units), and whether it restocked */
	refund?: { amount: number; currency: string } | null;
	restocked?: boolean;
	/** cancellation: present (true) only while its restock is still owed */
	restockPending?: true;
	/** refund: one ledger row that moved, or is moving, money */
	amount?: number;
	currency?: string;
	status?: string;
	purpose?: string;
	refundedBy?: string;
}

/** The order timeline payload (admin-UX Increment 1, timeline slice) — read-only.
 *  `stateChangesAudited` is false for a historical order whose transitions
 *  predate the audit table (a partial timeline). */
export interface OrderTimelineWire {
	orderId: string;
	stateChangesAudited: boolean;
	entries: TimelineEntryWire[];
}

/** POST add-note returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host. */
export type AddNoteResult =
	| { ok: true; appended: boolean; note: OrderNoteWire }
	| { ok: false; status: number };

/** Why the admin transition was refused — the domain's `TransitionOrderAsAdminFailure`,
 *  restated here as a closed union (this module imports no domain type, MOD-4), so a
 *  caller comparing against it is checked by the compiler and the in-process client
 *  cannot return a reason missing from it. */
export type TransitionRefusal =
	| "ORDER_NOT_FOUND"
	| "INVALID_TRANSITION"
	| "MANUAL_PAYMENT_NOT_ALLOWED"
	| "USE_CANCEL"
	/** Mark refunded while the ledger still holds captured money its provider can
	 *  return (QA2 M4): the money goes back through Money → Refunds. */
	| "REFUND_THROUGH_MONEY"
	/** Mark refunded while a refund on the order is still reserved or unverified:
	 *  its outcome is resolved in Money → Refunds first. */
	| "REFUND_IN_FLIGHT";

/** POST transition returns a discriminated result (like `updateSettings`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  On a failure, `reason` carries the domain's typed reason when one applies —
 *  `MANUAL_PAYMENT_NOT_ALLOWED` (a manual mark-paid — only the payment provider
 *  settles an order today) and `USE_CANCEL` (any bare cancel — Cancel order is the
 *  one way) get their own copy. */
export type TransitionOrderResult =
	| {
			ok: true;
			transitioned: boolean;
			/** What became of the email this move enqueued. Absent when it enqueued none
			 *  — a no-op, or a Mark refunded (bookkeeping, emails nobody). */
			email?: InlineEmailStatus;
	  }
	| { ok: false; status: number; reason?: TransitionRefusal };

/** POST resolve-reconciliation returns a discriminated result (like `transitionOrder`)
 *  so a failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `resolved:false` on a 2xx ⇒ the guarded flip found nothing to resolve (already
 *  resolved / lost race) — a benign no-op, not a failure. On a failure, `reason`
 *  carries the service's typed reason when one was returned (e.g.
 *  `RECONCILIATION_FLAG_CHANGED` — the live flag differs from the one reviewed, the
 *  console should tell the merchant to reload); the caller renders GENERIC copy
 *  keyed off it, never the raw status/URL. */
export type ResolveReconciliationResult =
	| { ok: true; resolved: boolean }
	| { ok: false; status: number; reason?: string };

/** POST record-fulfillment returns a discriminated result (like `transitionOrder`)
 *  so a failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `recorded:false` on a 2xx ⇒ the guarded flip found the order already shipped (a
 *  benign no-op, not a failure). On a failure, `reason` carries the service's typed
 *  reason when one was returned (e.g. `NOT_FULFILLABLE` — the order is not in
 *  `processing`); the caller renders GENERIC copy keyed off it, never the raw
 *  status/URL. */
export type RecordFulfillmentResult =
	| { ok: true; recorded: boolean; email?: InlineEmailStatus }
	| { ok: false; status: number; reason?: string };

/** POST cancel returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `cancelled:false` on a 2xx ⇒ the guarded flip found the order already
 *  cancelled with a reason on file (a benign no-op, not a failure). On a
 *  failure, `reason` carries the service's typed reason when one was returned
 *  (e.g. `NOT_CANCELLABLE` — the order can no longer be cancelled); the caller
 *  renders GENERIC copy keyed off it, never the raw status/URL. */
export type CancelOrderResult =
	| {
			ok: true;
			cancelled: boolean;
			/** The money the cancellation returned (QA T1-4), or null when none. On a
			 *  replay, what the cancellation on file returned. */
			refund?: { amountCents: number; currency: string } | null;
			/** Units THIS call returned to stock (0 on a replay or when declined). */
			restockedUnits?: number;
			/** The order is cancelled but its units are NOT all back yet: the restock
			 *  after the flip failed, and the sweep finishes it (issue #364). The
			 *  console must not say they were returned. */
			restockPending?: boolean;
			/** Lines the restock could not return, and why (`UNKNOWN_SKU`,
			 *  `HOLD_RELEASED`, `HOLD_UNKNOWN`) — reported so the console can say so. */
			restockSkipped?: { sku: string; quantity: number; reason: string }[];
			/** What became of the cancelled email. Absent on a replay. */
			email?: InlineEmailStatus;
	  }
	| {
			ok: false;
			status: number;
			reason?: string;
			/** With `reason: "REFUND_FAILED"`: the refund leg's own typed reason
			 *  (`GATEWAY_RETRYABLE`, `GATEWAY_TERMINAL`, `GATEWAY_UNVERIFIED`, …). */
			refundFailure?: string;
			/** With `reason: "CANCEL_LOST_AFTER_REFUND"` or
			 *  `"CANCEL_INCOMPLETE_AFTER_REFUND"`: what DID move — the refund, and (lost)
			 *  the units restocked. */
			refund?: { amountCents: number; currency: string } | null;
			restockedUnits?: number;
			/** With `reason: "CANCEL_INCOMPLETE_AFTER_REFUND"`: the failure was a busy
			 *  store, so the copy says so. */
			retryable?: boolean;
			/** With `reason: "CANCEL_LOST_AFTER_REFUND"`: the state the order moved to. */
			movedTo?: string | null;
			/** With `reason: "CANCEL_LOST_AFTER_REFUND"`: what became of the refund's own
			 *  email (its `refund-issued` notice, sent inline). Absent when no refund. */
			email?: InlineEmailStatus;
	  };

/**
 * THE ADMIN ORDERS SURFACE, structurally — what a caller may do, with no claim
 * about how it gets done.
 *
 * ONE implementation answers to this now (work order 02, INC-D3b):
 * `InProcessAdminOrdersClient`, which composes this behaviour over the plugin's
 * own document store. The `ctx.http` client that used to be the second
 * implementation is gone with the commerce service it talked to, and with it the
 * reason this was a `Pick` over a nominal class rather than an interface — so it
 * is written out as an interface now, which is what it always described.
 *
 * EVERY METHOD IS LISTED, and writing them out is still the point: a method
 * added to the in-process client without being declared here is not part of the
 * surface, and a method declared here that the client does not implement is a
 * compile error. The surface stays a deliberate decision rather than whatever
 * one class happens to expose.
 */
export interface AdminOrdersSurface {
	/**
	 * THE FILTER TRAVELS BESIDE THE CURSOR, and it did not used to.
	 *
	 * The old rule was "send ONLY the cursor when paging, so the two never
	 * disagree", and it was the wrong half of a true observation. The cursor does
	 * embed the filter it was minted under — but the reader, given both, took the
	 * predicate SOLELY from the token and never looked at the filter passed
	 * alongside it. So a page-two request that meant "paid orders" while carrying
	 * an unfiltered token got the unfiltered set, successfully, with nothing in
	 * the result admitting the substitution; upstream, a console deriving its
	 * filters from the address captions those rows "Paid". Passing only the cursor
	 * did not prevent the disagreement — it hid it.
	 *
	 * The implementation now compares the two as PREDICATES and REFUSES the cursor
	 * when they differ, so stating the filter on every call is what turns an
	 * invisible divergence into an answerable one. Agreeing filters are redundant,
	 * not a second opinion.
	 *
	 * NO CASE FOLDING, HERE OR ANYWHERE BEFORE THE STORE. The comparison is
	 * deliberately case-SENSITIVE — the store's case-insensitivity is the store's
	 * business, and a token round-trips whatever it was minted with — so a caller
	 * that helpfully lowercased a search term on one call and not on the other
	 * would manufacture mismatches out of nothing.
	 *
	 * WHAT THE CALLER OWES: for a filter derived from a RELATIVE period, the
	 * instants passed here must be the ones the cursor was minted under, not a
	 * fresh resolution of the same words. `orders-read.ts`'s `periodWindow`
	 * resolves presets to WHOLE-DAY bounds precisely so that holds — two calls on
	 * the same UTC day resolve identically, which is every call in a paging
	 * session bar one that crosses UTC midnight. That crossing describes a
	 * genuinely different window, so the refusal and the page-one recovery are the
	 * correct answer to it rather than a defect to design around.
	 *
	 * A REFUSED CURSOR IS RECOVERED HERE, not reported: the implementation drops
	 * the token, re-issues page one with the same filter, and flags the result
	 * `cursorRejected` so a consumer can say out loud that it did not get the page
	 * it asked for — or discard the rows, which a console refused mid-scan does.
	 * An unreachable store still fails loudly; those two want opposite treatments
	 * of the address bar, and collapsing them into one "list failed" is what made
	 * the console guess.
	 */
	listOrders(
		filter: OrdersListFilter,
		opts?: { cursor?: string; limit?: number },
	): Promise<OrdersListResult>;

	/** Read one order + its allowed transitions. A missing order resolves to
	 *  `null` (the console renders a "not found" state, not an error banner). */
	getOrder(orderId: string): Promise<OrderDetailResult | null>;

	/** Move an order to `toState`. Returns a discriminated result rather than
	 *  throwing, so a failure surfaces a GENERIC inline banner instead of tearing
	 *  through the host. */
	transitionOrder(
		orderId: string,
		toState: string,
		/** `actor`: who made the move — the signed-in operator the console names —
		 *  recorded on the audit event History shows. */
		opts: { idempotencyKey: string; actor?: string },
	): Promise<TransitionOrderResult>;

	/** Resolve an order's reconciliation flag (admin-UX Increment 1). The
	 *  disposition carries `expectedFlag` — the flag detail AS DISPLAYED to the
	 *  admin — and the implementation compare-and-clears against it, so a
	 *  mid-review re-flag conflicts (`RECONCILIATION_FLAG_CHANGED`) instead of
	 *  being cleared blind. Returns a discriminated result; `resolved:false` on
	 *  an `ok` is the benign no-op (already resolved / lost race). */
	resolveReconciliation(
		orderId: string,
		disposition: { expectedFlag: string; outcome: string; reason: string; resolvedBy: string },
		opts: { idempotencyKey: string },
	): Promise<ResolveReconciliationResult>;

	/** Record shipping fulfillment on an order (admin-UX Increment 1). Recording
	 *  fulfillment SHIPS the order (`processing → shipped`) and stores the tracking
	 *  so the buyer's shipped email carries it. Returns a discriminated result;
	 *  forwards a typed `reason` (e.g. `NOT_FULFILLABLE`) so the console can pick
	 *  the right GENERIC copy. */
	recordFulfillment(
		orderId: string,
		fulfillment: {
			carrier: string;
			trackingNumber: string;
			trackingUrl?: string | null;
			shippedAt?: string | null;
			recordedBy: string;
		},
		opts: { idempotencyKey: string },
	): Promise<RecordFulfillmentResult>;

	/** Cancel an order WITH a structured reason (admin-UX Increment 1). A paid
	 *  order is refunded what is still refundable and — unless `restock` is false —
	 *  its units are returned to stock BEFORE it is cancelled (QA T1-4,
	 *  `cancelOrderWithRefund`); a failed refund cancels nothing. Returns a
	 *  discriminated result; forwards a typed `reason` (e.g. `NOT_CANCELLABLE`,
	 *  `REFUND_FAILED` with its `refundFailure`) so the console can pick the right
	 *  GENERIC copy. `restock` defaults to true. */
	cancelOrder(
		orderId: string,
		cancellation: {
			reason: string;
			detail?: string | null;
			cancelledBy: string;
			restock?: boolean;
		},
		opts: { idempotencyKey: string },
	): Promise<CancelOrderResult>;

	/** Read an order's customer context (admin-UX Increment 1). Mirrors
	 *  `getOrder`'s shape: a missing order resolves to `null`; a genuine failure
	 *  throws — the caller degrades to an "unavailable" section, never a hard
	 *  error (and never blanks the order detail). */
	getCustomerContext(orderId: string): Promise<CustomerContextWire | null>;

	/** Read an order's timeline (admin-UX Increment 1). Mirrors
	 *  `getCustomerContext`'s shape: a missing order resolves to `null`; a genuine
	 *  failure throws — the caller degrades to an "unavailable" timeline section,
	 *  never a hard error (and never blanks the order detail). */
	getTimeline(orderId: string): Promise<OrderTimelineWire | null>;

	/** Read an order's refunds summary (ADR-0008): the ledger + the derived
	 *  ceiling/remaining + the gateway's honest capability. A missing order
	 *  resolves to `null`; a genuine failure throws — the caller degrades to an
	 *  "unavailable" refunds section, never a hard error. */
	getRefunds(orderId: string): Promise<RefundsSummaryWire | null>;

	/** Issue or record a refund (ADR-0008). The `idempotencyKey` is REQUIRED —
	 *  refunds are additive, so two deliberate refunds must not collapse. Returns
	 *  a discriminated result; forwards a typed `reason` so the console can pick
	 *  the right GENERIC copy. */
	refundOrder(
		orderId: string,
		refund: { amountCents: number; currency: string; reason?: string | null; refundedBy: string },
		opts: { idempotencyKey: string },
	): Promise<RefundOrderResult>;

	/** A person's answer to a refund whose provider outcome is UNKNOWN (review
	 *  round 2): `confirmed` finalizes it (refundRef optional), `voided` releases
	 *  it. Idempotent; only an `unverified` row can be resolved. */
	resolveUnverifiedRefund(
		orderId: string,
		input: {
			refundKey: string;
			outcome: "confirmed" | "voided";
			refundRef?: string;
			resolvedBy: string;
		},
	): Promise<ResolveUnverifiedRefundResult>;

	/** Read an order's append-only notes. A failure throws — the caller degrades
	 *  to an empty notes surface, never a hard error. */
	listNotes(orderId: string): Promise<OrderNoteWire[]>;

	/** Append a note. Returns a discriminated result so a failure surfaces a
	 *  GENERIC inline banner rather than throwing into the host. */
	addNote(
		orderId: string,
		note: { author: string; body: string },
		opts: { idempotencyKey: string },
	): Promise<AddNoteResult>;
}
