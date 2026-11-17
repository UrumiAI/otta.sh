import { z } from "zod";
import { defineTool } from "../tool.js";
import { requireZone } from "./shipping.js";

export const TAX_TOOLS = [
	defineTool({
		name: "tax_settings_get",
		description:
			"Read the store's tax options (whether tax is on, whether prices include tax, and the related switches), whether they have been saved yet, and whether any tax rate exists. Use it before changing tax or when totals look off.",
		input: z.object({}),
		async run({ clients }) {
			return clients.rules.getTaxSettings();
		},
	}),
	defineTool({
		name: "tax_classes_list",
		description:
			"List the tax classes (id, name) a product can carry. Use the class id when reading rates or assigning a product's tax class.",
		input: z.object({}),
		async run({ clients }) {
			return { items: await clients.rules.listTaxClasses() };
		},
	}),
	defineTool({
		name: "tax_rates_list",
		description:
			"List the tax rates in one shipping zone (id, tax class, rate in basis points where 1000 = 10%). Get the zoneId from shipping_zones_list. Fails with NOT_FOUND for an unknown zoneId.",
		input: z.object({ zoneId: z.string().min(1).describe("A zone id from shipping_zones_list.") }),
		async run({ clients, input }) {
			await requireZone(clients, input.zoneId);
			return { items: await clients.rules.listTaxRates(input.zoneId) };
		},
	}),
];
