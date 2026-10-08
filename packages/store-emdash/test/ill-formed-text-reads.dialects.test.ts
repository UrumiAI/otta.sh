/**
 * One stored document carrying text Postgres cannot read as JSON must not take a
 * whole collection's queries down (security review R3 round 2, B-X1).
 *
 * THE MECHANISM. EmDash stores a document as `JSON.stringify` text, which spells a
 * lone UTF-16 surrogate as `"\ud800"` and U+0000 as `"\u0000"`. Every `where` and
 * `orderBy` the host builds on Postgres reads the row through `(data)::jsonb`, and
 * `jsonb` refuses both escapes (`invalid input syntax for type json`, 22P02;
 * `unsupported Unicode escape sequence`, 22P05). The cast is evaluated for EVERY
 * row of the collection in scope, so ONE such row made `listOrders` and the expiry
 * sweep's `listExpirable` throw for the whole store. SQLite's JSON functions accept
 * both escapes, so the cases below are the same on every dialect: on SQLite they
 * pin that nothing changes; on Postgres they are the regression.
 *
 * The "legacy" rows are written through the RAW host collection, never through
 * `collectionOf` — that is the only way such a row can exist once the write guard
 * is in place, and it is exactly how a row written before the guard looks.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	toWellFormedText,
} from "@otta-sh/domain";
import type { CreateOrderInput } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	CART_COLLECTIONS,
	collectionOf,
	COUPON_COLLECTIONS,
	ENTITLEMENT_COLLECTIONS,
	IDENTITY_COLLECTIONS,
	INVENTORY_COLLECTIONS,
	ORDER_COLLECTIONS,
	ORDER_NOTES_COLLECTIONS,
	PAYMENT_EVENT_COLLECTIONS,
	PRODUCT_COMMERCE_COLLECTIONS,
	REPORTING_COLLECTIONS,
	RULES_COLLECTIONS,
	SETTINGS_COLLECTIONS,
} from "../src/index.js";
import { describeEachDialect, type StorageLayout } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness } from "./order-harness.js";

const USD = currency("USD");

/** The two code-unit sequences `jsonb` refuses, as a shopper could send them. */
const POISON = {
	"lone high surrogate": "Ber\uD800lin",
	"lone low surrogate": "\uDC00Berlin",
	"reversed pair": "Ber\uDC00\uD800lin",
	NUL: "Ber\u0000lin",
} as const;

function orderInput(id: string, holdExpiresAt: string): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: `cart-${id}`,
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${id}`),
		holdExpiresAt,
		buyerRef: `${id}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId(`p-${id}`),
				sku: sku(`SKU-${id}`),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: reservationId(`res-${id}`),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
		shippingAddress: {
			name: "Asha Rao",
			line1: "12 Park Street",
			line2: null,
			city: "Kolkata",
			region: null,
			postalCode: "700016",
			country: "IN",
			email: null,
			phone: null,
		},
	};
}

