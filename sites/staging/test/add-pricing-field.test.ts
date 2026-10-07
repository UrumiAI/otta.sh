/**
 * The migration for stores created before the Pricing & stock cards: what it
 * decides from a collection's fields (ADR-0014, amendment 2026-10-01).
 */
import { describe, expect, test } from "vitest";
import { PRICING_FIELD, planPricingField } from "../scripts/add-pricing-field.js";

const BEFORE = [
	{ slug: "title", type: "string" },
	{ slug: "description", type: "text" },
	{ slug: "images", type: "image" },
	{ slug: "variants", type: "repeater" },
];

describe("add-pricing-field", () => {
	test("binds the same field the seed declares", () => {
		expect(PRICING_FIELD).toEqual({
			slug: "pricing",
			label: "Pricing & stock",
			type: "json",
			widget: "otta-console:pricing",
		});
	});

	test("an older store gets the field, placed right after Images", () => {
		expect(planPricingField(BEFORE)).toEqual({
			kind: "create",
			order: ["title", "description", "images", "pricing", "variants"],
		});
	});

	test("a store that already has it is left alone, so the script is safe to re-run", () => {
		expect(
			planPricingField([
				...BEFORE,
				{ slug: "pricing", type: "json", widget: "otta-console:pricing" },
			]),
		).toEqual({
			kind: "ok",
		});
	});

	test("a pricing JSON field added by hand (raw editor, no widget) is re-bound to the cards", () => {
		expect(planPricingField([...BEFORE, { slug: "pricing", type: "json", widget: null }])).toEqual({
			kind: "bind",
		});
	});

	test("a different field that happens to be called pricing is refused, never overwritten", () => {
		const plan = planPricingField([...BEFORE, { slug: "pricing", type: "string" }]);
		expect(plan.kind).toBe("refuse");
	});
});
