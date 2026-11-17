/**
 * The shipping WRITE tools. A write that has a rule above the surface calls the
 * plugin's admin OPERATION, never the surface: zones (`createZone`, `updateZone` —
 * the regions must be ISO codes in no other zone, and the first zone needs an
 * acknowledgement) and rates (`upsertRate` — no free-shipping threshold on a
 * flat-rate method). Methods have no rule above the surface, so their writes call
 * it directly, the way the Shipping console does; every one of their result
 * variants is still mapped here, ending in `unhandled()`.
 *
 * A record id the surface refuses (`CommerceInputError`) becomes INVALID_INPUT
 * through `readOrRefuse`, as for every other tool.
 */
import type {
	AdminClients,
	RulesCasUpdateResult,
	RulesCreateResult,
	RulesDeleteResult,
	RulesUpdateResult,
	ShippingMethodType,
	ShippingMethodWire,
	ShippingRateWire,
	ShippingZoneWire,
	ZoneRegionsRefusal,
} from "@urumi.ai/otta-plugin";
import { createZone, updateZone, upsertRate } from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { MONEY_NOTE, readOrRefuse } from "./common.js";
import { type Complete, unhandled } from "./unhandled.js";

/** The domain's `ShippingMethodType`. */
const METHOD_TYPES = [
	"flat_rate",
	"free_shipping",
] as const satisfies readonly ShippingMethodType[];
const methodTypesComplete: Complete<ShippingMethodType, typeof METHOD_TYPES> = true;
void methodTypesComplete;

/** A surface create refused on a taken id. */
const CREATE_CONFLICT = 409;
/** A surface create refused because its parent (zone or method) is missing. */
const CREATE_PARENT_MISSING = 404;

/**
 * A record id, as the surface takes it: printable ASCII with no whitespace, at
 * most 200 characters (`requireIdToken`). Restated so a bad id is refused at the
 * schema with the field named, before any read.
 */
export const recordId = (what: string) =>
	z
		.string()
		.min(1)
		.max(200)
		.regex(/^[\x21-\x7e]+$/, "printable ASCII with no spaces")
		.describe(what);

/** A name: trimmed, then 1-200 characters (a blank one is refused). */
export const recordName = (what: string) => z.string().trim().min(1).max(200).describe(what);

const zoneIdInput = recordId("The zone's `id` from shipping_zones_list.");
const methodIdInput = recordId("The method's `id` from shipping_methods_list.");
const regionsInput = z
	.string()
	.max(4000)
	.describe(
		'The regions the zone covers: a comma-separated list of ISO codes, countries ("US") or subdivisions ("US-CA"), case-insensitive. Blank means the zone matches no address.',
	);
const currencyInput = z
	.string()
	.regex(/^[A-Z]{3}$/, "an upper-case ISO-4217 code")
	.describe("ISO-4217 code, upper case, e.g. USD.");
const minorUnits = z.number().int().nonnegative();

/** A regions refusal → its code. Nothing was written. */
function regionsRefusal(refusal: ZoneRegionsRefusal): never {
	switch (refusal.reason) {
		case "invalid_codes":
			return toolFailure(
				"INVALID_REGION_CODES",
				"Some regions are not ISO country or subdivision codes (details.invalid lists them, as typed). Nothing was written.",
				{ invalid: refusal.invalid },
			);
		case "overlap":
			return toolFailure(
				"ZONE_REGION_OVERLAP",
				`${refusal.code} is already in zone "${refusal.zoneName}"; a region may be in only one zone. Nothing was written.`,
				{ code: refusal.code, zoneId: refusal.zoneId, zoneName: refusal.zoneName },
			);
		default:
			return unhandled(refusal);
	}
}

/** A surface create's refusal → its code. */
function createRefusal(
	result: Extract<RulesCreateResult<unknown>, { ok: false }>,
	what: string,
	takenCode: string,
	fallback: string,
): never {
	if (result.status === CREATE_CONFLICT) {
		return toolFailure(takenCode, `That ${what} id is already taken. Nothing was written.`);
	}
	if (result.status === CREATE_PARENT_MISSING) {
		return toolFailure("NOT_FOUND", `The ${what}'s parent does not exist. Nothing was written.`);
	}
	return toolFailure(fallback, `The ${what} was not created.`, { status: result.status });
}

/** An LWW update's result → success data, or its code. */
function updateAnswer<T, K extends string>(
	result: RulesUpdateResult<T>,
	key: K,
	what: string,
	fallback: string,
): { status: "updated" } & Record<K, T> {
	if (result.ok)
		return { status: "updated", [key]: result.value } as { status: "updated" } & Record<K, T>;
	switch (result.reason) {
		case "not_found":
			return toolFailure("NOT_FOUND", `No such ${what}. Nothing was written.`);
		case "error":
			return toolFailure(fallback, `The ${what} was not saved.`, { status: result.status });
		default:
			return unhandled(result);
	}
}

