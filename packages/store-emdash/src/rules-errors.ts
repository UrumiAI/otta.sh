/**
 * The rules adapters' own errors — the primary keys and foreign keys the SQL
 * adapters leaned on, raised here instead.
 *
 * All four are LOUD, and deliberately so: each replaces a constraint violation
 * that aborted a transaction, and the ports' result types have no member for
 * "that id is taken" or "that zone does not exist" because the SQL adapters had
 * none either. A caller that could be handed one is a caller with a bug, not a
 * caller in a runtime condition.
 */

/** `createZone` was handed an id that already has a zone document (the PK). */
export class ShippingZoneIdCollisionError extends Error {
	override readonly name = "ShippingZoneIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SHIPPING_ZONE_ID_COLLISION";
	readonly zoneId: string;

	constructor(zoneId: string) {
		super(
			`shipping zone ${zoneId} already exists — a zone id is its immutable identity, ` +
				"and a create never re-defines one",
		);
		this.zoneId = zoneId;
	}
}

/**
 * `createMethod` named a zone with no document.
 *
 * `shipping_methods.zone_id` was a foreign key, so the insert was refused and the
 * transaction rolled back. Here the method-id claim is written first, so this
 * error is raised only AFTER the claim has been given back — a refused create
 * leaves nothing behind.
 */
export class ShippingZoneNotFoundError extends Error {
	override readonly name = "ShippingZoneNotFoundError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SHIPPING_ZONE_NOT_FOUND";
	readonly zoneId: string;

	constructor(zoneId: string) {
		super(`shipping zone ${zoneId} has no document — a method cannot be created outside a zone`);
		this.zoneId = zoneId;
	}
}

/**
 * `createMethod` was handed an id a LIVE method already holds.
 *
 * `shipping_methods.id` was a primary key across every zone, and the claim
 * document `shipping_method_owners/{methodId}` is what enforces that here. A
 * claim whose zone no longer holds the method is taken over rather than treated
 * as a conflict, so a crash between claiming an id and embedding the method does
 * not strand the id forever.
 */
export class ShippingMethodIdCollisionError extends Error {
	override readonly name = "ShippingMethodIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SHIPPING_METHOD_ID_COLLISION";
	readonly methodId: string;
	readonly heldBy: string;

	constructor(methodId: string, heldBy: string) {
		super(
			`shipping method id ${methodId} is already held by zone ${heldBy} — ` +
				"a method id identifies one method store-wide",
		);
		this.methodId = methodId;
		this.heldBy = heldBy;
	}
}

/**
 * `createRate` named a shipping method with no document.
 *
 * `shipping_rates.method_id` was a foreign key; same reasoning as
 * {@link ShippingZoneNotFoundError}.
 */
export class ShippingMethodNotFoundError extends Error {
	override readonly name = "ShippingMethodNotFoundError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SHIPPING_METHOD_NOT_FOUND";
	readonly methodId: string;

	constructor(methodId: string) {
		super(`shipping method ${methodId} has no document — a rate cannot be created without one`);
		this.methodId = methodId;
	}
}

/**
 * `createRate` was handed a `(methodId, currency)` that already has a rate.
 *
 * That pair was `shipping_rates`' primary key, so the second insert was refused.
 * The refusal is kept rather than softened into an upsert: a create that silently
 * replaced a price would overwrite money a shopper is being quoted, and the port
 * has `updateRate` — with its compare-and-set — for changing one.
 */
export class ShippingRateExistsError extends Error {
	override readonly name = "ShippingRateExistsError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SHIPPING_RATE_EXISTS";
	readonly methodId: string;
	readonly currency: string;

	constructor(methodId: string, currencyCode: string) {
		super(
			`shipping method ${methodId} already has a ${currencyCode} rate — ` +
				"one rate per method and currency; edit it with updateRate",
		);
		this.methodId = methodId;
		this.currency = currencyCode;
	}
}

/** `createClass` was handed an id that is already a DECLARED class (the PK). */
export class TaxClassIdCollisionError extends Error {
	override readonly name = "TaxClassIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "TAX_CLASS_ID_COLLISION";
	readonly taxClassId: string;

	constructor(taxClassId: string) {
		super(
			`tax class ${taxClassId} already exists — a class id is the referent every rate and ` +
				"product points at, and a create never re-defines one",
		);
		this.taxClassId = taxClassId;
	}
}

/**
 * `createRate` was handed a rate id a LIVE rate already holds.
 *
 * `tax_rates.id` was a primary key across every class, and the claim document
 * `tax_rate_owners/{rateId}` enforces it here — with the same orphan takeover as
 * {@link ShippingMethodIdCollisionError}.
 */
export class TaxRateIdCollisionError extends Error {
	override readonly name = "TaxRateIdCollisionError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "TAX_RATE_ID_COLLISION";
	readonly rateId: string;
	readonly heldBy: string;

	constructor(rateId: string, heldBy: string) {
		super(
			`tax rate id ${rateId} is already held by class ${heldBy} — ` +
				"a rate id identifies one rate store-wide",
		);
		this.rateId = rateId;
		this.heldBy = heldBy;
	}
}

/** Structural test for {@link ShippingZoneIdCollisionError}. */
export function isShippingZoneIdCollisionError(err: unknown): err is ShippingZoneIdCollisionError {
	return hasCode(err, "SHIPPING_ZONE_ID_COLLISION");
}

/** Structural test for {@link ShippingZoneNotFoundError}. */
export function isShippingZoneNotFoundError(err: unknown): err is ShippingZoneNotFoundError {
	return hasCode(err, "SHIPPING_ZONE_NOT_FOUND");
}

/** Structural test for {@link ShippingMethodIdCollisionError}. */
export function isShippingMethodIdCollisionError(
	err: unknown,
): err is ShippingMethodIdCollisionError {
	return hasCode(err, "SHIPPING_METHOD_ID_COLLISION");
}

/** Structural test for {@link ShippingMethodNotFoundError}. */
export function isShippingMethodNotFoundError(err: unknown): err is ShippingMethodNotFoundError {
	return hasCode(err, "SHIPPING_METHOD_NOT_FOUND");
}

/** Structural test for {@link ShippingRateExistsError}. */
export function isShippingRateExistsError(err: unknown): err is ShippingRateExistsError {
	return hasCode(err, "SHIPPING_RATE_EXISTS");
}

/** Structural test for {@link TaxClassIdCollisionError}. */
export function isTaxClassIdCollisionError(err: unknown): err is TaxClassIdCollisionError {
	return hasCode(err, "TAX_CLASS_ID_COLLISION");
}

/** Structural test for {@link TaxRateIdCollisionError}. */
export function isTaxRateIdCollisionError(err: unknown): err is TaxRateIdCollisionError {
	return hasCode(err, "TAX_RATE_ID_COLLISION");
}

function hasCode(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
