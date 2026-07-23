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
	KyselyCouponStore,
	KyselyEntitlementStore,
	KyselyInventoryStore,
	KyselyOrderStore,
	KyselyPaymentEventStore,
	KyselyProductCommerceStore,
	KyselyShippingRulesStore,
	KyselyTaxRulesStore,
	uuidIdGen,
} from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";

// THE PR-B acceptance gate (Postgres-required): the no-oversell guarantee extended
// to the BATCHED checkout ADOPT (adoptMany) + settle COMMIT (commitMany) with N>1
// ids per order. The sibling single-line gate (no-oversell-checkout.pg.test.ts)
// drives qty-1 single-line carts, so it never exercises the batch. Here each cart
// races MULTIPLE distinct-sku physical lines: a cart can win one sku and lose
// another and thus never fully check out, so `committed == M×lines` is NOT a valid
// assertion. Instead we compute the "full winners" (carts that won ALL their lines)
// and assert `committed == fullWinners × linesPerOrder`, each sku's on_hand == 0,
// and that no paid order half-commits (every paid order committed exactly its lines).

const PG = process.env.PG_CONNECTION_STRING;
const USD = currency("USD");

// linesPerOrder distinct skus; each cart adds one physical line per sku.
const SKUS = ["SKU-A", "SKU-B", "SKU-C"] as const;
const PIDS = ["pA", "pB", "pC"] as const;
const LINES = SKUS.length;

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
	seedProducts(): Promise<void>;
	onHand(sku: string): Promise<number>;
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
			shippingRules: new KyselyShippingRulesStore({ db }),
			taxRules: new KyselyTaxRulesStore({ db }),
			couponStore: new KyselyCouponStore({ db, idGen: uuidIdGen, clock }),
			clock,
			idGen: uuidIdGen,
			gateways: { stripe: gateway },
		},
		settleDeps: {
			orderStore,
			entitlementStore,
			paymentEventStore,
			inventoryStore: inventory,
			couponStore: new KyselyCouponStore({ db, idGen: uuidIdGen, clock }),
			clock,
		},
		gateway,
		async seedInventory(qty) {
			for (const sku of SKUS) {
				await db
					.insertInto("inventory")
					.values({ sku, on_hand: qty })
					.onConflict((oc) => oc.column("sku").doUpdateSet({ on_hand: qty }))
					.execute();
			}
		},
		async seedProducts() {
			for (let i = 0; i < LINES; i++) {
				await productCommerce.upsert(
					{
						productId: brandProductId(PIDS[i]!),
						sku: brandSku(SKUS[i]!),
						price: money(cents(100), USD),
						title: `Widget ${SKUS[i]}`,
						productKind: "physical",
					},
					idempotencyKey(`seed-${PIDS[i]}`),
				);
			}
		},
		async onHand(sku) {
			const row = await db
				.selectFrom("inventory")
				.select("on_hand")
				.where("sku", "=", sku)
				.executeTakeFirst();
			return row?.on_hand ?? 0;
		},
		async reset() {
			await db.deleteFrom("entitlements").execute();
			await db.deleteFrom("payments").execute();
			await db.deleteFrom("payment_events").execute();
			await db.deleteFrom("order_emails_outbox").execute();
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

describe.skipIf(PG === undefined)("no oversell through MULTI-LINE checkout [postgres]", () => {
	test("racing multi-line carts: adoptMany/commitMany with N>1 ids never oversell or half-commit", async () => {
		const M = 8; // per-sku stock
		const N = 10; // racing carts
		const LOOPS = 6;
		const h = await freshFixture(N * LINES + 4);
		await h.seedProducts();

		for (let loop = 0; loop < LOOPS; loop++) {
			await h.reset();
			await h.seedInventory(M);

			// N carts, each racing to reserve one physical line per sku (LINES lines).
			// Within a cart the adds are sequential; across carts they race — so a
			// cart can win some skus and lose others (Phase-0/3 no-oversell at reserve).
			const carts = await Promise.all(
				Array.from({ length: N }, async (_unused, i) => {
					const cartId = await createCart(h.cartDeps, USD);
					const results = await Promise.all(
						SKUS.map((sku, j) =>
							addLine(
								h.cartDeps,
								cartId,
								brandSku(sku),
								PIDS[j]!,
								1,
								idempotencyKey(`add-${loop}-${i}-${j}`),
								"physical",
							),
						),
					);
					return { cartId, i, wonAll: results.every((r) => r.ok) };
				}),
			);

			// Every sku is contended by all N > M carts, so each is fully drawn down.
			for (const sku of SKUS) {
				expect(await h.onHand(sku), `loop ${loop}: on_hand ${sku} after reserve`).toBe(0);
			}

			// Only FULL winners (won every line) can check out completely. They race
			// checkout (adoptMany, LINES ids) → pay → settle (commitMany, LINES ids).
			const fullWinners = carts.filter((c) => c.wonAll);
			expect(fullWinners.length, `loop ${loop}: full winners exist`).toBeGreaterThan(0);

			const orders = await Promise.all(
				fullWinners.map(async ({ cartId, i }) => {
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

			// Exactly the full winners are paid; each committed exactly LINES holds.
			const paid = await h.db
				.selectFrom("orders")
				.select((eb) => eb.fn.countAll<number>().as("n"))
				.where("state", "=", "paid")
				.executeTakeFirstOrThrow();
			expect(Number(paid.n), `loop ${loop}: paid orders`).toBe(fullWinners.length);

			const committed = await h.db
				.selectFrom("reservations")
				.select((eb) => eb.fn.countAll<number>().as("n"))
				.where("state", "=", "committed")
				.executeTakeFirstOrThrow();
			expect(Number(committed.n), `loop ${loop}: committed reservations`).toBe(
				fullWinners.length * LINES,
			);

			// No half-commit: every paid order committed EXACTLY its LINES reservations.
			for (const order of orders) {
				const perOrder = await h.db
					.selectFrom("reservations")
					.select((eb) => eb.fn.countAll<number>().as("n"))
					.where("order_id", "=", order.id)
					.where("state", "=", "committed")
					.executeTakeFirstOrThrow();
				expect(Number(perOrder.n), `loop ${loop}: order ${order.id} committed lines`).toBe(LINES);
			}

			// Committed stock stays gone (never resold): each sku still at 0.
			for (const sku of SKUS) {
				expect(await h.onHand(sku), `loop ${loop}: final on_hand ${sku}`).toBe(0);
			}
		}
	}, 180_000);
});