const INUSE_HINT: Readonly<Record<string, string>> = {
	ZONE_IN_USE: "Delete its shipping methods first (shipping_method_delete).",
	METHOD_IN_USE: "Delete its rates first (shipping_rate_delete).",
};

/** A delete's result → success data, or its code. */
function deleteAnswer(result: RulesDeleteResult, what: string, inUse: string, fallback: string) {
	if (result.ok) return { status: "deleted" as const };
	switch (result.reason) {
		case "not_found":
			return toolFailure("NOT_FOUND", `No such ${what} (it may already be deleted).`);
		case "in_use":
			return toolFailure(inUse, `The ${what} is still in use. ${INUSE_HINT[inUse] ?? ""}`.trim());
		case "error":
			return toolFailure(fallback, `The ${what} was not deleted.`, { status: result.status });
		default:
			return unhandled(result);
	}
}

/** The method `methodId` of zone `zoneId`, or NOT_FOUND. */
async function requireMethod(
	clients: AdminClients,
	zoneId: string,
	methodId: string,
): Promise<ShippingMethodWire> {
	const methods = await readOrRefuse(() => clients.rules.listMethods(zoneId));
	const method = methods.find((m) => m.id === methodId);
	if (method === undefined) {
		return toolFailure("NOT_FOUND", `No shipping method ${methodId} in zone ${zoneId}.`);
	}
	return method;
}

/** A rate write's surface result (a create or a CAS update) → success data, or its code. */
function rateAnswer(
	result: RulesCreateResult<ShippingRateWire> | RulesCasUpdateResult<ShippingRateWire>,
): { status: "set"; rate: ShippingRateWire } {
	if (result.ok) return { status: "set", rate: result.value };
	if (!("reason" in result)) {
		return createRefusal(result, "rate", "RATE_WRITE_FAILED", "RATE_WRITE_FAILED");
	}
	switch (result.reason) {
		case "not_found":
			return toolFailure(
				"NOT_FOUND",
				"The rate is gone (deleted since it was read). Nothing was written.",
			);
		case "stale":
			return toolFailure(
				"RATE_CHANGED",
				"The rate changed since it was read (details.current is the live rate). Nothing was written; decide again from it.",
				{ current: result.current },
			);
		case "error":
			return toolFailure("RATE_WRITE_FAILED", "The rate was not saved.", { status: result.status });
		default:
			return unhandled(result);
	}
}

const updateZoneInput = z
	.object({
		zoneId: zoneIdInput,
		name: recordName("The zone's new name.").optional(),
		regions: regionsInput.optional(),
	})
	.strict();

const updateMethodInput = z
	.object({
		zoneId: zoneIdInput,
		methodId: methodIdInput,
		name: recordName("The method's new name.").optional(),
		type: z.enum(METHOD_TYPES).optional(),
		taxable: z.boolean().optional().describe("Whether the shipping charge is taxed."),
	})
	.strict();

