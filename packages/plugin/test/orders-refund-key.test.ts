/**
 * F-2a, THE REFUND IDEMPOTENCY KEY — a DIRECT unit test, no sandbox and no HTTP.
 *
 * WHY THIS FILE EXISTS. The key `refundOrderAction` derives is
 * `admin-refund:<order>:<amount>:<watermark>`, and it is a pure function of
 * three values the caller supplies. It used to be asserted in
 * `orders-actions.sandbox.test.ts` by reading the `Idempotency-Key` header off a
 * recorded POST; with the transport gone there is no header to read, and the
 * sandbox tier cannot observe the string at all — the key is handed straight to
 * a use-case inside the isolate. So the property is asserted where it is still
 * observable: at `dispatchOrdersAction`, whose third argument IS the clients
 * seam, with a recorder standing in for `AdminOrdersSurface`.
 *
 * NO NEW API WAS EXPORTED FOR THIS. `dispatchOrdersAction` is already the
 * module's public entry point and already takes the client, so the smallest
 * honest seam was the one that was there.
 *
 * NOT A REPLACEMENT FOR THE SANDBOX SUITE. This pins the derivation only. What
 * the key BUYS end to end — a replay deduping, two deliberate refunds both
 * applying — is the sandbox suite's job the moment a payment gateway is composed
 * in process; a recorder proves nothing about a store.
 *
 * WHY THE POSITIVE CASE IS THE LOAD-BEARING ONE. The domain resolves a refund by
 * KEY ALONE, with no amount comparison. So a key that did NOT move with the
 * observed ledger would make the operator's second deliberate $5.00 refund
 * collapse into the first, and money that never came back would be reported as
 * already refunded. That is the failure this file exists to catch.
 */
import { describe, expect, test } from "vitest";
import {
	dispatchOrdersAction,
	type OrdersActionPayload,
	type OrdersActionResult,
} from "../src/admin/orders-actions.js";
import { refundIncrementText } from "@otta-sh/admin-presentation";
import type { AdminOrdersSurface, RefundsSummaryWire } from "../src/admin/admin-orders-surface.js";

const ORDER_ID = "order-refund-key-1";

/** The order this file refunds against: $15.00 captured, so the ceiling is
 *  $15.00 and a $5.00 refund is always inside it. */
const CAPTURED_CENTS = 1500;

interface Recorder {
	readonly client: AdminOrdersSurface;
	/** Every `idempotencyKey` a refund reached the client with, in order. */
	readonly keys: string[];
	/** The ledger total the next `getRefunds` reports — the watermark a dialog
	 *  would have been drawn from. */
	refundedSoFar: number;
	/** Capacity held by attempts that are NOT finalized (`reserved`/`unverified`):
	 *  counted in the active `refundedTotalCents`, never in the finalized total. */
	inFlight: number;
	/** The idempotency keys of the `voided` attempts the ledger carries — this
	 *  refund's own, or another refund's on the same order. */
	voidedKeys: string[];
}

/**
 * An `AdminOrdersSurface` that records what a refund was called with.
 *
 * Every method this test does not name throws: a refund that reached
 * `transitionOrder` would be a defect, and a silent no-op would hide it.
 */
/** A surface method a refund must never touch. Calling one is a defect, and a
 *  silent no-op would hide it. */
function refuse(method: string) {
	return (): never => {
		throw new Error(`${method} must not be called by a refund`);
	};
}

