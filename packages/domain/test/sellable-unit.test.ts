import {
	cents,
	currency,
	money,
	productId,
	productsSellingVariants,
	resolveSellableUnit,
	sku,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

const USD = currency("USD");
const product = { sku: sku("TEE"), price: money(cents(2000), USD), title: "Tee" };
const variant = (
	key: string,
	fields: {
		sku?: string | null;
		amount?: number | null;
		title?: string | null;
		orphaned?: boolean;
	},
) => ({
	variantKey: key,
	sku: fields.sku === null ? null : sku(fields.sku ?? `TEE-${key}`),
	price: fields.amount === null ? null : money(cents(fields.amount ?? 2500), USD),
	title: fields.title === undefined ? key.toUpperCase() : fields.title,
	orphanedAt: fields.orphaned === true ? new Date("2026-08-09T00:00:00.000Z") : null,
});

describe("resolveSellableUnit — what one cart line sells", () => {
	test("the product's own sku sells the product, at its price and title", () => {
		expect(resolveSellableUnit(product, [variant("m", {})], "TEE")).toEqual({
			kind: "product",
			sku: "TEE",
			price: product.price,
			title: "Tee",
			variantKey: null,
		});
	});

	test("a live variant's sku sells the variant, titled `<product> — <variant>`", () => {
		const unit = resolveSellableUnit(product, [variant("m", { amount: 2600 })], "TEE-m");
		expect(unit).toEqual({
			kind: "variant",
			sku: "TEE-m",
			price: money(cents(2600), USD),
			title: "Tee — M",
			variantKey: "m",
		});
	});

	test("a variant with no name is titled by its key", () => {
		expect(resolveSellableUnit(product, [variant("xl", { title: null })], "TEE-xl")?.title).toBe(
			"Tee — xl",
		);
	});

	test("an unpriced variant resolves with a null price — the caller refuses it", () => {
		expect(resolveSellableUnit(product, [variant("s", { amount: null })], "TEE-s")?.price).toBe(
			null,
		);
	});

	test("an orphaned variant, an unknown sku and a sku-less variant resolve to null", () => {
		const rows = [variant("m", { orphaned: true }), variant("n", { sku: null })];
		expect(resolveSellableUnit(product, rows, "TEE-m")).toBe(null);
		expect(resolveSellableUnit(product, rows, "OTHER")).toBe(null);
	});

	test("an untitled product carries a null title through to its variants", () => {
		expect(
			resolveSellableUnit({ ...product, title: null }, [variant("m", {})], "TEE-m")?.title,
		).toBe(null);
	});
});

describe("productsSellingVariants — whose variants a sell path must read", () => {
	test("only products with a line naming another sku than their own, each once", () => {
		const a = productId("a");
		const b = productId("b");
		const products = new Map([
			[a, { sku: sku("A") }],
			[b, { sku: sku("B") }],
		]);
		const lines = [
			{ productId: "a", sku: "A" },
			{ productId: "b", sku: "B-m" },
			{ productId: "b", sku: "B-l" },
			{ productId: null, sku: "X" },
			{ productId: "unknown", sku: "U" },
		];
		expect(productsSellingVariants(lines, products)).toEqual([b]);
	});

	test("a cart of product skus needs no variant read", () => {
		const a = productId("a");
		expect(
			productsSellingVariants([{ productId: "a", sku: "A" }], new Map([[a, { sku: sku("A") }]])),
		).toEqual([]);
	});
});
