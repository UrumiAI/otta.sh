/**
 * The shipping- and tax-rules documents: one document per zone, one per tax
 * class, and the two id-claim documents the port signatures force.
 *
 * The SQL adapters held five tables joined by foreign keys — `shipping_zones →
 * shipping_methods → shipping_rates` and `tax_classes` beside `tax_rates` — and
 * leaned on them for three separate things: the parent/child referential guards
 * (`DELETE … WHERE NOT EXISTS (children)`), the primary keys that made an id
 * unique, and the reverse lookups a child-id-only signature needs. Only the
 * first of those survives being embedded; the other two are documents.
 *
 * | Document | What it is |
 * |---|---|
 * | `shipping_zones/{zoneId}` | the zone, its `methods` map keyed by method id, and each method's `rates` map keyed by currency |
 * | `shipping_method_owners/{methodId}` | `{ zoneId }` — the method-id uniqueness claim, and the only way to reach a method from an id alone |
 * | `tax_classes/{classId}` | the class registry entry (`name`) and its `rates` map keyed by rate id |
 * | `tax_rate_owners/{rateId}` | `{ taxClassId }` — the rate-id uniqueness claim, and the only way to reach a rate from an id alone |
 *
 * **Why the two claim documents exist.** Six port methods take a child id with no
 * parent: `getMethod`, `updateMethod`, `deleteMethod` and the three rate methods
 * keyed by `methodId` on the shipping side; `updateRate` and `deleteRate` on the
 * tax side. With the children embedded there is no document to read, and a scan
 * would answer the question ambiguously the moment two zones could hold the same
 * method id — which SQL made impossible with a primary key and which no declared
 * index enforces here (see the README's "no physical indexes"). The claim
 * document is therefore both halves at once: create-if-absent on the document id
 * IS the uniqueness enforcement (the storage table's own primary key), and the
 * `zoneId`/`taxClassId` it carries IS the reverse lookup. It is the
 * `reservation_index` device from ADR-0019, for the same reason.
 *
 * **Why a tax class document may exist with no class in it.** `tax_rates` had NO
 * foreign key to `tax_classes` — the contract creates rates for classes that were
 * never declared, and `countRatesByClass` counts them — so the document that
 * holds a class's rates cannot require the class. {@link TaxClassDoc.name} is
 * therefore nullable: `null` means "rates only, no registry entry", which
 * `listClasses` skips and `updateClass`/`deleteClass` answer `not_found` for,
 * exactly as the missing row did.
 *
 * **Nothing here is indexed**, matching ADR-0019's index table: every read is a
 * document id lookup, or a bounded paged scan of a collection whose size is the
 * merchant's zone/class count. Ordering is done in code, because `ORDER BY` needs
 * a declared index and these collections declare none.
 */
import {
	cents,
	currency as toCurrency,
	type Cents,
	type Currency,
	type ShippingMethod,
	type ShippingMethodType,
	type ShippingRate,
	type ShippingZone,
	type TaxClass,
	type TaxClassId,
	type TaxRate,
} from "@otta-sh/domain";

/** Collection name: the shipping zone aggregate, one document per zone. */
export const SHIPPING_ZONES_COLLECTION = "shipping_zones";
/** Collection name: the method-id claim, one document per method id. */
export const SHIPPING_METHOD_OWNERS_COLLECTION = "shipping_method_owners";
/** Collection name: the tax class aggregate, one document per class id. */
export const TAX_CLASSES_COLLECTION = "tax_classes";
/** Collection name: the tax-rate-id claim, one document per rate id. */
export const TAX_RATE_OWNERS_COLLECTION = "tax_rate_owners";

/** One collection as the plugin descriptor declares it. */
export interface RulesCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The collections `EmdashShippingRulesStore` needs, as the descriptor declares
 * them: no indexes at all. Every read is a document id lookup or an unfiltered
 * paged scan, and both are index-free — a `where`/`orderBy` is what needs a
 * declaration, and this store issues none.
 */
export const SHIPPING_RULES_COLLECTIONS: Readonly<
	Record<string, RulesCollectionIndexDeclaration>
