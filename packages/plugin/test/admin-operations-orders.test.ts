/**
 * The admin ORDER operations, called directly — no Block Kit action, no notice.
 *
 * These are the decisions `orders-actions.ts` used to make inline: the ledger
 * re-read and the refund key (F-2a, `:v<n>` after a voided attempt), the order
 * re-read against the state the operator saw (DA-3a), and every write's derived
 * idempotency key. The admin console and the MCP tools both call them, so a
 * guard here holds for both. `orders-actions.sandbox.test.ts` pins the notices
 * the console renders from these outcomes; this file pins the outcomes.
 *
 * Real document store (in-memory SQLite, the host's migrations) and the client's
 * own stores; the gateway is the domain's fake Stripe, so a provider outcome can
 * be scripted without a transport.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@urumi.ai/otta-domain";
import { FakePaymentGateway } from "@urumi.ai/otta-domain/testing";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import {
	addOrderNote,
	cancelOrder,
	recordFulfillment,
	refundOrder,
	resolveReconciliation,
	resolveUnverifiedRefund,
	revokeDownloadAccess,
	transitionOrder,
	type RefundInput,
} from "../src/admin/operations/index.js";
import * as pluginIndex from "../src/index.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
const FAR = "2099-01-01T00:00:00.000Z";
const TOTAL = 1500;

let harness: InProcessCommerceHarness;
let stripe: FakePaymentGateway;
let client: InProcessAdminOrdersClient;
let seq = 0;

beforeEach(async () => {
	stripe = new FakePaymentGateway({ id: "stripe" });
	const gateways = { stripe };
	if (harness === undefined) harness = await makeInProcessCommerce({ gateways });
	else await harness.reset();
	client = new InProcessAdminOrdersClient(harness.ctx, { gateways });
});

afterAll(async () => {
	await harness?.close();
});

/** A paid card order for one physical line, its $15.00 captured. */
async function seedPaid(opts: { captured?: boolean } = {}): Promise<string> {
	seq += 1;
	const id = `ops-${String(seq)}`;
	const oid = toOrderId(id);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: FAR,
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
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
	await harness.stores.orderStore.markPaid(oid);
	if (opts.captured !== false) {
		await harness.stores.orderStore.recordPayment({
			orderId: oid,
			gateway: "stripe",
			providerRef: `pi_${id}`,
			amount: cents(TOTAL),
			currency: USD,
			status: "succeeded",
		});
	}
	return id;
}

const refund = (orderId: string, amountCents: number, refundedSoFarCents: number): RefundInput => ({
	orderId,
	amountCents,
	refundedSoFarCents,
	currency: "USD",
	refundedBy: "carol",
});

async function ledger(id: string): Promise<Array<[string, string]>> {
	const rows = await harness.stores.orderStore.listRefunds(toOrderId(id));
	return rows.map((r) => [r.status, String(r.idempotencyKey)]);
}

