import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cents, idempotencyKey, productId } from "../../src/index.js";
import { createOrderFromCart } from "../../src/orders/create-order-from-cart.js";
import { readOrderTaxSnapshot } from "../../src/orders/order-tax-snapshot.js";
import type { TaxCalculator, TaxRequest } from "../../src/pricing/tax-calculator.js";
import { makeOrderHarness, type OrderHarness, USD } from "./fake-harness.js";

/**
 * Order creation inherits the calculator through `computeQuote`, which runs
 * BEFORE any coupon redemption, order mint or hold adoption: a calculator that
 * cannot answer refuses the checkout with nothing moved. A good answer is
 * frozen into the order as the typed v1 snapshot, once.
 */
let h: OrderHarness;

beforeEach(async () => {
	h = makeOrderHarness();
	await h.shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
	await h.shippingRules.createMethod({ id: "m", zoneId: "z-us", name: "Flat", type: "flat_rate" });
	await h.shippingRules.createRate({
		methodId: "m",
		currency: USD,
		amountCents: cents(500),
		minSubtotalCents: null,
	});
	await h.taxRules.createClass({ id: "standard", name: "Standard rate" });
	await h.taxRules.createRate({
		id: "t",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 1000,
		appliesToShipping: true,
	});
	await h.couponStore.create({
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
	await h.seedPhysical({
		productId: "p1",
		sku: "SKU-1",
		priceCents: 1500,
		title: "Mug",
		onHand: 5,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const command = (cartId: string) => ({
	cartId,
	idempotencyKey: idempotencyKey(`k-${cartId}`),
	buyerRef: "ada@example.com",
	paymentMethod: "stripe" as const,
	couponCode: "SAVE5",
	shippingMethodId: "m",
	shippingAddress: {
		name: "Ada",
		line1: "1 Main St",
		city: "New York",
		region: "NY",
		postalCode: "10001",
		country: "US",
	},
});

describe("createOrderFromCart → TaxCalculator", () => {
	test("a refusing calculator ⇒ TAX_UNAVAILABLE: no order, no redemption, holds untouched", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const before = await h.cartStore.get(cartId);
		const refusing: TaxCalculator = {
			id: "acme.tax",
			calculate: async () => ({ ok: false, reason: "unavailable" }),
		};
		const res = await createOrderFromCart(
			{ ...h.createDeps, taxCalculator: refusing },
			command(cartId),
		);
		expect(res).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });
		expect(await h.orderStore.getByIdempotencyKey(idempotencyKey(`k-${cartId}`))).toBeNull();
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(0);
		const after = await h.cartStore.get(cartId);
		expect(after?.state).toBe("active");
		expect(after?.lines).toEqual(before?.lines);
		for (const line of after?.lines ?? []) {
			expect(h.inventory.reservationState(line.reservationId as string)).toBe("held");
		}
		expect(h.stripeGw.intentCalls).toEqual([]);
	});

	test("the built-in writes the typed v1 snapshot, labelled by class name", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, command(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// 3000 − 500 coupon = 2500 @10% = 250; shipping 500 @10% = 50.
		expect(res.order.totals.taxBreakdown).toEqual({
			v: 1,
			calculatorId: "otta.rate-table",
			pricesIncludeTax: false,
			// ADR-0032: the zone matched, so the tax was calculated for a place.
			located: true,
			lines: [
				{
					lineIndex: 0,
					taxClassId: "standard",
					// #427: the product's tax status, frozen with the line.
					taxStatus: "taxable",
					taxableCents: 2500,
					rateBps: 1000,
					label: "Standard rate",
					taxCents: 250,
				},
			],
			shipping: { taxableCents: 500, rateBps: 1000, label: "Standard rate", taxCents: 50 },
			// #478: the "Display tax totals" the order was placed under (nothing
			// saved and a rate exists: the upgrade rule's single row).
			totalsDisplay: "single",
		});
		expect(res.order.totals.tax).toBe(300);
		expect(readOrderTaxSnapshot(res.order.totals.taxBreakdown)?.v).toBe(1);
	});

	test("an outside calculator is asked for purpose 'order' with the full address, and frozen", async () => {
		const seen: TaxRequest[] = [];
		const calc: TaxCalculator = {
			id: "acme.tax",
			async calculate(req) {
				seen.push(req);
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
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(
			{ ...h.createDeps, taxCalculator: calc },
			command(cartId),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			purpose: "order",
			destination: { country: "US", region: "NY", postalCode: "10001", city: "New York" },
		});
		expect(res.ok && res.order.totals).toMatchObject({
			tax: 222,
			total: 2500 + 500 + 222,
			taxBreakdown: {
				v: 1,
				calculatorId: "acme.tax",
				lines: [{ lineIndex: 0, rateBps: 888, label: "NY", taxCents: 222 }],
				shipping: null,
			},
		});
	});
});

/** An outside calculator whose answer the test can change between calls. */
function switchable(): TaxCalculator & {
	calls: number;
	mode: { kind: "tax"; taxCents: number } | "throw" | "refuse";
} {
	const calc = {
		id: "acme.tax",
		calls: 0,
		mode: { kind: "tax", taxCents: 222 } as { kind: "tax"; taxCents: number } | "throw" | "refuse",
		async calculate(req: TaxRequest) {
			calc.calls += 1;
			const mode = calc.mode;
			if (mode === "throw") throw new Error("calculator down");
			if (mode === "refuse") return { ok: false as const, reason: "unavailable" as const };
			return {
				ok: true as const,
				currency: req.currency,
				lines: req.lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 888,
					label: "NY",
					taxCents: cents(mode.taxCents),
				})),
				shipping: null,
			};
		},
	};
	return calc;
}

/**
 * Issue #447 (from #414): idempotency across the calculator. A same-key replay
 * returns the order AS COMMITTED — the calculator is not asked again, so a
 * calculator that now answers differently, throws or refuses cannot change or
 * fail it. And a TAX_UNAVAILABLE commits nothing, so a retry under the same key
 * succeeds once the calculator answers.
 */
describe("createOrderFromCart → TaxCalculator replay (issue #447)", () => {
	for (const change of ["a different tax", "a throw", "a refusal"] as const) {
		test(`the calculator answers ${change} before a same-key replay ⇒ the ORIGINAL order`, async () => {
			const calc = switchable();
			const cartId = await h.cartWith([
				{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" },
			]);
			const deps = { ...h.createDeps, taxCalculator: calc };
			const first = await createOrderFromCart(deps, command(cartId));
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			expect(first.order.totals.tax).toBe(222);
			expect(calc.calls).toBe(1);

			calc.mode =
				change === "a different tax"
					? { kind: "tax", taxCents: 999 }
					: change === "a throw"
						? "throw"
						: "refuse";
			const replay = await createOrderFromCart(deps, command(cartId));
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			expect(replay.order.id).toBe(first.order.id);
			expect(replay.order.totals).toEqual(first.order.totals);
			expect(calc.calls).toBe(1);
			expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
		});
	}

	test("a retry under the same key after TAX_UNAVAILABLE succeeds once the calculator answers", async () => {
		const calc = switchable();
		calc.mode = "throw";
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const deps = { ...h.createDeps, taxCalculator: calc };
		const refused = await createOrderFromCart(deps, command(cartId));
		expect(refused).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });

		calc.mode = { kind: "tax", taxCents: 222 };
		const retried = await createOrderFromCart(deps, command(cartId));
		expect(retried.ok).toBe(true);
		if (!retried.ok) return;
		expect(retried.order.totals).toMatchObject({ tax: 222, total: 2500 + 500 + 222 });
		expect(await h.orderStore.getByIdempotencyKey(idempotencyKey(`k-${cartId}`))).not.toBeNull();
		expect((await h.couponStore.findById("cpn"))?.usesCount).toBe(1);
		expect(h.stripeGw.intentCalls).toHaveLength(1);
	});
});

