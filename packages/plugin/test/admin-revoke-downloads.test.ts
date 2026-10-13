/**
 * The console's "Revoke download access" (issue #447): a paid order whose money
 * left without moving it — a dispute or chargeback — keeps its download open
 * until an operator closes it here. Driven through the action the order detail
 * posts (`orders:revoke-downloads`), over a real document store (in-memory
 * SQLite, the host's migrations), and checked against the download route itself.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	money,
	orderId as toOrderId,
	type OrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import { dispatchOrdersAction } from "../src/admin/orders-actions.js";
import { createEntitlementDownloadHandler } from "../src/entitlements/download-route.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
const ULID = "01J9ZQ3V8K4M2N6P7R8S9T0VWX";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

/** A paid order for one digital line whose product carries a file, with the
 *  grant settlement writes — a buyer the download route authorizes. */
async function seedPaidDigital(id: string, opts: { paid?: boolean } = {}): Promise<OrderId> {
	const oid = toOrderId(id);
	const pid = toProductId(`prod-${id}`);
	const sku = toSku(`DIG-${id}`);
	const row = await harness.stores.productCommerce.upsert(
		{ productId: pid, sku, price: money(cents(1500), USD), productKind: "digital" },
		toIdempotencyKey(`seed-prod-${id}`),
	);
	const attached = await harness.stores.productCommerce.updateCommerceFields(
		{
			productId: pid,
			downloadAsset: {
				key: `dl/${pid}/${ULID}`,
				filename: "guide.pdf",
				contentType: "application/pdf",
				size: 2048,
			},
		},
		toIdempotencyKey(`seed-asset-${id}`),
		row.updatedAt.toISOString(),
	);
	if (!attached.ok) throw new Error("seed: asset not attached");
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: pid,
				sku,
				title: "Ebook",
				unitPrice: cents(1500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
	});
	if (opts.paid === false) return oid;
	await harness.stores.orderStore.markPaid(oid);
	await harness.stores.entitlementStore.grant({
		orderId: oid,
		productId: pid,
		sku,
		buyerRef: "buyer@example.com",
		source: "order_paid",
		grantIdempotencyKey: toIdempotencyKey(`ent:${id}:${sku}`),
	});
	return oid;
}

function download(id: string): Promise<unknown> {
	return createEntitlementDownloadHandler()(
		{
			input: { orderId: id, sku: `DIG-${id}` } as never,
			request: { method: "POST", url: "/route", headers: {} },
		},
		harness.ctx,
	);
}

function revoke(id: string, operator?: string) {
	return dispatchOrdersAction(
		"orders:revoke-downloads",
		{ orderId: id },
		new InProcessAdminOrdersClient(harness.ctx),
		operator,
	);
}

describe("orders:revoke-downloads", () => {
	test("closes the download at once, and History records who did it", async () => {
		const id = await seedPaidDigital("ord-dispute");
		expect(await download(id)).toMatchObject({ authorized: true });

		const res = await revoke(id, "carol");

		expect(res?.notice).toMatchObject({ variant: "default", title: "Download access revoked" });
		expect(await download(id)).toEqual({ authorized: false, reason: "NOT_FOUND" });
		// The order itself is untouched: still paid, nothing refunded.
		expect((await harness.stores.orderStore.getById(toOrderId(id)))?.state).toBe("paid");
		const notes = await new InProcessAdminOrdersClient(harness.ctx).listNotes(id);
		expect(notes.map((n) => n.author)).toEqual(["carol"]);
	});

	test("the order detail says open before the revoke and revoked after", async () => {
		const id = await seedPaidDigital("ord-detail");
		const client = new InProcessAdminOrdersClient(harness.ctx);
		expect((await client.getOrder(id))?.downloads).toBe("open");
		await revoke(id, "carol");
		expect((await client.getOrder(id))?.downloads).toBe("revoked");
	});

	test("a PENDING order is refused: nothing to close yet, and no note claims it was", async () => {
		const id = await seedPaidDigital("ord-pending", { paid: false });
		const res = await revoke(id, "carol");
		expect(res?.notice).toMatchObject({ variant: "error", title: "Download access not revoked" });
		expect(res?.notice?.description).toContain("not open");
		expect(await new InProcessAdminOrdersClient(harness.ctx).listNotes(id)).toEqual([]);
		expect((await new InProcessAdminOrdersClient(harness.ctx).getOrder(id))?.downloads).toBe(
			undefined,
		);
	});

	test("a second click changes nothing and says access was already closed", async () => {
		const id = await seedPaidDigital("ord-twice");
		await revoke(id, "carol");

		const again = await revoke(id, "carol");

		expect(again?.notice).toMatchObject({ title: "Download access already revoked" });
		expect(await new InProcessAdminOrdersClient(harness.ctx).listNotes(id)).toHaveLength(1);
		expect(await download(id)).toEqual({ authorized: false, reason: "NOT_FOUND" });
	});

	test("an order with no downloads is refused with an error notice", async () => {
		await harness.stores.orderStore.createFromCart({
			orderId: toOrderId("ord-mug"),
			cartId: null,
			currency: USD,
			idempotencyKey: toIdempotencyKey("seed-ord-mug"),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
			lines: [
				{
					productId: toProductId("prod-mug"),
					sku: toSku("MUG"),
					title: "Mug",
					unitPrice: cents(900),
					currency: USD,
					quantity: 1,
					fulfillmentKind: "physical",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(900), total: cents(900), currency: USD },
		});
		const res = await revoke("ord-mug", "carol");
		expect(res?.notice).toMatchObject({ variant: "error" });
		expect(await new InProcessAdminOrdersClient(harness.ctx).listNotes("ord-mug")).toEqual([]);
	});

	test("a payload with no order id is unreadable and changes nothing", async () => {
		const res = await dispatchOrdersAction(
			"orders:revoke-downloads",
			{},
			new InProcessAdminOrdersClient(harness.ctx),
			"carol",
		);
		expect(res?.notice).toMatchObject({ variant: "error", title: "That action could not be read" });
	});
});