describe("refundOrder", () => {
	test("a partial refund is `refunded`, not fully, under the derived key", async () => {
		const id = await seedPaid();
		const outcome = await refundOrder(client, refund(id, 500, 0), undefined);
		expect(outcome).toMatchObject({ kind: "refunded", fullyRefunded: false });
		expect(stripe.refundCalls.map((c) => String(c.idempotencyKey))).toEqual([
			`admin-refund:${id}:500:0`,
		]);
	});

	test("refunding the whole remainder is `refunded` and fully refunded", async () => {
		const id = await seedPaid();
		const outcome = await refundOrder(client, refund(id, TOTAL, 0), undefined);
		expect(outcome).toMatchObject({ kind: "refunded", fullyRefunded: true });
	});

	test("a retry with the SAME inputs after it went through is `already_refunded` — never a second refund", async () => {
		// Review focus 1: an agent retries after a timeout with the same inputs.
		const id = await seedPaid();
		expect((await refundOrder(client, refund(id, 500, 0), undefined)).kind).toBe("refunded");
		const again = await refundOrder(client, refund(id, 500, 0), undefined);
		expect(again).toEqual({ kind: "already_refunded" });
		expect(stripe.refundCalls).toHaveLength(1);
		expect(await ledger(id)).toEqual([["recorded", `admin-refund:${id}:500:0`]]);
	});

	test("a different amount against a ledger someone else moved is `stale_ledger` with what remains", async () => {
		const id = await seedPaid();
		await refundOrder(client, refund(id, 500, 0), undefined);
		const stale = await refundOrder(client, refund(id, 300, 0), undefined);
		expect(stale).toEqual({ kind: "stale_ledger", remainingCents: 1000, currency: "USD" });
		expect(stripe.refundCalls).toHaveLength(1);
	});

	test("a deliberate second refund at the MOVED watermark is a new refund", async () => {
		const id = await seedPaid();
		await refundOrder(client, refund(id, 500, 0), undefined);
		const second = await refundOrder(client, refund(id, 500, 500), undefined);
		expect(second).toMatchObject({ kind: "refunded", fullyRefunded: false });
		expect(stripe.refundCalls.map((c) => String(c.idempotencyKey))).toEqual([
			`admin-refund:${id}:500:0`,
			`admin-refund:${id}:500:500`,
		]);
	});

	test("a retry after a VOIDED attempt goes under the `:v1` key", async () => {
		const id = await seedPaid();
		stripe.setRefundResult({ ok: false, reason: "TERMINAL" });
		const rejected = await refundOrder(client, refund(id, 500, 0), undefined);
		expect(rejected).toEqual({ kind: "failed", reason: "GATEWAY_TERMINAL", currency: "USD" });
		stripe.clearRefundResult();
		const retry = await refundOrder(client, refund(id, 500, 0), undefined);
		expect(retry.kind).toBe("refunded");
		expect(await ledger(id)).toEqual(
			expect.arrayContaining([
				["voided", `admin-refund:${id}:500:0`],
				["recorded", `admin-refund:${id}:500:0:v1`],
			]),
		);
	});

	test("an UNVERIFIED gateway outcome is `failed` with GATEWAY_UNVERIFIED", async () => {
		const id = await seedPaid();
		stripe.setRefundResult({ ok: false, reason: "UNVERIFIED" });
		const outcome = await refundOrder(client, refund(id, 500, 0), undefined);
		expect(outcome).toEqual({ kind: "failed", reason: "GATEWAY_UNVERIFIED", currency: "USD" });
	});

	test("an order with no ledger to re-read is `ledger_unreadable`", async () => {
		const outcome = await refundOrder(client, refund("ops-missing", 500, 0), undefined);
		expect(outcome).toEqual({ kind: "ledger_unreadable" });
	});

	test("the operator is recorded when the input names nobody; `admin` when neither does", async () => {
		const named = await seedPaid();
		await refundOrder(
			client,
			{ orderId: named, amountCents: 100, refundedSoFarCents: 0, currency: "USD" },
			"dana",
		);
		const anon = await seedPaid();
		await refundOrder(
			client,
			{ orderId: anon, amountCents: 100, refundedSoFarCents: 0, currency: "USD" },
			undefined,
		);
		const by = async (id: string) =>
			(await harness.stores.orderStore.listRefunds(toOrderId(id)))[0]?.refundedBy;
		expect(await by(named)).toBe("dana");
		expect(await by(anon)).toBe("admin");
	});

	test("a non-positive or fractional amount, a negative watermark or a blank currency throws RangeError", async () => {
		const id = await seedPaid();
		for (const bad of [
			refund(id, 0, 0),
			refund(id, -100, 0),
			refund(id, 1.5, 0),
			refund(id, 100, -1),
			{ ...refund(id, 100, 0), currency: " " },
		]) {
			await expect(refundOrder(client, bad, undefined), JSON.stringify(bad)).rejects.toThrow(
				RangeError,
			);
		}
		expect(stripe.refundCalls).toHaveLength(0);
	});
});

describe("transitionOrder", () => {
	test("a matching watermark is attempted, and reports the order's settlement", async () => {
		const id = await seedPaid();
		const outcome = await transitionOrder(
			client,
			{ orderId: id, toState: "processing", observedState: "paid" },
			"dana",
		);
		expect(outcome).toMatchObject({
			kind: "attempted",
			result: { ok: true, transitioned: true },
			settlement: "gateway",
		});
	});

	test("a stale watermark is `state_changed` and moves nothing", async () => {
		const id = await seedPaid();
		const outcome = await transitionOrder(
			client,
			{ orderId: id, toState: "processing", observedState: "pending" },
			undefined,
		);
		expect(outcome).toEqual({ kind: "state_changed", liveState: "paid" });
		expect((await harness.stores.orderStore.getById(toOrderId(id)))?.state).toBe("paid");
	});

	test("an order that cannot be re-read is `order_unreadable`", async () => {
		const outcome = await transitionOrder(
			client,
			{ orderId: "ops-missing", toState: "processing", observedState: "paid" },
			undefined,
		);
		expect(outcome).toEqual({ kind: "order_unreadable" });
	});

	test("a target outside the state machine or a blank watermark throws RangeError", async () => {
		const id = await seedPaid();
		await expect(
			transitionOrder(
				client,
				{ orderId: id, toState: "teleported", observedState: "paid" },
				undefined,
			),
		).rejects.toThrow(RangeError);
		await expect(
			transitionOrder(
				client,
				{ orderId: id, toState: "processing", observedState: " " },
				undefined,
			),
		).rejects.toThrow(RangeError);
	});
});

