import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { requireZone } from "./shipping.js";
import { recordId } from "./shipping-writes.js";

export const TAX_TOOLS = [
	defineTool({
		name: "tax_settings_get",
		description:
			"Read the store's tax options (whether tax is on, whether prices include tax, and the related switches), whether they have been saved yet, and whether any tax rate exists. Use it before changing tax or when totals look off.",
		input: z.object({}).strict(),
		async run({ clients }) {
			return clients.rules.getTaxSettings();
		},
	}),
	defineTool({
		name: "tax_classes_list",
		description:
			"List the tax classes (id, name) a product can carry. Use the class id when reading rates or assigning a product's tax class.",
		input: z.object({}).strict(),
		async run({ clients }) {
			return { items: await clients.rules.listTaxClasses() };
		},
	}),
	defineTool({
		name: "tax_rates_list",
		description:
			"List tax rates (id, tax class, rate in basis points where 1000 = 10%), either in one shipping zone (`zoneId`, from shipping_zones_list) or for one tax class across every zone (`taxClassId`, from tax_classes_list); send exactly one. By class, each rate carries `zoneExists`: false marks a rate whose zone was deleted, which is never charged but still holds its class against tax_class_delete; remove it with tax_rate_delete. Fails with NOT_FOUND for an unknown zoneId, or a taxClassId that names no class and no rate.",
		input: z
			.object({
				zoneId: z.string().min(1).optional().describe("A zone id from shipping_zones_list."),
				taxClassId: recordId("A tax class id from tax_classes_list.").optional(),
			})
			.strict(),
		async run({ clients, input }) {
			// Checked here rather than with a zod refinement, so the tool's input
			// stays a plain object schema for the MCP SDK.
			if ((input.zoneId === undefined) === (input.taxClassId === undefined)) {
				toolFailure("INVALID_INPUT", "Send exactly one of zoneId and taxClassId.");
			}
			if (input.taxClassId !== undefined) {
				const classId = input.taxClassId;
				const items = await clients.rules.listTaxRatesForClass(classId);
				// A class that was never declared can still hold rates from before
				// #740, so those are listed too (to be deleted); with none, it is a typo.
				if (items.length === 0) {
					const classes = await clients.rules.listTaxClasses();
					if (!classes.some((c) => c.id === classId)) {
						toolFailure("NOT_FOUND", `No tax class ${classId}.`);
					}
				}
				return { items };
			}
			const zoneId = input.zoneId ?? "";
			await requireZone(clients, zoneId);
			return { items: await clients.rules.listTaxRates(zoneId) };
		},
	}),
];
