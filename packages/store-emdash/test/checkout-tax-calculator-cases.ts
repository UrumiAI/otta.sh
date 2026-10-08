/**
 * PR 1 (tax calculator hook) through REAL documents, shared by the sqlite/pg
 * tier (`checkout-tax-calculator.dialects.test.ts`) and the D1 tier
 * (`d1/checkout-tax-calculator.d1.spec.ts`). What the domain's fake suite cannot
 * show: a refusing calculator leaves the order, coupon and inventory DOCUMENTS
 * untouched, and the typed v1 snapshot round-trips through the order document.
 */
import {
	cents,
	createOrderFromCart,
	currency,
	idempotencyKey,
	readOrderTaxSnapshot,
	type CreateOrderDeps,
	type TaxCalculator,
} from "@otta-sh/domain";
import { expect, test, vi } from "vitest";
import type { StorageAccess } from "../src/index.js";
import { makeCouponHarness } from "./coupon-harness.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";

const USD = currency("USD");

/** A store's storage binding, resolved lazily (it opens in a `beforeAll`). */
export interface BoundStorage {
	readonly storage: StorageAccess;
}

const answering: TaxCalculator = {
	id: "acme.tax",
	async calculate(req) {
		return {
			ok: true,
			currency: req.currency,
			lines: req.lines.map((l) => ({
				lineId: l.lineId,
				rateBps: 888,
				label: "NY",
				taxCents: cents(222),
			})),
			shipping: null,
		};
	},
};

export function checkoutTaxCalculatorCases(bound: BoundStorage): void {
	async function setup(taxCalculator: TaxCalculator) {
		const orders: OrderHarness = makeOrderHarness(bound.storage);
		const coupons = makeCouponHarness(bound.storage, { clock: orders.clock });
		await coupons.store.create({
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: 5,
			maxUsesPerCustomer: null,
		});
		await orders.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Mug",
			onHand: 5,
		});
		const cartId = await orders.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
		]);
		const deps: CreateOrderDeps = {
			...orders.createDeps,
			couponStore: coupons.store,
			taxCalculator,
		};
		const command = {
			cartId,
			idempotencyKey: idempotencyKey(`k-${cartId}`),
			buyerRef: "ada@example.com",
			paymentMethod: "stripe" as const,
			couponCode: "SAVE5",
		};
		return { orders, coupons, deps, command, cartId };
	}

	test("a refusing calculator ⇒ TAX_UNAVAILABLE with no order, redemption or hold moved", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { orders, coupons, deps, command, cartId } = await setup({
				id: "acme.tax",
				calculate: () => Promise.reject(new Error("503")),
			});
			expect(await createOrderFromCart(deps, command)).toEqual({
				ok: false,
				reason: "TAX_UNAVAILABLE",
			});
			expect(await orders.store.getByIdempotencyKey(command.idempotencyKey)).toBeNull();
			expect((await coupons.store.findById("cpn"))?.usesCount).toBe(0);
			const cart = await orders.cartStore.get(cartId);
			expect(cart?.state).toBe("active");
			for (const line of cart?.lines ?? []) {
				expect(await orders.reservationState(line.reservationId as string)).toBe("held");
			}
			expect(orders.stripeGateway.intentCalls).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test("an answer is frozen into the order document as the v1 snapshot", async () => {
		const { orders, deps, command } = await setup(answering);
		const res = await createOrderFromCart(deps, command);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const stored = await orders.store.getById(res.order.id);
		expect(stored?.totals).toMatchObject({ tax: 222, total: 2500 + 222 });
		expect(readOrderTaxSnapshot(stored?.totals.taxBreakdown)).toEqual({
			v: 1,
			calculatorId: "acme.tax",
			pricesIncludeTax: false,
			// ADR-0031: no shipping zone matched (this store has none), so not located.
			located: false,
			lines: [
				{
					lineIndex: 0,
					taxClassId: "standard",
					taxableCents: 2500,
					rateBps: 888,
					label: "NY",
					taxCents: 222,
				},
			],
			shipping: null,
		});
	});
}
