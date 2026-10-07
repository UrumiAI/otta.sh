/**
 * The domain's `productCommerceStoreContract` against
 * `EmdashProductCommerceStore`, on every Node dialect.
 *
 * The contract suite IS the spec: the same 183 cases the fake and the SQL
 * adapter run, with no skips and no narrowing. What it exercises here that it
 * cannot exercise on the fake is that the guard ORDER survives being reassembled
 * out of compare-and-sets — the zero-row classifier, the sku claim's precedence
 * over both stock refusals, and the embedded variants' currency resolution all
 * have to give the same answers they gave inside a transaction.
 */
import {
	cents,
	currency,
	idempotencyKey,
	InvalidProductFieldError,
	money,
	productId,
	sku,
	updateProductCommerceFields,
} from "@otta-sh/domain";
import { CountingIdGen, productCommerceStoreContract } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { EmdashInventoryStore } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

describeEachDialect("EmdashProductCommerceStore", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);
	productCommerceStoreContract(async () => makeProductCommerceHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});

// A product document written before `downloadAsset` existed has no such key at all.
// It must read as "no file" (`null`, not `undefined`), and an edit must still be able
// to attach one to it — the field is additive, with no migration (issue #376).
describeEachDialect("EmdashProductCommerceStore downloadAsset on an older document", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	test("a document without the field reads null, and an edit attaches a file to it", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const pid = productId("legacy-dl");
		await h.store.upsert(
			{
				productId: pid,
				sku: sku("SKU-LEGACY"),
				price: money(cents(900), currency("USD")),
				productKind: "digital",
			},
			idempotencyKey("seed"),
		);
		const stored = await h.products.getVersioned(pid);
		if (stored === null) throw new Error("seed wrote no document");
		const { downloadAsset: _dropped, ...older } = stored.value;
		await h.products.compareAndSet(pid, stored.revision, older);
		expect("downloadAsset" in ((await h.products.get(pid)) ?? {})).toBe(false);

		const read = await h.store.getByProductId(pid);
		expect(read?.downloadAsset).toBeNull();

		const asset = {
			key: `dl/${pid}/01J9ZQ3V8K4M2N6P7R8S9T0VWX`,
			filename: "guide.pdf",
			contentType: "application/pdf",
			size: 10,
		};
		const res = await h.store.updateCommerceFields(
			{ productId: pid, downloadAsset: asset },
			idempotencyKey("attach"),
			read?.updatedAt.toISOString() ?? "",
		);
		expect(res.ok && res.product.downloadAsset).toEqual(asset);
	});
});

// A product document written before `taxStatus` existed (PR 2b) has no such key.
// It must read "taxable" — what it was charged as — with no migration, and an edit
// must still be able to set it.
describeEachDialect("EmdashProductCommerceStore taxStatus on an older document", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	test("a document without the field reads taxable, and an edit sets it", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const pid = productId("legacy-ts");
		await h.store.upsert(
			{
				productId: pid,
				sku: sku("SKU-LEGACY-TS"),
				price: money(cents(900), currency("USD")),
				productKind: "physical",
			},
			idempotencyKey("seed"),
		);
		const stored = await h.products.getVersioned(pid);
		if (stored === null) throw new Error("seed wrote no document");
		const { taxStatus: _dropped, ...older } = stored.value as typeof stored.value & {
			taxStatus?: unknown;
		};
		await h.products.compareAndSet(pid, stored.revision, older as typeof stored.value);
		expect("taxStatus" in ((await h.products.get(pid)) ?? {})).toBe(false);

		const read = await h.store.getByProductId(pid);
		expect(read?.taxStatus).toBe("taxable");
		const res = await h.store.updateCommerceFields(
			{ productId: pid, taxStatus: "shipping_only" },
			idempotencyKey("set-status"),
			read?.updatedAt.toISOString() ?? "",
		);
		expect(res.ok && res.product.taxStatus).toBe("shipping_only");
		expect((await h.store.getByProductId(pid))?.taxStatus).toBe("shipping_only");
	});
});

// A lone UTF-16 surrogate in a filename used to reach storage, where Postgres's jsonb
// cast rejects it with an unmapped storage error while SQLite keeps it. The use-case
// now refuses it by name before any write, on every dialect alike.
describeEachDialect("EmdashProductCommerceStore downloadAsset ill-formed filename", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	test("a lone surrogate in the filename is an input refusal, not a storage error", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const pid = productId("surrogate-dl");
		const seeded = await h.store.upsert(
			{
				productId: pid,
				sku: sku("SKU-SURROGATE"),
				price: money(cents(900), currency("USD")),
				productKind: "digital",
			},
			idempotencyKey("seed"),
		);
		const err = await updateProductCommerceFields(
			{
				productCommerce: h.store,
				inventory: new EmdashInventoryStore({
					storage: bound.storage,
					idGen: new CountingIdGen("r"),
					clock: h.clock,
				}),
			},
			{
				productId: pid,
				downloadAsset: {
					key: `dl/${pid}/01J9ZQ3V8K4M2N6P7R8S9T0VWX`,
					filename: `a${String.fromCharCode(0xd800)}.pdf`,
					contentType: "application/pdf",
					size: 10,
				},
			},
			idempotencyKey("attach"),
			seeded.updatedAt.toISOString(),
		).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(InvalidProductFieldError);
		expect((err as InvalidProductFieldError).field).toBe("downloadAsset.filename");
		expect((await h.store.getByProductId(pid))?.downloadAsset).toBeNull();
	});
});
