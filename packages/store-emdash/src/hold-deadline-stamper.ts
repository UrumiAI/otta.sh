/**
 * The adapter-level capability the cart store needs and the domain port does not
 * declare: stamping a live hold's deadline.
 *
 * `CartStore.upsertLine`'s contract is explicit that the deadline stamp is also
 * the **attach guard** — "it is scoped to `state='held'`, and a reservation that is
 * no longer held … throws `HoldExpiredError` instead of resurrecting a visible line
 * over dead stock". The SQL adapter got both halves from one statement
 * (`UPDATE reservations SET expires_at = :deadline WHERE id = :id AND
 * state = 'held'`). A *read* of the hold cannot: between the read and the cart
 * write the sweep can reap the hold, and the line would be resurrected anyway.
 *
 * `InventoryStore` has no method for it, and widening the port is a domain change
 * this increment may not make. So the capability is declared here, adapter-local,
 * and the cart store's constructor asks for `InventoryStore & HoldDeadlineStamper`
 * — which is also what keeps a store that cannot supply it (the Kysely adapter,
 * whose own cart store stamps inline) from being injected by mistake.
 */
export interface HoldDeadlineStamper {
	/**
	 * Set the live hold's deadline, **only while it is still `held`**.
	 *
	 * One guarded read-modify-write on the inventory aggregate: the state
	 * precondition, the ownership check and the new deadline commit together, so a
	 * `true` return is durable proof the hold was live at the instant of the write.
	 *
	 * Returns `false` — never throws — when there is no such live hold to stamp:
	 * an unknown reservation, a hold already pruned (committed/released/reaped), or
	 * one that has left `held` (adopted by an order). It NEVER touches a non-`held`
	 * hold, so it can neither extend an order's adopted deadline nor revive a reaped
	 * one.
	 *
	 * Idempotent: stamping the deadline a hold already carries writes nothing and
	 * still reports `true`.
	 *
	 * `expiresAt` is NON-NULL, and that is a narrowing over what the first cut
	 * accepted (a recorded follow-up from INC-B1's review). A stamp is always the
	 * attach of a line to a LIVE hold, and `adopt`/`adoptMany` are scoped
	 * `expires_at > :now`, so a hold stamped with no deadline could never be
	 * adopted — writing one would create exactly the hold that checkout classifies
	 * as lost. The domain never asks for it either: `expiresAt` is null on a cart
	 * line only when `reservationId` is too (a digital line reserves nothing), and
	 * that line never reaches a stamp. The type is what keeps it that way.
	 */
	stampHoldDeadline(reservationId: string, expiresAt: string): Promise<boolean>;
}
