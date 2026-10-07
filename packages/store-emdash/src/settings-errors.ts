/**
 * Adapter-level settings failures.
 *
 * The port's own answers are not here: `get` never errors, and a replay of a mutation
 * that landed returns its recorded result. What is left is the one condition the SQL
 * adapter could not have — it settled the claim and the write inside one transaction,
 * so "the world moved between them" was not a state that existed.
 */

/**
 * A mutation whose claim exists but never landed can no longer be applied: the settings
 * have moved since it was decided.
 *
 * The claim records the settings revision its creator read. A caller that did NOT create
 * it — a replay, a retry from another process — may only complete it by a compare-and-set
 * at exactly that revision. If the revision has moved, the patch was computed against a
 * state that no longer exists, and applying it would overwrite whatever replaced that
 * state: precisely the clobber the port forbids ("a stale replay arriving after a newer
 * update never clobbers it back").
 *
 * So the completion is REFUSED rather than re-decided, and the refusal is
 * **non-retryable**: nothing about re-issuing the same key can succeed, because the
 * revision it is pinned to will never come back. The remedy is a fresh idempotency key,
 * which is a new decision against the current state — which is what the operator would
 * want anyway, having seen a value they did not write.
 *
 * The trade is over-refusal, and it is the right direction: an update that was decided,
 * never landed, and has been overtaken is refused, where the alternative is silently
 * reverting the value that overtook it.
 */
export class SettingsMutationSupersededError extends Error {
	override readonly name = "SettingsMutationSupersededError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SETTINGS_MUTATION_SUPERSEDED";
	/** Re-issuing this key cannot succeed; issue a new one. */
	readonly retryable = false as const;
	/** The mutation key that can no longer be completed. */
	readonly idempotencyKey: string;
	/** The settings revision the claim was decided against. */
	readonly decidedRevision: string | null;
	/** The revision found instead — what overtook it. */
	readonly currentRevision: string | null;

	constructor(
		idempotencyKey: string,
		decidedRevision: string | null,
		currentRevision: string | null,
	) {
		super(
			`settings mutation ${idempotencyKey} was decided against revision ` +
				`${decidedRevision ?? "(none)"} and the settings are now at ` +
				`${currentRevision ?? "(none)"} — completing it would overwrite the update that ` +
				"overtook it, so it is refused; re-issue under a fresh idempotency key",
		);
		this.idempotencyKey = idempotencyKey;
		this.decidedRevision = decidedRevision;
		this.currentRevision = currentRevision;
	}
}

/** Structural test for {@link SettingsMutationSupersededError}. */
export function isSettingsMutationSupersededError(
	err: unknown,
): err is SettingsMutationSupersededError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "SETTINGS_MUTATION_SUPERSEDED"
	);
}
