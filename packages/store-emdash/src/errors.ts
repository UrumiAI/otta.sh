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
