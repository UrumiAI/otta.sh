import {
	addLine,
	type CartDeps,
	cents,
	createCart,
	type CreateOrderDeps,
	createOrderFromCart,
	currency,
	idempotencyKey,
	money,
	type Order,
	productId as brandProductId,
	type SettleDeps,
	settleOrder,
	sku as brandSku,
} from "@urumi/domain";
import { FakePaymentGateway, FixedClock } from "@urumi/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import {
	KyselyCartStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	uuidIdGen,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// THE Phase-4 acceptance gate (Postgres-required): N buyers race to buy the last
// M units. Only M reservations can be held (Phase-0/3 no-oversell), and the
// guarantee is extended across CHECKOUT + COMMIT — exactly M orders reach
// paid+commit, the losers never got a reservation, and final on_hand == 0
// (committed stock stays gone, never resold). Looped like the other gates.

const PG = process.env.PG_CONNECTION_STRING;
const USD = currency("USD");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

interface Fixture {
	db: Kysely<Database>;
	cartDeps: CartDeps;
	createDeps: CreateOrderDeps;
	settleDeps: SettleDeps;
	gateway: FakePaymentGateway;
	seedInventory(qty: number): Promise<void>;
	seedProduct(): Promise<void>;
	onHand(): Promise<number>;
	reset(): Promise<void>;
}

async function freshFixture(poolMax: number): Promise<Fixture> {
	if (PG === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(PG, { poolMax });
	cleanups.push(() => iso.teardown());
	const db = iso.db;
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new KyselyInventoryStore({ db, idGen: uuidIdGen, clock });
	const cartStore = new KyselyCartStore({ db, idGen: uuidIdGen, clock });
	const productCommerce = new KyselyProductCommerceStore({ db, clock });
	const orderStore = new KyselyOrderStore({ db, idGen: uuidIdGen, clock });
	const entitlementStore = new KyselyEntitlementStore({ db, idGen: uuidIdGen, clock });
	const paymentEventStore = new KyselyPaymentEventStore({ db, idGen: uuidIdGen });
	const gateway = new FakePaymentGateway({ id: "stripe" });

	return {
		db,
		cartDeps: { cartStore, inventoryStore: inventory, clock },
		createDeps: {
			orderStore,
			cartStore,
			inventoryStore: inventory,
			productCommerce,
			clock,
			idGen: uuidIdGen,
			gateways: { stripe: gateway },
		},
		settleDeps: {
			orderStore,
			entitlementStore,
			paymentEventStore,
			inventoryStore: inventory,
			clock,
		},
		gateway,
		async seedInventory(qty) {
			await db
				.insertInto("inventory")
				.values({ sku: "SKU-1", on_hand: qty })
				.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
				.execute();
		},
		async seedProduct() {
			await productCommerce.upsert(
				{
					productId: brandProductId("p1"),
					sku: brandSku("SKU-1"),
					price: money(cents(100), USD),
					title: "Widget",
					productKind: "physical",
				},
				idempotencyKey("seed-p1"),
			);
		},
		async onHand() {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", "SKU-1")
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async reset() {
			await db.deleteFrom("entitlements").execute();
			await db.deleteFrom("payments").execute();
			await db.deleteFrom("payment_events").execute();
			await db.deleteFrom("order_items").execute();
			await db.deleteFrom("order_totals").execute();
			await db.deleteFrom("orders").execute();
			await db.deleteFrom("cart_mutations").execute();
			await db.deleteFrom("cart_lines").execute();
			await db.deleteFrom("carts").execute();
			await db.deleteFrom("reservations").execute();
		},
	};
}

describe.skipIf(PG === undefined)("no oversell through checkout [postgres]", () => {
	test("concurrent checkout of the last units: exactly M orders reach paid+commit", async () => {
		const M = 5;
		const N = 40;
		const LOOPS = 8;
		const h = await freshFixture(N + 4);
		await h.seedProduct();

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.reset();
			await h.seedInventory(M);

			// N buyers, each their own cart, race the same M units at add-to-cart.
			const cartIds = await Promise.all(
				Array.from({ length: N }, () => createCart(h.cartDeps, USD)),
			);
			const added = await Promise.all(
				cartIds.map((cartId, i) =>
					addLine(
						h.cartDeps,
						cartId,
						brandSku("SKU-1"),
						"p1",
						1,
						idempotencyKey(`add-${loop}-${i}`),
						"physical",
					).then((r) => ({ cartId, r })),
				),
			);
			const winners = added.filter((x) => x.r.ok);
			expect(winners).toHaveLength(M); // Phase-0/3 no-oversell at reserve

			// The winners concurrently check out → pay → commit.
			const orders = await Promise.all(
				winners.map(async ({ cartId }, i) => {
					const created = await createOrderFromCart(h.createDeps, {
						cartId,
						idempotencyKey: idempotencyKey(`ord-${loop}-${i}`),
						buyerRef: `b${i}@example.com`,
						paymentMethod: "stripe",
					});
					if (!created.ok) throw new Error(`checkout failed: ${created.reason}`);
					return created.order;
				}),
			);
			await Promise.all(
				orders.map((order: Order) =>
					settleOrder(
						h.settleDeps,
						h.gateway,
						h.gateway.webhook({
							outcome: "succeeded",
							orderId: order.id,
							providerRef: `pi-${order.id}`,
							amount: order.totals.total,
							currency: "USD",
							dedupeKey: `evt-${order.id}`,
						}),
					),
				),
			);

			const paid = await h.db
				.selectFrom("orders")
				.select((eb) => eb.fn.countAll<number>().as("n"))
				.where("state", "=", "paid")
				.executeTakeFirstOrThrow();
			const committed = await h.db
				.selectFrom("reservations")
				.select((eb) => eb.fn.countAll<number>().as("n"))
				.where("state", "=", "committed")
				.executeTakeFirstOrThrow();
			expect(Number(paid.n), `loop ${loop}: paid orders`).toBe(M);
			expect(Number(committed.n), `loop ${loop}: committed reservations`).toBe(M);
			expect(await h.onHand(), `loop ${loop}: final on_hand`).toBe(0);
		}
	}, 180_000);
});
