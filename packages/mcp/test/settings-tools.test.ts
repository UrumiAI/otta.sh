/**
 * The settings and payment WRITE tools, driven through `withMcp`'s routes over a
 * real SQLite document store and the harness's kv. Every write goes through the
 * plugin's admin settings OPERATION (`saveStoreCurrency`, `saveOperationalSettings`,
 * `saveStoreDisplayName`, `saveCashOnDelivery`, `setPaymentSecret`,
 * `clearPaymentSecret`). These cases pin how each outcome reaches an agent —
 * success data (a `needs_confirmation` included), or a `ToolError` with a stable
 * code — and that NO response ever carries a payment secret's value.
 */
import { cents, currency as toCurrency, idempotencyKey, orderId, sku } from "@urumi.ai/otta-domain";
import { FixedClock } from "@urumi.ai/otta-domain/testing";
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashReportingStore,
	uuidIdGen,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OTTA_MCP_TOOLS, withMcp, type McpRouteEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";
import { seedStore } from "./helpers/seed.js";

let harness: AdminHarness;
const plugin = withMcp(createOttaPlugin());

/** The pinned secret: no response JSON may ever contain it. */
const PINNED = "sk_test_PINNED6F";

/** Every response this file saw, success or failure, as JSON. */
const seen: string[] = [];

beforeAll(async () => {
	harness = await makeAdminHarness();
});
beforeEach(async () => {
	await harness.reset();
	for (const { key } of await harness.ctx.kv.list()) await harness.ctx.kv.delete(key);
});
afterAll(async () => {
	expect(harness.egressAttempts()).toBe(0);
	for (const json of seen) expect(json).not.toContain(PINNED);
	await harness?.close();
});

function record(value: unknown): void {
	seen.push(
		JSON.stringify(value, (_key, v: unknown) =>
			v instanceof Error ? { ...v, message: v.message, name: v.name } : v,
		),
	);
}

async function call(name: string, input: unknown): Promise<any> {
	const route = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
	if (route === undefined) throw new Error(`no route mcp/${name}`);
	const out = await route.handler(
		{ input, request: new Request("http://x"), user: { name: "Ada" } } as never,
		harness.ctx,
	);
	record(out);
	return out;
}

async function failure(
	name: string,
	input: unknown,
): Promise<{ name: string; code: string; message: string; details?: any }> {
	try {
		await call(name, input);
	} catch (e) {
		record(e);
		return e as { name: string; code: string; message: string; details?: any };
	}
	throw new Error(`${name} did not fail`);
}

async function settings(): Promise<any> {
	return call("settings_get", {});
}

