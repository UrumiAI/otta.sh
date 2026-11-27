/**
 * The tax WRITE tools. The tax options go through the plugin's admin OPERATION
 * (`updateTaxSettings`: one idempotency key per save, and a compare-and-set on
 * the options in force, read there because an agent passes no digest). Tax
 * classes and tax rates have no rule above the surface (see the operation's own
 * doc), so their writes call it directly, as the Tax console does; every result
 * variant is still mapped here, ending in `unhandled()`.
 */
import type {
	AdminClients,
	RulesCasUpdateResult,
	TaxRateWire,
	TaxSettingsUpdateResult,
	TaxSettingsWire,
} from "@urumi.ai/otta-plugin";
import { updateTaxSettings } from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { readOrRefuse } from "./common.js";
import { recordId, recordName } from "./shipping-writes.js";
import { unhandled } from "./unhandled.js";

/** A surface create refused on a taken id (or, for a tax rate, a taken slot). */
const CREATE_CONFLICT = 409;

const classIdInput = recordId("The tax class's `id` from tax_classes_list.");
const rateIdInput = recordId("The tax rate's `id` from tax_rates_list.");
const zoneIdInput = recordId("The zone's `id` from shipping_zones_list.");
const bps = z
	.number()
	.int()
	.min(0)
	.max(10_000)
	.describe("A rate in basis points, 0-10000 (825 = 8.25%).");
const ppm = z
	.number()
	.int()
	.min(0)
	.max(1_000_000)
	.describe(
		"Only for a rate finer than a basis point: the exact rate in millionths (82_550 = 8.255%); `rateBps` must then be it rounded half up.",
	);

/** The tax options block, whole: what tax_settings_get returns as `settings`. */
const taxSettingsInput = z
	.object({
		enabled: z.boolean().describe("Whether the store charges tax at all."),
		pricesIncludeTax: z.boolean().describe("Whether entered prices already include tax."),
		basedOn: z
			.enum(["shipping", "billing", "base"])
			.describe("Which address picks the tax rate: the shipping, billing or store base address."),
		baseAddress: z
			.object({
				country: z.string().min(1).describe("ISO country code, e.g. DE."),
				region: z.string().min(1).nullable().describe("ISO subdivision, e.g. US-CA, or null."),
			})
			.strict()
			.nullable()
			.describe("The store's own address; needed when basedOn is base."),
		shippingTaxClass: z
			.discriminatedUnion("kind", [
				z.object({ kind: z.literal("inherit") }).strict(),
				z.object({ kind: z.literal("legacy") }).strict(),
				z.object({ kind: z.literal("fixed"), taxClassId: recordId("A tax class id.") }).strict(),
			])
			.describe(
				'How shipping is taxed: "inherit" (from the cart\'s items), "legacy", or "fixed" with a taxClassId.',
			),
		roundAtSubtotal: z.boolean().describe("Round tax once on the subtotal, not per line."),
		displayCart: z
			.enum(["excl", "incl"])
			.describe("Cart and checkout show prices excl or incl tax."),
		totalsDisplay: z
			.enum(["itemized", "single"])
			.describe("Show each tax separately, or one total."),
		displayShop: z
			.enum(["excl", "incl"])
			.optional()
			.describe("Shop pages show prices excl or incl tax; absent means as entered."),
	})
	.strict();

// The schema and the wire type agree both ways: a field renamed on either side
// fails the typecheck.
const settingsToWire = (s: z.infer<typeof taxSettingsInput>): TaxSettingsWire => s;
const wireToSettings = (s: TaxSettingsWire): z.infer<typeof taxSettingsInput> => s;
void [settingsToWire, wireToSettings];

const updateTaxRateInput = z
	.object({
		zoneId: zoneIdInput,
		rateId: rateIdInput,
		rateBps: bps.optional(),
		ratePpm: ppm.optional(),
		appliesToShipping: z.boolean().optional().describe("Whether the rate also taxes shipping."),
		expectedRateBps: bps
			.optional()
			.describe("The rateBps you last read; the update is refused if the rate changed since."),
		expectedRatePpm: ppm
			.optional()
			.describe("The ratePpm you last read, when the rate you read had one."),
		expectedAppliesToShipping: z
			.boolean()
			.optional()
			.describe("The appliesToShipping you last read; refused if it changed since."),
	})
	.strict();

const updateTaxClassInput = z
	.object({ classId: classIdInput, name: recordName("The class's new name.") })
	.strict();

/** A tax class still in use → TAX_CLASS_IN_USE, saying by what. */
function classInUse(usedBy: string, count?: number): never {
	return toolFailure(
		"TAX_CLASS_IN_USE",
		`The tax class is still used by ${usedBy}. Nothing was deleted.`,
		count === undefined ? { usedBy } : { usedBy, count },
	);
}