function recorder(): Recorder {
	const keys: string[] = [];
	const state = { refundedSoFar: 0, inFlight: 0, voidedKeys: [] as string[] };
	const client: AdminOrdersSurface = {
		getRefunds: (orderId: string): Promise<RefundsSummaryWire | null> => {
			expect(orderId).toBe(ORDER_ID);
			const voidedRows = state.voidedKeys.map((key, i) => ({
				id: `voided-${String(i)}`,
				orderId: ORDER_ID,
				amountCents: 500,
				currency: "USD",
				kind: "gateway",
				gateway: "stripe",
				refundRef: null,
				reason: null,
				refundedBy: "carol",
				createdAt: "2026-01-01T00:00:00.000Z",
				status: "voided",
				idempotencyKey: key,
			}));
			return Promise.resolve({
				refunds: voidedRows,
				currency: "USD",
				capturedTotalCents: CAPTURED_CENTS,
				refundedTotalCents: state.refundedSoFar + state.inFlight,
				finalizedTotalCents: state.refundedSoFar,
				ceilingCents: CAPTURED_CENTS,
				remainingCents: CAPTURED_CENTS - state.refundedSoFar - state.inFlight,
				paymentMethod: "stripe",
				refundable: true,
				legacyPaymentMethod: false,
			});
		},
		refundOrder: (
			_orderId: string,
			_refund: {
				amountCents: number;
				currency: string;
				reason?: string | null;
				refundedBy: string;
			},
			opts: { idempotencyKey: string },
		) => {
			keys.push(opts.idempotencyKey);
			return Promise.resolve({
				ok: true as const,
				recorded: true,
				duplicate: false,
				fullyRefunded: false,
			});
		},
		listOrders: refuse("listOrders"),
		getOrder: refuse("getOrder"),
		transitionOrder: refuse("transitionOrder"),
		resolveReconciliation: refuse("resolveReconciliation"),
		recordFulfillment: refuse("recordFulfillment"),
		cancelOrder: refuse("cancelOrder"),
		getCustomerContext: refuse("getCustomerContext"),
		getTimeline: refuse("getTimeline"),
		listNotes: refuse("listNotes"),
		addNote: refuse("addNote"),
		resolveUnverifiedRefund: refuse("resolveUnverifiedRefund"),
	};
	return {
		client,
		keys,
		get refundedSoFar() {
			return state.refundedSoFar;
		},
		set refundedSoFar(value: number) {
			state.refundedSoFar = value;
		},
		get inFlight() {
			return state.inFlight;
		},
		set inFlight(value: number) {
			state.inFlight = value;
		},
		get voidedKeys() {
			return state.voidedKeys;
		},
		set voidedKeys(value: string[]) {
			state.voidedKeys = value;
		},
	};
}

/** One refund, dispatched exactly as the console's act branch dispatches it. */
async function refund(
	client: AdminOrdersSurface,
	payload: OrdersActionPayload,
): Promise<OrdersActionResult> {
	const result = await dispatchOrdersAction("orders:refund", payload, client);
	// `undefined` means the id is not registered — a rename would silently turn
	// every case below into a no-op.
	expect(result, "orders:refund is not a registered action id").toBeDefined();
	return result as OrdersActionResult;
}

function payloadFor(amountCents: string, refundedSoFarCents: string): OrdersActionPayload {
	return {
		orderId: ORDER_ID,
		amountCents,
		refundedSoFarCents,
		currency: "USD",
		reason: "damaged",
		refundedBy: "carol",
	};
}

