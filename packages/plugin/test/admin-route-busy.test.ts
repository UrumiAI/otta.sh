/**
 * The single `admin` route under storage pressure. EmDash wraps whatever the
 * route returns in a 200 envelope and turns a THROW into its own 500, so "busy"
 * has to be an ANSWER here, never an escaped throw:
 *  - the React console gets the retryable `STORE_BUSY` refusal, never the generic
 *    "unavailable" copy that sends an operator hunting for an outage;
 *  - a Block Kit screen still renders its blocks (each page's own degraded
 *    state). That is ALL this file asserts for them — Block Kit screens have no
 *    busy-specific banner (yet), only the guarantee that a busy store is not a
 *    host 500.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ADMIN_ROUTE, createAdminRouteHandler } from "../src/admin/admin-route.js";
import { CONSOLE_READ_INTERACTION, STORE_BUSY } from "../src/admin/console-transport.js";
import { COUPONS_PAGE } from "../src/admin/coupons-page.js";
import { REPORTS_PAGE } from "../src/admin/reports-page.js";
import { SETTINGS_PAGE } from "../src/admin/settings-form.js";
import { SHIPPING_PAGE } from "../src/admin/shipping-page.js";
import { TAX_PAGE } from "../src/admin/tax-page.js";
import type { PluginContext } from "../src/types.js";
import { busyStorage } from "./helpers/busy-storage.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

function loaded(): PluginContext {
	return { ...harness.ctx, storage: busyStorage(harness.ctx.storage!) };
}

async function invoke(input: Record<string, unknown>, ctx: PluginContext): Promise<unknown> {
	const handler = createAdminRouteHandler();
	return handler(
		{ input: input as never, request: { method: "POST", url: `/${ADMIN_ROUTE}`, headers: {} } },
		ctx,
	);
}

describe("the React console", () => {
	test("STORE_BUSY is a retryable console refusal with its own copy", () => {
		expect(STORE_BUSY).toMatchObject({ ok: false, retryable: true });
		expect(STORE_BUSY.title).toMatch(/busy/i);
	});

	test.each(["orders.list", "products.list"])(
		"a %s read against a busy store answers STORE_BUSY, not the generic unavailable copy",
		async (resource) => {
			expect(await invoke({ type: CONSOLE_READ_INTERACTION, resource }, loaded())).toEqual(
				STORE_BUSY,
			);
		},
	);
});

describe("Block Kit screens", () => {
	test.each([REPORTS_PAGE, SETTINGS_PAGE, TAX_PAGE, SHIPPING_PAGE, COUPONS_PAGE])(
		"page_load $path against a busy store still renders blocks — never a throw",
		async (page) => {
			await expect(invoke({ type: "page_load", page: page.path }, loaded())).resolves.toEqual(
				expect.objectContaining({ blocks: expect.any(Array) }),
			);
		},
	);
});
