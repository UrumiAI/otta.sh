import { describe, expect, test } from "vitest";
import { cents, currency, money } from "../../src/money/cents.js";
import { productId, reservationId, sku } from "../../src/money/ids.js";
import { snapshotOrderLine } from "../../src/orders/line-snapshot.js";
import { type PricedLine, quoteCommandFor } from "../../src/pricing/quote-input.js";

/**
 * The two shared helpers' own contracts (ADR-0028 increment 3). That they
 * reproduce what checkout and `createOrderFromCart` built inline is proven by
 * the characterization suites; these state what any new caller can rely on.
 */
const USD = currency("USD");

const physical: PricedLine = {
	price: money(cents(1500), USD),
	qty: 2,
	taxClass: null,
	productKind: "physical",
};
const digital: PricedLine = {
	price: money(cents(999), USD),
	qty: 1,
	taxClass: "reduced",
	productKind: "digital",
};

describe("quoteCommandFor", () => {
	test("a line's tax base is price × qty at its class, standard when it names none", () => {
		expect(quoteCommandFor({ currency: USD, lines: [physical, digital] }).lines).toEqual([
			{ unitPriceCents: 1500, qty: 2, taxClassId: "standard" },
			{ unitPriceCents: 999, qty: 1, taxClassId: "reduced" },
		]);
	});

	test("the order ships iff any line is physical", () => {
		expect(quoteCommandFor({ currency: USD, lines: [digital] }).requiresShipping).toBe(false);
		expect(quoteCommandFor({ currency: USD, lines: [digital, physical] }).requiresShipping).toBe(
			true,
		);
	});

	test("an optional passed as undefined is absent from the command, not a key", () => {
		const command = quoteCommandFor({
			currency: USD,
			lines: [digital],
			destination: undefined,
			methodId: undefined,
			couponCode: undefined,
		});
		expect(Object.keys(command)).toEqual(["currency", "lines", "requiresShipping"]);
	});

	test("the optionals are carried as given", () => {
		const destination = { country: "US", region: "CA" };
		const command = quoteCommandFor({
			currency: USD,
			lines: [physical],
			destination,
			methodId: "m-1",
			couponCode: "SAVE5",
		});
		expect(command.destination).toBe(destination);
		expect(command.methodId).toBe("m-1");
		expect(command.couponCode).toBe("SAVE5");
	});
});

describe("snapshotOrderLine", () => {
	const ids = { productId: productId("p1"), sku: sku("SKU-1"), title: "Mug" };

	test("freezes the price, currency, title, quantity and kind", () => {
		expect(
			snapshotOrderLine({ ...physical, ...ids, reservationId: reservationId("res-1") }),
		).toEqual({
			productId: "p1",
			sku: "SKU-1",
			title: "Mug",
			unitPrice: 1500,
			currency: "USD",
			quantity: 2,
			fulfillmentKind: "physical",
			reservationId: "res-1",
		});
	});

	test("a digital line carries no hold, whatever is passed", () => {
		expect(
			snapshotOrderLine({ ...digital, ...ids, reservationId: reservationId("res-1") })
				.reservationId,
		).toBeNull();
	});
});
