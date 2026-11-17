/**
 * The order WRITE tools, driven through `withMcp`'s routes over a real SQLite
 * document store. Every one calls the plugin's admin operation (the ledger and
 * order re-reads, the derived idempotency keys); these cases pin how each
 * outcome reaches an agent: success data, or a `ToolError` with a stable code.
 *
 * Money moves only on a cash-on-delivery order here: its gateway is
 * non-refundable, so a refund is RECORDED with no provider call, and the
 * harness's `ctx.http` (which rejects and counts) proves nothing reached out.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { createOttaPlugin } from "@urumi.ai/otta-plugin";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashReportingStore,
	systemClock,
	uuidIdGen,
} from "@urumi.ai/otta-store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OTTA_MCP_TOOLS, withMcp, type McpRouteEntry } from "../src/index.js";
import { makeAdminHarness, type AdminHarness } from "./helpers/admin-harness.js";

const USD = toCurrency("USD");
const TOTAL = 1500;

let harness: AdminHarness;
let orders: EmdashOrderStore;
let seq = 0;
const plugin = withMcp(createOttaPlugin());

beforeAll(async () => {
	harness = await makeAdminHarness();
	const storage = harness.ctx.storage;
	if (storage === undefined) throw new Error("harness has no storage");
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	const reporting = new EmdashReportingStore({ storage, clock: systemClock });
	orders = new EmdashOrderStore({
		storage,
		inventory,
		idGen: uuidIdGen,
		clock: systemClock,
		reporting,
	});
});
afterAll(async () => {
	// Nothing in this file may have reached for egress: COD refunds are records.
	expect(harness.egressAttempts()).toBe(0);
	await harness?.close();
});

/** A paid cash-on-delivery order for one physical line, its $15.00 collected. */
async function seedPaidCod(): Promise<string> {
	const id = await seedPlacedCod();
	const oid = toOrderId(id);
	await orders.markPaid(oid);
	await orders.recordPayment({
		orderId: oid,
		gateway: "cod",
		providerRef: `cod_${id}`,
		amount: cents(TOTAL),
		currency: USD,
		status: "succeeded",
	});
	return id;
}

/** A cash-on-delivery order placed and still unpaid (`awaiting_payment`). */
async function seedAwaitingCod(): Promise<string> {
	const id = await seedPlacedCod();
	await orders.transition({
		orderId: toOrderId(id),
		fromState: "pending",
		toState: "awaiting_payment",
		idempotencyKey: toIdempotencyKey(`place-${id}`),
		enqueueEmail: false,
	});
	return id;
}

async function seedPlacedCod(): Promise<string> {
	seq += 1;
	const id = `mcp-ord-${String(seq)}`;
	const oid = toOrderId(id);
	await orders.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "cod",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Linen apron",
				unitPrice: cents(TOTAL),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(TOTAL), total: cents(TOTAL), currency: USD },
	});
	return id;
}

async function call(name: string, input: unknown, user: unknown = { name: "Ada" }): Promise<any> {
	const route = plugin.routes[`mcp/${name}`] as McpRouteEntry | undefined;
	if (route === undefined) throw new Error(`no route mcp/${name}`);
	return route.handler({ input, request: new Request("http://x"), user } as never, harness.ctx);
}

async function failure(
	name: string,
	input: unknown,
): Promise<{ name: string; code: string; message: string; details?: any }> {
	try {
		await call(name, input);
	} catch (e) {
		return e as { name: string; code: string; message: string; details?: any };
	}
	throw new Error(`${name} did not fail`);
}

async function ledger(id: string): Promise<Array<[string, string, number]>> {
	const rows = await orders.listRefunds(toOrderId(id));
	return rows.map((r) => [r.status, String(r.idempotencyKey), Number(r.amount)]);
}

const WRITE_TOOLS = [
	"orders_transition",
	"orders_record_fulfillment",
	"orders_cancel",
	"orders_refund",
	"orders_resolve_unverified_refund",
	"orders_resolve_reconciliation",
	"orders_add_note",
	"orders_revoke_download_access",
];

test("the order write tools are in the table; cancel, refund and revoke are destructive", () => {
	const byName = new Map(OTTA_MCP_TOOLS.map((t) => [t.name, t]));
	for (const name of WRITE_TOOLS) expect(byName.has(name), name).toBe(true);
	const destructive = WRITE_TOOLS.filter((n) => byName.get(n)?.destructive === true);
	expect(destructive).toEqual(["orders_cancel", "orders_refund", "orders_revoke_download_access"]);
	expect(byName.get("orders_refund")?.description).toContain(
		"Pass refundedSoFarCents exactly as orders_get returned it. Retrying with identical arguments is safe and never refunds twice.",
	);
});

