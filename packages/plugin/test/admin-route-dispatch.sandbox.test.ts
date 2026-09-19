import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	reservationId as toReservationId,
	sku as toSku,
} from "@otta-sh/domain";
import { plugin } from "@otta-sh/plugin";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashReportingStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterEach, describe, expect, test } from "vitest";
import { blocksOf, field, findBlocks, formFor, tableWithId } from "./helpers/blocks.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

// This change: em-dash's admin shell renders EVERY plugin admin page by
// `POST /plugins/{id}/admin` and resolves the route by the literal key
// "admin", dispatching on the BlockInteraction's `type` + `page`/`action_id`.
// Otta previously registered `admin/reports`/`admin/settings` (which never
// dispatch) → Reports/Settings 404'd. Proven here under the REAL
// workerd-on-Node sandbox.
//
// INC-D3a (the commerce service is folded into the plugin): Reports and
// Settings used to be served over `ctx.http` against a stubbed commerce
// service, guarded by an `X-Internal-Token` this suite seeded through a
// `save-token` action. Both the service and the token are gone — Reports now
// reads real order/inventory data straight off `ctx.storage`
// (`makeAdminClients`, in-process), and Settings has no "Service connection"
// group or token field to render at all (ADR-0014 D3). The token-forwarding
// and `save-token` round-trip tests this file used to carry are deleted
// below rather than adapted: there is no analogous concept to preserve, and
// the write-only-secret round trip they were closest to is already covered,
// against the real 5 payment/email secrets, by `payment-secrets.test.ts`.

/** Places one paid order and seeds one below-threshold sku directly against the
 *  same storage the isolate's `ctx.storage` bridges to — the real write path
 *  every in-process report in this suite reads back from (revenue and
 *  orders-by-status off the order store's own `reporting_daily` rollup, top
 *  products off a live scan of the order's frozen line snapshot, low stock off
 *  a live scan of inventory). */
async function seedReportingFixtures(storage: StorageAccess): Promise<void> {
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	// The rollup writer travels WITH the order store (mirroring
	// `createInProcessCommerceStores`'s own wiring, see `in-process-commerce-stores.ts`)
	// — without it, orders still write, but the `reporting_daily` doc the revenue
	// and orders-by-status reads fold over is never touched.
	const reportingStore = new EmdashReportingStore({ storage, clock: systemClock });
	const orderStore = new EmdashOrderStore({
		storage,
		inventory,
		idGen: uuidIdGen,
		clock: systemClock,
		reporting: reportingStore,
	});

	const paidSku = toSku("REPORTS-PAID");
	await inventory.seedOnHand(paidSku, 10);
	const held = await inventory.reserve(paidSku, 1, idempotencyKey("res-reports-dispatch"));
	if (!held.ok) throw new Error(`could not reserve: ${held.reason}`);
	const holdExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
	await inventory.stampHoldDeadline(held.reservationId, holdExpiresAt);
	await inventory.adoptMany({
		reservationIds: [held.reservationId],
		orderId: toOrderId("order-reports-dispatch"),
		holdExpiresAt,
		now: new Date().toISOString(),
	});
	await orderStore.createFromCart({
		orderId: toOrderId("order-reports-dispatch"),
		cartId: "cart-reports-dispatch",
		currency: currency("USD"),
		idempotencyKey: idempotencyKey("create-reports-dispatch"),
		holdExpiresAt,
		buyerRef: "buyer-reports-dispatch@example.test",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId("prod-reports-dispatch"),
				sku: paidSku,
				title: "Reports Dispatch Widget",
				unitPrice: cents(1999),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: toReservationId(held.reservationId),
			},
		],
		totals: { subtotal: cents(1999), total: cents(1999), currency: currency("USD") },
	});
	await orderStore.markPaid(toOrderId("order-reports-dispatch"));

	// A second, unrelated sku below the default low-stock threshold (5 —
	// `DEFAULT_OPERATIONAL_SETTINGS.lowStockThreshold`, untouched by this test).
	// Low stock is a current-state scan of inventory alone, so it needs no order.
	await inventory.seedOnHand(toSku("REPORTS-LOW"), 2);
}

let sandbox: SandboxHandle | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
});

