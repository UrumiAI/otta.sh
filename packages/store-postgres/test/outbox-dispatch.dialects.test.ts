import {
	cents,
	currency,
	dispatchOrderEmails,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type CreateOrderInput,
	type OrderStore,
} from "@otta-sh/domain";
import { CountingIdGen, FakeEmailSender, FixedClock } from "@otta-sh/domain/testing";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test } from "vitest";
import { KyselyOrderStore, makeSqliteDb, migrateToLatest } from "../src/index.js";
import type { Database } from "../src/schema.js";
import { createIsolatedPgSchema } from "../src/testing.js";
import { PG_ENABLED } from "./describe-each-dialect.js";

// Step 5.8: the outbox dispatcher's retry + lease semantics on the real
// adapters — a crashed run's claimed row becomes claimable again once its lease
// expires; a failed send returns the row to pending for the next tick.

const USD = currency("USD");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

interface OutboxHarness {
	store: OrderStore;
	emailSender: FakeEmailSender;
	clock: FixedClock;
}

function build(db: Kysely<Database>): OutboxHarness {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return {
		store: new KyselyOrderStore({ db, idGen: new CountingIdGen("oi"), clock }),
		emailSender: new FakeEmailSender(),
		clock,
	};
}

async function makeSqlite(): Promise<OutboxHarness> {
	const db = makeSqliteDb(":memory:");
	await migrateToLatest(db);
	cleanups.push(async () => {
		await db.destroy();
	});
	return build(db);
}

async function makePg(): Promise<OutboxHarness> {
	const connectionString = process.env.PG_CONNECTION_STRING;
	if (connectionString === undefined) throw new Error("PG_CONNECTION_STRING is not set");
	const iso = await createIsolatedPgSchema(connectionString, { poolMax: 4 });
	cleanups.push(() => iso.teardown());
	return build(iso.db);
}

function pendingInput(): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
	};
}

function suite(make: () => Promise<OutboxHarness>, dialect: string): void {
	describe(`outbox dispatcher [${dialect}]`, () => {
		test("a crashed dispatcher run leaves the row claimable again after its lease expires", async () => {
			const h = await make();
			await h.store.createFromCart(pendingInput());
			await h.store.markPaid(orderId("ord-1")); // enqueues one confirmation row

			const now = "2026-07-10T00:00:00.000Z";
			const lease = "2026-07-10T00:05:00.000Z";
			const first = await h.store.claimNextEmail(now, lease);
			expect(first).not.toBeNull();

			// Simulate a crash: the row is 'sending' but never marked sent. A second
			// claim within the lease window finds nothing.
			expect(await h.store.claimNextEmail(now, lease)).toBeNull();

			// After the lease expires, the same row is claimable again (reclaimed).
			const afterLease = "2026-07-10T00:06:00.000Z";
			const reclaimed = await h.store.claimNextEmail(afterLease, "2026-07-10T00:11:00.000Z");
			expect(reclaimed?.id).toBe(first?.id);
			expect(reclaimed?.attempts).toBe(2); // incremented on each claim
		});

		test("a failed send returns the row to pending; the next dispatch delivers it exactly once", async () => {
			const h = await make();
			await h.store.createFromCart(pendingInput());
			await h.store.markPaid(orderId("ord-1"));

			const deps = { orderStore: h.store, emailSender: h.emailSender, clock: h.clock };
			h.emailSender.failNextSends(1); // first send throws
			expect(await dispatchOrderEmails(deps)).toBe(0); // failed → backed off, nothing delivered
			// Backoff lease hasn't elapsed yet → still not claimable this tick.
			expect(await dispatchOrderEmails(deps)).toBe(0);
			// Next cron tick (past the backoff lease) delivers it exactly once.
			h.clock.advance(10 * 60 * 1000);
			expect(await dispatchOrderEmails(deps)).toBe(1);
			expect(await dispatchOrderEmails(deps)).toBe(0); // no double-send
			expect(h.emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
		});
	});
}

suite(makeSqlite, "sqlite");
describe.skipIf(!PG_ENABLED)("[postgres]", () => {
	suite(makePg, "pg");
});
