import type {
	DeleteShippingZoneResult,
	ShippingRulesStore,
} from "../ports/shipping-rules-store.js";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";

export interface DeleteShippingZoneDeps {
	shippingRules: ShippingRulesStore;
	/** The tax rates, each of which names the zone it applies in. */
	taxRules: TaxRulesStore;
}

/**
 * Outcome of `deleteShippingZone`: the store's own `DeleteShippingZoneResult` widened by the tax-rate
 * refusal. `in_use_by_tax_rates` carries how many rates still name the zone, so a
 * surface can say what has to go first.
 */
export type DeleteShippingZoneOutcome =
	| DeleteShippingZoneResult
	| { ok: false; reason: "in_use_by_tax_rates"; count: number };

/**
 * Delete a shipping zone with a DELETE-IN-USE guard spanning both aggregates that
 * can reference it (#741). A zone is the referent of its shipping methods
 * (embedded in the zone, guarded ATOMICALLY by `ShippingRulesStore.deleteZone`)
 * and of the tax rates that name it (`TaxRate.zoneId`, held by `TaxRulesStore`).
 * The shipping store cannot see the tax rates, so the second guard is composed
 * here, as `deleteTaxClass` composes its product guard:
 *
 *  1. If any tax rate names the zone → `in_use_by_tax_rates` with the count,
 *     unless the zone is already gone (`not_found`, so a replayed delete stays the
 *     idempotent no-op even when a rate left over from before this guard names it).
 *  2. Otherwise delegate to `ShippingRulesStore.deleteZone`: `in_use_by_methods`,
 *     `not_found` or `ok`.
 *
 * Every refusal writes nothing.
 *
 * NOTE the TOCTOU window between the rate read and the zone delete, the same one
 * `deleteTaxClass` accepts for products: the methods guard is atomic because the
 * methods live IN the zone document the delete is conditioned on, but a tax rate
 * lives in its CLASS document, so no single compare-and-delete can see both. A
 * rate created in that gap is left naming a deleted zone. It is inert at checkout
 * while no zone has that id (a deleted zone never matches an address), but a zone
 * later created with the SAME id picks it up, and the merchant clears it with a
 * rate delete by id. Accepted for a rare admin maintenance action rather than a
 * cross-document lock; the same window exists today for any rate created naming
 * a zone that does not exist, since a rate create does not check its zone.
 */
export async function deleteShippingZone(
	deps: DeleteShippingZoneDeps,
	zoneId: string,
): Promise<DeleteShippingZoneOutcome> {
	const rates = await deps.taxRules.listRatesForZone(zoneId);
	if (rates.length > 0) {
		if ((await deps.shippingRules.getZone(zoneId)) === null) {
			return { ok: false, reason: "not_found" };
		}
		return { ok: false, reason: "in_use_by_tax_rates", count: rates.length };
	}
	return deps.shippingRules.deleteZone(zoneId);
}