/**
 * The rates refusal, naming each rate that holds the class (#744) as
 * `details.rates` — including one whose zone was deleted (`zoneExists: false`),
 * which no zone's tax_rates_list shows — so each can go with tax_rate_delete.
 */
async function classInUseByRates(
	clients: AdminClients,
	classId: string,
	count: number,
): Promise<never> {
	// A read after the refusal: if it fails, the refusal keeps its code and count.
	let rates: { id: string; zoneId: string; zoneExists: boolean }[];
	try {
		rates = (await clients.rules.listTaxRatesForClass(classId)).map((r) => ({
			id: r.id,
			zoneId: r.zoneId,
			zoneExists: r.zoneExists,
		}));
	} catch {
		return classInUse("rates", count);
	}
	return toolFailure(
		"TAX_CLASS_IN_USE",
		`The tax class is still used by ${count} tax rate${count === 1 ? "" : "s"}. Nothing was deleted. Delete each one in details.rates with tax_rate_delete (a rate whose zone was deleted, zoneExists false, deletes the same way), then retry.`,
		{ usedBy: "rates", count, rates },
	);
}

/**
 * {@link readOrRefuse}, keeping the refused field as `details.field` (the shape
 * tax_settings_update gives a refused option). A rate on a class that does not
 * exist (#740) is refused on `taxClassId`, one on a zone that does not exist
 * (#743) on `zoneId`; each says how to make what is missing.
 */
async function refuseWithField<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		const field = (error as { field?: unknown } | null)?.field;
		if (
			error instanceof Error &&
			(error as { code?: unknown }).code === "INVALID_INPUT" &&
			typeof field === "string"
		) {
			const hint =
				field === "taxClassId"
					? " Create the class with tax_class_create, or pick one from tax_classes_list."
					: field === "zoneId"
						? " Create the zone with shipping_zone_create, or pick one from shipping_zones_list."
						: "";
			return toolFailure("INVALID_INPUT", `${error.message}. Nothing was written.${hint}`, {
				field,
				message: error.message,
			});
		}
		// Every other refusal keeps readOrRefuse's mapping.
		return readOrRefuse(async () => {
			throw error;
		});
	}
}

function settingsAnswer(result: TaxSettingsUpdateResult) {
	if (result.ok) return { status: "updated" as const, settings: result.settings };
	switch (result.reason) {
		case "invalid":
			return toolFailure(
				"INVALID_INPUT",
				`The tax options' ${result.field} was refused. Nothing was saved.`,
				{ field: result.field, message: result.message },
			);
		case "stale":
			return toolFailure(
				"TAX_SETTINGS_CHANGED",
				"The tax options changed while saving (details.current is what is in force). Nothing was saved; decide again from them.",
				{ current: result.current },
			);
		default:
			return unhandled(result);
	}
}

function taxRateUpdateAnswer(result: RulesCasUpdateResult<TaxRateWire>, rateId: string) {
	if (result.ok) return { status: "updated" as const, taxRate: result.value };
	switch (result.reason) {
		case "not_found":
			return toolFailure("NOT_FOUND", `No tax rate ${rateId}. Nothing was written.`);
		case "stale":
			return toolFailure(
				"TAX_RATE_CHANGED",
				"The tax rate changed since it was read (details.current is the live rate). Nothing was written; decide again from it.",
				{ current: result.current },
			);
		case "error":
			return toolFailure("TAX_RATE_UPDATE_FAILED", "The tax rate was not saved.", {
				status: result.status,
			});
		default:
			return unhandled(result);
	}
}