describe("admin route dispatch (workerd sandbox)", () => {
	test("the plugin registers the single `admin` route and NOT the old per-page keys", () => {
		const keys = Object.keys(plugin.routes ?? {});
		expect(keys).toContain("admin");
		expect(keys).not.toContain("admin/reports");
		expect(keys).not.toContain("admin/settings");
	});

	test("page_load /reports renders the Reports blocks over real in-process order/inventory data", async () => {
		const { storage } = await storageBridge();
		await seedReportingFixtures(storage);

		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		expect(blocks.length).toBeGreaterThan(0);
		// §12.5: the four report groups are accordions, resolved by `block_id`
		// (never by label — D-6 makes labels carry live figures).
		const groupIds = findBlocks(blocks, "accordion").map((a) => a.block_id);
		expect(groupIds).toEqual(
			expect.arrayContaining(["reports:revenue", "reports:statuses", "reports:top", "reports:low"]),
		);
		expect(findBlocks(blocks, "table")).toHaveLength(4);

		// INC-D3a: there is no service left to prove a token reached — what a
		// genuine in-process render must prove instead is that these are the REAL
		// figures read back off `ctx.storage`, not a stub's fixture.
		const statusesTable = tableWithId(blocks, "reports:statuses-table");
		expect(statusesTable?.rows).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "paid", orderCount: 1 })]),
		);
		const revenueTable = tableWithId(blocks, "reports:revenue-table");
		const revenueRows = revenueTable?.rows as unknown[] | undefined;
		expect(revenueRows, "reports:revenue-table must render its rows").toBeDefined();
		expect(revenueRows?.length ?? 0).toBeGreaterThan(0);
		const topTable = tableWithId(blocks, "reports:top-table");
		expect(topTable?.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ titleSnapshot: "Reports Dispatch Widget", qtySold: 1 }),
			]),
		);
		const lowTable = tableWithId(blocks, "reports:low-table");
		expect(lowTable?.rows).toEqual(
			expect.arrayContaining([expect.objectContaining({ sku: "REPORTS-LOW", onHand: "2 · Low" })]),
		);
		// The low-stock group label states the threshold it read off Settings —
		// the default (5), since nothing in this test touches it.
		const lowGroup = findBlocks(blocks, "accordion").find((a) => a.block_id === "reports:low");
		expect(String(lowGroup?.label)).toContain("at or below 5");
	}, 60_000);

	test("page_load /settings renders the Settings form (display + operational + the 5 payment/email secrets, no legacy service token)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/settings" });
		const blocks = blocksOf(outcome);
		expect(blocks.length).toBeGreaterThan(0);
		// §12.6: the three groups (store/checkout/payments) are accordions —
		// resolve each field by its form's SUBMIT action_id (stable), not by a
		// top-level flat scan.
		expect(field(formFor(blocks, "save-display"), "storeDisplayName")).toBeDefined();
		expect(field(formFor(blocks, "save-operational"), "holdTtlMinutes")).toBeDefined();
		expect(field(formFor(blocks, "save-operational"), "lowStockThreshold")).toBeDefined();
		// INC-D3a deleted the "Service connection" group and its `save-token`
		// field outright (ADR-0014 D3) — there is no second deployable left to
		// authenticate to, so no form on this page submits that id any more.
		expect(formFor(blocks, "save-token")).toBeUndefined();
		// INC-09: every payment/email secret still renders write-only — a plain
		// `text_input`, never a masked `secret_input`, and carrying no
		// `initial_value` (the stored secret is never echoed back).
		for (const actionId of [
			"save-stripe-secret-key",
			"save-stripe-webhook-secret",
			"save-email-api-key",
			"save-x402-facilitator-secret",
			"save-webhook-edge-token",
		]) {
			const form = formFor(blocks, actionId);
			expect(form, `no form submitting ${actionId}`).toBeDefined();
		}
		const stripeKeyField = field(formFor(blocks, "save-stripe-secret-key"), "stripeSecretKey");
		expect(stripeKeyField?.type).toBe("text_input");
		expect(stripeKeyField).not.toHaveProperty("initial_value");
	});

	test("NO-STORAGE page_load /reports (ctx.storage undeclared) fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		// `storage` deliberately omitted: `makeAdminClients` builds every
		// in-process commerce adapter over `ctx.storage` and THROWS synchronously
		// at construction when it is absent. Reports-page constructs it INSIDE its
		// own try/catch precisely so that throw cannot escape into the host — this
		// is the in-process analogue of the old "no token → 401 → fail-closed
		// banner" proof.
		sandbox = await loadPluginInSandbox({ allowedHosts: [] });

		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/reports" });
		const blocks = blocksOf(outcome);
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		const text = `${String(banner?.title ?? "")} ${String(banner?.description ?? "")}`;
		expect(text).not.toMatch(/HTTP \d|\/reports\/|401/);
	});

	test("the old per-page keys no longer resolve (404 unknown route)", async () => {
		sandbox = await loadPluginInSandbox({ allowedHosts: [] });

		const outcome = await sandbox.invokeRoute("admin/reports", {
			type: "page_load",
			page: "/reports",
		});
		expect("error" in outcome).toBe(true);
		if (!("error" in outcome)) return;
		expect(outcome.error).toContain("unknown route");
	});
});
