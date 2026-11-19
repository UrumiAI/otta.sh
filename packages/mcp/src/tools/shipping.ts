import { z } from "zod";
import type { AdminClients } from "@urumi.ai/otta-plugin";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { MONEY_NOTE } from "./common.js";

/** Zones are few; an unknown zone id is NOT_FOUND rather than an empty list. */
export async function requireZone(clients: AdminClients, zoneId: string): Promise<void> {
	const zones = await clients.rules.listZones();
	if (!zones.some((zone) => zone.id === zoneId))
		toolFailure("NOT_FOUND", `No shipping zone ${zoneId}.`);
}

export const SHIPPING_TOOLS = [
	defineTool({
		name: "shipping_zones_list",
		description:
			"List the shipping zones (id, name, the regions each covers). Start here to find a zoneId for shipping_methods_list or tax_rates_list.",
		input: z.object({}).strict(),
		async run({ clients }) {
			return { items: await clients.rules.listZones() };
		},
	}),
	defineTool({
		name: "shipping_methods_list",
		description:
			"List the shipping methods offered in one zone (id, name). Use the methodId with shipping_rate_get to read its price. Fails with NOT_FOUND for an unknown zoneId.",
		input: z
			.object({ zoneId: z.string().min(1).describe("A zone id from shipping_zones_list.") })
			.strict(),
		async run({ clients, input }) {
			await requireZone(clients, input.zoneId);
			return { items: await clients.rules.listMethods(input.zoneId) };
		},
	}),
	defineTool({
		name: "shipping_rate_get",
		description: `Read the price of one shipping method in one currency. ${MONEY_NOTE} Fails with NOT_FOUND when the method has no rate in that currency.`,
		input: z
			.object({
				methodId: z.string().min(1).describe("A method id from shipping_methods_list."),
				currency: z.string().length(3).describe("ISO-4217 code, e.g. USD."),
			})
			.strict(),
		async run({ clients, input }) {
			const rate = await clients.rules.getRate(input.methodId, input.currency);
			if (rate === null) {
				toolFailure(
					"NOT_FOUND",
					`No ${input.currency} rate for shipping method ${input.methodId}.`,
				);
			}
			return rate;
		},
	}),
];