export const TAX_WRITE_TOOLS = [
	defineTool({
		name: "tax_settings_update",
		description:
			'Replace the store\'s tax options. Read them with tax_settings_get, change what you need in its `settings`, and send the WHOLE block back as `settings` (every field but displayShop is required; an unknown key is refused). Returns `{status: "updated", settings}` as stored. Refusals: INVALID_INPUT (details.field, e.g. a fixed shipping tax class that does not exist), TAX_SETTINGS_CHANGED (another save landed at the same moment; details.current).',
		input: z.object({ settings: taxSettingsInput }).strict(),
		async run({ clients, input }) {
			// No `expected`: the operation reads the options in force and guards on them.
			const result = await readOrRefuse(() => updateTaxSettings(clients.rules, input.settings));
			return settingsAnswer(result);
		},
	}),
	defineTool({
		name: "tax_class_create",
		description:
			'Create a tax class (e.g. Reduced) that products and tax rates can name. Returns `{status: "created", taxClass}`. Refusals: TAX_CLASS_ID_TAKEN, INVALID_INPUT.',
		input: z
			.object({
				id: recordId(
					"The class's id (printable ASCII, no spaces), e.g. reduced. Defaults to a fresh UUID.",
				).optional(),
				name: recordName("What the merchant calls it, e.g. Reduced rate."),
			})
			.strict(),
		async run({ clients, input }) {
			const result = await readOrRefuse(() =>
				clients.rules.createTaxClass({ id: input.id ?? crypto.randomUUID(), name: input.name }),
			);
			if (result.ok) return { status: "created", taxClass: result.value };
			if (result.status === CREATE_CONFLICT) {
				return toolFailure(
					"TAX_CLASS_ID_TAKEN",
					"That tax class id is already taken. Nothing was written.",
				);
			}
			return toolFailure("TAX_CLASS_CREATE_FAILED", "The tax class was not created.", {
				status: result.status,
			});
		},
	}),
	defineTool({
		name: "tax_class_update",
		description:
			'Rename a tax class (its id never changes, so nothing that names it moves). Returns `{status: "updated", taxClass}`. Refusals: NOT_FOUND, INVALID_INPUT.',
		input: updateTaxClassInput,
		async run({ clients, input }) {
			const result = await readOrRefuse(() =>
				clients.rules.updateTaxClass(input.classId, { name: input.name }),
			);
			if (result.ok) return { status: "updated", taxClass: result.value };
			switch (result.reason) {
				case "not_found":
					return toolFailure("NOT_FOUND", `No tax class ${input.classId}. Nothing was written.`);
				case "error":
					return toolFailure("TAX_CLASS_UPDATE_FAILED", "The tax class was not saved.", {
						status: result.status,
					});
				default:
					return unhandled(result);
			}
		},
	}),
	defineTool({
		name: "tax_class_delete",
		description:
			'Delete a tax class. A class still in use is refused with TAX_CLASS_IN_USE, details.usedBy "products" or "rates" (with details.count; for rates, details.rates lists the id, zoneId and zoneExists of each, to delete with tax_rate_delete) or "settings" (the tax options\' fixed shipping tax class): move those off it first. Returns `{status: "deleted"}`; NOT_FOUND for an unknown id, including one already deleted.',
		destructive: true,
		input: z.object({ classId: classIdInput }).strict(),
		async run({ clients, input }) {
			const result = await readOrRefuse(() => clients.rules.deleteTaxClass(input.classId));
			if (result.ok) return { status: "deleted" };
			switch (result.reason) {
				case "not_found":
					return toolFailure(
						"NOT_FOUND",
						`No tax class ${input.classId} (it may already be deleted).`,
					);
				case "in_use_by_products":
					return classInUse("products", result.count);
				case "in_use_by_rates":
					return classInUseByRates(clients, input.classId, result.count);
				case "in_use_by_settings":
					return classInUse("settings");
				case "error":
					return toolFailure("TAX_CLASS_DELETE_FAILED", "The tax class was not deleted.", {
						status: result.status,
					});
				default:
					return unhandled(result);
			}
		},
	}),
	defineTool({
		name: "tax_rate_create",
		description:
			'Create a tax rate: the rate one tax class pays in one shipping zone. There is one rate per (class, zone): a second is refused with TAX_RATE_SLOT_TAKEN, details.existing naming the one there (update it with tax_rate_update instead). Returns `{status: "created", taxRate}`. Refusals: TAX_RATE_SLOT_TAKEN, TAX_RATE_ID_TAKEN, INVALID_INPUT (details.field, e.g. taxClassId naming a class that does not exist: create it with tax_class_create first; or zoneId naming a shipping zone that does not exist: create it with shipping_zone_create first). Products with no tax class are taxed at class id `standard`, which must be declared with tax_class_create before it can take a rate.',
		input: z
			.object({
				id: recordId(
					"The rate's id (printable ASCII, no spaces). Defaults to a fresh UUID.",
				).optional(),
				taxClassId: classIdInput,
				zoneId: zoneIdInput,
				rateBps: bps,
				ratePpm: ppm.optional(),
				appliesToShipping: z
					.boolean()
					.optional()
					.describe("Whether the rate also taxes shipping. Defaults to false."),
			})
			.strict(),
		async run({ clients, input }) {
			const { id, ...rest } = input;
			const result = await refuseWithField(() =>
				clients.rules.createTaxRate({
					id: id ?? crypto.randomUUID(),
					taxClassId: rest.taxClassId,
					zoneId: rest.zoneId,
					rateBps: rest.rateBps,
					...(rest.ratePpm === undefined ? {} : { ratePpm: rest.ratePpm }),
					...(rest.appliesToShipping === undefined
						? {}
						: { appliesToShipping: rest.appliesToShipping }),
				}),
			);
			if (result.ok) return { status: "created", taxRate: result.value };
			if (result.duplicateTaxRate !== undefined) {
				return toolFailure(
					"TAX_RATE_SLOT_TAKEN",
					`This class already has a rate in this zone (${result.duplicateTaxRate.id}); update that one with tax_rate_update. Nothing was written.`,
					{ existing: result.duplicateTaxRate },
				);
			}
			if (result.status === CREATE_CONFLICT) {
				return toolFailure(
					"TAX_RATE_ID_TAKEN",
					"That tax rate id is already taken. Nothing was written.",
				);
			}
			return toolFailure("TAX_RATE_CREATE_FAILED", "The tax rate was not created.", {
				status: result.status,
			});
		},
	}),
	defineTool({
		name: "tax_rate_update",
		description:
			'Change a tax rate\'s rate or whether it taxes shipping: send only what changes; a field you leave out is kept (sending rateBps without ratePpm makes the rate exactly rateBps). Pass the values you read as expectedRateBps / expectedAppliesToShipping to refuse the update if the rate moved since; without them the values read here are the guard. Returns `{status: "updated", taxRate}`. Refusals: NOT_FOUND (the rate is not in that zone), TAX_RATE_CHANGED (details.current), INVALID_INPUT (nothing to change, or expectedRatePpm without expectedRateBps). An unknown key is refused before the tool runs.',
		input: updateTaxRateInput,
		async run({ clients, input }) {
			const { zoneId, rateId, rateBps, ratePpm, appliesToShipping } = input;
			if (rateBps === undefined && ratePpm === undefined && appliesToShipping === undefined) {
				return toolFailure(
					"INVALID_INPUT",
					"nothing to change: send `rateBps` (with `ratePpm` for a sub-basis-point rate), `appliesToShipping`, or both.",
				);
			}
			if (ratePpm !== undefined && rateBps === undefined) {
				return toolFailure(
					"INVALID_INPUT",
					"`ratePpm` needs `rateBps` too (ratePpm rounded half up to a basis point).",
				);
			}
			if (input.expectedRatePpm !== undefined && input.expectedRateBps === undefined) {
				return toolFailure(
					"INVALID_INPUT",
					"`expectedRatePpm` needs `expectedRateBps` too (send both as you read them with tax_rates_list).",
				);
			}
			const rates = await readOrRefuse(() => clients.rules.listTaxRates(zoneId));
			const current = rates.find((r) => r.id === rateId);
			if (current === undefined) {
				return toolFailure("NOT_FOUND", `No tax rate ${rateId} in zone ${zoneId}.`);
			}
			// A new rate is exactly what was sent; an omitted one keeps the stored rate
			// (its millionths too).
			const nextRate =
				rateBps === undefined
					? {
							rateBps: current.rateBps,
							...(current.ratePpm === undefined ? {} : { ratePpm: current.ratePpm }),
						}
					: { rateBps, ...(ratePpm === undefined ? {} : { ratePpm }) };
			const expectedRate =
				input.expectedRateBps === undefined
					? {
							expectedRateBps: current.rateBps,
							...(current.ratePpm === undefined ? {} : { expectedRatePpm: current.ratePpm }),
						}
					: {
							expectedRateBps: input.expectedRateBps,
							...(input.expectedRatePpm === undefined
								? {}
								: { expectedRatePpm: input.expectedRatePpm }),
						};
			const result = await readOrRefuse(() =>
				clients.rules.updateTaxRate(rateId, {
					...nextRate,
					appliesToShipping: appliesToShipping ?? current.appliesToShipping,
					...expectedRate,
					expectedAppliesToShipping: input.expectedAppliesToShipping ?? current.appliesToShipping,
				}),
			);
			return taxRateUpdateAnswer(result, rateId);
		},
	}),
	defineTool({
		name: "tax_rate_delete",
		description:
			'Delete a tax rate. Orders already placed keep the tax they were charged. Returns `{status: "deleted"}`; NOT_FOUND for an unknown id, including one already deleted.',
		destructive: true,
		input: z.object({ rateId: rateIdInput }).strict(),
		async run({ clients, input }) {
			const result = await readOrRefuse(() => clients.rules.deleteTaxRate(input.rateId));
			if (result.ok) return { status: "deleted" };
			switch (result.reason) {
				case "not_found":
					return toolFailure(
						"NOT_FOUND",
						`No tax rate ${input.rateId} (it may already be deleted).`,
					);
				case "in_use":
					return toolFailure(
						"TAX_RATE_IN_USE",
						"The tax rate is still in use. Nothing was deleted.",
					);
				case "error":
					return toolFailure("TAX_RATE_DELETE_FAILED", "The tax rate was not deleted.", {
						status: result.status,
					});
				default:
					return unhandled(result);
			}
		},
	}),
];