describe("orders_refund", () => {
	test("the same arguments twice: the second is already_refunded, and the ledger has ONE row", async () => {
		// Review focus 1: an agent retries a refund after a timeout, same inputs.
		const id = await seedPaidCod();
		const args = { orderId: id, amountCents: 500, refundedSoFarCents: 0, currency: "USD" };
		const first = await call("orders_refund", args);
		expect(first).toMatchObject({ status: "refunded", fullyRefunded: false });
		const again = await call("orders_refund", args);
		expect(again).toEqual({ status: "already_refunded" });
		expect(await ledger(id)).toEqual([["recorded", `admin-refund:${id}:500:0`, 500]]);
	});

	test("the refund is recorded as the signed-in operator", async () => {
		const id = await seedPaidCod();
		await call("orders_refund", {
			orderId: id,
			amountCents: 200,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		const rows = await orders.listRefunds(toOrderId(id));
		expect(rows.map((r) => r.refundedBy)).toEqual(["Ada"]);
	});

	test("a stale refundedSoFarCents is REFUND_LEDGER_CHANGED with what remains, and refunds nothing", async () => {
		const id = await seedPaidCod();
		await call("orders_refund", {
			orderId: id,
			amountCents: 500,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		const err = await failure("orders_refund", {
			orderId: id,
			amountCents: 300,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		expect(err.name).toBe("PluginRouteError");
		expect(err.code).toBe("REFUND_LEDGER_CHANGED");
		expect(err.details).toEqual({ remainingCents: 1000, currency: "USD" });
		expect(await ledger(id)).toHaveLength(1);
	});

	test("refunding past the remainder is a typed refusal from the service", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_refund", {
			orderId: id,
			amountCents: TOTAL + 1,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		expect(err.code).toBe("REFUND_EXCEEDS_TOTAL");
		expect(await ledger(id)).toEqual([]);
	});

	test("an unknown order is NOT_FOUND", async () => {
		const err = await failure("orders_refund", {
			orderId: "mcp-missing",
			amountCents: 100,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		expect(err.code).toBe("NOT_FOUND");
	});

	test("a decimal amount never reaches the operation", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_refund", {
			orderId: id,
			amountCents: 4.5,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		expect(err.code).toBe("INVALID_INPUT");
		expect(await ledger(id)).toEqual([]);
	});
});

describe("orders_transition", () => {
	test("moves an order from the state the agent saw", async () => {
		const id = await seedPaidCod();
		const out = await call("orders_transition", {
			orderId: id,
			toState: "processing",
			observedState: "paid",
		});
		expect(out).toMatchObject({ status: "transitioned", settlement: "offline" });
		expect((await orders.getById(toOrderId(id)))?.state).toBe("processing");
	});

	test("an order that moved since it was read is STATE_CHANGED and nothing is attempted", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_transition", {
			orderId: id,
			toState: "processing",
			observedState: "pending",
		});
		expect(err.code).toBe("STATE_CHANGED");
		expect(err.details).toEqual({ liveState: "paid" });
		expect((await orders.getById(toOrderId(id)))?.state).toBe("paid");
	});

	test("a bare cancel is refused with the domain's USE_CANCEL", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_transition", {
			orderId: id,
			toState: "cancelled",
			observedState: "paid",
		});
		expect(err.code).toBe("USE_CANCEL");
	});

	test("an unknown state is INVALID_INPUT", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_transition", {
			orderId: id,
			toState: "teleported",
			observedState: "paid",
		});
		expect(err.code).toBe("INVALID_INPUT");
	});
});

describe("orders_add_note", () => {
	test("appends a note authored by the operator; the same note again is a no-op", async () => {
		const id = await seedPaidCod();
		const out = await call("orders_add_note", { orderId: id, body: "Called the buyer." });
		expect(out).toMatchObject({
			status: "appended",
			note: { orderId: id, author: "Ada", body: "Called the buyer." },
		});
		const again = await call("orders_add_note", { orderId: id, body: "Called the buyer." });
		expect(again.status).toBe("unchanged");
	});

	test("a whitespace-only body is INVALID_INPUT, not an internal error", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_add_note", { orderId: id, body: "   " });
		expect(err.code).toBe("INVALID_INPUT");
	});
});

