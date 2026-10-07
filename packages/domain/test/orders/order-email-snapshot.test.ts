import {
	cents,
	createOrderFromCart,
	currency,
	dispatchOrderEmails,
	idempotencyKey,
	money,
	productId as brandProductId,
	renderEmail,
	transitionOrder,
	updateProductCommerceFields,
	upsertProductCommerce,
} from "@otta-sh/domain";
import { FakeEmailSender } from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";
import { makeOrderHarness } from "./fake-harness.js";

/**
 * QA U-3, the snapshot half: the order email lists the order's lines, and those
 * lines must be the ones the buyer PAID FOR — the order's own snapshot (CLAUDE.md:
 * "Orders snapshot price + title at purchase time") — never the live product.
 * Pinned through the real path: place an order, rename and reprice the product,
 * then let the dispatcher build the email data and render it.
 */
describe("order emails are rendered from the order snapshot", () => {
	test("a product renamed and repriced after purchase does not change the email", async () => {
		const h = makeOrderHarness();
		await h.seedPhysical({
			productId: "prod-1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Original Title",
			onHand: 10,
		});
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "prod-1", qty: 2, kind: "physical" },
		]);
		const placed = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey("order-1"),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!placed.ok) throw new Error("order not placed");

		const pid = brandProductId("prod-1");
		const deps = { productCommerce: h.productCommerce, inventory: h.inventory };
		const current = await h.productCommerce.getByProductId(pid);
		await updateProductCommerceFields(
			deps,
			{ productId: pid, price: money(cents(9999), currency("USD")) },
			idempotencyKey("edit-1"),
			current!.updatedAt.toISOString(),
		);
		await upsertProductCommerce(
			deps,
			{ productId: pid, title: "Renamed Product" },
			idempotencyKey("sync-1"),
		);

		await transitionOrder(
			{ orderStore: h.orderStore },
			{ orderId: placed.order.id, toState: "paid", idempotencyKey: idempotencyKey("pay-1") },
		);
		const emailSender = new FakeEmailSender();
		await dispatchOrderEmails({ orderStore: h.orderStore, emailSender, clock: h.clock });

		const sent = emailSender.sends.find((s) => s.template === "order-confirmation");
		expect(sent).toBeDefined();
		// The data carries the recorded totals and the snapshot lines…
		expect(sent!.data).toMatchObject({
			subtotalCents: 2000,
			discountCents: 0,
			totalCents: 2000,
			appliedCouponCode: null,
			shippingCalculated: false,
			taxCalculated: false,
			lines: [{ title: "Original Title", quantity: 2, unitPriceCents: 1000 }],
		});

		// …and the rendered email shows them, never the live product.
		const rendered = renderEmail(sent!.template, sent!.data, {
			formatMoney: (minor, code) => `${code} ${String(minor)}`,
		});
		expect(rendered.text).toContain("Original Title × 2 — USD 2000");
		expect(rendered.text).toContain("Subtotal: USD 2000");
		expect(rendered.text).not.toContain("Renamed Product");
		expect(rendered.text).not.toContain("9999");
		expect(rendered.html).not.toContain("Renamed Product");
	});
});
