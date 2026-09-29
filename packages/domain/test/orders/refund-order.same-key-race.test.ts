import { cents, currency as toCurrency } from "@otta-sh/domain";
import { idempotencyKey, orderId as toOrderId, productId, sku } from "@otta-sh/domain";
import { refundOrder } from "@otta-sh/domain";
import type { IdempotencyKey, RefundInput, RefundRecord, RefundResult } from "@otta-sh/domain";
import {
	CountingIdGen,
	FakePaymentGateway,
	FixedClock,
	InMemoryOrderStore,
} from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

const USD = toCurrency("USD");

// Two requests carrying the SAME idempotency key race (a double-submit, or a
// retry sent while the first attempt is still in flight). Request A reserved the
// ledger slot and is waiting on the provider; request B reaches the provider's
// pre-flight after A's refund has landed there, so the pre-flight sees money it
// has no record of and answers PROVIDER_ALREADY_REFUNDED. That refusal is about
// B's view, not A's reservation: B must not void the row A's successful refund
// is about to finalize, or A ends REFUND_ISSUED_UNRECORDED for money that did
// move.

/** A gateway whose FIRST refund call is held open until the test releases it,
 *  and whose later calls answer the provider pre-flight's fail-closed refusal. */
class HeldFirstRefundGateway extends FakePaymentGateway {
	#release: (() => void) | undefined;
	readonly firstCallStarted: Promise<void>;
	#started: () => void = () => undefined;

	constructor() {
		super({ id: "stripe" });
		this.firstCallStarted = new Promise((resolve) => {
			this.#started = resolve;
		});
	}

	release(): void {
		this.#release?.();
	}

	override async refund(input: RefundInput): Promise<RefundResult> {
		this.refundCalls.push(input);
		if (this.refundCalls.length === 1) {
			await new Promise<void>((resolve) => {
				this.#release = resolve;
				this.#started();
			});
			return {
				ok: true,
				refundRef: `re_${input.idempotencyKey}`,
				amount: input.amount,
				currency: input.currency,
			};
		}
		return { ok: false, reason: "PROVIDER_ALREADY_REFUNDED" };
	}
}

/** A store whose replay read never sees a row, so request B does not RESUME:
 *  it reaches `reserveRefund` and learns about A's reservation from the store's
 *  `duplicate` outcome — the other way B can arrive without having created it. */
class BlindReplayReadStore extends InMemoryOrderStore {
	override async getRefundByIdempotencyKey(_key: IdempotencyKey): Promise<RefundRecord | null> {
		return null;
	}
}

async function seedPaid(
	store: InMemoryOrderStore,
	id: string,
): Promise<ReturnType<typeof toOrderId>> {
	const oid = toOrderId(id);
	await store.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(1000),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1000), total: cents(1000), currency: USD },
	});
	await store.markPaid(oid);
	await store.recordPayment({
		orderId: oid,
		gateway: "stripe",
		providerRef: `pi_${id}`,
		amount: cents(1000),
		currency: USD,
		status: "succeeded",
	});
	return oid;
}

function storeOf<T extends InMemoryOrderStore>(
	Ctor: new (o: ConstructorParameters<typeof InMemoryOrderStore>[0]) => T,
): T {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	return new Ctor({ idGen: new CountingIdGen("oi"), clock });
}

describe("refundOrder — a same-key request never voids a reservation it did not create", () => {
	for (const [label, Ctor] of [
		["B RESUMES A's reservation (its replay read sees the reserved row)", InMemoryOrderStore],
		["B learns of A's reservation from the store's duplicate outcome", BlindReplayReadStore],
	] as const) {
		test(label, async () => {
			const orderStore = storeOf(Ctor);
			const id = await seedPaid(orderStore, "ord-same-key");
			const gw = new HeldFirstRefundGateway();
			const cmd = {
				orderId: id,
				amount: cents(400),
				currency: USD,
				refundedBy: "admin",
				idempotencyKey: idempotencyKey("rf-same-key"),
			};

			const a = refundOrder({ orderStore }, gw, cmd);
			await gw.firstCallStarted;
			const b = await refundOrder({ orderStore }, gw, cmd);
			// B's own attempt issued nothing, and says so.
			expect(b).toEqual({ ok: false, reason: "PROVIDER_ALREADY_REFUNDED" });
			// ...and it left A's reservation exactly as it was.
			const [held] = await orderStore.listRefunds(id);
			expect(held?.status).toBe("reserved");

			gw.release();
			const settled = await a;
			expect(settled).toMatchObject({ ok: true, recorded: true, duplicate: false });
			const [row] = await orderStore.listRefunds(id);
			expect(row).toMatchObject({ status: "recorded", refundRef: "re_rf-same-key", amount: 400 });
			expect((await orderStore.getById(id))?.reconciliationFlag ?? null).toBeNull();
		});
	}
});
