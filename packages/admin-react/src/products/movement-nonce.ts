/**
 * The nonce a stock movement carries as its idempotency key: minted FRESH on
 * every Add/Remove click, and re-sent only by an explicit Retry.
 *
 * WHY THE CONSOLE MINTS IT. A stock movement is not idempotent by content: Add 2
 * at 7, Remove 2, Add 2 at 7 is three decisions with one shape, and a key derived
 * from that shape on the server made the third a replay of the first. Only the
 * console knows which submits are one decision, so it says so — each click is
 * one.
 *
 * WHY A CLICK NEVER REUSES ONE. A response can be lost after the write landed,
 * and re-sending under the same nonce is what makes that safe. But a later click
 * that merely LOOKS like the lost one is not its retry — the operator may have
 * checked the count and decided to add the same amount again — so reusing a
 * nonce by resemblance would silently drop genuine moves. The one re-send is the
 * "Retry this change" action the screen offers after an indeterminate failure
 * (`HeldRetry` in `product-detail.tsx`), held in memory only, so a reload or a
 * duplicated tab never inherits a move to re-send.
 *
 * `getRandomValues`, NOT `randomUUID`: `randomUUID` exists only in a secure
 * context, and an admin reached over plain http on a LAN address is not one. 128
 * random bits as hex — 32 characters, inside the plugin's accepted shape.
 */
export function mintMovementNonce(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