export const SHIPPING_WRITE_TOOLS = [
	defineTool({
		name: "shipping_zone_create",
		description:
			'Create a shipping zone: a named set of regions that its shipping methods and tax rates apply to. A region may be in only one zone. Creating the store\'s FIRST zone turns on address matching, so every address outside the zones can no longer check out: the first call answers `{status: "needs_confirmation", message, retryWith: {acknowledgeFirstZone: true}}` and writes nothing; tell the merchant, then call again with that flag. Returns `{status: "created", zone}`. Refusals: INVALID_REGION_CODES (details.invalid), ZONE_REGION_OVERLAP (details.code, zoneId, zoneName), ZONE_ID_TAKEN, INVALID_INPUT.',
		input: z
			.object({
				id: recordId(
					"The zone's id (printable ASCII, no spaces), e.g. us. Defaults to a fresh UUID.",
				).optional(),
				name: recordName("What the merchant calls the zone, e.g. United States."),
				regions: regionsInput,
				acknowledgeFirstZone: z
					.boolean()
					.default(false)
					.describe(
						"Set true only after the merchant has accepted that the first zone stops checkout for addresses outside every zone.",
					),
			})
			.strict(),
		async run({ clients, input }) {
			const outcome = await readOrRefuse(() =>
				createZone(clients.rules, {
					id: input.id ?? crypto.randomUUID(),
					name: input.name,
					regions: input.regions,
					acknowledgeFirstZone: input.acknowledgeFirstZone,
				}),
			);
			if (outcome.ok) {
				const { result } = outcome;
				if (result.ok) return { status: "created", zone: result.value };
				return createRefusal(result, "zone", "ZONE_ID_TAKEN", "ZONE_CREATE_FAILED");
			}
			switch (outcome.reason) {
				case "first_zone_unacknowledged":
					return {
						status: "needs_confirmation",
						message:
							"This is the store's first shipping zone. Once it exists, addresses outside every zone can no longer check out. Nothing was written; confirm with the merchant, then call again with acknowledgeFirstZone: true.",
						retryWith: { acknowledgeFirstZone: true },
					};
				case "invalid_codes":
				case "overlap":
					return regionsRefusal(outcome);
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "shipping_zone_update",
		description:
			'Rename a zone or change its regions: send only what changes; a field you leave out is kept. `regions` replaces the whole list (blank clears it). Returns `{status: "updated", zone}`. Refusals: NOT_FOUND, INVALID_REGION_CODES, ZONE_REGION_OVERLAP, LEGACY_ZONE_REGIONS (the zone still holds free-text regions from before ISO codes: send `regions` as ISO codes with the rename), INVALID_INPUT (nothing to change). An unknown key is refused before the tool runs.',
		input: updateZoneInput,
		async run({ clients, input }) {
			const { zoneId, name, regions } = input;
			if (name === undefined && regions === undefined) {
				return toolFailure("INVALID_INPUT", "nothing to change: send `name`, `regions` or both.");
			}
			const outcome = await readOrRefuse(async () => {
				try {
					return await updateZone(clients.rules, zoneId, {
						...(name === undefined ? {} : { name }),
						...(regions === undefined ? {} : { regions }),
					});
				} catch (error) {
					// The stored regions, sent back untouched, are refused by the surface:
					// they predate ISO codes (free text). Only a re-entry can save them.
					if (regions === undefined && (error as { field?: unknown }).field === "regions") {
						toolFailure(
							"LEGACY_ZONE_REGIONS",
							"This zone's stored regions are free text from before ISO codes; re-enter this zone's regions as ISO codes (send `regions` with your change). Nothing was written.",
						);
					}
					throw error;
				}
			});
			if (!outcome.ok) return regionsRefusal(outcome);
			return updateAnswer<ShippingZoneWire, "zone">(
				outcome.result,
				"zone",
				`shipping zone ${zoneId}`,
				"ZONE_UPDATE_FAILED",
			);
		},
	}),
	defineTool({
		name: "shipping_zone_delete",
		description:
			'Delete a shipping zone. A zone that still has shipping methods is refused (ZONE_IN_USE): delete its methods first. Returns `{status: "deleted"}`; NOT_FOUND for an unknown id, including one already deleted.',
		destructive: true,
		input: z.object({ zoneId: zoneIdInput }).strict(),
		async run({ clients, input }) {
			const result = await readOrRefuse(() => clients.rules.deleteZone(input.zoneId));
			return deleteAnswer(result, "shipping zone", "ZONE_IN_USE", "ZONE_DELETE_FAILED");
		},
	}),
	defineTool({
		name: "shipping_method_create",
		description:
			'Add a shipping method to a zone. `flat_rate` always charges its rate; `free_shipping` is free above its rate\'s threshold. Set the price per currency with shipping_rate_set. Method ids are unique across every zone. Returns `{status: "created", method}`. Refusals: NOT_FOUND (unknown zone), METHOD_ID_TAKEN, INVALID_INPUT.',
		input: z
			.object({
				zoneId: zoneIdInput,
				id: recordId(
					"The method's id (printable ASCII, no spaces), e.g. us-standard. Defaults to a fresh UUID.",
				).optional(),
				name: recordName("What shoppers see, e.g. Standard shipping."),
				type: z.enum(METHOD_TYPES),
				taxable: z
					.boolean()
					.optional()
					.describe("Whether the shipping charge is taxed. Defaults to true."),
			})
			.strict(),
		async run({ clients, input }) {
			const result = await readOrRefuse(() =>
				clients.rules.createMethod(input.zoneId, {
					id: input.id ?? crypto.randomUUID(),
					name: input.name,
					type: input.type,
					...(input.taxable === undefined ? {} : { taxable: input.taxable }),
				}),
			);
			if (result.ok) return { status: "created", method: result.value };
			return createRefusal(result, "shipping method", "METHOD_ID_TAKEN", "METHOD_CREATE_FAILED");
		},
	}),
	defineTool({
		name: "shipping_method_update",
		description:
			"Change a shipping method's name, type or taxable flag: send only what changes; a field you leave out is kept. Switching free_shipping → flat_rate leaves any threshold its rates carry unused, and the answer's `note` says so. Returns `{status: \"updated\", method, note?}`. Refusals: NOT_FOUND, INVALID_INPUT (nothing to change). An unknown key is refused before the tool runs.",
		input: updateMethodInput,
		async run({ clients, input }) {
			const { zoneId, methodId, name, type, taxable } = input;
			if (name === undefined && type === undefined && taxable === undefined) {
				return toolFailure(
					"INVALID_INPUT",
					"nothing to change: send `name`, `type`, `taxable` or a combination.",
				);
			}
			const stored = await requireMethod(clients, zoneId, methodId);
			const result = await readOrRefuse(() =>
				clients.rules.updateMethod(methodId, {
					name: name ?? stored.name,
					type: type ?? stored.type,
					...(taxable === undefined ? {} : { taxable }),
				}),
			);
			const answer = updateAnswer<ShippingMethodWire, "method">(
				result,
				"method",
				`shipping method ${methodId}`,
				"METHOD_UPDATE_FAILED",
			);
			if (stored.type === "free_shipping" && answer.method.type === "flat_rate") {
				return {
					...answer,
					note: "This method is now flat rate: a flat rate always charges its rate, so any free-shipping threshold on its rates no longer applies. Clear them with shipping_rate_set (minSubtotalCents: null).",
				};
			}
			return answer;
		},
	}),
	defineTool({
		name: "shipping_method_delete",
		description:
			'Delete a shipping method. A method that still has rates is refused (METHOD_IN_USE): delete its rates first. Returns `{status: "deleted"}`; NOT_FOUND for an unknown id, including one already deleted.',
		destructive: true,
		input: z.object({ methodId: methodIdInput }).strict(),
		async run({ clients, input }) {
			const result = await readOrRefuse(() => clients.rules.deleteMethod(input.methodId));
			return deleteAnswer(result, "shipping method", "METHOD_IN_USE", "METHOD_DELETE_FAILED");
		},
	}),
	defineTool({
		name: "shipping_rate_set",
		description: `Set a shipping method's price in one currency: creates the rate, or updates the one there. \`minSubtotalCents\` is a free-shipping threshold and only applies to a free_shipping method: on a flat_rate method it is refused (THRESHOLD_ON_FLAT_RATE). Leaving \`minSubtotalCents\` out keeps the stored threshold; null clears it. A flat-rate rate that still carries a LEGACY threshold (saved before that rule) refuses an amount-only update with THRESHOLD_ON_FLAT_RATE too: send minSubtotalCents: null with the new amount. Pass \`expectedAmountCents\` (the amount you read with shipping_rate_get) to refuse an update if the rate moved since; without it the amount read here is the guard. Returns \`{status: "set", rate}\`. Refusals: NOT_FOUND (zone or method), THRESHOLD_ON_FLAT_RATE, RATE_CHANGED (details.current), INVALID_INPUT (e.g. a currency the store does not support). ${MONEY_NOTE}`,
		input: z
			.object({
				zoneId: zoneIdInput,
				methodId: methodIdInput,
				currency: currencyInput,
				amountCents: minorUnits.describe("The shipping charge, integer minor units (500 = 5.00)."),
				minSubtotalCents: minorUnits
					.nullable()
					.optional()
					.describe(
						"free_shipping only: the cart subtotal at which shipping is free, integer minor units; null clears it.",
					),
				expectedAmountCents: minorUnits
					.optional()
					.describe("The amount you last read for this rate; the update is refused if it changed."),
			})
			.strict(),
		async run({ clients, input }) {
			const { zoneId, methodId, currency, amountCents, minSubtotalCents, expectedAmountCents } =
				input;
			await requireMethod(clients, zoneId, methodId);
			const outcome = await readOrRefuse(() =>
				upsertRate(clients.rules, zoneId, methodId, {
					currency,
					amountCents,
					...(minSubtotalCents === undefined ? {} : { minSubtotalCents }),
					...(expectedAmountCents === undefined ? {} : { expectedAmountCents }),
				}),
			);
			if (outcome.ok) return rateAnswer(outcome.result);
			switch (outcome.reason) {
				case "threshold_on_flat_rate":
					return toolFailure(
						"THRESHOLD_ON_FLAT_RATE",
						"A flat-rate method always charges its rate, so a free-shipping threshold would never apply. Send minSubtotalCents: null (it also clears a legacy one), or make the method free_shipping. Nothing was written.",
					);
				default:
					return unhandled(outcome.reason, outcome);
			}
		},
	}),
	defineTool({
		name: "shipping_rate_delete",
		description:
			'Delete a shipping method\'s rate in one currency; the method then cannot ship in that currency. Orders already placed keep their shipping charge. Returns `{status: "deleted"}`; NOT_FOUND for an unknown zone, method or rate, including one already deleted.',
		destructive: true,
		input: z
			.object({ zoneId: zoneIdInput, methodId: methodIdInput, currency: currencyInput })
			.strict(),
		async run({ clients, input }) {
			await requireMethod(clients, input.zoneId, input.methodId);
			const result = await readOrRefuse(() =>
				clients.rules.deleteRate(input.methodId, input.currency),
			);
			return deleteAnswer(result, "shipping rate", "RATE_IN_USE", "RATE_DELETE_FAILED");
		},
	}),
];
