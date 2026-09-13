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
