/**
 * The admin SETTINGS operations, called directly — no console action, no notice.
 *
 * These are the decisions `settings-form.ts` used to make inline around each
 * Settings write: the store currency switch and its confirm (a count of the
 * products priced in the old currency, and the re-check against `from`), the
 * cash-on-delivery save and its confirm for a shorter auto-cancel window, the
 * operational settings' range check, the display name's bounds, and the
 * write-only payment secrets (encrypted at rest by the host, ADR-0037; never
 * returned). The admin console and the MCP tools both call these, so a guard
 * here holds for both. `settings-widget.sandbox.test.ts` and
 * `settings-secrets.test.ts` pin the notices the console renders from these
 * outcomes; this file pins the outcomes.
 *
 * Real document store (in-memory SQLite, the host's migrations) and an in-memory kv.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	money,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessReportingSettingsClient } from "../src/admin/in-process-reporting-settings-client.js";
import {
	clearPaymentSecret,
	readSettingsSummary,
	saveCashOnDelivery,
	saveOperationalSettings,
	saveStoreCurrency,
	saveStoreDisplayName,
	setPaymentSecret,
} from "../src/admin/operations/index.js";
import { createInProcessCommerceStores } from "../src/commerce/in-process-commerce-stores.js";
import * as pluginIndex from "../src/index.js";
import { STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import {
	COD_AUTO_CANCEL_DAYS_KEY,
	COD_ENABLED_KEY,
	COD_INSTRUCTIONS_KEY,
} from "../src/payments/cash-on-delivery.js";
import type { KvAccess } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;
let client: InProcessReportingSettingsClient;
let kv: Map<string, unknown>;

/** A fresh kv per case: the harness's own outlives `reset()`. */
function freshKv(): KvAccess {
	kv = new Map();
	return {
		async get<T>(key: string): Promise<T | null> {
			return kv.has(key) ? (kv.get(key) as T) : null;
		},
		async set(key: string, value: unknown): Promise<void> {
			kv.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return kv.delete(key);
		},
		async list(): Promise<Array<{ key: string; value: unknown }>> {
			return [...kv].map(([key, value]) => ({ key, value }));
		},
	};
}

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	harness.ctx.kv = freshKv();
	client = new InProcessReportingSettingsClient(harness.ctx);
});

afterAll(async () => {
	await harness?.close();
});

const WHSEC = ["whsec_", "0123456789abcdef0123456789abcdef"].join("");
const SK_PINNED = ["sk_test_", "PINNED0123456789abcdef"].join("");

async function seedUsdProducts(count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) {
		await harness.stores.productCommerce.upsert(
			{ productId: toProductId(`p-${String(i)}`), price: money(cents(1200), toCurrency("USD")) },
			idempotencyKey(`seed-p-${String(i)}`),
		);
	}
}