describe("createOrderFromCart → product tax status (PR 2b)", () => {
	test("#427: a cart of [taxable, none, shipping_only] freezes each status at its own position", async () => {
		for (const [id, sku, status] of [
			["p2", "SKU-2", "none"],
			["p3", "SKU-3", "shipping_only"],
		] as const) {
			await h.seedPhysical({ productId: id, sku, priceCents: 1000, title: id, onHand: 5 });
			const row = await h.productCommerce.getByProductId(productId(id));
			if (row === null) throw new Error(`no seeded row ${id}`);
			const edited = await h.productCommerce.updateCommerceFields(
				{ productId: productId(id), taxStatus: status },
				idempotencyKey(`status-${id}`),
				row.updatedAt.toISOString(),
			);
			expect(edited.ok).toBe(true);
		}
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" },
			{ sku: "SKU-3", productId: "p3", qty: 1, kind: "physical" },
		]);
		const res = await createOrderFromCart(h.createDeps, {
			...command(cartId),
			couponCode: undefined,
		});
		if (!res.ok) throw new Error(`create failed: ${res.reason}`);
		const stored = await h.orderStore.getById(res.order.id);
		const snapshot = readOrderTaxSnapshot(stored?.totals.taxBreakdown);
		if (snapshot?.v !== 1) throw new Error("expected a v1 snapshot");
		expect(stored?.lines.map((l) => l.sku)).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
		expect(snapshot.lines.map((l) => [l.lineIndex, l.taxStatus])).toEqual([
			[0, "taxable"],
			[1, "none"],
			[2, "shipping_only"],
		]);
		// Only the taxable line carried tax (1500 @10% = 150).
		expect(snapshot.lines.map((l) => l.taxCents)).toEqual([150, 0, 0]);
	});

	test("#427: a replay with the same idempotency key returns the byte-identical snapshot", async () => {
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const first = await createOrderFromCart(h.createDeps, command(cartId));
		if (!first.ok) throw new Error("first create failed");
		// The product's status changes after the order: the frozen line must not.
		const row = await h.productCommerce.getByProductId(productId("p1"));
		if (row === null) throw new Error("no seeded row");
		await h.productCommerce.updateCommerceFields(
			{ productId: productId("p1"), taxStatus: "none" },
			idempotencyKey("status-after"),
			row.updatedAt.toISOString(),
		);
		const replay = await createOrderFromCart(h.createDeps, command(cartId));
		if (!replay.ok) throw new Error("replay failed");
		expect(replay.order.id).toBe(first.order.id);
		expect(JSON.stringify(replay.order.totals.taxBreakdown)).toBe(
			JSON.stringify(first.order.totals.taxBreakdown),
		);
		const stored = await h.orderStore.getById(first.order.id);
		expect(JSON.stringify(stored?.totals.taxBreakdown)).toBe(
			JSON.stringify(first.order.totals.taxBreakdown),
		);
		const snapshot = readOrderTaxSnapshot(stored?.totals.taxBreakdown);
		expect(snapshot?.v === 1 && snapshot.lines[0]?.taxStatus).toBe("taxable");
	});

	test("a 'none' product: line tax 0 in the totals and the v1 snapshot; shipping still taxed (legacy)", async () => {
		const row = await h.productCommerce.getByProductId(productId("p1"));
		if (row === null) throw new Error("no seeded row");
		const edited = await h.productCommerce.updateCommerceFields(
			{ productId: productId("p1"), taxStatus: "none" },
			idempotencyKey("status-none"),
			row.updatedAt.toISOString(),
		);
		expect(edited.ok && edited.product.taxStatus).toBe("none");
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, command(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const snapshot = readOrderTaxSnapshot(res.order.totals.taxBreakdown);
		if (snapshot?.v !== 1) throw new Error("expected a v1 snapshot");
		expect(snapshot.lines.map((l) => l.taxCents)).toEqual([0]);
		// #427: the order remembers WHY the line carried no tax.
		expect(snapshot.lines.map((l) => l.taxStatus)).toEqual(["none"]);
		// Nothing saved + rates ⇒ legacy: shipping keeps its tax, 500 @10% = 50.
		expect(snapshot.shipping?.taxCents).toBe(50);
		expect(res.order.totals.tax).toBe(50);
	});

	test("a method that is not taxable: no shipping tax on the order", async () => {
		const updated = await h.shippingRules.updateMethod("m", {
			name: "Flat",
			type: "flat_rate",
			taxable: false,
		});
		expect(updated.ok && updated.method.taxable).toBe(false);
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, command(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const snapshot = readOrderTaxSnapshot(res.order.totals.taxBreakdown);
		if (snapshot?.v !== 1) throw new Error("expected a v1 snapshot");
		expect(snapshot.shipping).toBeNull();
		expect(res.order.totals.tax).toBe(250);
	});
});