describeEachDialect("ill-formed text already stored: order reads", (ctx) => {
	const bound = ctx.useStorage(ORDER_LAYOUT);

	for (const [label, poison] of Object.entries(POISON)) {
		test(`one order whose ship-to and buyerRef hold a ${label} breaks no order query`, async () => {
			const h = makeOrderHarness(bound.storage);
			await h.store.createFromCart(orderInput("ord-clean", "2026-07-10T00:15:00.000Z"));
			await h.store.createFromCart(orderInput("ord-bad", "2026-07-10T00:15:00.000Z"));

			// Plant the legacy row: rewrite the stored document through the RAW host
			// collection, as a pre-guard checkout would have left it.
			const raw = bound.storage["orders"];
			if (raw === undefined) throw new Error("orders collection missing");
			const stored = (await raw.get("ord-bad")) as Record<string, unknown>;
			const address = stored["shippingAddress"] as Record<string, unknown>;
			await raw.put("ord-bad", {
				...stored,
				buyerRef: `evil${poison}@example.com`,
				shippingAddress: { ...address, city: poison },
			});

			const listed = await h.store.listOrders({}, { limit: 10 });
			expect(listed.orders.map((o) => o.id).toSorted()).toEqual(["ord-bad", "ord-clean"]);
			expect(await h.store.countOrders({ states: ["pending"] })).toBe(2);
			expect((await h.store.listExpirable("2099-01-01T00:00:00.000Z")).toSorted()).toEqual([
				"ord-bad",
				"ord-clean",
			]);

			// The read path repairs only what a reader cannot read. Postgres could not,
			// so the row was REPAIRED in place (never dropped): every bad code unit is
			// now U+FFFD and nothing else moved. SQLite could, so nothing was rewritten.
			const expected = ctx.dialect === "postgres" ? toWellFormedText(poison) : poison;
			const afterReads = await h.store.getById(orderId("ord-bad"));
			expect(afterReads?.buyerRef).toBe(`evil${expected}@example.com`);
			expect(afterReads?.shippingAddress?.city).toBe(expected);

			// And the legacy order is not bricked for writes: the sweep can still expire
			// it (releasing its stock), and that write stores the repaired text on
			// every dialect.
			expect(await h.store.expire(orderId("ord-bad"), "2099-01-01T00:00:00.000Z")).toBe(true);
			const expired = await h.store.getById(orderId("ord-bad"));
			expect(expired?.state).toBe("expired");
			expect(expired?.shippingAddress?.city).toBe(toWellFormedText(poison));
			expect((await h.store.getById(orderId("ord-clean")))?.buyerRef).toBe("ord-clean@example.com");
		});
	}
});

/** Every collection the plugin declares — the whole storage surface, not a sample. */
const EVERY_COLLECTION = {
	...CART_COLLECTIONS,
	...COUPON_COLLECTIONS,
	...ENTITLEMENT_COLLECTIONS,
	...IDENTITY_COLLECTIONS,
	...INVENTORY_COLLECTIONS,
	...ORDER_COLLECTIONS,
	...ORDER_NOTES_COLLECTIONS,
	...PAYMENT_EVENT_COLLECTIONS,
	...PRODUCT_COMMERCE_COLLECTIONS,
	...REPORTING_COLLECTIONS,
	...RULES_COLLECTIONS,
	...SETTINGS_COLLECTIONS,
};

const EVERY_LAYOUT: StorageLayout = Object.fromEntries(
	Object.entries(EVERY_COLLECTION).map(([name, d]) => [
		name,
		{
			indexes: (d.indexes ?? []).map((i) => (typeof i === "string" ? i : [...i])),
			uniqueIndexes: (d.uniqueIndexes ?? []).map((i) => (typeof i === "string" ? i : [...i])),
		},
	]),
);

/** The first single-field index a collection declares — the field a `where` may name. */
function firstIndexField(name: string): string | undefined {
	const d = EVERY_LAYOUT[name];
	for (const i of [...(d?.indexes ?? []), ...(d?.uniqueIndexes ?? [])]) {
		if (typeof i === "string") return i;
		if (i[0] !== undefined) return i[0];
	}
	return undefined;
}

describeEachDialect("ill-formed text already stored: every declared collection", (ctx) => {
	const bound = ctx.useStorage(EVERY_LAYOUT);

	test("a where-query, an orderBy page and a count over a collection holding one bad row all answer", async () => {
		const queried: string[] = [];
		for (const name of Object.keys(EVERY_LAYOUT)) {
			const field = firstIndexField(name);
			if (field === undefined) continue;
			const raw = bound.storage[name];
			if (raw === undefined) throw new Error(`${name} missing`);
			await raw.put("good", { [field]: "k", note: "fine" });
			await raw.put("bad", { [field]: "k", note: POISON["lone high surrogate"] });

			const coll = collectionOf<Record<string, unknown>>(bound.storage, name);
			const page = await coll.query({ where: { [field]: "k" }, orderBy: { [field]: "asc" } });
			expect(page.items.map((i) => i.id).toSorted(), name).toEqual(["bad", "good"]);
			expect(await coll.count({ [field]: "k" }), name).toBe(2);
			queried.push(name);
		}
		// Not vacuous: the surface is every collection with an index, and that is most.
		expect(queried.length).toBeGreaterThan(15);
	});
});