> = {
	[SHIPPING_ZONES_COLLECTION]: {},
	[SHIPPING_METHOD_OWNERS_COLLECTION]: {},
};

/** The collections `EmdashTaxRulesStore` needs. Index-free, as above. */
export const TAX_RULES_COLLECTIONS: Readonly<Record<string, RulesCollectionIndexDeclaration>> = {
	[TAX_CLASSES_COLLECTION]: {},
	[TAX_RATE_OWNERS_COLLECTION]: {},
};

/** Both rules stores' collections, for a caller that wires the pair. */
export const RULES_COLLECTIONS: Readonly<Record<string, RulesCollectionIndexDeclaration>> = {
	...SHIPPING_RULES_COLLECTIONS,
	...TAX_RULES_COLLECTIONS,
};

/** One shipping rate, as embedded in its method. Keyed by currency. */
export interface ShippingRateDoc {
	/** ISO-4217 alpha code — the key this rate is stored under, kept in the value. */
	readonly currency: string;
	/** Integer minor units. The money-bearing field `updateRate` CAS-guards. */
	readonly amountCents: number;
	/** Free-shipping threshold in integer minor units; `null` = none. */
	readonly minSubtotalCents: number | null;
}

/** One shipping method, as embedded in its zone. Keyed by method id. */
export interface ShippingMethodDoc {
	readonly methodId: string;
	readonly name: string;
	readonly type: ShippingMethodType;
	/** The method's rates, keyed by currency — the SQL's `(method, currency)` key. */
	readonly rates: Readonly<Record<string, ShippingRateDoc>>;
}

/** The shipping zone aggregate. */
export interface ShippingZoneDoc {
	readonly zoneId: string;
	readonly name: string;
	/** Opaque match list the engine never reads; `null` = none. */
	readonly regions: unknown;
	/** The zone's methods, keyed by method id. */
	readonly methods: Readonly<Record<string, ShippingMethodDoc>>;
}

/** The method-id claim: which zone document holds that method. */
export interface ShippingMethodOwnerDoc {
	readonly methodId: string;
	readonly zoneId: string;
	readonly claimedAt: string;
}

/** One tax rate, as embedded in its class. Keyed by rate id. */
export interface TaxRateDoc {
	readonly rateId: string;
	readonly zoneId: string;
	/** Integer basis points. The money-bearing field `updateRate` CAS-guards. */
	readonly rateBps: number;
	readonly appliesToShipping: boolean;
}

/**
 * The tax class aggregate — or just its rates.
 *
 * `name` is `null` when no class was ever created and the document exists only to
 * hold rates (the SQL had no foreign key, and the contract relies on that).
 */
export interface TaxClassDoc {
	readonly taxClassId: string;
	readonly name: string | null;
	/** The class's rates, keyed by rate id — the SQL's `tax_rates.id` primary key. */
	readonly rates: Readonly<Record<string, TaxRateDoc>>;
}

/** The rate-id claim: which class document holds that rate. */
export interface TaxRateOwnerDoc {
	readonly rateId: string;
	readonly taxClassId: string;
	readonly claimedAt: string;
}

/**
 * Fill in what an older or partially-written document may not carry.
 *
 * Every read goes through it for the same reason the sibling stores normalize:
 * `noUncheckedIndexedAccess` protects the call sites from a missing KEY, not from
 * a document written before a field existed, and a store that indexed straight
 * into `doc.methods` would throw on one.
 */
export function normalizeZoneDoc(doc: ShippingZoneDoc): ShippingZoneDoc {
	return {
		zoneId: doc.zoneId,
		name: doc.name,
		regions: doc.regions ?? null,
		methods: Object.fromEntries(
			Object.entries(doc.methods ?? {}).map(([id, method]) => [id, normalizeMethodDoc(method)]),
		),
	};
}

/** As {@link normalizeZoneDoc}, for one embedded method. */
export function normalizeMethodDoc(doc: ShippingMethodDoc): ShippingMethodDoc {
	return { ...doc, rates: doc.rates ?? {} };
}

