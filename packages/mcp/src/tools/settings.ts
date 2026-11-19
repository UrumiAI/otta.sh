import { readSettingsSummary } from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { defineTool } from "../tool.js";

export const SETTINGS_TOOLS = [
	defineTool({
		name: "settings_get",
		description:
			"Read the store's settings: display name, currency (ISO-4217), operational settings (cart hold minutes, low-stock threshold in units), cash on delivery (enabled, auto-cancel days, the caps maxOpenPerBuyer / maxOpenPerClient / maxUnitsPerOrder where 0 = no cap, and the buyer instructions or null) and which payment secrets are configured. Secrets are reported only as set or not_set, never their value. Use it to answer how the store is set up before changing anything.",
		input: z.object({}).strict(),
		async run({ ctx, clients }) {
			return readSettingsSummary(ctx, clients.reporting);
		},
	}),
];
