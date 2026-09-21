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
}

export interface OrderDetailWire {
	id: string;
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
}

/** The refunds summary for an order (ADR-0008): the append-only ledger plus the
 *  derived ceiling / remaining-refundable and the gateway's HONEST `refundable`
 *  capability, so the panel shows the right action (a real Stripe refund vs a
 *  recorded manual refund) and never a button that silently no-ops. */
export interface RefundsSummaryWire {
	refunds: RefundWire[];
	currency: string;
	capturedTotalCents: number;
	refundedTotalCents: number;
	ceilingCents: number;
	remainingCents: number;
	paymentMethod: string | null;
	refundable: boolean;
}

/** POST refund returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `recorded:false` on a 2xx ⇒ an idempotent replay (`duplicate`). On a failure,
 *  `reason` carries the service's typed reason when one was returned (e.g.
 *  `REFUND_EXCEEDS_TOTAL`, `PROVIDER_ALREADY_REFUNDED`, `GATEWAY_UNVERIFIED`); the
 *  caller renders GENERIC copy keyed off it, never the raw status/URL. */
export type RefundOrderResult =
	| { ok: true; recorded: boolean; duplicate: boolean; fullyRefunded: boolean }
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
 * than throwing. Money-free — the timeline is an audit surface, not a totals one.
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
	/** cancellation */
	reason?: string;
	detail?: string | null;
	cancelledBy?: string;
	/** reconciliation_resolved */
	outcome?: string;
	resolvedBy?: string;
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

/** POST transition returns a discriminated result (like `updateSettings`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host. */
export type TransitionOrderResult =
	| { ok: true; transitioned: boolean }
	| { ok: false; status: number };

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
	| { ok: true; recorded: boolean }
	| { ok: false; status: number; reason?: string };

/** POST cancel returns a discriminated result (like `transitionOrder`) so a
 *  failure surfaces a GENERIC inline banner rather than throwing into the host.
 *  `cancelled:false` on a 2xx ⇒ the guarded flip found the order already
 *  cancelled with a reason on file (a benign no-op, not a failure). On a
 *  failure, `reason` carries the service's typed reason when one was returned
 *  (e.g. `NOT_CANCELLABLE` — the order can no longer be cancelled); the caller
 *  renders GENERIC copy keyed off it, never the raw status/URL. */
export type CancelOrderResult =
	| { ok: true; cancelled: boolean }
	| { ok: false; status: number; reason?: string };

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
		opts: { idempotencyKey: string },
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

	/** Cancel an order WITH a structured reason (admin-UX Increment 1). Returns a
	 *  discriminated result; forwards a typed `reason` (e.g. `NOT_CANCELLABLE`) so
	 *  the console can pick the right GENERIC copy. */
	cancelOrder(
		orderId: string,
		cancellation: { reason: string; detail?: string | null; cancelledBy: string },
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
