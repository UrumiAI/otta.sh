import type { z } from "zod";
import type { McpToolDef } from "../tool.js";
import { COUPON_WRITE_TOOLS } from "./coupon-writes.js";
import { COUPON_TOOLS } from "./coupons.js";
import { ORDER_WRITE_TOOLS } from "./order-writes.js";
import { ORDER_TOOLS } from "./orders.js";
import { PRODUCT_WRITE_TOOLS } from "./product-writes.js";
import { PRODUCT_TOOLS } from "./products.js";
import { REPORT_TOOLS } from "./reports.js";
import { SETTINGS_TOOLS } from "./settings.js";
import { SHIPPING_WRITE_TOOLS } from "./shipping-writes.js";
import { SHIPPING_TOOLS } from "./shipping.js";
import { TAX_WRITE_TOOLS } from "./tax-writes.js";
import { TAX_TOOLS } from "./tax.js";

/**
 * The tool table: every Otta MCP tool, one entry each. `withMcp` reads it by
 * default. Each area's tools live in their own module beside this one and are
 * spread in here.
 */
export const OTTA_MCP_TOOLS: readonly McpToolDef<z.ZodTypeAny>[] = [
	...PRODUCT_TOOLS,
	...PRODUCT_WRITE_TOOLS,
	...ORDER_TOOLS,
	...ORDER_WRITE_TOOLS,
	...COUPON_TOOLS,
	...COUPON_WRITE_TOOLS,
	...SHIPPING_TOOLS,
	...SHIPPING_WRITE_TOOLS,
	...TAX_TOOLS,
	...TAX_WRITE_TOOLS,
	...REPORT_TOOLS,
	...SETTINGS_TOOLS,
] as readonly McpToolDef<z.ZodTypeAny>[];
