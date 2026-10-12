import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { EntitlementStore } from "../ports/entitlement-store.js";
import type { OrderNotesStore } from "../ports/order-notes-store.js";
import type { OrderStore } from "../ports/order-store.js";

export interface RevokeDownloadAccessDeps {
	orderStore: OrderStore;
	entitlementStore: EntitlementStore;
	/** Where the revocation is recorded: a note on the order, so History shows
	 *  who closed access and when. */
	orderNotesStore: OrderNotesStore;
}

export interface RevokeDownloadAccessCommand {
	orderId: OrderId;
	/** Who closed access — recorded as the note's author. */
	revokedBy: string;
	/** Every command carries one (CLAUDE.md). It keys the audit note, so a
	 *  replay records nothing new. */
	idempotencyKey: IdempotencyKey;
}

export type RevokeDownloadAccessFailure = "ORDER_NOT_FOUND" | "NO_DOWNLOADS" | "EMPTY_REVOKED_BY";

/** `revoked: false` is the idempotent replay: access was already closed by this
 *  command and nothing new was written. */
export type RevokeDownloadAccessOutcome =
	| { ok: true; revoked: boolean }
	| { ok: false; reason: RevokeDownloadAccessFailure };

/** The body of the note the revocation leaves on the order. */
export const DOWNLOAD_ACCESS_REVOKED_NOTE =
	"Download access revoked. The buyer's download links for this order no longer work.";

/**
 * Close a paid order's download access by hand (issue #447): the path for money
 * that left WITHOUT moving the order — a dispute or chargeback — which none of
 * the full-refund revocations (`revokeOrderEntitlements`) can see.
 *
 * It revokes every grant the order made (`revokeByOrder`, terminal and
 * idempotent), THEN records a note authored by `revokedBy` under the command's
 * key. Revoke first, so a crash between the two leaves access closed and the
 * retry writes the missing note; the key makes that note once-only, which is
 * what makes the whole command idempotent. The download gate reads the grant
 * fresh on every request, so the refusal is immediate.
 *
 * An order with no digital line has nothing to revoke and is refused, so the
 * command never writes a note claiming access that never existed was closed.
 */
export async function revokeOrderDownloadAccess(
	deps: RevokeDownloadAccessDeps,
	cmd: RevokeDownloadAccessCommand,
): Promise<RevokeDownloadAccessOutcome> {
	const revokedBy = cmd.revokedBy.trim();
	if (revokedBy.length === 0) return { ok: false, reason: "EMPTY_REVOKED_BY" };

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
	if (!order.lines.some((line) => line.fulfillmentKind === "digital")) {
		return { ok: false, reason: "NO_DOWNLOADS" };
	}

	await deps.entitlementStore.revokeByOrder(order.id);
	const { appended } = await deps.orderNotesStore.append({
		orderId: order.id,
		author: revokedBy,
		body: DOWNLOAD_ACCESS_REVOKED_NOTE,
		idempotencyKey: cmd.idempotencyKey,
	});
	return { ok: true, revoked: appended };
}