describe("the refund idempotency key (F-2a)", () => {
	test("THE POSITIVE CASE: two DELIBERATE identical refunds derive DIFFERENT keys, because the observed watermark moved", async () => {
		const rec = recorder();

		// The first $5.00, against an untouched ledger.
		const first = await refund(rec.client, payloadFor("500", "0"));
		expect(first.notice?.variant).toBe("default");

		// That refund moved the ledger, so the operator's next view of the order
		// carries a NEW watermark — and the SAME amount against it is a different
		// intent, which must be a different key or the domain collapses the two.
		rec.refundedSoFar = 500;
		await refund(rec.client, payloadFor("500", "500"));

		expect(rec.keys).toEqual([
			`admin-refund:${ORDER_ID}:500:0`,
			`admin-refund:${ORDER_ID}:500:500`,
		]);
		expect(rec.keys[1]).not.toBe(rec.keys[0]);
	});

	test("the SAME click twice derives the SAME key — content-derived, never a nonce", async () => {
		// The other half of the same rule, and the reason the key cannot simply be
		// made unique per render: a double-click of one control is one intent, and
		// two keys for it would refund twice.
		const rec = recorder();
		await refund(rec.client, payloadFor("500", "0"));
		await refund(rec.client, payloadFor("500", "0"));
		expect(rec.keys).toEqual([`admin-refund:${ORDER_ID}:500:0`, `admin-refund:${ORDER_ID}:500:0`]);
	});

	test("a different AMOUNT against the same watermark is a different key", async () => {
		// The third component. Two refunds an operator staged from the same view
		// are different intents whenever the amounts differ, and a key that dropped
		// the amount would report the second as already refunded.
		const rec = recorder();
		await refund(rec.client, payloadFor("500", "0"));
		await refund(rec.client, payloadFor("600", "0"));
		expect(rec.keys[1]).not.toBe(rec.keys[0]);
		expect(rec.keys[1]).toBe(`admin-refund:${ORDER_ID}:600:0`);
	});

	test("a STALE watermark never reaches the write, so no key is derived at all", async () => {
		// DA-3a in front of F-2a: the ledger moved since the dialog was drawn, so
		// the refusal happens before the key exists. Asserted here because it is
		// what makes the watermark safe to put IN the key — a mismatched one is
		// never keyed, it is refused.
		const rec = recorder();
		rec.refundedSoFar = 500;
		const result = await refund(rec.client, payloadFor("500", "0"));
		expect(result.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(rec.keys).toEqual([]);
	});

	test("an attempt still IN FLIGHT does not move the watermark, so the retry reaches the SAME key and resumes it", async () => {
		// A refund that ended GATEWAY_RETRYABLE (or UNVERIFIED) left a reserved row
		// that holds ceiling capacity but moved no money yet. The console's
		// watermark is the FINALIZED total, so the operator's "try again" is the
		// same intent under the same key — the domain resumes that reservation
		// instead of refusing the click as "someone else refunded this order".
		const rec = recorder();
		rec.inFlight = 500;
		const result = await refund(rec.client, payloadFor("500", "0"));
		expect(result.notice?.title).not.toBe("The refund ledger changed — nothing was refunded");
		expect(rec.keys).toEqual([`admin-refund:${ORDER_ID}:500:0`]);
	});

	test("a VOIDED attempt of THIS refund spends its key, so a deliberate retry derives a new one", async () => {
		// A voided key answers its own rejection forever (the domain replays it), so
		// the retry after a definite provider rejection must not reuse it. The
		// count is of THIS refund's voided attempts, read from the LIVE ledger.
		const rec = recorder();
		rec.voidedKeys = [`admin-refund:${ORDER_ID}:500:0`];
		await refund(rec.client, payloadFor("500", "0"));
		// ...and a second rejection of the retry moves it on again.
		rec.voidedKeys = [`admin-refund:${ORDER_ID}:500:0`, `admin-refund:${ORDER_ID}:500:0:v1`];
		await refund(rec.client, payloadFor("500", "0"));
		expect(rec.keys).toEqual([
			`admin-refund:${ORDER_ID}:500:0:v1`,
			`admin-refund:${ORDER_ID}:500:0:v2`,
		]);
	});

	test("a voided attempt of a DIFFERENT refund on the same order does not change this refund's key", async () => {
		// A $5.00 refund that ended RETRYABLE is still reserved under `…:500:0`.
		// A $3.00 refund on the same order is rejected (voided), and so is a
		// $50.00 one whose key merely STARTS like this one's. Retrying the $5.00
		// must still reach `…:500:0` and resume its reservation — a fresh key would
		// orphan it and could refund twice.
		const rec = recorder();
		rec.inFlight = 500;
		rec.voidedKeys = [`admin-refund:${ORDER_ID}:300:0`, `admin-refund:${ORDER_ID}:5000:0`];
		await refund(rec.client, payloadFor("500", "0"));
		expect(rec.keys).toEqual([`admin-refund:${ORDER_ID}:500:0`]);
	});
});

describe("a refund the order's currency cannot be paid back in (ADR-0033 amendment)", () => {
	test("the domain's AMOUNT_NOT_PAYMENT_INCREMENT is worded with the currency's step", async () => {
		const rec = recorder();
		const usdRefunds = rec.client.getRefunds.bind(rec.client);
		rec.client.getRefunds = async (orderId: string) => {
			const summary = await usdRefunds(orderId);
			return summary === null ? null : { ...summary, currency: "KWD" };
		};
		rec.client.refundOrder = (_orderId, _refund, opts) => {
			rec.keys.push(opts.idempotencyKey);
			return Promise.resolve({
				ok: false as const,
				status: 400,
				reason: "AMOUNT_NOT_PAYMENT_INCREMENT",
			});
		};
		const refused = await refund(rec.client, { ...payloadFor("1234", "0"), currency: "KWD" });
		expect(refused.notice?.variant).toBe("error");
		expect(refused.notice?.title).toBe("Not refunded");
		expect(refused.notice?.description).toBe(refundIncrementText("KWD"));
		expect(rec.keys).toEqual([`admin-refund:${ORDER_ID}:1234:0`]);
	});
});