/** One open unpaid COD order created `daysAgo` days ago. */
async function seedUnpaidCod(tag: string, daysAgo: number): Promise<void> {
	const at = new Date(Date.now() - daysAgo * 86_400_000);
	const { orderStore } = createInProcessCommerceStores(harness.ctx, { clock: { now: () => at } });
	await orderStore.createFromCart({
		orderId: toOrderId(`o-${tag}`),
		cartId: null,
		currency: toCurrency("USD"),
		idempotencyKey: idempotencyKey(`cod-${tag}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: `${tag}@example.test`,
		paymentMethod: "cod",
		lines: [
			{
				productId: toProductId("p-mug"),
				sku: toSku("SKU-MUG"),
				title: "Mug",
				unitPrice: cents(1000),
				currency: toCurrency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: toCurrency("USD") },
	});
	await orderStore.transition({
		orderId: toOrderId(`o-${tag}`),
		fromState: "pending",
		toState: "awaiting_payment",
		idempotencyKey: idempotencyKey(`cod-placed-${tag}`),
		enqueueEmail: false,
	});
}

describe("saveStoreCurrency", () => {
	test("a switch away from priced products is `needs_confirmation` with the count; nothing changes", async () => {
		await seedUsdProducts(2);
		const outcome = await saveStoreCurrency(harness.ctx, client, { currency: "EUR" });
		expect(outcome).toMatchObject({
			kind: "needs_confirmation",
			message: "2 products are priced in USD.",
			affected: 2,
			from: "USD",
			to: "EUR",
		});
		expect((await client.getSettings()).currency).toBeUndefined();
	});

	test("confirming against the right `from` saves", async () => {
		await seedUsdProducts(1);
		const outcome = await saveStoreCurrency(harness.ctx, client, {
			currency: "EUR",
			confirm: { from: "USD" },
		});
		expect(outcome).toEqual({ kind: "saved", currency: "EUR" });
		expect((await client.getSettings()).currency).toBe("EUR");
	});

	test("confirming against a stale `from` is `stale`; nothing changes", async () => {
		await seedUsdProducts(1);
		const outcome = await saveStoreCurrency(harness.ctx, client, {
			currency: "EUR",
			confirm: { from: "GBP" },
		});
		expect(outcome).toEqual({ kind: "stale" });
		expect((await client.getSettings()).currency).toBeUndefined();
	});

	test("with no priced product, a switch saves at once", async () => {
		expect(await saveStoreCurrency(harness.ctx, client, { currency: "EUR" })).toEqual({
			kind: "saved",
			currency: "EUR",
		});
	});

	test("the same currency is `unchanged` and writes nothing", async () => {
		const outcome = await saveStoreCurrency(harness.ctx, client, { currency: "USD" });
		expect(outcome).toMatchObject({ kind: "unchanged", currency: "USD" });
		expect((await client.getSettings()).currency).toBeUndefined();
	});

	test("an unsupported code is `unsupported`", async () => {
		expect(await saveStoreCurrency(harness.ctx, client, { currency: "XYZ" })).toEqual({
			kind: "unsupported",
			currency: "XYZ",
		});
	});
});

describe("saveCashOnDelivery", () => {
	test("a lower window with affected orders is `needs_confirmation`; nothing changes", async () => {
		await seedUnpaidCod("old", 10);
		const outcome = await saveCashOnDelivery(harness.ctx, {
			enabled: true,
			instructions: "Exact change.",
			numbers: { codAutoCancelDays: "7" },
		});
		expect(outcome).toEqual({
			kind: "needs_confirmation",
			message:
				"Lowering the window to 7 days cancels 1 unpaid cash-on-delivery order on the next sweep (their stock goes back on sale and the buyers are emailed). Save anyway?",
			affected: 1,
			days: 7,
			from: 14,
		});
		expect(kv.has(COD_ENABLED_KEY)).toBe(false);
		expect(kv.has(COD_AUTO_CANCEL_DAYS_KEY)).toBe(false);
	});

	test("the confirm against the window it was asked about saves", async () => {
		await seedUnpaidCod("old", 10);
		const outcome = await saveCashOnDelivery(harness.ctx, {
			enabled: true,
			numbers: { codAutoCancelDays: 7 },
			confirm: { from: 14 },
		});
		expect(outcome).toEqual({ kind: "saved", enabled: true });
		expect(kv.get(COD_AUTO_CANCEL_DAYS_KEY)).toBe(7);
		expect(kv.get(COD_ENABLED_KEY)).toBe(true);
	});

	test("a confirm against a window that moved is `stale`; nothing changes", async () => {
		const outcome = await saveCashOnDelivery(harness.ctx, {
			enabled: true,
			numbers: { codAutoCancelDays: 7 },
			confirm: { from: 30 },
		});
		expect(outcome).toEqual({ kind: "stale" });
		expect(kv.size).toBe(0);
	});

	test("a raised window saves straight away", async () => {
		await seedUnpaidCod("old", 10);
		const outcome = await saveCashOnDelivery(harness.ctx, {
			enabled: false,
			instructions: "",
			numbers: { codAutoCancelDays: "30" },
		});
		expect(outcome).toEqual({ kind: "saved", enabled: false });
		expect(kv.get(COD_AUTO_CANCEL_DAYS_KEY)).toBe(30);
	});

	test("a bad number or over-long instructions are `invalid`; nothing is written", async () => {
		const bad = await saveCashOnDelivery(harness.ctx, {
			enabled: true,
			numbers: { codAutoCancelDays: "abc" },
		});
		expect(bad).toMatchObject({ kind: "invalid" });
		const long = await saveCashOnDelivery(harness.ctx, {
			enabled: true,
			instructions: "x".repeat(5000),
		});
		expect(long).toMatchObject({ kind: "invalid" });
		expect(kv.size).toBe(0);
	});

	test("instructions left out are kept (the toggle alone, as an agent sends it)", async () => {
		kv.set(COD_INSTRUCTIONS_KEY, "Exact change.");
		expect(await saveCashOnDelivery(harness.ctx, { enabled: true })).toEqual({
			kind: "saved",
			enabled: true,
		});
		expect(kv.get(COD_INSTRUCTIONS_KEY)).toBe("Exact change.");
	});
});

describe("saveOperationalSettings", () => {
	test("out of range is `invalid`, naming the field; nothing is saved", async () => {
		const outcome = await saveOperationalSettings(client, {
			holdTtlMinutes: 0,
			lowStockThreshold: 3,
		});
		expect(outcome).toMatchObject({
			kind: "invalid",
			problems: [{ field: "holdTtlMinutes" }],
		});
		expect((await client.getSettings()).lowStockThreshold).toBe(5);
	});

	test("valid values are `saved`, with the settings now in force", async () => {
		const outcome = await saveOperationalSettings(client, { holdTtlMinutes: 20 });
		expect(outcome).toMatchObject({
			kind: "saved",
			settings: { holdTtlMinutes: 20, lowStockThreshold: 5 },
		});
	});
});

describe("saveStoreDisplayName", () => {
	test("blank or over 200 is `invalid`; a name is saved trimmed", async () => {
		expect(await saveStoreDisplayName(harness.ctx, "  ")).toMatchObject({ kind: "invalid" });
		expect(await saveStoreDisplayName(harness.ctx, "x".repeat(201))).toMatchObject({
			kind: "invalid",
		});
		expect(await saveStoreDisplayName(harness.ctx, " Acme ")).toEqual({
			kind: "saved",
			name: "Acme",
		});
		expect(kv.get("settings:storeDisplayName")).toBe("Acme");
	});
});

describe("payment secrets", () => {
	test("set: stored, the save generation bumps; blank and bad shapes write nothing", async () => {
		expect(await setPaymentSecret(harness.ctx, "stripeWebhookSecret", ` ${WHSEC}\n`)).toEqual({
			kind: "saved",
		});
		expect(kv.get(STRIPE_WEBHOOK_SECRET_KEY)).toBe(WHSEC);
		expect(kv.get("settings:stripeWebhookSecretGen")).toBe(1);
		expect(await setPaymentSecret(harness.ctx, "stripeWebhookSecret", "  ")).toEqual({
			kind: "blank",
		});
		expect(await setPaymentSecret(harness.ctx, "stripeWebhookSecret", "nope")).toMatchObject({
			kind: "invalid",
		});
		expect(await setPaymentSecret(harness.ctx, "storeDisplayName", WHSEC)).toEqual({
			kind: "unknown_field",
		});
		expect(kv.get(STRIPE_WEBHOOK_SECRET_KEY)).toBe(WHSEC);
		expect(kv.get("settings:stripeWebhookSecretGen")).toBe(1);
	});

	test("a write the host refuses (no encryption key) stores nothing and bumps nothing", async () => {
		harness.ctx.kv.set = async () => {
			throw new Error("Plugin secret settings require EMDASH_ENCRYPTION_KEY");
		};
		const outcome = await setPaymentSecret(harness.ctx, "stripeWebhookSecret", WHSEC);
		expect(["encryption_unavailable", "write_failed"]).toContain(outcome.kind);
		expect(kv.size).toBe(0);
	});

	test("clear: removed; then `not_stored`; an unknown field is `unknown_field`", async () => {
		kv.set(STRIPE_WEBHOOK_SECRET_KEY, WHSEC);
		expect(await clearPaymentSecret(harness.ctx, "stripeWebhookSecret")).toEqual({
			kind: "cleared",
		});
		expect(kv.has(STRIPE_WEBHOOK_SECRET_KEY)).toBe(false);
		expect(await clearPaymentSecret(harness.ctx, "stripeWebhookSecret")).toEqual({
			kind: "not_stored",
		});
		expect(await clearPaymentSecret(harness.ctx, "nope")).toEqual({ kind: "unknown_field" });
	});
});

describe("readSettingsSummary", () => {
	test("states each secret as set or not, and never carries a secret value", async () => {
		kv.set("settings:stripeSecretKey", SK_PINNED);
		await saveStoreDisplayName(harness.ctx, "Acme");
		const summary = await readSettingsSummary(harness.ctx, client);
		expect(summary).toMatchObject({
			storeDisplayName: "Acme",
			currency: "USD",
			operational: { holdTtlMinutes: 15, lowStockThreshold: 5 },
			cashOnDelivery: { enabled: false, autoCancelDays: 14 },
			paymentSecrets: {
				stripeSecretKey: "set",
				stripeWebhookSecret: "not_set",
				webhookEdgeToken: "not_set",
			},
		});
		expect(JSON.stringify(summary).includes("sk_test_PINNED")).toBe(false);
	});
});

test("the settings operations are exported from the plugin entry (admin operations, MCP)", () => {
	for (const name of [
		"saveStoreCurrency",
		"saveCashOnDelivery",
		"saveOperationalSettings",
		"saveStoreDisplayName",
		"setPaymentSecret",
		"clearPaymentSecret",
		"readSettingsSummary",
	]) {
		expect(typeof (pluginIndex as Record<string, unknown>)[name], name).toBe("function");
	}
});
