/**
 * Adapter-level errors — conditions that are about the storage layer rather than
 * about commerce, so they have no home in the domain port.
 *
 * (`StorageContentionError`, the retry-exhaustion failure, lives with the retry
 * loop in `cas-retry.ts`, because its ceiling and its meaning are the same fact.)
 */

/**
 * A reservation id came back already taken.
 *
 * `reservation_index/{reservationId}` is written create-if-absent before the hold,
 * and `applied: false` means a document already exists under that id. If it is
 * not this same reserve key's own entry — a replay finishing its own claim — then
 * the id source has collided, and adopting the existing entry would silently
 * attach this reserve to somebody else's reservation. It is a programming or
 * id-source failure, never a runtime condition, so it is loud.
 */
export class ReservationIdCollisionError extends Error {
	override readonly name = "ReservationIdCollisionError";
	readonly reservationId: string;
	readonly idempotencyKey: string;

	constructor(reservationId: string, idempotencyKey: string, heldBy: string) {
		super(
			`reservation id ${reservationId} is already indexed against idempotency key ${heldBy}, ` +
				`not ${idempotencyKey} — the id source collided and the existing reservation was not adopted`,
		);
		this.reservationId = reservationId;
		this.idempotencyKey = idempotencyKey;
	}
}

/**
 * A `release` was asked for a reservation that is not releasable: it exists, but
 * it is already `committed` (or `failed`) rather than live-held or already
 * released.
 *
 * It replaces a bare `Error` on that path. The condition is a real one a caller
 * may want to classify — the cart expiry swallows it, because a hold an order
 * already committed is not the cart's to return — and an untyped error forces
 * that caller to match on a message. The message is unchanged from the bare error
 * it replaces, so nothing reading the text has to change.
 *
 * It is an ADAPTER error rather than the domain's `ReservationNotHeldError`: that
 * class is the port's `adjust` failure and its message says "cannot adjust", which
 * would be false here. Widening the port to cover `release` is a domain change
 * with its own PR.
 */
export class ReservationNotReleasableError extends Error {
	override readonly name = "ReservationNotReleasableError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "RESERVATION_NOT_RELEASABLE";
	readonly reservationId: string;
	/** The state the reservation was found in: `committed` or `failed`. */
	readonly state: string;

	constructor(reservationId: string, state: string) {
		super(`cannot release reservation ${reservationId} in state ${state}`);
		this.reservationId = reservationId;
		this.state = state;
	}
}

/** Structural test for {@link ReservationNotReleasableError}. */
export function isReservationNotReleasableError(
	err: unknown,
): err is ReservationNotReleasableError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "RESERVATION_NOT_RELEASABLE"
	);
}

/**
 * An order id came back already taken by a DIFFERENT idempotency key.
 *
 * `orders/{orderId}` is created create-if-absent from the key claim's payload, and
 * `applied: false` means a document already exists under that id. If it is not
 * this key's own order — a replay finishing its own claim — then the id source has
 * collided, and returning the existing order would silently hand this checkout
 * somebody else's order, with somebody else's lines and total. It is a programming
 * or id-source failure, never a runtime condition, so it is loud.
 *
 * The inventory sibling is {@link ReservationIdCollisionError}; the reasoning and
 * the shape are deliberately the same.
 */
export class OrderIdCollisionError extends Error {
	override readonly name = "OrderIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "ORDER_ID_COLLISION";
	readonly orderId: string;
	readonly idempotencyKey: string;

	constructor(orderId: string, idempotencyKey: string, heldBy: string) {
		super(
			`order id ${orderId} already exists under idempotency key ${heldBy}, not ` +
				`${idempotencyKey} — the id source collided and the existing order was not adopted`,
		);
		this.orderId = orderId;
		this.idempotencyKey = idempotencyKey;
	}
}

/**
 * `recordPayment` was handed an order id that has no document.
 *
 * The SQL adapter's insert would have failed its foreign key; the document store has
 * no foreign keys, so the alternative to this error is a silent no-op — money
 * recorded nowhere, on the settle path, with the call reporting success. That is the
 * one outcome a payments ledger must never have, so it is loud.
 */
export class OrderNotFoundError extends Error {
	override readonly name = "OrderNotFoundError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "ORDER_NOT_FOUND";
	readonly orderId: string;
	readonly operation: string;

	constructor(orderId: string, operation: string) {
		super(`${operation} found no order document for ${orderId} — nothing was recorded`);
		this.orderId = orderId;
		this.operation = operation;
	}
}

/** Structural test for {@link OrderNotFoundError}. */
export function isOrderNotFoundError(err: unknown): err is OrderNotFoundError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ORDER_NOT_FOUND"
	);
}

/**
 * A payment provider reference already belongs to a DIFFERENT order.
 *
 * `payment_refs/{providerRef}` is the global once-only that `payments.provider_ref`
 * UNIQUE was. A redelivered webhook against the same order is a benign no-op; the
 * same reference arriving against another order means one payment is about to be
 * counted twice — and `Σ captured` is the refund ceiling — so it is refused loudly
 * rather than recorded.
 */
export class PaymentRefConflictError extends Error {
	override readonly name = "PaymentRefConflictError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "PAYMENT_REF_CONFLICT";
	readonly providerRef: string;
	readonly orderId: string;
	/** The order that already holds the reference. */
	readonly heldBy: string;

	constructor(providerRef: string, orderId: string, heldBy: string) {
		super(
			`payment reference ${providerRef} is already recorded against order ${heldBy}, ` +
				`not ${orderId} — recording it twice would double the captured total`,
		);
		this.providerRef = providerRef;
		this.orderId = orderId;
		this.heldBy = heldBy;
	}
}

