/**
 * Adapter-level identity failures — conditions about the storage layer rather
 * than about commerce, so they have no home in the domain ports.
 *
 * The ports' own failures are deliberately NOT here: a duplicate email is the
 * domain's `DuplicateCustomerEmailError`, a foreign address id is a `null`/`false`
 * miss by port contract, and every credential outcome is a discriminated union.
 * What is left is the one condition the SQL adapter answered with a primary-key
 * violation.
 */

/**
 * A generated customer id came back already taken by an ACCOUNT.
 *
 * `customers/{customerId}` is written create-if-absent, and a document that is
 * already there is normally the address-only shape the address book creates for an
 * unregistered id — which a create ADOPTS, keeping its addresses, because that is
 * what the missing foreign key allowed. A document that already holds an account
 * is different: the id source has collided, and adopting it would overwrite a live
 * customer's identity fields. It is a programming or id-source failure, never a
 * runtime condition, so it is loud.
 */
export class CustomerIdCollisionError extends Error {
	override readonly name = "CustomerIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "CUSTOMER_ID_COLLISION";
	readonly customerId: string;

	constructor(customerId: string) {
		super(
			`customer id ${customerId} already holds an account — the id source collided and the ` +
				"existing customer was not overwritten",
		);
		this.customerId = customerId;
	}
}

/** Structural test for {@link CustomerIdCollisionError}. */
export function isCustomerIdCollisionError(err: unknown): err is CustomerIdCollisionError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "CUSTOMER_ID_COLLISION"
	);
}

/**
 * A generated challenge id came back already taken.
 *
 * `login_challenges/{challengeId}` is written create-if-absent, so a refusal means
 * a document already exists under the id this call minted. Overwriting it would
 * invalidate a magic link somebody is holding and hand this call's token the other
 * challenge's window, so the id source's collision is reported rather than
 * absorbed. Like every id-source failure in this package it is a programming
 * condition, never a runtime one.
 */
export class ChallengeIdCollisionError extends Error {
	override readonly name = "ChallengeIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "CHALLENGE_ID_COLLISION";
	readonly challengeId: string;

	constructor(challengeId: string) {
		super(
			`challenge id ${challengeId} is already taken — the id source collided and the existing ` +
				"challenge was not overwritten",
		);
		this.challengeId = challengeId;
	}
}

/** Structural test for {@link ChallengeIdCollisionError}. */
export function isChallengeIdCollisionError(err: unknown): err is ChallengeIdCollisionError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "CHALLENGE_ID_COLLISION"
	);
}