describe("orders_cancel", () => {
	test("a paid order with no restock choice is RESTOCK_CHOICE_REQUIRED and stays paid", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_cancel", {
			orderId: id,
			reason: "customer_request",
			observedState: "paid",
		});
		expect(err.code).toBe("RESTOCK_CHOICE_REQUIRED");
		expect((await orders.getById(toOrderId(id)))?.state).toBe("paid");
	});

	test("a paid COD order cannot be refunded automatically: the service's code is kept", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_cancel", {
			orderId: id,
			reason: "customer_request",
			observedState: "paid",
			restock: false,
		});
		expect(err.code).toBe("REFUND_NOT_AUTOMATIC");
		expect((await orders.getById(toOrderId(id)))?.state).toBe("paid");
		expect(await ledger(id)).toEqual([]);
	});

	test("cancels an unpaid order (no restock choice needed); a retry is refused by the watermark", async () => {
		const id = await seedAwaitingCod();
		const args = { orderId: id, reason: "customer_request", observedState: "awaiting_payment" };
		const out = await call("orders_cancel", args);
		expect(out).toMatchObject({ status: "cancelled", restock: true, refund: null });
		expect((await orders.getById(toOrderId(id)))?.state).toBe("cancelled");
		const again = await failure("orders_cancel", args);
		expect(again.code).toBe("STATE_CHANGED");
		expect(again.details).toEqual({ liveState: "cancelled" });
	});
});

describe("orders_record_fulfillment", () => {
	test("ships a processing order with its tracking", async () => {
		const id = await seedPaidCod();
		await call("orders_transition", { orderId: id, toState: "processing", observedState: "paid" });
		const out = await call("orders_record_fulfillment", {
			orderId: id,
			carrier: "UPS",
			trackingNumber: "1Z999",
			trackingUrl: "https://ups.example/1Z999",
		});
		expect(out).toMatchObject({ status: "recorded", state: "shipped" });
	});

	test("a non-http tracking URL is INVALID_INPUT", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_record_fulfillment", {
			orderId: id,
			carrier: "UPS",
			trackingNumber: "1Z",
			trackingUrl: "javascript:alert(1)",
		});
		expect(err.code).toBe("INVALID_INPUT");
	});
});

describe("the remaining writes refuse with the service's codes", () => {
	test("orders_revoke_download_access on an order with no digital line is NO_DOWNLOADS", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_revoke_download_access", { orderId: id });
		expect(err.code).toBe("NO_DOWNLOADS");
	});

	test("orders_resolve_reconciliation on an unflagged order is NOT_IN_RECONCILIATION", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_resolve_reconciliation", {
			orderId: id,
			expectedFlag: "anything",
			outcome: "written_off",
			reason: "checked",
		});
		expect(err.code).toBe("NOT_IN_RECONCILIATION");
	});

	test("orders_resolve_unverified_refund with an unknown key is refused with a code", async () => {
		const id = await seedPaidCod();
		const err = await failure("orders_resolve_unverified_refund", {
			orderId: id,
			refundKey: "nope",
			outcome: "voided",
		});
		expect(err.name).toBe("PluginRouteError");
		expect(err.code).toBe("REFUND_NOT_FOUND");
	});

	test("orders_resolve_unverified_refund on a refund that is not unverified is NOT_UNVERIFIED", async () => {
		const id = await seedPaidCod();
		await call("orders_refund", {
			orderId: id,
			amountCents: 100,
			refundedSoFarCents: 0,
			currency: "USD",
		});
		const err = await failure("orders_resolve_unverified_refund", {
			orderId: id,
			refundKey: `admin-refund:${id}:100:0`,
			outcome: "confirmed",
		});
		expect(err.code).toBe("NOT_UNVERIFIED");
		expect(await ledger(id)).toEqual([["recorded", `admin-refund:${id}:100:0`, 100]]);
	});

	test("an unknown order is NOT_FOUND on every write, whatever the service called it", async () => {
		for (const [name, input] of [
			["orders_revoke_download_access", { orderId: "mcp-missing" }],
			["orders_add_note", { orderId: "mcp-missing", body: "hi" }],
			[
				"orders_record_fulfillment",
				{ orderId: "mcp-missing", carrier: "UPS", trackingNumber: "1" },
			],
			[
				"orders_transition",
				{ orderId: "mcp-missing", toState: "processing", observedState: "paid" },
			],
			["orders_cancel", { orderId: "mcp-missing", reason: "other", observedState: "paid" }],
			[
				"orders_resolve_reconciliation",
				{ orderId: "mcp-missing", expectedFlag: "x", outcome: "written_off", reason: "r" },
			],
			[
				"orders_resolve_unverified_refund",
				{ orderId: "mcp-missing", refundKey: "k", outcome: "voided" },
			],
		] as const) {
			expect((await failure(name, input)).code, name).toBe("NOT_FOUND");
		}
	});
});