/** Structural test for {@link PaymentRefConflictError}. */
export function isPaymentRefConflictError(err: unknown): err is PaymentRefConflictError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "PAYMENT_REF_CONFLICT"
	);
}

/**
 * A paged scan hit its page ceiling with more pages to read.
 *
 * The alternative is silent truncation, and for `listExpirable` that means an order
 * whose hold is past its deadline is never swept — stock held out of sale forever,
 * reported as "nothing to expire". The ceiling exists so a runaway cursor cannot
 * loop without bound; hitting it is an operational condition (far more expirable
 * orders than the sweep's page budget), so it is a typed signal rather than a lie.
 *
 * **The remedy is to raise the page budget** — `EmdashOrderStoreOptions.maxExpiryPages`
 * for the expiry scan, `maxOutboxPages` for the email claim and settle scans (each
 * default 1000 pages of 100, and each raised on its own, because the two scans are
 * bounded by different things) — not to retry the same call: nothing was written, but
 * nothing was returned either, so a bare retry re-reads the same pages and stops in
 * the same place. `collected` says how many rows the scan had reached before it gave
 * up, which is how far the budget got — and `retryable` means only that the call is
 * safe to re-issue, never that re-issuing it unchanged will get further.
 */
export class ScanPageLimitError extends Error {
	override readonly name = "ScanPageLimitError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SCAN_PAGE_LIMIT";
	/**
	 * Nothing was written, so the call is safe to re-issue. It will NOT get further
	 * unchanged, though — raise the page budget (see the class docblock).
	 */
	readonly retryable = true as const;
	readonly operation: string;
	readonly pages: number;
	/** What the scan had collected before it gave up — never silently returned. */
	readonly collected: number;
	/** WHICH page budget to raise — the remedy names the option, not a guess. */
	readonly budgetOption: string;

	constructor(
		operation: string,
		pages: number,
		collected: number,
		budgetOption = "maxExpiryPages",
	) {
		super(
			`${operation} reached its ${String(pages)}-page ceiling with more pages to read ` +
				`(${String(collected)} rows collected before giving up) — returning them would have ` +
				`been a silent truncation; raise the page budget (${budgetOption}) rather than ` +
				"re-running this call unchanged",
		);
		this.operation = operation;
		this.pages = pages;
		this.collected = collected;
		this.budgetOption = budgetOption;
	}
}

/** Structural test for {@link ScanPageLimitError}. */
export function isScanPageLimitError(err: unknown): err is ScanPageLimitError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "SCAN_PAGE_LIMIT"
	);
}

/**
 * A settle arrived for an outbox entry no locator names and no index walk can find.
 *
 * Thrown by `markEmailSent` / `rescheduleEmail` — and deliberately, rather than the
 * silent no-op the earlier walk-only implementation returned. The two cases a silent
 * return conflated are NOT equivalent: an entry that is already terminal has a LOCATOR
 * (so it never reaches the walk at all, and its settle is a guarded no-op), while an
 * entry whose locator was lost and whose row the walk missed is still `sending` — and
 * returning quietly there leaves a live lease to lapse and the message to be claimed and
 * sent a second time. So the unresolvable case is loud.
 *
 * `retryable` is true because nothing was written and the locator may simply have been
 * written by a peer a moment later; the caller's own retry, or the next dispatcher tick,
 * is the remedy. It is not a promise that an unchanged retry will find it.
 */
export class OutboxEntryUnlocatableError extends Error {
	override readonly name = "OutboxEntryUnlocatableError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "OUTBOX_ENTRY_UNLOCATABLE";
	readonly retryable = true as const;
	readonly entryId: string;
	/** How many pages the fallback walk read before giving up on finding it. */
	readonly pages: number;

	constructor(entryId: string, pages: number) {
		super(
			`outbox entry ${entryId} could not be located: no outbox_keys locator names it and ` +
				`${String(pages)} page(s) of the emailDueAt index do not hold it — refusing to settle ` +
				"silently, because a lost locator over a still-claimed entry would leave its lease to " +
				"lapse and the message to be sent twice",
		);
		this.entryId = entryId;
		this.pages = pages;
	}
}

/** Structural test for {@link OutboxEntryUnlocatableError}. */
export function isOutboxEntryUnlocatableError(err: unknown): err is OutboxEntryUnlocatableError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "OUTBOX_ENTRY_UNLOCATABLE"
	);
}

/**
 * A DERIVED pointer document already exists and names a different order.
 *
 * The two pointer collections — `order_sku_index` and `outbox_keys` — are written
 * create-if-absent, and a refused write normally means "a peer or a replay already wrote
 * exactly this". That is only safe if the incumbent agrees, so the refusal is READ BACK
 * and compared. A disagreement means an id source collided (a duplicated outbox entry id,
 * a hand-written pointer), and adopting it would mis-route a settle onto somebody else's
 * order or make the sku search answer with it — loud, never adopted.
 */
export class DerivedPointerConflictError extends Error {
	override readonly name = "DerivedPointerConflictError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "DERIVED_POINTER_CONFLICT";
	readonly collection: string;
	readonly pointerId: string;
	readonly expectedOrderId: string;
	readonly foundOrderId: string;

	constructor(collection: string, pointerId: string, expected: string, found: string) {
		super(
			`${collection}/${pointerId} already points at order ${found}, not ${expected} — the ` +
				"pointer is derived, so adopting a disagreeing incumbent would silently attach this " +
				"order's reads to another order's document",
		);
		this.collection = collection;
		this.pointerId = pointerId;
		this.expectedOrderId = expected;
		this.foundOrderId = found;
	}
}

/** Structural test for {@link DerivedPointerConflictError}. */
export function isDerivedPointerConflictError(err: unknown): err is DerivedPointerConflictError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "DERIVED_POINTER_CONFLICT"
	);
}
