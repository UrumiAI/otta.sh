/**
 * #427: the admin order detail carries each line's FROZEN tax status — read off
 * the order's tax snapshot, never the product's live status — so a later product
 * edit cannot change what an old order says about why a line was (not) taxed.
 * A line whose snapshot predates the field (or a legacy / missing snapshot)
 * carries NO status: unknown, never defaulted to "taxable".
 *
 * Driven over a REAL document store through `InProcessAdminOrdersClient`.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	money,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type OrderTaxSnapshotV1,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, beforeEach, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
let harness: InProcessCommerceHarness;
const gateways = { stripe: new FakePaymentGateway({ id: "stripe" }) };

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce({ gateways });
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

const taxed = (lineIndex: number, extra: Record<string, unknown> = {}) => ({
	lineIndex,
	taxClassId: "standard",
	...extra,
	taxableCents: 1000,
	rateBps: 0,
	label: "Tax",
	taxCents: 0,
});

/** A two-line order whose frozen `taxBreakdown` is `taxBreakdown`. */
async function seed(id: string, taxBreakdown: unknown): Promise<string> {
	const line = (n: number) => ({
		productId: toProductId(`prod-${id}-${String(n)}`),
		sku: toSku(`SKU-${id}-${String(n)}`),
		title: `Item ${String(n)}`,
		unitPrice: cents(1000),
		currency: USD,
		quantity: 1,
		fulfillmentKind: "digital" as const,
		reservationId: null,
	});
	await harness.stores.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [line(0), line(1)],
		totals: {
			subtotal: cents(2000),
			total: cents(2000),
			currency: USD,
			// The write port takes today's v1 shape; the older shapes here stand in
			// for documents written by earlier code, so they are cast at this seam.
			taxBreakdown: taxBreakdown as OrderTaxSnapshotV1 | null,
		},
	});
	return id;
}

async function lineStatuses(id: string): Promise<unknown[]> {
	const detail = await new InProcessAdminOrdersClient(harness.ctx, { gateways }).getOrder(id);
	if (detail === null) throw new Error("no order");
	return detail.order.lines.map((l) => ("taxStatus" in l ? l.taxStatus : "<absent>"));
}

test("each line carries the tax status frozen in its order's snapshot", async () => {
	const id = await seed("ord-status", {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		located: true,
		lines: [taxed(0, { taxStatus: "shipping_only" }), taxed(1, { taxStatus: "none" })],
		shipping: null,
	});
	expect(await lineStatuses(id)).toEqual(["shipping_only", "none"]);
});

test("a snapshot written before #427 leaves the status absent (unknown), never 'taxable'", async () => {
	const id = await seed("ord-old-v1", {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		lines: [taxed(0), taxed(1)],
		shipping: null,
	});
	expect(await lineStatuses(id)).toEqual(["<absent>", "<absent>"]);
});

test("a legacy or missing snapshot leaves every status absent", async () => {
	const legacy = await seed("ord-legacy", {
		lines: [
			{ taxClassId: "standard", discountedCents: 1000, taxCents: 0 },
			{ taxClassId: "standard", discountedCents: 1000, taxCents: 0 },
		],
		shippingTaxCents: 0,
	});
	expect(await lineStatuses(legacy)).toEqual(["<absent>", "<absent>"]);
	const none = await seed("ord-null", null);
	expect(await lineStatuses(none)).toEqual(["<absent>", "<absent>"]);
});

test("a status this code does not know never reaches the wire; the line reads as unknown", async () => {
	const id = await seed("ord-future", {
		v: 1,
		calculatorId: "otta.rate-table",
		pricesIncludeTax: false,
		lines: [taxed(0, { taxStatus: "exempt" }), taxed(1, { taxStatus: "none" })],
		shipping: null,
	});
	expect(await lineStatuses(id)).toEqual(["<absent>", "none"]);
});

test("end to end: a [taxable, none, shipping_only] checkout shows each frozen status by position", async () => {
	const products = [
		["p-tax", "SKU-TAX", "taxable"],
		["p-none", "SKU-NONE", "none"],
		["p-ship", "SKU-SHIP", "shipping_only"],
	] as const;
	for (const [id, sku, status] of products) {
		const upserted = await harness.stores.productCommerce.upsert(
			{
				productId: toProductId(id),
				sku: toSku(sku),
				price: money(cents(1000), USD),
				title: id,
				productKind: "digital",
			},
			toIdempotencyKey(`seed-${id}`),
		);
		await harness.stores.productCommerce.updateCommerceFields(
			{ productId: toProductId(id), taxStatus: status },
			toIdempotencyKey(`status-${id}`),
			upserted.updatedAt.toISOString(),
		);
		await harness.stores.productCommerce.activate(
			toProductId(id),
			toIdempotencyKey(`publish-${id}`),
			"2026-01-01T00:00:00.000Z",
		);
	}
	const { cartId } = await harness.client.createCart(USD);
	for (const [id, sku] of products) {
		const added = await harness.client.addCartLine(cartId, sku, id, 1, `add-${id}`);
		expect(added.ok).toBe(true);
	}
	const placed = await harness.client.createOrder(
		{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
		`place-${cartId}`,
	);
	if (!placed.ok) throw new Error(placed.reason);
	const detail = await new InProcessAdminOrdersClient(harness.ctx, { gateways }).getOrder(
		placed.order.id,
	);
	// The order keeps its own line order (not necessarily the add order); each
	// line must carry ITS product's status, matched by the snapshot's lineIndex.
	const lines = detail?.order.lines ?? [];
	expect(lines).toHaveLength(3);
	const expected = new Map<string, string>(products.map(([, sku, status]) => [sku, status]));
	for (const line of lines)
		expect([line.sku, line.taxStatus]).toEqual([line.sku, expected.get(line.sku)]);
});
