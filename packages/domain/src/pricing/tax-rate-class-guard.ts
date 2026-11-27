import type { TaxClassId } from "./types.js";

/**
 * `createRate` was asked, with `requireDeclaredClass: true`, for a rate whose tax
 * class is not declared — never created, deleted, or present only as the holder
 * of rates written for a class nobody declared (#742). No rate was written.
 *
 * The check runs inside the store's own atomic write, so it also refuses a class
 * deleted by a peer between a caller's read of the class list and the create —
 * the window a read-then-write pre-check cannot close.
 */
export class TaxRateClassNotDeclaredError extends Error {
	override readonly name = "TaxRateClassNotDeclaredError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "TAX_RATE_CLASS_NOT_DECLARED";
	readonly taxClassId: TaxClassId;

	constructor(taxClassId: TaxClassId) {
		super(
			`tax class ${taxClassId} is not declared — a rate requiring a declared class was refused`,
		);
		this.taxClassId = taxClassId;
	}
}

/** Structural test for {@link TaxRateClassNotDeclaredError}: the code and the class
 *  it names. */
export function isTaxRateClassNotDeclaredError(err: unknown): err is TaxRateClassNotDeclaredError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "TAX_RATE_CLASS_NOT_DECLARED" &&
		typeof (err as { taxClassId?: unknown }).taxClassId === "string"
	);
}