describe("cancelOrder", () => {
	test("a paid order's cancel with a restock choice is attempted and refunds", async () => {
		const id = await seedPaid();
		const outcome = await cancelOrder(
			client,
			{ orderId: id, reason: "customer_request", observedState: "paid", restock: false },
			"dana",
		);
		expect(outcome).toMatchObject({
			kind: "attempted",
			restock: false,
			result: { ok: true, cancelled: true, refund: { amountCents: TOTAL } },
		});
		expect(stripe.refundCalls.map((c) => String(c.idempotencyKey))).toEqual([
			`admin-cancel:${id}:refund`,
		]);
	});

	test("a paid order's cancel with NO restock choice is `restock_choice_required` and changes nothing", async () => {
		const id = await seedPaid();
		const outcome = await cancelOrder(
			client,
			{ orderId: id, reason: "customer_request", observedState: "paid" },
			undefined,
		);
		expect(outcome).toEqual({ kind: "restock_choice_required" });
		expect(stripe.refundCalls).toHaveLength(0);
	});

	test("a stale watermark is `state_changed`", async () => {
		const id = await seedPaid();
		const outcome = await cancelOrder(
			client,
			{ orderId: id, reason: "customer_request", observedState: "pending", restock: true },
			undefined,
		);
		expect(outcome).toEqual({ kind: "state_changed", liveState: "paid" });
	});
});

describe("the straight-through order writes keep their derived keys", () => {
	test("addOrderNote dedupes the same note", async () => {
		const id = await seedPaid();
		const note = { orderId: id, author: "carol", body: "called the buyer" };
		expect(await addOrderNote(client, note, undefined)).toMatchObject({ ok: true, appended: true });
		expect(await addOrderNote(client, note, undefined)).toMatchObject({
			ok: true,
			appended: false,
		});
	});

	test("recordFulfillment refuses a non-http(s) tracking URL with RangeError", async () => {
		const id = await seedPaid();
		await expect(
			recordFulfillment(
				client,
				{
					orderId: id,
					carrier: "UPS",
					trackingNumber: "1Z",
					trackingUrl: "javascript:alert(1)",
					recordedBy: "carol",
				},
				undefined,
			),
		).rejects.toThrow(RangeError);
	});

	test("revokeDownloadAccess on an order with no download is refused NO_DOWNLOADS", async () => {
		const id = await seedPaid();
		expect(await revokeDownloadAccess(client, { orderId: id }, "dana")).toMatchObject({
			ok: false,
			reason: "NO_DOWNLOADS",
		});
	});

	test("resolveReconciliation on an unflagged order does not resolve anything", async () => {
		const id = await seedPaid();
		const result = await resolveReconciliation(
			client,
			{ orderId: id, expectedFlag: "", outcome: "fulfilled", reason: "ok", resolvedBy: "carol" },
			undefined,
		);
		expect(result.ok && result.resolved).toBe(false);
	});

	test("resolveUnverifiedRefund confirms an unverified refund, recording the operator", async () => {
		const id = await seedPaid();
		stripe.setRefundResult({ ok: false, reason: "UNVERIFIED" });
		await refundOrder(client, refund(id, 500, 0), undefined);
		const result = await resolveUnverifiedRefund(
			client,
			{ orderId: id, refundKey: `admin-refund:${id}:500:0`, outcome: "confirmed" },
			"dana",
		);
		expect(result).toMatchObject({ ok: true, changed: true });
		expect(await ledger(id)).toEqual([["recorded", `admin-refund:${id}:500:0`]]);
	});
});

describe("the plugin's public entry exports the operations (MCP reuses them)", () => {
	test("every order operation is re-exported from the package index", () => {
		for (const name of [
			"refundOrder",
			"cancelOrder",
			"transitionOrder",
			"recordFulfillment",
			"addOrderNote",
			"revokeDownloadAccess",
			"resolveUnverifiedRefund",
			"resolveReconciliation",
		]) {
			expect(typeof (pluginIndex as Record<string, unknown>)[name], name).toBe("function");
		}
	});
});
