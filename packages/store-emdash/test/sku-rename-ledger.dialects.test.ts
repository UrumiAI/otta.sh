/**
 * The sku-rename carry's AUDIT TRAIL — the pair of `inventory_movements` entries a
 * rename writes for the units it moved.
 *
 * This lives outside `productCommerceStoreContract` because the ledger is a STORE
 * concern, not part of the `ProductCommerceStore` port: the fake has nothing to
 * say about it, so the contract suite cannot see these documents. It runs per
 * dialect all the same, because the trail is a durability claim and only a real
 * database can be asked whether it kept it.
 *
 * Ported case-for-case from the SQL adapter's own suite. Two things differ, and
 * neither is a weakening: the entries are DOCUMENTS with `rename:`-prefixed ids
 * rather than rows in a table with a unique key, and there is no `qty > 0` column
 * CHECK behind the "a rename that carries nothing records nothing" case — so that
 * case now pins a decision the code makes rather than one the schema enforces,
 * which is exactly why it is still here.
 */
import { idempotencyKey, productId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	INVENTORY_MOVEMENTS_COLLECTION,
	skuRenameLedgerId,
	type SkuRenameLedgerDoc,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { PRODUCT_COMMERCE_LAYOUT } from "./product-commerce-collections.js";
import { makeProductCommerceHarness } from "./product-commerce-harness.js";

/** A live product on `s`, stocked at `onHand`; returns its CAS watermark. */
async function seedStocked(
	h: ReturnType<typeof makeProductCommerceHarness>,
	id: string,
	s: string,
	onHand: number,
): Promise<string> {
	const row = await h.store.upsert(
		{ productId: productId(id), sku: sku(s) },
		idempotencyKey(`seed-${id}`),
	);
	await h.seedStock(s, onHand);
	return row.updatedAt.toISOString();
}

describeEachDialect("sku-rename audit trail", (ctx) => {
	const bound = ctx.useStorage(PRODUCT_COMMERCE_LAYOUT);

	/** Every RENAME entry for a sku, oldest first. */
	async function movements(s: string): Promise<SkuRenameLedgerDoc[]> {
		const ledger = bound.collection<SkuRenameLedgerDoc>(INVENTORY_MOVEMENTS_COLLECTION);
		const page = await ledger.query({
			where: { sku: s },
			orderBy: { createdAt: "asc" },
			limit: 100,
		});
		// The collection also holds the per-key movement claims; the rename trail is
		// the `kind: "rename"` half of it, and the two never share an id space.
		return page.items.map(({ data }) => data).filter((entry) => entry.kind === "rename");
	}

	test("a rename writes one entry OUT of the source and one INTO the target, with the moved quantity on both", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-led", "SKU-LED-FROM", 40);

		const res = await h.store.updateCommerceFields(
			{ productId: productId("prod-led"), sku: sku("SKU-LED-TO") },
			idempotencyKey("led-rename"),
			wm,
		);
		expect(res.ok).toBe(true);

		const out = await movements("SKU-LED-FROM");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			sku: "SKU-LED-FROM",
			direction: "rename_out",
			qty: 40,
			outcome: "ok",
			// The source is left empty, so its resulting count is 0.
			resultOnHand: 0,
		});

		const into = await movements("SKU-LED-TO");
		expect(into).toHaveLength(1);
		expect(into[0]).toMatchObject({
			sku: "SKU-LED-TO",
			direction: "rename_in",
			qty: 40,
			outcome: "ok",
			// The target ends holding exactly what arrived.
			resultOnHand: 40,
		});

		// The two entries are a PAIR: same quantity, same token, opposite ends of one
		// move — so the ledger reads as "40 left here, 40 arrived there" rather than as
		// two unrelated adjustments.
		expect(out[0]?.qty).toBe(into[0]?.qty);
		expect(out[0]?.token).toBe(into[0]?.token);
	});

	test("the trail follows the move — a refused rename leaves no entry behind", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-led-ref", "SKU-LEDR-FROM", 12);
		// An occupied target: the rename is refused by the claim, before anything moves.
		await h.seedStock("SKU-LEDR-TAKEN", 3);

		await expect(
			h.store.updateCommerceFields(
				{ productId: productId("prod-led-ref"), sku: sku("SKU-LEDR-TAKEN") },
				idempotencyKey("ledr-rename"),
				wm,
			),
		).rejects.toMatchObject({ name: "SkuStockConflictError" });

		// No move, therefore no record of one — the trail can never claim units
		// travelled that did not.
		expect(await movements("SKU-LEDR-FROM")).toHaveLength(0);
		expect(await movements("SKU-LEDR-TAKEN")).toHaveLength(0);
	});

	test("an idempotent REPLAY of a rename writes no second pair", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-led-rep", "SKU-LEDP-FROM", 25);
		const key = idempotencyKey("ledp-rename");
		const input = { productId: productId("prod-led-rep"), sku: sku("SKU-LEDP-TO") };

		await h.store.updateCommerceFields(input, key, wm);
		const replay = await h.store.updateCommerceFields(input, key, wm);
		expect(replay.ok).toBe(true);

		// A replay applies no update, so it never carries, so it records nothing: the
		// ledger counts MOVEMENTS, not attempts.
		expect(await movements("SKU-LEDP-FROM")).toHaveLength(1);
		expect(await movements("SKU-LEDP-TO")).toHaveLength(1);
	});

	test("a rename that carries NOTHING records nothing — an empty source is not a movement", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-led-zero", "SKU-LEDZ-FROM", 0);

		const res = await h.store.updateCommerceFields(
			{ productId: productId("prod-led-zero"), sku: sku("SKU-LEDZ-TO") },
			idempotencyKey("ledz-rename"),
			wm,
		);
		expect(res.ok).toBe(true);

		// The rename happened and the target was claimed, but zero units moved. A
		// zero-quantity entry would be a lie, and there is no column CHECK here to
		// stop one being written — so this is the assertion that does.
		expect(await movements("SKU-LEDZ-FROM")).toHaveLength(0);
		expect(await movements("SKU-LEDZ-TO")).toHaveLength(0);
		expect(await h.onHandOf("SKU-LEDZ-TO")).toBe(0);
	});

	test("a ledger key collision costs the audit entry, never the merchant's rename", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		const wm = await seedStocked(h, "prod-led-col", "SKU-LEDC-FROM", 30);
		const ledger = bound.collection<SkuRenameLedgerDoc>(INVENTORY_MOVEMENTS_COLLECTION);

		// The entry ids are derived from the CLIENT's idempotency key, so a caller can
		// occupy one — by reusing a key across two renames of the same source sku, or
		// by crafting a movement key that lands on the same string. Squat the "out" id.
		await ledger.put(skuRenameLedgerId("ledc-rename", "rename_out", "SKU-LEDC-FROM"), {
			kind: "rename",
			sku: "SKU-LEDC-FROM",
			direction: "rename_out",
			qty: 1,
			outcome: "ok",
			resultOnHand: 29,
			token: "squatted",
			createdAt: "2026-07-09T00:00:00.000Z",
		});

		const res = await h.store.updateCommerceFields(
			{ productId: productId("prod-led-col"), sku: sku("SKU-LEDC-TO") },
			idempotencyKey("ledc-rename"),
			wm,
		);

		// The rename is legal and must not be aborted by a collision in its own
		// bookkeeping — a raw conflict here would fail a correct write on a key the
		// operator never chose.
		expect(res.ok).toBe(true);
		expect(await h.onHandOf("SKU-LEDC-TO")).toBe(30);

		// The squatted entry is left exactly as it was — the carry's own entry is what
		// gets dropped, and only that one.
		const out = await movements("SKU-LEDC-FROM");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ qty: 1, token: "squatted" });

		// ONLY the colliding half is lost. The other half's id was never squatted, so
		// it lands normally: create-if-absent drops the document that conflicts, not
		// the pair, so the trail keeps what it can.
		const into = await movements("SKU-LEDC-TO");
		expect(into).toHaveLength(1);
		expect(into[0]).toMatchObject({ direction: "rename_in", qty: 30, resultOnHand: 30 });
	});

	test("a rename through UPSERT writes the same pair — the trail follows the column, not one writer", async () => {
		const h = makeProductCommerceHarness(bound.storage);
		await seedStocked(h, "prod-led-up", "SKU-LEDU-FROM", 17);

		const renamed = await h.store.upsert(
			{ productId: productId("prod-led-up"), sku: sku("SKU-LEDU-TO") },
			idempotencyKey("ledu-rename"),
		);
		expect(renamed.sku).toBe("SKU-LEDU-TO");

		// The integrator PUT moves stock exactly as the console edit does, so it has to
		// leave the same record behind — an audit trail with a hole in it for one of
		// the writers is worse than none, because it reads as a complete history.
		const out = await movements("SKU-LEDU-FROM");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ direction: "rename_out", qty: 17, resultOnHand: 0 });

		const into = await movements("SKU-LEDU-TO");
		expect(into).toHaveLength(1);
		expect(into[0]).toMatchObject({ direction: "rename_in", qty: 17, resultOnHand: 17 });
	});
});