/** A cash-on-delivery order placed `daysAgo` days ago, now `awaiting_payment`. */
async function placeCodOrder(tag: string, daysAgo: number): Promise<void> {
	const storage = harness.ctx.storage;
	if (storage === undefined) throw new Error("harness has no storage");
	const clock = new FixedClock(new Date(Date.now() - daysAgo * 86_400_000));
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock });
	const reporting = new EmdashReportingStore({ storage, clock });
	const orders = new EmdashOrderStore({ storage, inventory, idGen: uuidIdGen, clock, reporting });
	const USD = toCurrency("USD");
	const id = orderId(`cod-${tag}`);
	await orders.createFromCart({
		orderId: id,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`cod-${tag}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: `${tag}@example.test`,
		paymentMethod: "cod",
		lines: [
			{
				productId: null,
				sku: sku(`COD-${tag}`),
				title: "Widget",
				unitPrice: cents(1000),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: USD },
	} as never);
	const flipped = await orders.transition({
		orderId: id,
		fromState: "pending",
		toState: "awaiting_payment",
		idempotencyKey: idempotencyKey(`cod-${tag}`),
		enqueueEmail: false,
	});
	if (!flipped.transitioned) throw new Error(`could not place COD order ${tag}`);
}

const WRITE_TOOLS = [
	"settings_update",
	"settings_update_store_name",
	"settings_update_currency",
	"payments_cod_set_enabled",
	"payments_set_secret",
	"payments_clear_secret",
];
const DESTRUCTIVE = ["payments_cod_set_enabled", "payments_set_secret", "payments_clear_secret"];

test("the settings and payment tools are in the table; the payment writes are destructive", () => {
	const byName = new Map(OTTA_MCP_TOOLS.map((t) => [t.name, t]));
	for (const name of WRITE_TOOLS) expect(byName.has(name), name).toBe(true);
	expect(WRITE_TOOLS.filter((n) => byName.get(n)?.destructive === true)).toEqual(DESTRUCTIVE);
});

describe("settings_update_currency (Review Focus 3)", () => {
	test("priced products and no confirmFrom → needs_confirmation, nothing changes; the returned confirmFrom saves", async () => {
		await seedStore(harness.ctx);
		const ask = await call("settings_update_currency", { currency: "EUR" });
		expect(ask).toEqual({
			status: "needs_confirmation",
			message: expect.stringMatching(/^1 product is priced in USD\. .*Nothing was changed\.$/),
			affected: 1,
			retryWith: { confirmFrom: "USD" },
		});
		expect((await settings()).currency).toBe("USD");

		const saved = await call("settings_update_currency", {
			currency: "EUR",
			...ask.retryWith,
		});
		expect(saved).toEqual({ status: "saved", currency: "EUR" });
		expect((await settings()).currency).toBe("EUR");
	});

	test("no priced products → saved at once; the same code again → unchanged", async () => {
		expect(await call("settings_update_currency", { currency: "GBP" })).toEqual({
			status: "saved",
			currency: "GBP",
		});
		expect(await call("settings_update_currency", { currency: "GBP" })).toEqual({
			status: "unchanged",
			currency: "GBP",
		});
	});

	test("a confirmFrom that is no longer the store currency → STALE, nothing changes", async () => {
		await seedStore(harness.ctx);
		const err = await failure("settings_update_currency", { currency: "EUR", confirmFrom: "GBP" });
		expect(err.code).toBe("STALE");
		expect((await settings()).currency).toBe("USD");
	});

	test("an unsupported code → UNSUPPORTED_CURRENCY", async () => {
		const err = await failure("settings_update_currency", { currency: "ZZZ" });
		expect(err.code).toBe("UNSUPPORTED_CURRENCY");
		expect(err.details).toEqual({ currency: "ZZZ" });
	});

	test("an unknown key is refused", async () => {
		const err = await failure("settings_update_currency", { currency: "EUR", confirm: true });
		expect(err.code).toBe("INVALID_INPUT");
	});
});

describe("settings_update", () => {
	test("a partial update keeps what it leaves out", async () => {
		const before = (await settings()).operational;
		const out = await call("settings_update", { lowStockThreshold: 7 });
		expect(out.status).toBe("saved");
		expect(out.settings.lowStockThreshold).toBe(7);
		const after = (await settings()).operational;
		expect(after).toEqual({ ...before, lowStockThreshold: 7 });
	});

	test("an out-of-range value → INVALID_INPUT naming the field; nothing is saved", async () => {
		const err = await failure("settings_update", { holdTtlMinutes: 0, showHoldTimer: true });
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.message).toMatch(/holdTtlMinutes/);
		expect(err.details.problems).toEqual([
			{ field: "holdTtlMinutes", message: expect.stringMatching(/Cart hold time/) },
		]);
		expect((await settings()).operational.showHoldTimer).not.toBe(true);
	});

	test("nothing to change → INVALID_INPUT", async () => {
		expect((await failure("settings_update", {})).code).toBe("INVALID_INPUT");
	});

	test("the currency is not an operational field here", async () => {
		expect((await failure("settings_update", { currency: "EUR" })).code).toBe("INVALID_INPUT");
	});
});

describe("settings_update_store_name", () => {
	test("saved trimmed; a blank name → INVALID_INPUT", async () => {
		expect(await call("settings_update_store_name", { name: "  Ada's Shop " })).toEqual({
			status: "saved",
			name: "Ada's Shop",
		});
		expect((await settings()).storeDisplayName).toBe("Ada's Shop");
		const err = await failure("settings_update_store_name", { name: "   " });
		expect(err.code).toBe("INVALID_INPUT");
		expect((await settings()).storeDisplayName).toBe("Ada's Shop");
	});
});

describe("payments_cod_set_enabled", () => {
	test("enabling saves, and the summary shows it", async () => {
		expect(await call("payments_cod_set_enabled", { enabled: true, autoCancelDays: 10 })).toEqual({
			status: "saved",
			enabled: true,
		});
		expect((await settings()).cashOnDelivery).toEqual({ enabled: true, autoCancelDays: 10 });
	});

	test("`enabled` must be a boolean", async () => {
		const err = await failure("payments_cod_set_enabled", { enabled: "yes" });
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.message).toMatch(/enabled/);
	});

	test("a shorter window that cancels open orders needs confirmation; its confirmFrom saves", async () => {
		await call("payments_cod_set_enabled", { enabled: true, autoCancelDays: 30 });
		await placeCodOrder("a", 10);
		const ask = await call("payments_cod_set_enabled", { enabled: true, autoCancelDays: 5 });
		expect(ask).toEqual({
			status: "needs_confirmation",
			message: expect.stringMatching(/Lowering the window to 5 days cancels 1 unpaid/),
			affected: 1,
			retryWith: { confirmFrom: 30 },
		});
		expect((await settings()).cashOnDelivery.autoCancelDays).toBe(30);
		const stale = await failure("payments_cod_set_enabled", {
			enabled: true,
			autoCancelDays: 5,
			confirmFrom: 14,
		});
		expect(stale.code).toBe("STALE");
		expect(
			await call("payments_cod_set_enabled", {
				enabled: true,
				autoCancelDays: 5,
				...ask.retryWith,
			}),
		).toEqual({ status: "saved", enabled: true });
		expect((await settings()).cashOnDelivery.autoCancelDays).toBe(5);
	});

	test("an out-of-range number → INVALID_INPUT; nothing is written", async () => {
		const err = await failure("payments_cod_set_enabled", { enabled: true, autoCancelDays: 400 });
		expect(err.code).toBe("INVALID_INPUT");
		expect((await settings()).cashOnDelivery.enabled).toBe(false);
	});
});

describe("payment secrets", () => {
	test("payments_set_secret returns no value, and settings_get then shows set", async () => {
		const out = await call("payments_set_secret", { field: "webhookEdgeToken", value: PINNED });
		expect(out).toEqual({ status: "saved", field: "webhookEdgeToken" });
		expect((await settings()).paymentSecrets.webhookEdgeToken).toBe("set");
	});

	test("NO settings tool response carries the secret value", async () => {
		await seedStore(harness.ctx);
		await call("payments_set_secret", { field: "webhookEdgeToken", value: PINNED });
		// Every settings tool, success and refusal both.
		await settings();
		await call("settings_update", { lowStockThreshold: 3 });
		await failure("settings_update", { holdTtlMinutes: -1 });
		await call("settings_update_store_name", { name: "Shop" });
		await failure("settings_update_store_name", { name: "" });
		await call("settings_update_currency", { currency: "EUR" });
		await failure("settings_update_currency", { currency: "ZZZ" });
		await call("payments_cod_set_enabled", { enabled: false });
		await failure("payments_cod_set_enabled", { enabled: 1 });
		// A secret in the wrong box, or as an unknown key, is not echoed back either.
		await failure("payments_set_secret", { field: "stripeSecretKey", value: PINNED });
		await failure("payments_set_secret", { field: "stripeWebhookSecret", value: PINNED });
		await failure("payments_set_secret", { field: PINNED, value: PINNED });
		await failure("payments_set_secret", { field: "webhookEdgeToken", value: PINNED, [PINNED]: 1 });
		await failure("payments_set_secret", { field: "webhookEdgeToken", value: `${PINNED} x` });
		await failure("payments_clear_secret", { field: PINNED });
		await call("payments_clear_secret", { field: "webhookEdgeToken" });
		await failure("payments_clear_secret", { field: "webhookEdgeToken" });
		const json = seen.join("\n");
		expect(json).toContain("webhookEdgeToken");
		expect(json).not.toContain(PINNED);
		expect(json).not.toContain("PINNED6F");
	});

	test("a wrong-shape secret → INVALID_INPUT naming the shape; the stored one stays", async () => {
		await call("payments_set_secret", { field: "webhookEdgeToken", value: PINNED });
		const err = await failure("payments_set_secret", {
			field: "stripeSecretKey",
			value: "pk_test_abcdefghijkl",
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(err.message).toMatch(/sk_live_ or sk_test_/);
		expect(err.message).not.toContain("pk_test_abcdefghijkl");
		const summary = await settings();
		expect(summary.paymentSecrets).toEqual({
			stripeSecretKey: "not_set",
			stripeWebhookSecret: "not_set",
			webhookEdgeToken: "set",
		});
	});

	test("a blank value → BLANK; nothing is written", async () => {
		const err = await failure("payments_set_secret", { field: "webhookEdgeToken", value: "   " });
		expect(err.code).toBe("BLANK");
		expect((await settings()).paymentSecrets.webhookEdgeToken).toBe("not_set");
	});

	test("an unknown field is refused at the schema", async () => {
		const err = await failure("payments_set_secret", { field: "nope", value: "abc" });
		expect(err.code).toBe("INVALID_INPUT");
	});

	test("payments_clear_secret removes it; clearing again → NOT_STORED", async () => {
		await call("payments_set_secret", { field: "webhookEdgeToken", value: PINNED });
		expect(await call("payments_clear_secret", { field: "webhookEdgeToken" })).toEqual({
			status: "cleared",
			field: "webhookEdgeToken",
		});
		expect((await settings()).paymentSecrets.webhookEdgeToken).toBe("not_set");
		expect((await failure("payments_clear_secret", { field: "webhookEdgeToken" })).code).toBe(
			"NOT_STORED",
		);
	});

	test("a host that refuses the encrypted write → nothing stored, no value in the error", async () => {
		const original = harness.ctx.kv.set.bind(harness.ctx.kv);
		harness.ctx.kv.set = async (key: string, value: unknown) => {
			if (value === PINNED) throw new Error(`refused to store ${String(value)}`);
			return original(key, value);
		};
		try {
			const err = await failure("payments_set_secret", {
				field: "webhookEdgeToken",
				value: PINNED,
			});
			expect(["ENCRYPTION_UNAVAILABLE", "WRITE_FAILED"]).toContain(err.code);
		} finally {
			harness.ctx.kv.set = original;
		}
		expect((await settings()).paymentSecrets.webhookEdgeToken).toBe("not_set");
	});
});