/** As {@link normalizeZoneDoc}, for a tax class document. */
export function normalizeTaxClassDoc(doc: TaxClassDoc): TaxClassDoc {
	return {
		taxClassId: doc.taxClassId,
		name: doc.name ?? null,
		rates: doc.rates ?? {},
	};
}

/** The zone as the port returns it. */
export function toShippingZone(doc: ShippingZoneDoc): ShippingZone {
	return { id: doc.zoneId, name: doc.name, regions: doc.regions ?? null };
}

/** The method as the port returns it — the zone id comes from its holder. */
export function toShippingMethod(zoneId: string, doc: ShippingMethodDoc): ShippingMethod {
	return { id: doc.methodId, zoneId, name: doc.name, type: doc.type };
}

/** The rate as the port returns it, with money re-branded on the way out. */
export function toShippingRate(methodId: string, doc: ShippingRateDoc): ShippingRate {
	return {
		methodId,
		currency: toCurrency(doc.currency),
		amountCents: cents(doc.amountCents),
		minSubtotalCents: doc.minSubtotalCents === null ? null : cents(doc.minSubtotalCents),
	};
}

/** The registry entry as the port returns it. Only a DECLARED class has one. */
export function toTaxClass(doc: TaxClassDoc): TaxClass | null {
	return doc.name === null ? null : { id: doc.taxClassId, name: doc.name };
}

/** The tax rate as the port returns it — the class id comes from its holder. */
export function toTaxRate(taxClassId: TaxClassId, doc: TaxRateDoc): TaxRate {
	return {
		id: doc.rateId,
		taxClassId,
		zoneId: doc.zoneId,
		rateBps: doc.rateBps,
		appliesToShipping: doc.appliesToShipping,
	};
}

/** The rate doc for a new shipping rate. Money is stored as integer minor units. */
export function newShippingRateDoc(input: {
	currency: Currency;
	amountCents: Cents;
	minSubtotalCents: Cents | null;
}): ShippingRateDoc {
	return {
		currency: input.currency,
		amountCents: input.amountCents,
		minSubtotalCents: input.minSubtotalCents,
	};
}

/** A zone's methods in the SQL adapter's `ORDER BY id` order, sorted in code. */
export function methodsOf(doc: ShippingZoneDoc): ShippingMethodDoc[] {
	return Object.values(doc.methods).toSorted((a, b) => (a.methodId < b.methodId ? -1 : 1));
}

/** A class's rates in the SQL adapter's `ORDER BY id` order, sorted in code. */
export function ratesOf(doc: TaxClassDoc): TaxRateDoc[] {
	return Object.values(doc.rates).toSorted((a, b) => (a.rateId < b.rateId ? -1 : 1));
}

/** Replace (or add) one method inside a zone document. */
export function withMethod(doc: ShippingZoneDoc, method: ShippingMethodDoc): ShippingZoneDoc {
	return { ...doc, methods: { ...doc.methods, [method.methodId]: method } };
}

/** Remove one method from a zone document. */
export function withoutMethod(doc: ShippingZoneDoc, methodId: string): ShippingZoneDoc {
	const methods = { ...doc.methods };
	delete methods[methodId];
	return { ...doc, methods };
}

/** Replace (or add) one rate inside a method. */
export function withRate(doc: ShippingMethodDoc, rate: ShippingRateDoc): ShippingMethodDoc {
	return { ...doc, rates: { ...doc.rates, [rate.currency]: rate } };
}

/** Remove one rate from a method. */
export function withoutRate(doc: ShippingMethodDoc, currencyCode: string): ShippingMethodDoc {
	const rates = { ...doc.rates };
	delete rates[currencyCode];
	return { ...doc, rates };
}

/** Replace (or add) one rate inside a tax class document. */
export function withTaxRate(doc: TaxClassDoc, rate: TaxRateDoc): TaxClassDoc {
	return { ...doc, rates: { ...doc.rates, [rate.rateId]: rate } };
}

/** Remove one rate from a tax class document. */
export function withoutTaxRate(doc: TaxClassDoc, rateId: string): TaxClassDoc {
	const rates = { ...doc.rates };
	delete rates[rateId];
	return { ...doc, rates };
}
